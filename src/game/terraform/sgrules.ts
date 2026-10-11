// Security group rules as AWS sees them: the group's inline ingress/egress plus every separate rule resource
// (aws_vpc_security_group_{ingress,egress}_rule, aws_security_group_rule) that names it.
import type { Value } from './eval.ts'
import { exprRefs, type GNode, type Ref } from './graph.ts'
import { realityKey, type Reality } from './refresh.ts'
import type { Diagnostic } from './types.ts'

export type Direction = 'ingress' | 'egress'
export interface SgRule {
  dir: Direction
  proto: string // tcp, udp, icmp, ... or -1 (all)
  from: number
  to: number
  src: { kind: 'cidr4' | 'cidr6' | 'sg' | 'pl'; v: string } // the peer: a CIDR, a security group, a prefix list
}

// The type of each separate rule resource, with the direction it fixes (undefined: the `type` argument says).
export const RULE_TYPES: Record<string, Direction | undefined> = {
  aws_vpc_security_group_ingress_rule: 'ingress',
  aws_vpc_security_group_egress_rule: 'egress',
  aws_security_group_rule: undefined,
}
export const isRuleType = (t: string) => Object.hasOwn(RULE_TYPES, t)

const isObj = (v: Value | undefined): v is Record<string, Value> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strs = (v: Value | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const num = (v: Value | undefined, d: number) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : d)

// Protocol numbers and names mean one thing: 6 is tcp, 17 udp, 1 icmp, 58 icmpv6; -1 and all are every protocol.
const PROTO_NUMBERS: Record<string, string> = { '6': 'tcp', '17': 'udp', '1': 'icmp', '58': 'icmpv6', all: '-1' }
export const normProto = (p: Value | undefined): string => {
  const x = typeof p === 'number' ? String(p) : typeof p === 'string' ? p.trim().toLowerCase() : 'tcp'
  return Object.hasOwn(PROTO_NUMBERS, x) ? PROTO_NUMBERS[x] : x
}

function make(dir: Direction, protocol: Value | undefined, from: Value | undefined, to: Value | undefined, srcs: SgRule['src'][]): SgRule[] {
  const p = normProto(protocol)
  const all = p === '-1'
  return srcs.map((src) => ({ dir, proto: p, from: all ? 0 : num(from, 0), to: all ? 65535 : num(to, 0), src }))
}

// The rules one object grants: an inline ingress/egress entry of group `owner`, or a separate rule resource.
export function rulesOf(type: string, o: Record<string, Value>, dir?: Direction, owner?: string): SgRule[] {
  if (type === 'aws_security_group') {
    const d = dir!
    return make(d, o.protocol, o.from_port, o.to_port, [
      ...strs(o.cidr_blocks).map((v) => ({ kind: 'cidr4' as const, v })),
      ...strs(o.ipv6_cidr_blocks).map((v) => ({ kind: 'cidr6' as const, v })),
      ...strs(o.security_groups).map((v) => ({ kind: 'sg' as const, v })),
      ...strs(o.prefix_list_ids).map((v) => ({ kind: 'pl' as const, v })),
      ...(o.self === true && owner ? [{ kind: 'sg' as const, v: owner }] : []),
    ])
  }
  if (type === 'aws_security_group_rule') {
    const d = o.type === 'egress' ? 'egress' : 'ingress'
    return make(d, o.protocol, o.from_port, o.to_port, [
      ...strs(o.cidr_blocks).map((v) => ({ kind: 'cidr4' as const, v })),
      ...strs(o.ipv6_cidr_blocks).map((v) => ({ kind: 'cidr6' as const, v })),
      ...strs(o.prefix_list_ids).map((v) => ({ kind: 'pl' as const, v })),
      ...(typeof o.source_security_group_id === 'string' ? [{ kind: 'sg' as const, v: o.source_security_group_id }] : []),
      ...(o.self === true && typeof o.security_group_id === 'string' ? [{ kind: 'sg' as const, v: o.security_group_id }] : []),
    ])
  }
  const d = RULE_TYPES[type] ?? 'ingress'
  return make(d, o.ip_protocol, o.from_port, o.to_port, [
    ...(typeof o.cidr_ipv4 === 'string' ? [{ kind: 'cidr4' as const, v: o.cidr_ipv4 }] : []),
    ...(typeof o.cidr_ipv6 === 'string' ? [{ kind: 'cidr6' as const, v: o.cidr_ipv6 }] : []),
    ...(typeof o.referenced_security_group_id === 'string' ? [{ kind: 'sg' as const, v: o.referenced_security_group_id }] : []),
    ...(typeof o.prefix_list_id === 'string' ? [{ kind: 'pl' as const, v: o.prefix_list_id }] : []),
  ])
}

// Everything the cloud holds for the group in one direction.
export function effectiveRules(reality: Reality, groupId: string, dir: Direction): SgRule[] {
  const out: SgRule[] = []
  const group = reality[realityKey('aws_security_group', groupId)]
  if (group && Array.isArray(group[dir])) for (const e of group[dir] as Value[]) if (isObj(e)) out.push(...rulesOf('aws_security_group', e, dir, groupId))
  for (const k of Object.keys(reality).sort()) {
    const type = k.slice(0, k.indexOf(':'))
    const o = reality[k]
    if (!isRuleType(type) || o.security_group_id !== groupId) continue
    out.push(...rulesOf(type, o).filter((r) => r.dir === dir))
  }
  return out
}

export const sameRule = (a: SgRule, b: SgRule) => a.dir === b.dir && a.proto === b.proto && a.from === b.from && a.to === b.to && a.src.kind === b.src.kind && a.src.v === b.src.v

