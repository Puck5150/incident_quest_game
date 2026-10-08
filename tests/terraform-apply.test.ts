import { describe, expect, it } from 'vitest'
import { executeApply, type ApplyContext, type Fault } from '../src/game/terraform/apply.ts'
import type { Value } from '../src/game/terraform/eval.ts'
import { realityKey, type Reality } from '../src/game/terraform/refresh.ts'
import { emptyState, findInstance, listAddresses, type State } from '../src/game/terraform/state.ts'

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]'
type Seed = { type: string; name: string; key?: string | number; attrs: Record<string, Value>; deps?: string[] }
const stateOf = (...seeds: Seed[]): State => {
  const s = emptyState()
  for (const x of seeds) {
    let r = s.resources.find((r) => r.type === x.type && r.name === x.name)
    if (!r) {
      r = { mode: 'managed', type: x.type, name: x.name, provider: AWS, instances: [] }
      s.resources.push(r)
    }
    r.instances.push({ ...(x.key === undefined ? {} : { index_key: x.key }), attributes: x.attrs, ...(x.deps ? { dependencies: x.deps } : {}) })
  }
  return s
}
const cloudOf = (state: State): Reality =>
  Object.fromEntries(state.resources.flatMap((r) => r.instances.map((i) => [realityKey(r.type, i.attributes.id as string), structuredClone(i.attributes)] as const)))
const ctx = (o: Partial<ApplyContext> = {}): ApplyContext => ({ faults: [], taken: new Set(), attempts: new Map(), seed: '1', ...o })
const run = (tf: string, o: { state?: State; reality?: Reality; vars?: Record<string, Value>; ctx?: Partial<ApplyContext> } = {}) => {
  const state = o.state ?? emptyState()
  return executeApply({ files: [{ name: 'main.tf', text: tf }], state, reality: o.reality ?? cloudOf(state), vars: o.vars ?? {} }, ctx(o.ctx))
}
const ops = (r: { steps: { op: string; address: string; ok: boolean }[] }) => r.steps.map((s) => `${s.ok ? '' : '!'}${s.op} ${s.address}`)

