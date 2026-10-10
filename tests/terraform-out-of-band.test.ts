import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { IncidentShell } from '../src/game/shell.ts'
import { ScenarioSchema, type Scenario } from '../src/schema/scenario.ts'
import { executeApply, type ApplyContext } from '../src/game/terraform/apply.ts'
import { planConfig } from '../src/game/terraform/plan.ts'
import type { Value } from '../src/game/terraform/eval.ts'
import { realityKey, type Reality } from '../src/game/terraform/refresh.ts'
import { emptyState, listAddresses, type State } from '../src/game/terraform/state.ts'

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]'
type Seed = { type: string; name: string; attrs: Record<string, Value> }
const stateOf = (...seeds: Seed[]): State => {
  const s = emptyState()
  for (const x of seeds) s.resources.push({ mode: 'managed', type: x.type, name: x.name, provider: AWS, instances: [{ attributes: x.attrs }] })
  return s
}
const ctx = (): ApplyContext => ({ faults: [], taken: new Set(), attempts: new Map(), seed: '1' })
const run = (tf: string, state: State, reality: Reality, destroy: boolean, refresh = true) =>
  executeApply({ files: [{ name: 'main.tf', text: tf }], state, reality, vars: {}, destroy, refresh }, ctx())

const VPC = { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', tags: {}, tags_all: {} }
const SUBNET = { id: 'subnet-1', arn: 'arn:subnet-1', vpc_id: 'vpc-1', cidr_block: '10.0.1.0/24', tags: {}, tags_all: {} }
const INST = { id: 'i-0abc', arn: 'arn:i-0abc', ami: 'ami-1', instance_type: 't3.micro', tags: {}, tags_all: {} }
const vpcTf = 'resource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const vpcSt = () => stateOf({ type: 'aws_vpc', name: 'v', attrs: VPC })
// A state exactly as an apply of tf leaves it (so a later plan of the same text has no changes).
const applied = (tf: string) => run(tf, emptyState(), {}, false)

describe('out-of-band deletes in the engine', () => {
  it('destroy with refresh plans nothing for a console-deleted object and empties state', () => {
    const r = run(vpcTf, vpcSt(), {}, true)
    expect(r.errors).toEqual([])
    expect(r.plan.items.filter((i) => i.action === 'destroy')).toHaveLength(0)
    expect(r.steps).toEqual([])
    expect(listAddresses(r.state)).toEqual([])
  })
  it('-refresh=false destroy treats the delete as already done', () => {
    const r = run(vpcTf, vpcSt(), {}, true, false)
    expect(r.errors).toEqual([])
    expect(r.steps.map((s) => `${s.ok} ${s.op} ${s.address}`)).toEqual(['true delete aws_vpc.v'])
    expect(r.counts.destroyed).toBe(1)
    expect(listAddresses(r.state)).toEqual([])
  })
  it('-refresh=false update of a vanished EC2 instance is NotFound and blocks dependents', () => {
    const st = stateOf({ type: 'aws_instance', name: 'w', attrs: INST }, { type: 'aws_subnet', name: 's', attrs: SUBNET })
    st.resources[1].instances[0].dependencies = ['aws_instance.w']
    const tf = 'resource "aws_instance" "w" {\n  ami = "ami-1"\n  instance_type = "t3.small"\n}\nresource "aws_subnet" "s" {\n  vpc_id = "vpc-1"\n  cidr_block = "10.0.1.0/24"\n  tags = { n = aws_instance.w.id }\n}\n'
    const r = run(tf, st, { [realityKey('aws_subnet', 'subnet-1')]: SUBNET }, false, false)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].summary).toMatch(/^updating EC2 Instance \(i-0abc\): operation error EC2: ModifyInstanceAttribute, https response error StatusCode: 400, RequestID: [0-9a-f-]{36}, api error InvalidInstanceID\.NotFound: The instance ID 'i-0abc' does not exist$/)
    expect(r.errors[0].address).toBe('aws_instance.w')
    expect(r.steps.map((s) => `${s.ok} ${s.op} ${s.address}`)).toEqual(['false update aws_instance.w'])
    expect(r.counts.changed).toBe(0)
  })
  it('names S3 and generic objects in their own wording', () => {
    const b0 = 'resource "aws_s3_bucket" "b" {\n  bucket = "logs-1"\n}\n'
    const s3 = run(b0.replace('}', '  tags = { a = "b" }\n}'), applied(b0).state, {}, false, false)
    expect(s3.errors[0].summary).toMatch(/^updating S3 Bucket \(logs-1\) tags: .*api error NoSuchBucket: The specified bucket does not exist$/)
    const g = run(vpcTf.replace('}', '  tags = { a = "b" }\n}'), applied(vpcTf).state, {}, false, false)
    expect(g.errors[0].summary).toMatch(/^updating aws_vpc \(vpc-[0-9a-f]+\): .*NotFound/)
  })
  it('-refresh=false plan trusts state and shows no changes for a vanished object', () => {
    const { state } = applied(vpcTf)
    const p = (refresh: boolean) => planConfig({ files: [{ name: 'main.tf', text: vpcTf }], state, reality: {}, vars: {}, refresh })
    expect(p(false).items.filter((i) => i.action !== 'noop')).toEqual([])
    expect(p(true).items.map((i) => i.action)).toEqual(['create'])
  })
})

