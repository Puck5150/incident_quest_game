// The sg_only and config_matches predicate leaves.
import { describe, expect, it } from 'vitest'
import { evalPredicate, stripHclComments, type Predicate, type World } from '../src/game/terraform/predicates.ts'
import { realityKey, type Reality } from '../src/game/terraform/refresh.ts'
import type { Value } from '../src/game/terraform/eval.ts'
import { emptyState } from '../src/game/terraform/state.ts'
import { LeafSchema } from '../src/schema/scenario.ts'

const G = 'sg-0a'
const group = (ingress: object[]): Reality => ({ [realityKey('aws_security_group', G)]: { id: G, ingress: ingress as Value[] } })
const rule = (cidr: string, port = 8443) => ({ cidr_blocks: [cidr], from_port: port, to_port: port, protocol: 'tcp' })
const w = (reality: Reality, files: Record<string, string> = {}): World => ({
  state: emptyState(),
  reality,
  history: [],
  plan: () => undefined,
  readFile: async () => undefined,
  listFiles: async () => Object.entries(files).map(([name, text]) => ({ name, text })),
})
const only = (reality: Reality, extra: object = {}) => evalPredicate({ sg_only: { group_id: G, direction: 'ingress', cidrs: ['10.0.0.0/16', '198.51.100.16/28'], ...extra } } as Predicate, w(reality))

describe('sg_only', () => {
  it('is true when every rule comes from a listed peer, and false for any other source', async () => {
    expect(await only(group([rule('10.0.0.0/16', 443), rule('198.51.100.16/28')]))).toBe(true)
    expect(await only(group([rule('10.0.0.0/16', 443), rule('198.51.100.16/28'), rule('198.51.100.0/25')]))).toBe(false)
    expect(await only(group([rule('198.51.100.16/28'), rule('0.0.0.0/0', 22)]))).toBe(false)
    expect(await only(group([rule('198.51.100.16/28'), { ipv6_cidr_blocks: ['::/0'], from_port: 22, to_port: 22, protocol: 'tcp' }]))).toBe(false)
    expect(await only(group([{ security_groups: ['sg-other'], from_port: 8443, to_port: 8443, protocol: 'tcp' }]))).toBe(false)
    expect(await only(group([{ security_groups: ['sg-other'], from_port: 8443, to_port: 8443, protocol: 'tcp' }]), { source_group_ids: ['sg-other'] })).toBe(true)
  })
  it('with a port, only the rules covering that port count; an all-protocols rule covers every port', async () => {
    expect(await only(group([rule('0.0.0.0/0', 22), rule('198.51.100.16/28')]), { port: 8443 })).toBe(true)
    expect(await only(group([rule('198.51.100.16/28'), { cidr_blocks: ['0.0.0.0/0'], from_port: 0, to_port: 0, protocol: '-1' }]), { port: 8443 })).toBe(false)
    expect(await only(group([rule('198.51.100.16/28'), { cidr_blocks: ['203.0.113.0/24'], from_port: 8000, to_port: 9000, protocol: 'tcp' }]), { port: 8443 })).toBe(false)
  })
  it('is false for an unknown group, true for a known group with no rules, and the schema wants a peer list', async () => {
    expect(await only({})).toBe(false)
    expect(await only(group([]))).toBe(true)
    expect(LeafSchema.safeParse({ sg_only: { group_id: G, direction: 'ingress' } }).success).toBe(false)
    expect(LeafSchema.safeParse({ sg_only: { group_id: G, direction: 'ingress', cidrs: ['10.0.0.0/8'] } }).success).toBe(true)
  })
})

describe('config_matches', () => {
  const ev = (files: Record<string, string>, matches: string) => evalPredicate({ config_matches: { dir: '/lab', matches } } as Predicate, w({}, files))
  it('reads any .tf file in the directory and ignores other files', async () => {
    expect(await ev({ 'versions.tf': 'terraform {\n  backend "s3" {}\n}\n' }, 'backend\\s+"s3"')).toBe(true)
    expect(await ev({ 'notes.txt': 'backend "s3"' }, 'backend\\s+"s3"')).toBe(false)
    expect(await ev({}, 'x')).toBe(false)
  })
  it('does not see comments, but keeps # and // inside strings', async () => {
    expect(await ev({ 'a.tf': 'encrypt = false # encrypt = true\n' }, '^[ \\t]*encrypt[ \\t]*=[ \\t]*true[ \\t]*$')).toBe(false)
    expect(await ev({ 'a.tf': '# use_lockfile = true\n// use_lockfile = true\n/* use_lockfile = true\n*/\n' }, 'use_lockfile')).toBe(false)
    expect(await ev({ 'a.tf': 'url = "http://x/#a"\n' }, 'url = "http://x/#a"')).toBe(true)
    expect(stripHclComments('a /* x\ny */ b\n# c\nd')).toBe('a \n b\n\nd')
  })
  it('stays linear on a long hostile file', async () => {
    const big = `backend "s3" {\n${'x'.repeat(200000)}\n`
    const t = Date.now()
    await ev({ 'a.tf': big }, 'backend\\s+"s3"\\s*\\{(?=[^}]*?^[ \\t]*encrypt[ \\t]*=[ \\t]*true[ \\t]*$)')
    expect(Date.now() - t).toBeLessThan(2000)
  })
})
