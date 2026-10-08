import { describe, expect, it } from 'vitest'
import type { Value } from '../src/game/terraform/eval.ts'
import { evalPredicate, type Predicate, type World } from '../src/game/terraform/predicates.ts'
import { planConfig } from '../src/game/terraform/plan.ts'
import { realityKey, type Reality } from '../src/game/terraform/refresh.ts'
import { emptyState, type State } from '../src/game/terraform/state.ts'

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]'
const VPC = { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1' }
const stateOf = (...seeds: { type: string; name: string; key?: string; attrs: Record<string, Value> }[]): State => {
  const s = emptyState()
  for (const x of seeds) {
    let r = s.resources.find((r) => r.type === x.type && r.name === x.name)
    if (!r) s.resources.push((r = { mode: 'managed', type: x.type, name: x.name, provider: AWS, instances: [] }))
    r.instances.push({ ...(x.key === undefined ? {} : { index_key: x.key }), attributes: x.attrs })
  }
  return s
}
const CFG = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const world = (o: { tf?: string; state?: State; reality?: Reality; lock?: object; history?: string[]; files?: Record<string, string>; plan?: World['plan'] } = {}): World & { calls: number } => {
  const state = o.state ?? stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC })
  const reality = o.reality ?? { [realityKey('aws_vpc', 'vpc-1')]: VPC }
  const files = new Map(Object.entries(o.files ?? {}))
  const w = {
    state,
    reality,
    ...(o.lock ? { lock: o.lock } : {}),
    history: o.history ?? [],
    calls: 0,
    plan() {
      w.calls++
      return o.plan ? o.plan() : planConfig({ files: [{ name: 'main.tf', text: o.tf ?? CFG }], state, reality, vars: {} })
    },
    readFile: async (p: string) => files.get(p),
  }
  return w
}
const ev = (p: Predicate, w: World = world()) => evalPredicate(p, w)