const NETWORK = (cidr: string) => `
resource "aws_vpc" "main" {
  cidr_block = "${cidr}"
}
resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}
`
const VPC = { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1' }
const SUBNET = { id: 'subnet-1', arn: 'arn:subnet-1', vpc_id: 'vpc-1', cidr_block: '10.0.1.0/24', availability_zone: 'us-east-1a', map_public_ip_on_launch: false }
const both = () => stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_subnet', name: 'a', attrs: SUBNET, deps: ['aws_vpc.main'] })

describe('executeApply: create', () => {
  it('creates in dependency order, with real values flowing to dependents', () => {
    const r = run(NETWORK('10.0.0.0/16'))
    expect(r.errors).toEqual([])
    expect(ops(r)).toEqual(['create aws_vpc.main', 'create aws_subnet.a'])
    expect(r.counts).toEqual({ imported: 0, added: 2, changed: 0, destroyed: 0 })
    const vpc = findInstance(r.state, 'aws_vpc.main')!.instance
    const subnet = findInstance(r.state, 'aws_subnet.a')!.instance
    expect(vpc.attributes.id).toMatch(/^vpc-0[0-9a-f]{8}$/)
    expect(subnet.attributes.vpc_id).toBe(vpc.attributes.id)
    expect(subnet.dependencies).toEqual(['aws_vpc.main'])
    expect(r.reality[realityKey('aws_subnet', subnet.attributes.id as string)]).toEqual(subnet.attributes)
    expect(r.state.serial).toBe(1)
    expect(r.steps.map((s) => s.seconds)).toEqual([1, 1])
    expect(r.steps[0].id).toBe(vpc.attributes.id)
  })

  it('is deterministic, and applying again after a clean apply does nothing', () => {
    const a = run(NETWORK('10.0.0.0/16'))
    expect(run(NETWORK('10.0.0.0/16')).state).toEqual(a.state)
    const again = executeApply({ files: [{ name: 'main.tf', text: NETWORK('10.0.0.0/16') }], state: a.state, reality: a.reality, vars: {} }, ctx())
    expect(again.steps).toEqual([])
    expect(again.counts).toEqual({ imported: 0, added: 0, changed: 0, destroyed: 0 })
    expect(again.state.serial).toBe(a.state.serial)
  })

  it('does not mutate its inputs', () => {
    const state = both()
    const reality = cloudOf(state)
    const copy = structuredClone([state, reality])
    run(NETWORK('10.9.0.0/16'), { state, reality })
    expect([state, reality]).toEqual(copy)
  })

  it('fills outputs from real values after a clean apply', () => {
    const r = run(NETWORK('10.0.0.0/16') + 'output "subnet" {\n  value = aws_subnet.a.id\n}\noutput "secret" {\n  value = "x"\n  sensitive = true\n}\n')
    expect(r.state.outputs.subnet.value).toBe(findInstance(r.state, 'aws_subnet.a')!.instance.attributes.id)
    expect(r.state.outputs.secret).toEqual({ value: 'x', sensitive: true })
  })
})

describe('executeApply: update, replace, destroy', () => {
  it('updates in place', () => {
    const r = run('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  enable_dns_hostnames = true\n}\n', { state: stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }) })
    expect(ops(r)).toEqual(['update aws_vpc.main'])
    expect(r.counts).toEqual({ imported: 0, added: 0, changed: 1, destroyed: 0 })
    expect(findInstance(r.state, 'aws_vpc.main')!.instance.attributes).toMatchObject({ id: 'vpc-1', enable_dns_hostnames: true })
    expect(r.reality[realityKey('aws_vpc', 'vpc-1')]).toMatchObject({ enable_dns_hostnames: true })
  })

  it('replaces a resource and its dependents in the right order, wiring the new ids', () => {
    const r = run(NETWORK('10.1.0.0/16'), { state: both() })
    expect(r.errors).toEqual([])
    expect(ops(r)).toEqual(['delete aws_subnet.a', 'delete aws_vpc.main', 'create aws_vpc.main', 'create aws_subnet.a'])
    expect(r.counts).toEqual({ imported: 0, added: 2, changed: 0, destroyed: 2 })
    const vpc = findInstance(r.state, 'aws_vpc.main')!.instance.attributes
    expect(vpc.id).not.toBe('vpc-1')
    expect(vpc.cidr_block).toBe('10.1.0.0/16')
    expect(findInstance(r.state, 'aws_subnet.a')!.instance.attributes.vpc_id).toBe(vpc.id)
    expect(Object.keys(r.reality).sort()).toEqual([realityKey('aws_subnet', findInstance(r.state, 'aws_subnet.a')!.instance.attributes.id as string), realityKey('aws_vpc', vpc.id as string)].sort())
  })

  it('destroys what is no longer configured, dependents first (from state dependencies)', () => {
    const r = run('# none\n', { state: both() })
    expect(ops(r)).toEqual(['delete aws_subnet.a', 'delete aws_vpc.main'])
    expect(r.state.resources).toEqual([])
    expect(r.reality).toEqual({})
    expect(r.counts.destroyed).toBe(2)
  })

  it('forgets without touching the cloud, and applies moved blocks', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'old', attrs: VPC })
    const forgot = run('removed {\n  from = aws_vpc.old\n  lifecycle {\n    destroy = false\n  }\n}\n', { state })
    expect(ops(forgot)).toEqual(['forget aws_vpc.old'])
    expect(forgot.state.resources).toEqual([])
    expect(forgot.reality[realityKey('aws_vpc', 'vpc-1')]).toBeDefined()
    const moved = run('resource "aws_vpc" "new" {\n  cidr_block = "10.0.0.0/16"\n}\nmoved {\n  from = aws_vpc.old\n  to   = aws_vpc.new\n}\n', { state })
    expect(listAddresses(moved.state)).toEqual(['aws_vpc.new'])
    expect(moved.steps).toEqual([])
  })

  it('brings a drifted cloud back to the configuration, persisting the refresh first', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: { ...VPC, tags: { Name: 'main' }, tags_all: { Name: 'main' } } })
    const reality = cloudOf(state)
    reality[realityKey('aws_vpc', 'vpc-1')] = { ...VPC, tags: { Name: 'main', Owner: 'ops' }, tags_all: { Name: 'main', Owner: 'ops' } }
    const r = run('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  tags = { Name = "main" }\n}\n', { state, reality })
    expect(ops(r)).toEqual(['update aws_vpc.main'])
    expect(r.reality[realityKey('aws_vpc', 'vpc-1')]).toMatchObject({ tags: { Name: 'main' } })
    expect(r.plan.drift).toHaveLength(1)
  })
})