const base = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@') && !s.stages)!
const fixId = base.actions[0].id
const tfBlock = (tf: Record<string, unknown> = {}) => ({
  dir: '~/infra',
  files: [{ path: 'main.tf', content: 'resource "aws_subnet" "s" {\n  vpc_id     = "vpc-1"\n  cidr_block = "10.0.1.0/24"\n}\n' }],
  state: [{ type: 'aws_subnet', name: 's', attrs: SUBNET }],
  cloud: { add: [{ type: 'aws_network_interface', attrs: { id: 'eni-1', subnet_id: 'subnet-1' } }], release: [{ type: 'aws_network_interface', id: 'eni-1', when_actions: [fixId] }] },
  ...tf,
})
const scenario = (tf = tfBlock()): Scenario => ({ ...structuredClone(base), terminal: { ...structuredClone(base.terminal!), prompt: 'you@laptop:~/infra$', commands: [] }, terraform: tf }) as Scenario
const runWith = async (sh: IncidentShell, s: Scenario, taken: Set<string>, ...lines: string[]) => {
  const out = []
  for (const l of lines) out.push(await sh.run(l, s, taken))
  return out
}

describe('cloud.release', () => {
  const parse = (tf: unknown) => ScenarioSchema.safeParse({ ...structuredClone(base), terraform: tf })
  const issues = (tf: unknown) => {
    const r = parse(tf)
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
  }
  it('validates like faults: known actions, existing objects, strict shape', () => {
    expect(issues(tfBlock())).toEqual([])
    const rel = (o: object) => tfBlock({ cloud: { add: [{ type: 'aws_network_interface', attrs: { id: 'eni-1' } }], release: [{ type: 'aws_network_interface', id: 'eni-1', when_actions: [fixId], ...o }] } })
    expect(issues(rel({ when_actions: ['nope'] })).join()).toMatch(/unknown action "nope"/)
    expect(issues(rel({ id: 'eni-9' })).join()).toMatch(/eni-9/)
    expect(issues(rel({ extra: 1 }))).not.toEqual([])
    expect(issues(rel({ when_actions: [] }))).not.toEqual([])
  })
  it('a subnet blocked by an ENI fails destroy, then succeeds once the action is taken', async () => {
    const s = scenario()
    const sh = new IncidentShell(s)
    const [bad] = await runWith(sh, s, new Set(), 'terraform destroy -auto-approve')
    expect(bad.exitCode).toBe(1)
    expect(bad.output).toContain('DependencyViolation')
    const taken = new Set([fixId])
    await sh.update(s, taken)
    const [ok, again] = await runWith(sh, s, taken, 'terraform destroy -auto-approve', 'terraform destroy -auto-approve')
    expect(ok.exitCode).toBe(0)
    expect(ok.output).toContain('Destroy complete! Resources: 1 destroyed')
    expect(again.exitCode).toBe(0)
  })
  it('is replay-safe: a fresh shell with the action taken sees the same cloud', async () => {
    const s = scenario()
    const taken = new Set([fixId])
    const [a] = await runWith(new IncidentShell(s), s, taken, 'terraform destroy -auto-approve')
    const [b] = await runWith(new IncidentShell(s), s, taken, 'terraform destroy -auto-approve')
    expect(a.exitCode).toBe(0)
    expect(b.output).toBe(a.output)
  })
})

describe('console-deleted object through the shell', () => {
  const gone = () => scenario(tfBlock({ cloud: { delete: [{ type: 'aws_subnet', id: 'subnet-1' }] } }))
  it('destroy after refresh plans nothing to destroy and drops the state entry', async () => {
    const s = gone()
    const [d, list] = await runWith(new IncidentShell(s), s, new Set(), 'terraform destroy -auto-approve', 'terraform state list')
    expect(d.output).toContain('No objects need to be destroyed.')
    expect(d.exitCode).toBe(0)
    expect(list.output).not.toContain('aws_subnet.s')
  })
  it('-refresh=false destroy deletes the already-gone object without error', async () => {
    const s = gone()
    const [d] = await runWith(new IncidentShell(s), s, new Set(), 'terraform destroy -refresh=false -auto-approve')
    expect(d.exitCode).toBe(0)
    expect(d.output).toContain('Destroy complete! Resources: 1 destroyed')
  })
})