describe('predicates', () => {
  it('plan_clean', async () => {
    expect(await ev({ plan_clean: true })).toBe(true)
    expect(await ev({ plan_clean: true }, world({ state: emptyState(), reality: {} }))).toBe(false)
    expect(await ev({ plan_clean: true }, world({ plan: () => undefined }))).toBe(false)
    expect(await ev({ plan_clean: true }, world({ tf: 'resource "aws_vpc" "main" {' }))).toBe(false)
  })
  it('plan_has.no_destroy', async () => {
    const upd = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  enable_dns_hostnames = true\n}\n'
    const rep = 'resource "aws_vpc" "main" {\n  cidr_block = "10.1.0.0/16"\n}\n'
    expect(await ev({ plan_has: { no_destroy: ['aws_vpc.main'] } }, world({ tf: upd }))).toBe(true)
    expect(await ev({ plan_has: { no_destroy: ['aws_vpc.main'] } }, world({ tf: rep }))).toBe(false)
    expect(await ev({ plan_has: { no_destroy: ['aws_s3_bucket.x'] } }, world({ tf: rep }))).toBe(true)
    expect(await ev({ plan_has: { no_destroy: ['aws_vpc.main'] } }, world({ tf: '' }))).toBe(false)
    expect(await ev({ plan_has: { no_destroy: [] } }, world({ plan: () => undefined }))).toBe(false)
    expect(await ev({ plan_has: { no_destroy: [] } }, world({ tf: 'resource "aws_vpc" "main" {' }))).toBe(false)
  })
  it('state_has / state_lacks, instance vs resource address', async () => {
    const w = world({ state: stateOf({ type: 'aws_s3_bucket', name: 'b', key: 'x', attrs: { id: 'x' } }) })
    expect(await ev({ state_has: 'aws_s3_bucket.b["x"]' }, w)).toBe(true)
    expect(await ev({ state_has: 'aws_s3_bucket.b' }, w)).toBe(true)
    expect(await ev({ state_has: 'aws_s3_bucket.b["y"]' }, w)).toBe(false)
    expect(await ev({ state_has: 'aws_s3_bucket.bb' }, w)).toBe(false)
    expect(await ev({ state_lacks: 'aws_s3_bucket.b' }, w)).toBe(false)
    expect(await ev({ state_lacks: 'aws_s3_bucket.c' }, w)).toBe(true)
  })
  it('lock_free', async () => {
    expect(await ev({ lock_free: true })).toBe(true)
    expect(await ev({ lock_free: true }, world({ lock: { id: 'l' } }))).toBe(false)
  })
  it('reality_has / reality_lacks', async () => {
    expect(await ev({ reality_has: { type: 'aws_vpc', id: 'vpc-1' } })).toBe(true)
    expect(await ev({ reality_has: { type: 'aws_vpc', id: 'vpc-2' } })).toBe(false)
    expect(await ev({ reality_has: { type: 'aws_vpc', id: 'vpc-1', attr: 'cidr_block', equals: '10.0.0.0/16' } })).toBe(true)
    expect(await ev({ reality_has: { type: 'aws_vpc', id: 'vpc-1', attr: 'cidr_block', equals: 'x' } })).toBe(false)
    const tagged = world({ reality: { [realityKey('aws_vpc', 'vpc-1')]: { ...VPC, tags: { a: '1' } } } })
    expect(await ev({ reality_has: { type: 'aws_vpc', id: 'vpc-1', attr: 'tags', equals: { a: '1' } } }, tagged)).toBe(true)
    expect(await ev({ reality_has: { type: 'aws_vpc', id: 'vpc-1', attr: 'tags', equals: { a: '2' } } }, tagged)).toBe(false)
    expect(await ev({ reality_has: { type: 'aws_vpc', id: 'vpc-1', attr: 'nope', equals: null } })).toBe(false)
    expect(await ev({ reality_has: { type: 'aws_vpc', id: 'vpc-1', attr: 'nope' } })).toBe(false)
    expect(await ev({ reality_has: { type: 'aws_vpc', id: 'vpc-1', attr: 'id' } })).toBe(true)
    expect(await ev({ reality_lacks: { type: 'aws_vpc', id: 'vpc-2' } })).toBe(true)
    expect(await ev({ reality_lacks: { type: 'aws_vpc', id: 'vpc-1' } })).toBe(false)
  })
  it('applied', async () => {
    const w = world({ history: ['create aws_s3_bucket.b["x"]', 'delete aws_vpc.main'] })
    expect(await ev({ applied: { op: 'create', address: 'aws_s3_bucket.b["x"]' } }, w)).toBe(true)
    expect(await ev({ applied: { op: 'create', address: 'aws_s3_bucket.b' } }, w)).toBe(true)
    expect(await ev({ applied: { op: 'create', address: 'aws_s3_bucket.b["y"]' } }, w)).toBe(false)
    expect(await ev({ applied: { op: 'update', address: 'aws_s3_bucket.b' } }, w)).toBe(false)
    expect(await ev({ applied: { op: 'delete', address: 'aws_vpc.main' } }, w)).toBe(true)
    expect(await ev({ applied: { op: 'delete', address: 'aws_vpc.mai' } }, w)).toBe(false)
  })
  it('file_contains', async () => {
    const w = world({ files: { 'main.tf': 'a\nretention = 7\n' } })
    expect(await ev({ file_contains: { path: 'main.tf', matches: '^retention = 7$' } }, w)).toBe(true)
    expect(await ev({ file_contains: { path: 'main.tf', matches: '^retention = 8$' } }, w)).toBe(false)
    expect(await ev({ file_contains: { path: 'main.tf', matches: '(' } }, w)).toBe(false)
    expect(await ev({ file_contains: { path: 'nope.tf', matches: '.' } }, w)).toBe(false)
  })
  it('not / all / any', async () => {
    const t = { lock_free: true } as const
    const f = { state_has: 'aws_nope.x' }
    expect(await ev({ not: f })).toBe(true)
    expect(await ev({ not: t })).toBe(false)
    expect(await ev({ all: [t, { not: f }] })).toBe(true)
    expect(await ev({ all: [t, f] })).toBe(false)
    expect(await ev({ any: [f, t] })).toBe(true)
    expect(await ev({ any: [f, { not: t }] })).toBe(false)
    expect(await ev({ all: [] })).toBe(true)
    expect(await ev({ any: [] })).toBe(false)
  })
  it('plans at most once per evaluation, and not at all when unused', async () => {
    const w = world()
    await ev({ all: [{ plan_clean: true }, { plan_has: { no_destroy: ['aws_vpc.main'] } }, { not: { plan_clean: true } }] }, w)
    expect(w.calls).toBe(1)
    const w2 = world()
    await ev({ lock_free: true }, w2)
    expect(w2.calls).toBe(0)
  })
  it('does not mutate the world', async () => {
    const w = world({ history: ['create aws_vpc.main'] })
    const before = structuredClone({ s: w.state, r: w.reality, h: w.history })
    await ev({ all: [{ plan_clean: true }, { applied: { op: 'create', address: 'aws_vpc.main' } }] }, w)
    expect({ s: w.state, r: w.reality, h: w.history }).toEqual(before)
  })
  it('is false, not a rejection, for malformed input', async () => {
    expect(await ev({ all: null } as never)).toBe(false)
    expect(await ev({ any: [{ applied: null }] } as never)).toBe(false)
    expect(await ev({} as never)).toBe(false)
  })
})