describe('executeApply: failures', () => {
  it('stops at a dependency violation and does not attempt what depends on the failure', () => {
    const state = both()
    const reality = cloudOf(state)
    reality[realityKey('aws_network_interface', 'eni-1')] = { id: 'eni-1', subnet_id: 'subnet-1' }
    const r = run('# none\n', { state, reality })
    expect(ops(r)).toEqual(['!delete aws_subnet.a'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ severity: 'error', address: 'aws_subnet.a' })
    expect(r.errors[0].summary).toContain("api error DependencyViolation: The subnet 'subnet-1' has dependencies and cannot be deleted.")
    expect(listAddresses(r.state)).toEqual(['aws_subnet.a', 'aws_vpc.main'])
    expect(Object.keys(r.reality)).toHaveLength(3)
    expect(r.counts.destroyed).toBe(0)
  })

  it('fails to create something that already exists, changing nothing', () => {
    const tf = 'resource "aws_s3_bucket" "b" {\n  bucket = "legacy"\n}\n'
    const reality: Reality = { [realityKey('aws_s3_bucket', 'legacy')]: { id: 'legacy', arn: 'arn:aws:s3:::legacy', bucket: 'legacy' } }
    const r = run(tf, { reality })
    expect(ops(r)).toEqual(['!create aws_s3_bucket.b'])
    expect(r.errors[0].summary).toMatch(/^creating S3 Bucket \(legacy\):.*BucketAlreadyOwnedByYou/)
    expect(r.errors[0]).toMatchObject({ file: 'main.tf', line: 1, context: 'resource "aws_s3_bucket" "b"', address: 'aws_s3_bucket.b' })
    expect(r.state.resources).toEqual([])
    expect(r.reality).toEqual(reality)
  })

  it('imports the existing object instead, and the next apply is clean', () => {
    const tf = 'resource "aws_s3_bucket" "b" {\n  bucket = "legacy"\n}\nimport {\n  to = aws_s3_bucket.b\n  id = "legacy"\n}\n'
    const reality: Reality = { [realityKey('aws_s3_bucket', 'legacy')]: { id: 'legacy', arn: 'arn:aws:s3:::legacy', bucket: 'legacy', force_destroy: false } }
    const r = run(tf, { reality })
    expect(r.errors).toEqual([])
    expect(ops(r)).toEqual(['import aws_s3_bucket.b'])
    expect(r.counts).toEqual({ imported: 1, added: 0, changed: 0, destroyed: 0 })
    expect(findInstance(r.state, 'aws_s3_bucket.b')!.instance.attributes.id).toBe('legacy')
    const again = executeApply({ files: [{ name: 'main.tf', text: tf }], state: r.state, reality: r.reality, vars: {} }, ctx())
    expect(again.steps).toEqual([])
  })

  it('keeps going with independent resources after one fails, and leaves a half-applied world', () => {
    const tf = NETWORK('10.0.0.0/16') + 'resource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n'
    const faults: Fault[] = [{ at: 'aws_vpc.main', on: 'create', error: 'creating EC2 VPC: operation error EC2: CreateVpc, https response error StatusCode: 400, api error VpcLimitExceeded: The maximum number of VPCs has been reached.' }]
    const r = run(tf, { ctx: { faults } })
    expect(ops(r)).toEqual(['create aws_s3_bucket.logs', '!create aws_vpc.main'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].summary).toContain('VpcLimitExceeded')
    expect(listAddresses(r.state)).toEqual(['aws_s3_bucket.logs'])
    expect(r.counts.added).toBe(1)
    expect(r.state.outputs).toEqual({})
  })

  it('applies partway: the dependency succeeds and the dependent fails', () => {
    const faults: Fault[] = [{ at: 'aws_subnet.a', on: 'create', error: "creating EC2 Subnet: api error InvalidSubnet.Conflict: The CIDR '10.0.1.0/24' conflicts with another subnet" }]
    const r = run(NETWORK('10.0.0.0/16'), { ctx: { faults } })
    expect(ops(r)).toEqual(['create aws_vpc.main', '!create aws_subnet.a'])
    expect(listAddresses(r.state)).toEqual(['aws_vpc.main'])
    const next = executeApply({ files: [{ name: 'main.tf', text: NETWORK('10.0.0.0/16') }], state: r.state, reality: r.reality, vars: {} }, ctx())
    expect(ops(next)).toEqual(['create aws_subnet.a'])
  })
})