const PEER = (r: SgRule) => (r.src.kind === 'pl' ? `pl: ${r.src.v}` : `peer: ${r.src.v}`)
// ponytail: wording unverified (CONTENT_TODO); the real text names the rule in the SDK's own format.
export function ruleDuplicate(type: string, o: Record<string, Value>, reality: Reality, requestId: string): string | undefined {
  const gid = o.security_group_id
  if (typeof gid !== 'string') return undefined
  const have = (dir: Direction) => effectiveRules(reality, gid, dir)
  for (const r of rulesOf(type, o)) {
    if (!have(r.dir).some((x) => sameRule(x, r))) continue
    const proto = r.proto === '-1' ? 'ALL' : r.proto.toUpperCase()
    const ports = r.proto === '-1' ? '' : `, from port: ${r.from}, to port: ${r.to}`
    const call = r.dir === 'ingress' ? 'AuthorizeSecurityGroupIngress' : 'AuthorizeSecurityGroupEgress'
    const what = type === 'aws_security_group_rule' ? 'Security Group Rule' : `VPC Security Group ${r.dir === 'ingress' ? 'Ingress' : 'Egress'} Rule`
    return `creating ${what}: operation error EC2: ${call}, https response error StatusCode: 400, RequestID: ${requestId}, api error InvalidPermission.Duplicate: the specified rule "${PEER(r)}, ${proto}${ports}, ALLOW" already exists`
  }
  return undefined
}

// Does any rule on the group match? port is covered by the rule's range (exact: the rule is for that one port and protocol); source_group_id / cidr ('*': any CIDR) narrow the peer.
export function groupHasRule(reality: Reality, q: { group_id: string; direction: Direction; port: number; protocol?: string; exact?: boolean; source_group_id?: string; cidr?: string }): boolean {
  const proto = normProto(q.protocol)
  return effectiveRules(reality, q.group_id, q.direction).some(
    (r) =>
      (q.exact ? r.proto === proto && r.from === q.port && r.to === q.port : (r.proto === '-1' || r.proto === proto) && r.from <= q.port && q.port <= r.to) &&
      (q.source_group_id === undefined || (r.src.kind === 'sg' && r.src.v === q.source_group_id)) &&
      (q.cidr === undefined || ((r.src.kind === 'cidr4' || r.src.kind === 'cidr6') && (q.cidr === '*' || r.src.v === q.cidr))),
  )
}

// Is every rule on the group (this direction; covering `port` when given, else all) from one of the allowed peers? No rule at all is true: pair with sg_rule to require one.
export function groupOnly(reality: Reality, q: { group_id: string; direction: Direction; port?: number; protocol?: string; cidrs?: string[]; source_group_ids?: string[] }): boolean {
  if (!Object.hasOwn(reality, realityKey('aws_security_group', q.group_id))) return false
  const proto = normProto(q.protocol)
  return effectiveRules(reality, q.group_id, q.direction)
    .filter((r) => q.port === undefined || ((r.proto === '-1' || r.proto === proto) && r.from <= q.port && q.port <= r.to))
    .every((r) => ((r.src.kind === 'cidr4' || r.src.kind === 'cidr6') && !!q.cidrs?.includes(r.src.v)) || (r.src.kind === 'sg' && !!q.source_group_ids?.includes(r.src.v)))
}

export const MIXED_SUMMARY = 'Security group rules are managed twice'

// A group that writes ingress/egress inline while a separate rule resource manages rules for it: the AWS provider
// treats the inline set as the whole truth for the group, so each apply of one undoes the other.
// The real provider says nothing at plan time (it just keeps showing a diff); the lab warns, and plan_clean refuses it.
export function mixedRules(nodes: Map<string, GNode>): Diagnostic[] {
  const out: Diagnostic[] = []
  const rules = [...nodes.values()].filter((n) => n.kind === 'resource' && n.block && isRuleType(n.block.labels[0])).sort((a, b) => a.address.localeCompare(b.address))
  const byGroup = new Map<string, GNode[]>()
  for (const n of rules) {
    const refs: Ref[] = []
    for (const a of n.block!.attrs) if (a.name === 'security_group_id') exprRefs(a.value, refs)
    for (const r of refs) {
      if (r.path.length < 2) continue
      const addr = `${n.module ? `${n.module}.` : ''}${r.path[0]}.${r.path[1]}`
      byGroup.set(addr, [...(byGroup.get(addr) ?? []), n])
    }
  }
  for (const [addr, owned] of [...byGroup].sort(([a], [b]) => a.localeCompare(b))) {
    const g = nodes.get(addr)
    if (!g?.block || g.block.labels[0] !== 'aws_security_group') continue
    const inline = g.block.blocks.some((b) => b.type === 'ingress' || b.type === 'egress' || (b.type === 'dynamic' && (b.labels[0] === 'ingress' || b.labels[0] === 'egress'))) || g.block.attrs.some((a) => a.name === 'ingress' || a.name === 'egress')
    if (!inline) continue
    out.push({
      severity: 'warning',
      summary: MIXED_SUMMARY,
      detail: `${addr} defines ingress or egress rules inline, and ${owned.map((n) => n.address).join(', ')} also manage${owned.length === 1 ? 's' : ''} rules for it. The AWS provider treats the inline rules as the group's complete rule set, so applying one overwrites what the other created. Manage each group's rules one way only: all inline, or all as separate rule resources with no ingress or egress in the group. Rules already on a group are not revoked just because its ingress or egress arguments are deleted from the configuration: set ingress = [] and egress = [] and apply to clear them, then remove those arguments.`,
      file: g.file,
      line: g.block.pos.line,
      col: g.block.pos.col,
      context: `resource "aws_security_group" "${g.block.labels[1]}"`,
    })
  }
  return out
}