describe('executeApply: scripted faults', () => {
  const create = 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n'
  const err = 'creating S3 Bucket (x): AccessDenied'

  it('fires a limited number of times across runs, with the attempts persisted by the caller', () => {
    const c = ctx({ faults: [{ at: 'aws_s3_bucket.b', on: 'create', error: err, times: 1 }] })
    const first = executeApply({ files: [{ name: 'main.tf', text: create }], state: emptyState(), reality: {}, vars: {} }, c)
    expect(ops(first)).toEqual(['!create aws_s3_bucket.b'])
    expect(c.attempts.get(0)).toBe(1)
    const second = executeApply({ files: [{ name: 'main.tf', text: create }], state: first.state, reality: first.reality, vars: {} }, c)
    expect(ops(second)).toEqual(['create aws_s3_bucket.b'])
  })

  it('is conditional on an attribute value and on actions taken', () => {
    const big = 'resource "aws_instance" "w" {\n  ami = "ami-1"\n  instance_type = "m5.24xlarge"\n}\n'
    const small = big.replace('m5.24xlarge', 't3.micro')
    const fault: Fault = { at: 'aws_instance.w', on: 'create', error: 'creating EC2 Instance: InsufficientInstanceCapacity', if: { attr: 'instance_type', equals: 'm5.24xlarge' } }
    expect(ops(run(big, { ctx: { faults: [fault] } }))).toEqual(['!create aws_instance.w'])
    expect(ops(run(small, { ctx: { faults: [fault] } }))).toEqual(['create aws_instance.w'])
    const gated: Fault = { at: 'aws_instance.w', on: 'create', error: 'creating EC2 Instance: UnauthorizedOperation', until_actions: ['attach-policy'] }
    expect(ops(run(small, { ctx: { faults: [gated] } }))).toEqual(['!create aws_instance.w'])
    expect(ops(run(small, { ctx: { faults: [gated], taken: new Set(['attach-policy']) } }))).toEqual(['create aws_instance.w'])
  })

  it('matches instance addresses and resource addresses, and the operation', () => {
    const many = 'resource "aws_s3_bucket" "b" {\n  for_each = toset(["a", "b"])\n  bucket = "bk-${each.key}"\n}\n'
    expect(ops(run(many, { ctx: { faults: [{ at: 'aws_s3_bucket.b["b"]', on: 'create', error: 'boom' }] } }))).toEqual(['create aws_s3_bucket.b["a"]', '!create aws_s3_bucket.b["b"]'])
    expect(ops(run(many, { ctx: { faults: [{ at: 'aws_s3_bucket.b', on: 'create', error: 'boom' }] } }))).toEqual(['!create aws_s3_bucket.b["a"]', '!create aws_s3_bucket.b["b"]'])
    expect(ops(run(many, { ctx: { faults: [{ at: 'aws_s3_bucket.b', on: 'delete', error: 'boom' }] } }))).toEqual(['create aws_s3_bucket.b["a"]', 'create aws_s3_bucket.b["b"]'])
  })

  it('reports configuration errors without executing anything', () => {
    const r = run('resource "aws_vpc" "main" {\n  cidr_block\n}\n')
    expect(r.steps).toEqual([])
    expect(r.errors[0].summary).toBe('Argument or block definition required')
  })
})
