import { describe, expect, it } from 'vitest'
import { UNKNOWN, type Value } from '../src/game/terraform/eval.ts'
import { planConfig, type PlanResult } from '../src/game/terraform/plan.ts'
import { realityKey, type Reality } from '../src/game/terraform/refresh.ts'
import { emptyState, type State } from '../src/game/terraform/state.ts'

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]'
type Seed = { type: string; name: string; key?: string | number; attrs: Record<string, Value>; mode?: 'managed' | 'data'; status?: 'tainted' }
const stateOf = (...seeds: Seed[]): State => {
  const s = emptyState()
  for (const x of seeds) {
    const mode = x.mode ?? 'managed'
    let r = s.resources.find((r) => r.mode === mode && r.type === x.type && r.name === x.name)
    if (!r) {
      r = { mode, type: x.type, name: x.name, provider: AWS, instances: [] }
      s.resources.push(r)
    }
    r.instances.push({ ...(x.key === undefined ? {} : { index_key: x.key }), ...(x.status ? { status: x.status } : {}), attributes: x.attrs })
  }
  return s
}
// A cloud that matches the state exactly.
const cloudOf = (state: State): Reality =>
  Object.fromEntries(state.resources.filter((r) => r.mode === 'managed').flatMap((r) => r.instances.map((i) => [realityKey(r.type, i.attributes.id as string), i.attributes] as const)))

const plan = (tf: string, o: { state?: State; reality?: Reality; vars?: Record<string, Value>; replace?: string[]; destroy?: boolean } = {}): PlanResult => {
  const state = o.state ?? emptyState()
  return planConfig({ files: [{ name: 'main.tf', text: tf }], state, reality: o.reality ?? cloudOf(state), vars: o.vars ?? {}, ...(o.replace ? { replace: o.replace } : {}), ...(o.destroy ? { destroy: true } : {}) })
}
const actions = (r: PlanResult) => r.items.filter((i) => i.action !== 'noop').map((i) => `${i.action} ${i.address}`)

const VPC = { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1' }
const SUBNET = { id: 'subnet-1', arn: 'arn:subnet-1', vpc_id: 'vpc-1', cidr_block: '10.0.1.0/24', availability_zone: 'us-east-1a', map_public_ip_on_launch: false }
const NETWORK = (cidr: string) => `
resource "aws_vpc" "main" {
  cidr_block = "${cidr}"
}
resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}
`
const BUCKET = (n: number) => ({ id: `logs-${n}`, arn: `arn:logs-${n}`, bucket: `logs-${n}`, force_destroy: false })

// drift that a changing object may or may not refer to
describe('planConfig: which drift is shown', () => {
  const vpcState = { type: 'aws_vpc', name: 'main', attrs: { ...VPC, tags: { Name: 'main' }, tags_all: { Name: 'main' } } }
  const drifted = (over: Record<string, Value>, ...extra: Seed[]) => {
    const state = stateOf(vpcState, ...extra)
    const reality = cloudOf(state)
    reality[realityKey('aws_vpc', 'vpc-1')] = { ...vpcState.attrs, ...over }
    return { state, reality }
  }
  const SUBNET_TF = (tags: string, cidr = '10.0.1.0/24') => `
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = "main" }
}
resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "${cidr}"
  ${tags}
}
`
  const subnet = { type: 'aws_subnet', name: 'a', attrs: SUBNET }

  it('keeps the full list in drift, and shows none when the plan only reverts the change', () => {
    const r = plan(SUBNET_TF('', '10.0.1.0/24'), drifted({ tags: { Name: 'main', Owner: 'ops' } }, subnet))
    expect(r.drift).toHaveLength(1)
    expect(r.driftShown).toEqual([])
  })

  it('shows nothing when a changing dependent refers to another attribute than the one that drifted', () => {
    const r = plan(SUBNET_TF('', '10.0.2.0/24'), drifted({ tags: { Name: 'main', Owner: 'ops' } }, subnet))
    expect(actions(r)).toContain('replace aws_subnet.a')
    expect(r.driftShown).toEqual([])
  })

  it('shows only the referenced attributes that drifted', () => {
    const r = plan(SUBNET_TF('tags = { Vpc = aws_vpc.main.cidr_block }'), drifted({ cidr_block: '10.9.0.0/16', tags: { Name: 'main', Owner: 'ops' } }, subnet))
    expect(r.driftShown).toEqual([{ address: 'aws_vpc.main', kind: 'changed', changes: [{ name: 'cidr_block', before: '10.0.0.0/16', after: '10.9.0.0/16' }] }])
  })

  it('follows references through a local', () => {
    const r = plan(`locals {\n  v = aws_vpc.main.cidr_block\n}\n${SUBNET_TF('tags = { Vpc = local.v }')}`, drifted({ cidr_block: '10.9.0.0/16' }, subnet))
    expect(r.driftShown.map((d) => [d.address, d.changes.map((c) => c.name)])).toEqual([['aws_vpc.main', ['cidr_block']]])
  })

  it('treats a reference to the whole resource as a reference to every attribute', () => {
    const r = plan(`${SUBNET_TF('')}\noutput "v" {\n  value = aws_vpc.main\n}`, drifted({ enable_dns_hostnames: true, tags: { Name: 'main', Owner: 'ops' } }))
    expect(r.driftShown.map((d) => d.changes.map((c) => c.name))).toEqual([['enable_dns_hostnames', 'tags']])
  })

  it('shows no drift note for a deleted object the plan creates again, since nothing refers to it', () => {
    const state = stateOf(vpcState, { type: 'aws_s3_bucket', name: 'old', attrs: BUCKET(1) })
    const reality = cloudOf(state)
    delete reality[realityKey('aws_vpc', 'vpc-1')]
    delete reality[realityKey('aws_s3_bucket', 'logs-1')]
    const r = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  tags       = { Name = "main" }\n}', { state, reality })
    expect(r.drift.map((d) => d.address)).toEqual(['aws_vpc.main', 'aws_s3_bucket.old'])
    expect(actions(r)).toContain('create aws_vpc.main')
    expect(r.driftShown).toEqual([])
  })

  it('carries the attributes a plan uses on a deleted object', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_subnet', name: 'a', attrs: SUBNET })
    const reality = cloudOf(state)
    delete reality[realityKey('aws_vpc', 'vpc-1')]
    const r = plan(NETWORK('10.0.0.0/16'), { state, reality })
    expect(r.driftShown).toEqual([{ address: 'aws_vpc.main', kind: 'deleted', changes: [], before: VPC, relevant: ['id'] }])
  })
})

describe('planConfig: single resources and dependencies', () => {
  it('creates everything from an empty state, with dependents seeing unknown ids', () => {
    const r = plan(NETWORK('10.0.0.0/16'))
    expect(r.diagnostics).toEqual([])
    expect(actions(r)).toEqual(['create aws_subnet.a', 'create aws_vpc.main'])
    expect(r.items[0].changes.find((c) => c.name === 'vpc_id')).toMatchObject({ before: undefined, after: UNKNOWN })
    expect(r.summary).toEqual({ add: 2, change: 0, destroy: 0 })
  })

  it('plans no changes when state matches, and dependents see the real ids', () => {
    const r = plan(NETWORK('10.0.0.0/16'), { state: stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_subnet', name: 'a', attrs: SUBNET }) })
    expect(r.diagnostics).toEqual([])
    expect(r.items.map((i) => i.action)).toEqual(['noop', 'noop'])
    expect(r.summary).toEqual({ add: 0, change: 0, destroy: 0 })
  })

  it('cascades a replacement to dependents whose forcing attribute references the replaced resource', () => {
    const r = plan(NETWORK('10.1.0.0/16'), { state: stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_subnet', name: 'a', attrs: SUBNET }) })
    expect(actions(r)).toEqual(['replace aws_subnet.a', 'replace aws_vpc.main'])
    expect(r.items[0].changes.find((c) => c.name === 'vpc_id')).toMatchObject({ before: 'vpc-1', after: UNKNOWN, forcesReplacement: true })
    expect(r.summary).toEqual({ add: 2, change: 0, destroy: 2 })
  })

  it('updates in place when a non-forcing attribute changes', () => {
    const r = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  enable_dns_hostnames = true\n}', { state: stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }) })
    expect(actions(r)).toEqual(['update aws_vpc.main'])
    expect(r.summary).toEqual({ add: 0, change: 1, destroy: 0 })
  })

  it('shows drift and plans to put the resource back as configured', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: { ...VPC, tags: { Name: 'main' }, tags_all: { Name: 'main' } } })
    const reality = cloudOf(state)
    reality[realityKey('aws_vpc', 'vpc-1')] = { ...VPC, tags: { Name: 'main', Owner: 'ops' }, tags_all: { Name: 'main' } }
    const r = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  tags = { Name = "main" }\n}', { state, reality })
    expect(r.drift).toEqual([{ address: 'aws_vpc.main', kind: 'changed', changes: [{ name: 'tags', before: { Name: 'main' }, after: { Name: 'main', Owner: 'ops' } }] }])
    expect(r.items[0]).toMatchObject({ action: 'update', changes: [{ name: 'tags', before: { Name: 'main', Owner: 'ops' }, after: { Name: 'main' } }] })
    // nothing else in the plan refers to the VPC, so the drift is not worth a note
    expect(r.driftShown).toEqual([])
  })

  it('plans a create for something deleted outside Terraform', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC })
    const r = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}', { state, reality: {} })
    expect(r.drift).toEqual([{ address: 'aws_vpc.main', kind: 'deleted', changes: [], before: VPC }])
    expect(actions(r)).toEqual(['create aws_vpc.main'])
  })

  it('destroys what is in state but no longer in the configuration', () => {
    const r = plan('# nothing here\n', { state: stateOf({ type: 'aws_vpc', name: 'old', attrs: VPC }) })
    expect(r.items).toMatchObject([{ address: 'aws_vpc.old', action: 'destroy' }])
    expect(r.items[0].changes.find((c) => c.name === 'cidr_block')).toMatchObject({ before: '10.0.0.0/16', after: null })
    expect(r.summary).toEqual({ add: 0, change: 0, destroy: 1 })
  })

  it('honours ignore_changes, and shows the change without it', () => {
    const tf = (lc: string) => `resource "aws_ecs_service" "web" {\n  name = "web"\n  cluster = "prod"\n  task_definition = "web:1"\n  desired_count = 2\n${lc}}`
    const state = stateOf({ type: 'aws_ecs_service', name: 'web', attrs: { id: 'svc-1', arn: 'arn:svc-1', name: 'web', cluster: 'prod', task_definition: 'web:1', desired_count: 5 } })
    expect(actions(plan(tf('  lifecycle {\n    ignore_changes = [desired_count]\n  }\n'), { state }))).toEqual([])
    expect(plan(tf(''), { state }).items[0]).toMatchObject({ action: 'update', changes: [{ name: 'desired_count', before: 5, after: 2 }] })
  })

  it('compares nested blocks as lists of objects', () => {
    const tf = (to: number) => `resource "aws_security_group" "web" {\n  name = "web"\n  description = "Managed by Terraform"\n  vpc_id = "vpc-1"\n  ingress {\n    from_port = 22\n    to_port = ${to}\n  }\n}`
    const state = stateOf({ type: 'aws_security_group', name: 'web', attrs: { id: 'sg-1', arn: 'a', name: 'web', description: 'Managed by Terraform', vpc_id: 'vpc-1', ingress: [{ from_port: 22, to_port: 22 }] } })
    expect(actions(plan(tf(22), { state }))).toEqual([])
    expect(plan(tf(2222), { state }).items[0]).toMatchObject({ action: 'update', changes: [{ name: 'ingress', after: [{ from_port: 22, to_port: 2222 }] }] })
  })
})

describe('planConfig: count and for_each', () => {
  const COUNTED = 'variable "n" {\n  default = 3\n}\nresource "aws_s3_bucket" "b" {\n  count  = var.n\n  bucket = "logs-${count.index}"\n}\n'

  it('creates count instances with count.index available', () => {
    const r = plan(COUNTED)
    expect(actions(r)).toEqual(['create aws_s3_bucket.b[0]', 'create aws_s3_bucket.b[1]', 'create aws_s3_bucket.b[2]'])
    expect(r.items[1].changes.find((c) => c.name === 'bucket')).toMatchObject({ after: 'logs-1' })
  })

  it('destroys exactly the removed instances when count goes down', () => {
    const state = stateOf(...[0, 1, 2].map((n) => ({ type: 'aws_s3_bucket', name: 'b', key: n, attrs: BUCKET(n) })))
    const r = plan(COUNTED, { state, vars: { n: 2 } })
    expect(actions(r)).toEqual(['destroy aws_s3_bucket.b[2]'])
    expect(r.items.filter((i) => i.action === 'noop').map((i) => i.address)).toEqual(['aws_s3_bucket.b[0]', 'aws_s3_bucket.b[1]'])
  })

  it('creates one instance per for_each key and destroys a removed key', () => {
    const tf = 'resource "aws_s3_bucket" "b" {\n  for_each = toset(["a", "b"])\n  bucket   = "b-${each.key}"\n}'
    expect(actions(plan(tf))).toEqual(['create aws_s3_bucket.b["a"]', 'create aws_s3_bucket.b["b"]'])
    const state = stateOf(...['a', 'b', 'c'].map((k) => ({ type: 'aws_s3_bucket', name: 'b', key: k, attrs: { id: `b-${k}`, arn: `arn:b-${k}`, bucket: `b-${k}`, force_destroy: false } })))
    expect(actions(plan(tf, { state }))).toEqual(['destroy aws_s3_bucket.b["c"]'])
  })

  it('gives each for_each map entry its value', () => {
    const tf = 'resource "aws_s3_bucket" "b" {\n  for_each = { x = "one", y = "two" }\n  bucket   = "v-${each.value}"\n}'
    const r = plan(tf)
    expect(r.items.map((i) => [i.address, i.changes.find((c) => c.name === 'bucket')!.after])).toEqual([
      ['aws_s3_bucket.b["x"]', 'v-one'],
      ['aws_s3_bucket.b["y"]', 'v-two'],
    ])
  })

  it('refuses an unknown for_each or count with the real error, and plans nothing', () => {
    const fe = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\nresource "aws_subnet" "s" {\n  for_each = toset([aws_vpc.main.id])\n  vpc_id = each.key\n  cidr_block = "10.0.1.0/24"\n}')
    expect(fe.diagnostics[0]).toMatchObject({ summary: 'Invalid for_each argument', file: 'main.tf', line: 5, context: 'resource "aws_subnet" "s"' })
    expect(fe.items).toEqual([])
    const ct = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\nresource "aws_subnet" "s" {\n  count = length(aws_vpc.main.id)\n  cidr_block = "10.0.1.0/24"\n}')
    expect(ct.diagnostics[0].summary).toBe('Invalid count argument')
  })

  it('requires an instance key to reference a counted resource', () => {
    const tf = COUNTED + 'resource "aws_sqs_queue" "q" {\n  name = aws_s3_bucket.b.bucket\n}'
    const r = plan(tf)
    expect(r.diagnostics[0]).toMatchObject({ summary: 'Missing resource instance key' })
    expect(r.diagnostics[0].detail).toContain('aws_s3_bucket.b[count.index]')
    const ok = plan(COUNTED + 'resource "aws_sqs_queue" "q" {\n  name = aws_s3_bucket.b[1].bucket\n}')
    expect(ok.diagnostics).toEqual([])
    expect(ok.items.find((i) => i.address === 'aws_sqs_queue.q')!.changes.find((c) => c.name === 'name')).toMatchObject({ after: 'logs-1' })
  })
})

describe('planConfig: variables, locals, outputs, data', () => {
  const TF = 'variable "env" {}\nlocals {\n  name = "app-${var.env}"\n}\nresource "aws_s3_bucket" "b" {\n  bucket = local.name\n}\noutput "id" {\n  value = aws_s3_bucket.b.id\n}\noutput "bucket" {\n  value = aws_s3_bucket.b.bucket\n}\noutput "secret" {\n  value = local.name\n  sensitive = true\n}\n'

  it('evaluates locals and outputs, with computed values unknown, sorted by name', () => {
    const r = plan(TF, { vars: { env: 'prod' } })
    expect(r.diagnostics).toEqual([])
    expect(r.outputs).toEqual([
      { name: 'bucket', value: 'app-prod', sensitive: false },
      { name: 'id', value: UNKNOWN, sensitive: false },
      { name: 'secret', value: 'app-prod', sensitive: true },
    ])
  })

  it('reports a missing required variable, and prefers a supplied value over the default', () => {
    const r = plan(TF)
    expect(r.diagnostics[0]).toMatchObject({ summary: 'No value for required variable', context: 'variable "env"', line: 1 })
    expect(r.diagnostics[0].detail).toContain('The root module input variable "env" is not set')
    const d = 'variable "cidr" {\n  default = "10.0.0.0/16"\n}\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}'
    expect(plan(d).items[0].changes.find((c) => c.name === 'cidr_block')).toMatchObject({ after: '10.0.0.0/16' })
    expect(plan(d, { vars: { cidr: '10.9.0.0/16' } }).items[0].changes.find((c) => c.name === 'cidr_block')).toMatchObject({ after: '10.9.0.0/16' })
  })

  it('reads a data source from state, and treats an unread one as unknown', () => {
    const tf = 'data "aws_ami" "x" {}\nresource "aws_instance" "i" {\n  ami = data.aws_ami.x.id\n  instance_type = "t3.micro"\n}'
    const read = plan(tf, { state: stateOf({ mode: 'data', type: 'aws_ami', name: 'x', attrs: { id: 'ami-1' } }) })
    expect(read.items.find((i) => i.address === 'aws_instance.i')!.changes.find((c) => c.name === 'ami')).toMatchObject({ after: 'ami-1' })
    expect(plan(tf).items.find((i) => i.address === 'aws_instance.i')!.changes.find((c) => c.name === 'ami')).toMatchObject({ after: UNKNOWN })
  })
})

describe('planConfig: errors', () => {
  it('reports an unmodeled resource type, a module, a dynamic block and a bad attribute reference, and plans nothing', () => {
    const r = plan('resource "aws_nope" "x" {}\nmodule "m" {\n  source = "./m"\n}\nresource "aws_security_group" "g" {\n  dynamic "ingress" {\n    for_each = []\n  }\n}\nresource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\nresource "aws_subnet" "s" {\n  vpc_id = aws_vpc.v.nope\n  cidr_block = "10.0.1.0/24"\n}')
    expect(r.diagnostics.map((d) => d.summary).sort()).toEqual(['Invalid resource type', 'Unsupported attribute', 'Unsupported dynamic block', 'Unsupported module'])
    expect(r.items).toEqual([])
    expect(r.outputs).toEqual([])
  })

  it('reports parse and graph errors without planning', () => {
    expect(plan('resource "aws_vpc" "main" {\n  cidr_block\n}').diagnostics[0].summary).toBe('Argument or block definition required')
    expect(plan('resource "aws_vpc" "a" {\n  cidr_block = aws_vpc.nope.id\n}').diagnostics[0].summary).toBe('Reference to undeclared resource')
  })

  it('does not touch the caller\'s state', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC })
    const copy = structuredClone(state)
    plan(NETWORK('10.1.0.0/16'), { state })
    expect(state).toEqual(copy)
  })
})

describe('planConfig: review fixes', () => {
  const B = (n?: string) => `resource "aws_s3_bucket" "b" {\n${n ? `  count = ${n}\n` : ''}  bucket = "logs-0"\n}`
  const b0 = { id: 'logs-0', arn: 'arn:logs-0', bucket: 'logs-0', force_destroy: false }
  const one = (key?: number) => stateOf({ type: 'aws_s3_bucket', name: 'b', key, attrs: b0 })

  it('moves an unkeyed instance to [0] when count is added, with no destroy', () => {
    const r = plan(B('1'), { state: one() })
    expect(r.diagnostics).toEqual([])
    expect(r.items.map((i) => `${i.action} ${i.address}`)).toEqual(['noop aws_s3_bucket.b[0]'])
    expect(r.items[0].movedFrom).toBe('aws_s3_bucket.b')
    expect(r.summary.destroy).toBe(0)
  })

  it('moves [0] back to the unkeyed address when count is removed', () => {
    const r = plan(B(), { state: one(0) })
    expect(r.items.map((i) => `${i.action} ${i.address}`)).toEqual(['noop aws_s3_bucket.b'])
    expect(r.items[0].movedFrom).toBe('aws_s3_bucket.b[0]')
  })

  it('count=2 moves the unkeyed instance to [0] and creates [1]', () => {
    const r = plan(B('2'), { state: one() })
    expect(r.items.map((i) => `${i.action} ${i.address}`)).toEqual(['noop aws_s3_bucket.b[0]', 'create aws_s3_bucket.b[1]'])
    expect(r.items[1].movedFrom).toBeUndefined()
  })

  it('uses the real instance when both forms exist, and destroys the other', () => {
    const state = stateOf({ type: 'aws_s3_bucket', name: 'b', attrs: b0 }, { type: 'aws_s3_bucket', name: 'b', key: 0, attrs: { ...b0, id: 'logs-x', arn: 'arn:logs-x' } })
    const r = plan(B('1'), { state })
    expect(r.items.map((i) => `${i.action} ${i.address}`)).toEqual(['destroy aws_s3_bucket.b', 'noop aws_s3_bucket.b[0]'])
    expect(r.items.every((i) => i.movedFrom === undefined)).toBe(true)
  })

  it('never moves for_each instances', () => {
    const r = plan('resource "aws_s3_bucket" "b" {\n  for_each = toset(["a"])\n  bucket = "logs-0"\n}', { state: one() })
    expect(actions(r)).toEqual(['destroy aws_s3_bucket.b', 'create aws_s3_bucket.b["a"]'])
  })

  it('reports only the root error when a node fails, not its dependents', () => {
    expect(plan('variable "n" {}\n' + B('var.n')).diagnostics.map((d) => d.summary)).toEqual(['No value for required variable'])
    expect(plan('variable "e" {}\nresource "aws_s3_bucket" "b" {\n  for_each = toset([var.e])\n}').diagnostics.map((d) => d.summary)).toEqual(['No value for required variable'])
    const r = plan('resource "aws_nope" "x" {}\nresource "aws_s3_bucket" "b" {\n  bucket = aws_nope.x.id\n}')
    expect(r.diagnostics.map((d) => d.summary)).toEqual(['Invalid resource type'])
  })

  it('accepts a numeric string for count', () => {
    expect(plan('variable "n" {}\n' + B('var.n'), { vars: { n: '2' } }).items).toHaveLength(2)
  })

  it('orders instances by type, name, then numeric key', () => {
    const r = plan(B('12') + '\nresource "aws_s3_bucket" "b2" {\n  bucket = "x"\n}')
    expect(r.items.map((i) => i.address)).toEqual([...Array.from({ length: 12 }, (_, i) => `aws_s3_bucket.b[${i}]`), 'aws_s3_bucket.b2'])
  })

  it('orders an unkeyed destroy before keyed instances of the same name', () => {
    const r = plan(B('2'), { state: stateOf({ type: 'aws_s3_bucket', name: 'b', attrs: b0 }, { type: 'aws_s3_bucket', name: 'b', key: 0, attrs: b0 }) })
    expect(r.items.map((i) => i.address)).toEqual(['aws_s3_bucket.b', 'aws_s3_bucket.b[0]', 'aws_s3_bucket.b[1]'])
  })

  it('does not alias the caller\'s state when refresh is off', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'v', attrs: { ...VPC, tags: { a: '1' } } })
    const r = planConfig({ files: [{ name: 'main.tf', text: 'resource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}' }], state, reality: {}, vars: {}, refresh: false })
    const before = r.items[0].changes.find((c) => c.name === 'tags')!.before as Record<string, Value>
    before.a = 'mutated'
    expect(state.resources[0].instances[0].attributes.tags).toEqual({ a: '1' })
  })

  it('errors on an output without a value, on self outside a provisioner, and tags local errors', () => {
    expect(plan('output "o" {}')).toMatchObject({ diagnostics: [{ summary: 'Missing required argument', detail: 'The argument "value" is required, but no definition was found.', context: 'output "o"' }] })
    expect(plan('output "o" {\n  value = self.id\n}').diagnostics[0].summary).toBe('Invalid "self" reference')
    expect(plan('locals {\n  x = 1 / 0\n}').diagnostics[0].context).toBe('locals')
  })
})

const INSTANCE = { id: 'i-1', arn: 'arn:i-1', ami: 'ami-1', instance_type: 't3.micro' }
const WEB = 'resource "aws_instance" "web" {\n  ami           = "ami-1"\n  instance_type = "t3.micro"\n}\n'
const webState = (status?: 'tainted') => stateOf({ type: 'aws_instance', name: 'web', attrs: INSTANCE, ...(status ? { status } : {}) })

describe('planConfig: forced replacement', () => {
  it('replaces a tainted instance even though nothing changed, and says why', () => {
    const r = plan(WEB, { state: webState('tainted') })
    expect(r.items).toMatchObject([{ address: 'aws_instance.web', action: 'replace', reason: 'tainted' }])
    expect(r.items[0].changes.find((c) => c.name === 'id')).toMatchObject({ before: 'i-1', after: UNKNOWN })
    expect(r.summary).toEqual({ add: 1, change: 0, destroy: 1 })
  })

  it('leaves an untainted, unchanged instance alone', () => {
    expect(plan(WEB, { state: webState() }).items).toMatchObject([{ action: 'noop' }])
  })

  it('replaces exactly the instances named by -replace, with reason requested', () => {
    const state = stateOf(...[0, 1, 2].map((n) => ({ type: 'aws_s3_bucket', name: 'b', key: n, attrs: BUCKET(n) })))
    const tf = 'resource "aws_s3_bucket" "b" {\n  count  = 3\n  bucket = "logs-${count.index}"\n}'
    const r = plan(tf, { state, replace: ['aws_s3_bucket.b[1]'] })
    expect(r.items.map((i) => `${i.action} ${i.address}`)).toEqual(['noop aws_s3_bucket.b[0]', 'replace aws_s3_bucket.b[1]', 'noop aws_s3_bucket.b[2]'])
    expect(r.items[1].reason).toBe('requested')
    expect(r.warnings).toEqual([])
  })

  const AMI2 = 'resource "aws_instance" "web" {\n  ami           = "ami-2"\n  instance_type = "t3.micro"\n}\n'

  it('says requested when -replace is given for an instance that would be replaced anyway', () => {
    const r = plan(AMI2, { state: webState(), replace: ['aws_instance.web'] })
    expect(r.items[0]).toMatchObject({ action: 'replace', reason: 'requested' })
  })

  it('says tainted for a tainted instance whose arguments force replacement, and nothing for a plain forced-by-argument replacement', () => {
    expect(plan(AMI2, { state: webState('tainted') }).items[0]).toMatchObject({ action: 'replace', reason: 'tainted' })
    const r = plan(AMI2, { state: webState() })
    expect(r.items[0].action).toBe('replace')
    expect(r.items[0].reason).toBeUndefined()
  })

  it('lets a trigger override tainted, and records only the first triggering reference', () => {
    const tf = `resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  enable_dns_hostnames = true\n}\nresource "aws_vpc" "other" {\n  cidr_block = "10.1.0.0/16"\n  enable_dns_hostnames = true\n}\nresource "aws_instance" "web" {\n  ami           = "ami-1"\n  instance_type = "t3.micro"\n  lifecycle {\n    replace_triggered_by = [aws_vpc.main, aws_vpc.other]\n  }\n}\n`
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_vpc', name: 'other', attrs: { ...VPC, cidr_block: '10.1.0.0/16' } }, { type: 'aws_instance', name: 'web', attrs: INSTANCE, status: 'tainted' })
    const r = plan(tf, { state })
    expect(r.items.find((i) => i.address === 'aws_instance.web')).toMatchObject({ action: 'replace', reason: 'triggered', triggeredBy: ['aws_vpc.main'] })
  })

  it('builds a tainted replacement from the configuration, ignoring ignore_changes', () => {
    const tf = 'resource "aws_instance" "web" {\n  ami           = "ami-2"\n  instance_type = "t3.micro"\n  lifecycle {\n    ignore_changes = [ami]\n  }\n}\n'
    const r = plan(tf, { state: webState('tainted') })
    expect(r.items[0]).toMatchObject({ action: 'replace', reason: 'tainted' })
    expect(r.items[0].changes.find((c) => c.name === 'ami')).toMatchObject({ before: 'ami-1', after: 'ami-2' })
    expect(plan(tf, { state: webState() }).items[0].action).toBe('noop')
  })

  it('keeps a forced replacement of something that does not exist a plain create', () => {
    const r = plan(WEB, { replace: ['aws_instance.web'] })
    expect(r.items).toMatchObject([{ action: 'create' }])
    expect(r.items[0].reason).toBeUndefined()
    expect(r.warnings).toEqual([])
  })

  it('gives no diagnostic for a nonexistent or mismatched -replace address', () => {
    for (const a of ['aws_instance.nope', 'aws_instance.web[0]']) {
      const r = plan(WEB, { state: webState(), replace: [a] })
      expect(r.diagnostics).toEqual([])
      expect(r.warnings).toEqual([])
      expect(r.items).toMatchObject([{ action: 'noop' }])
    }
  })

  const S3 = (head: string) => `resource "aws_s3_bucket" "b" {\n  ${head}\n  bucket = "logs-\${${head.startsWith('count') ? 'count.index' : 'each.key'}}"\n}`
  const P = "Your force-replace request for aws_s3_bucket.b doesn't match any resource instances"

  it('warns when a keyless -replace names a count or for_each resource', () => {
    const state = stateOf(...[0, 1].map((n) => ({ type: 'aws_s3_bucket', name: 'b', key: n, attrs: BUCKET(n) })))
    const many = plan(S3('count = 2'), { state, replace: ['aws_s3_bucket.b', 'aws_s3_bucket.b'] })
    expect(many.warnings).toHaveLength(1)
    expect(many.warnings[0]).toMatchObject({ severity: 'warning', summary: 'Incompletely-matched force-replace resource instance' })
    expect(many.warnings[0].detail).toBe(`${P} because it lacks an instance key.\n\nTo force replacement of particular instances, use one or more of the following options instead:\n  -replace="aws_s3_bucket.b[0]"\n  -replace="aws_s3_bucket.b[1]"`)
    const one = plan(S3('count = 1'), { replace: ['aws_s3_bucket.b'] })
    expect(one.warnings[0].detail).toBe(`${P} because it lacks an instance key.\n\nTo force replacement of the single declared instance, use the following option instead:\n  -replace="aws_s3_bucket.b[0]"`)
    const none = plan(S3('count = 0'), { replace: ['aws_s3_bucket.b'] })
    expect(none.warnings[0].detail).toBe(`${P} because this resource doesn't have any instances.`)
  })

})

describe('planConfig: replace_triggered_by', () => {
  const TF = (dns: boolean, cidr = '10.0.0.0/16') =>
    `resource "aws_vpc" "main" {\n  cidr_block = "${cidr}"\n  enable_dns_hostnames = ${dns}\n}\nresource "aws_instance" "web" {\n  ami           = "ami-1"\n  instance_type = "t3.micro"\n  lifecycle {\n    replace_triggered_by = [aws_vpc.main]\n  }\n}\n`
  const both = () => stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_instance', name: 'web', attrs: INSTANCE })
  const instanceOf = (r: PlanResult) => r.items.find((i) => i.address === 'aws_instance.web')!

  it('does nothing while the referenced resource is unchanged', () => {
    expect(instanceOf(plan(TF(false), { state: both() })).action).toBe('noop')
  })

  it('replaces when the referenced resource is updated, and says what triggered it', () => {
    const r = plan(TF(true), { state: both() })
    expect(r.items.find((i) => i.address === 'aws_vpc.main')!.action).toBe('update')
    expect(instanceOf(r)).toMatchObject({ action: 'replace', reason: 'triggered', triggeredBy: ['aws_vpc.main'] })
  })

  it('replaces when the referenced resource is replaced', () => {
    expect(instanceOf(plan(TF(false, '10.9.0.0/16'), { state: both() }))).toMatchObject({ action: 'replace', reason: 'triggered' })
  })

  it('does not trigger when the referenced resource is only being created', () => {
    const r = plan(TF(false), { state: webState() })
    expect(r.items.find((i) => i.address === 'aws_vpc.main')!.action).toBe('create')
    expect(instanceOf(r).action).toBe('noop')
  })
})

describe('planConfig: prevent_destroy and create_before_destroy', () => {
  const DB = (encrypted: boolean, cls = 'db.r6g.large', protect = true) =>
    `resource "aws_db_instance" "orders" {\n  identifier        = "orders-prod"\n  engine            = "postgres"\n  instance_class    = "${cls}"\n  storage_encrypted = ${encrypted}\n${protect ? '  lifecycle {\n    prevent_destroy = true\n  }\n' : ''}}\n`
  const dbState = () => stateOf({ type: 'aws_db_instance', name: 'orders', attrs: { id: 'db-1', arn: 'arn:db-1', identifier: 'orders-prod', engine: 'postgres', instance_class: 'db.r6g.large', storage_encrypted: false } })

  it('stops a plan that would replace a protected resource, with the real error', () => {
    const r = plan(DB(true), { state: dbState() })
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]).toMatchObject({ summary: 'Instance cannot be destroyed', file: 'main.tf', line: 1, context: 'resource "aws_db_instance" "orders"' })
    expect(r.diagnostics[0].detail).toContain('Resource aws_db_instance.orders has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed.')
    expect(r.diagnostics[0].detail).toContain('reduce the scope of the plan using the -target option')
    expect(r.items).toEqual([])
  })

  it('allows plans that do not destroy it: no change, or an in-place update', () => {
    expect(plan(DB(false), { state: dbState() }).diagnostics).toEqual([])
    const r = plan(DB(false, 'db.r6g.xlarge'), { state: dbState() })
    expect(r.diagnostics).toEqual([])
    expect(r.items[0].action).toBe('update')
  })

  it('does not protect once the resource block is removed from the configuration', () => {
    const r = plan('# removed\n', { state: dbState() })
    expect(r.diagnostics).toEqual([])
    expect(r.items).toMatchObject([{ address: 'aws_db_instance.orders', action: 'destroy' }])
  })

  it('protects instances that a smaller count would destroy', () => {
    const state = stateOf(...[0, 1, 2].map((n) => ({ type: 'aws_s3_bucket', name: 'b', key: n, attrs: BUCKET(n) })))
    const tf = (n: number) => `resource "aws_s3_bucket" "b" {\n  count  = ${n}\n  bucket = "logs-\${count.index}"\n  lifecycle {\n    prevent_destroy = true\n  }\n}`
    expect(plan(tf(3), { state }).diagnostics).toEqual([])
    const r = plan(tf(2), { state })
    expect(r.diagnostics[0]).toMatchObject({ summary: 'Instance cannot be destroyed' })
    expect(r.diagnostics[0].detail).toContain('Resource aws_s3_bucket.b[2] has lifecycle.prevent_destroy set')
  })

  it('protects a protected resource from -replace and from a tainted state', () => {
    const tf = 'resource "aws_instance" "web" {\n  ami = "ami-1"\n  instance_type = "t3.micro"\n  lifecycle {\n    prevent_destroy = true\n  }\n}'
    expect(plan(tf, { state: webState(), replace: ['aws_instance.web'] }).diagnostics[0].summary).toBe('Instance cannot be destroyed')
    expect(plan(tf, { state: webState('tainted') }).diagnostics[0].summary).toBe('Instance cannot be destroyed')
  })

  it('records create_before_destroy on a replacement only', () => {
    const tf = (cbd: boolean, ami: string) => `resource "aws_instance" "web" {\n  ami = "${ami}"\n  instance_type = "t3.micro"\n  lifecycle {\n    create_before_destroy = ${cbd}\n  }\n}`
    expect(plan(tf(true, 'ami-2'), { state: webState() }).items[0]).toMatchObject({ action: 'replace', createBeforeDestroy: true })
    expect(plan(tf(false, 'ami-2'), { state: webState() }).items[0].createBeforeDestroy).toBeUndefined()
    expect(plan(tf(true, 'ami-1'), { state: webState() }).items[0].createBeforeDestroy).toBeUndefined()
  })
})

const DB_ATTRS = { id: 'db-1', arn: 'arn:db-1', identifier: 'orders-prod', engine: 'postgres', instance_class: 'db.r6g.large', storage_encrypted: false }
const DB_BLOCK = (name: string) => `resource "aws_db_instance" "${name}" {\n  identifier        = "orders-prod"\n  engine            = "postgres"\n  instance_class    = "db.r6g.large"\n  storage_encrypted = false\n}\n`
const ordersState = () => stateOf({ type: 'aws_db_instance', name: 'orders', attrs: DB_ATTRS })

describe('planConfig: moved blocks', () => {
  it('shows the destroy-and-create trap without a moved block, and a no-op with one', () => {
    const trap = plan(DB_BLOCK('primary'), { state: ordersState() })
    expect(actions(trap)).toEqual(['destroy aws_db_instance.orders', 'create aws_db_instance.primary'])
    const fixed = plan(DB_BLOCK('primary') + 'moved {\n  from = aws_db_instance.orders\n  to   = aws_db_instance.primary\n}\n', { state: ordersState() })
    expect(fixed.diagnostics).toEqual([])
    expect(fixed.items).toMatchObject([{ address: 'aws_db_instance.primary', action: 'noop', movedFrom: 'aws_db_instance.orders' }])
    expect(fixed.summary).toEqual({ add: 0, change: 0, destroy: 0 })
    expect(fixed.refreshed.resources[0].name).toBe('orders')
  })

  it('re-keys count indexes to for_each keys without destroying', () => {
    const state = stateOf(
      { type: 'aws_s3_bucket', name: 'b', key: 0, attrs: { id: 'b-a', arn: 'arn:b-a', bucket: 'b-a', force_destroy: false } },
      { type: 'aws_s3_bucket', name: 'b', key: 1, attrs: { id: 'b-b', arn: 'arn:b-b', bucket: 'b-b', force_destroy: false } },
    )
    const tf =
      'resource "aws_s3_bucket" "b" {\n  for_each = toset(["a", "b"])\n  bucket   = "b-${each.key}"\n}\n' +
      'moved {\n  from = aws_s3_bucket.b[0]\n  to   = aws_s3_bucket.b["a"]\n}\nmoved {\n  from = aws_s3_bucket.b[1]\n  to   = aws_s3_bucket.b["b"]\n}\n'
    const r = plan(tf, { state })
    expect(r.diagnostics).toEqual([])
    expect(r.items.map((i) => [i.address, i.action, i.movedFrom])).toEqual([
      ['aws_s3_bucket.b["a"]', 'noop', 'aws_s3_bucket.b[0]'],
      ['aws_s3_bucket.b["b"]', 'noop', 'aws_s3_bucket.b[1]'],
    ])
  })

  it('still diffs a moved resource against its new configuration', () => {
    const tf = DB_BLOCK('primary').replace('storage_encrypted = false', 'storage_encrypted = true') + 'moved {\n  from = aws_db_instance.orders\n  to   = aws_db_instance.primary\n}\n'
    expect(plan(tf, { state: ordersState() }).items).toMatchObject([{ address: 'aws_db_instance.primary', action: 'replace', movedFrom: 'aws_db_instance.orders' }])
  })

  const MOVE_OP = 'moved {\n  from = aws_db_instance.orders\n  to   = aws_db_instance.primary\n}\n'

  it('is an error when the old address is still declared', () => {
    const r = plan(DB_BLOCK('orders') + DB_BLOCK('primary') + MOVE_OP, { state: ordersState() })
    expect(r.diagnostics[0]).toMatchObject({ summary: 'Moved object still exists', file: 'main.tf' })
    expect(r.items).toEqual([])
  })

  it('does not complain about the add-count pattern, but does when an old keyed instance is still planned', () => {
    const x = 'resource "aws_s3_bucket" "x" {\n  count  = 1\n  bucket = "b"\n}\n'
    const ok = plan(x + 'moved {\n  from = aws_s3_bucket.x\n  to   = aws_s3_bucket.x[0]\n}\n')
    expect(ok.diagnostics).toEqual([])
    const bad = plan(x + 'moved {\n  from = aws_s3_bucket.x[0]\n  to   = aws_s3_bucket.x["a"]\n}\n')
    expect(bad.diagnostics[0].summary).toBe('Moved object still exists')
  })

  it('keeps the original address when the implicit count move follows an explicit one', () => {
    const state = stateOf({ type: 'aws_s3_bucket', name: 'x_old', attrs: BUCKET(1) })
    const r = plan('resource "aws_s3_bucket" "x" {\n  count  = 1\n  bucket = "logs-1"\n}\nmoved {\n  from = aws_s3_bucket.x_old\n  to   = aws_s3_bucket.x\n}\n', { state })
    expect(r.diagnostics).toEqual([])
    expect(r.items).toMatchObject([{ address: 'aws_s3_bucket.x[0]', movedFrom: 'aws_s3_bucket.x_old' }])
  })

  it('errors for a type mismatch', () => {
    const mismatch = plan(DB_BLOCK('primary') + 'moved {\n  from = aws_db_instance.orders\n  to   = aws_vpc.main\n}\n', { state: ordersState() })
    expect(mismatch.diagnostics[0].summary).toBe('Resource type mismatch')
    expect(mismatch.items).toEqual([])
  })

  it('warns, and lets the existing object win, for a move onto an occupied address', () => {
    const both = stateOf({ type: 'aws_db_instance', name: 'orders', attrs: DB_ATTRS }, { type: 'aws_db_instance', name: 'primary', attrs: { ...DB_ATTRS, id: 'db-2' } })
    const r = plan(DB_BLOCK('primary') + MOVE_OP, { state: both })
    expect(r.diagnostics).toEqual([])
    expect(r.warnings.map((w) => w.summary)).toEqual(['Unresolved resource instance address changes'])
    expect(r.warnings[0].detail).toContain('move aws_db_instance.orders to aws_db_instance.primary')
    expect(r.items.map((i) => `${i.action} ${i.address}`)).toEqual(['destroy aws_db_instance.orders', 'noop aws_db_instance.primary'])
  })
})

describe('planConfig: removed blocks', () => {
  const state = () => stateOf({ type: 'aws_vpc', name: 'old', attrs: VPC })
  const REMOVED = (lc: string) => `removed {\n  from = aws_vpc.old\n${lc}}\n`

  it('forgets with destroy = false: no destroy, no destroy count', () => {
    const r = plan(REMOVED('  lifecycle {\n    destroy = false\n  }\n'), { state: state() })
    expect(r.items).toMatchObject([{ address: 'aws_vpc.old', action: 'forget', changes: [], unchanged: VPC }])
    expect(r.summary).toEqual({ add: 0, change: 0, destroy: 0 })
  })

  it('destroys with destroy = true or no lifecycle', () => {
    expect(plan(REMOVED('  lifecycle {\n    destroy = true\n  }\n'), { state: state() }).items[0].action).toBe('destroy')
    expect(plan(REMOVED(''), { state: state() }).items[0].action).toBe('destroy')
  })

  it('is an error while the resource is still declared', () => {
    const r = plan('resource "aws_vpc" "old" {\n  cidr_block = "10.0.0.0/16"\n}\n' + REMOVED(''), { state: state() })
    expect(r.diagnostics[0].summary).toBe('Removed resource still exists')
    expect(r.items).toEqual([])
  })
})

describe('planConfig: import blocks', () => {
  const LEGACY = { id: 'legacy-bucket', arn: 'arn:legacy-bucket', bucket: 'legacy-bucket', force_destroy: false }
  const CLOUD: Reality = { [realityKey('aws_s3_bucket', 'legacy-bucket')]: LEGACY }
  const BUCKET_TF = (extra = '') => `resource "aws_s3_bucket" "b" {\n  bucket = "legacy-bucket"\n${extra}}\n`
  const IMPORT = (id = '"legacy-bucket"', to = 'aws_s3_bucket.b') => `import {\n  to = ${to}\n  id = ${id}\n}\n`

  it('would plan a create without the import block, and an import with it', () => {
    expect(actions(plan(BUCKET_TF(), { reality: CLOUD }))).toEqual(['create aws_s3_bucket.b'])
    const r = plan(BUCKET_TF() + IMPORT(), { reality: CLOUD })
    expect(r.diagnostics).toEqual([])
    expect(r.items).toMatchObject([{ address: 'aws_s3_bucket.b', action: 'noop', importing: 'legacy-bucket' }])
    expect(r.imported).toBe(1)
    expect(r.summary).toEqual({ add: 0, change: 0, destroy: 0 })
  })

  it('shows the difference between the imported object and the configuration', () => {
    const r = plan(BUCKET_TF('  force_destroy = true\n') + IMPORT(), { reality: CLOUD })
    expect(r.items[0]).toMatchObject({ action: 'update', importing: 'legacy-bucket', changes: [{ name: 'force_destroy', before: false, after: true }] })
    expect(r.summary).toEqual({ add: 0, change: 1, destroy: 0 })
  })

  it('evaluates the id after the variable it uses', () => {
    const r = plan('variable "bucket" {\n  default = "legacy-bucket"\n}\n' + BUCKET_TF() + IMPORT('var.bucket'), { reality: CLOUD })
    expect(r.diagnostics).toEqual([])
    expect(r.items[0].importing).toBe('legacy-bucket')
  })

  it('imports a keyed instance', () => {
    const tf = 'resource "aws_s3_bucket" "b" {\n  for_each = toset(["x"])\n  bucket   = "legacy-bucket"\n}\n' + IMPORT('"legacy-bucket"', 'aws_s3_bucket.b["x"]')
    expect(plan(tf, { reality: CLOUD }).items).toMatchObject([{ address: 'aws_s3_bucket.b["x"]', importing: 'legacy-bucket' }])
  })

  it('fails with the real errors when the object does not exist or the target is not configured', () => {
    const none = plan(BUCKET_TF() + IMPORT('"nope"'), { reality: CLOUD })
    expect(none.diagnostics[0]).toMatchObject({ summary: 'Cannot import non-existent remote object' })
    expect(none.diagnostics[0].detail).toContain('import an existing object to "aws_s3_bucket.b"')
    expect(none.items).toEqual([])
    const unconfigured = plan(BUCKET_TF() + IMPORT('"legacy-bucket"', 'aws_s3_bucket.other'), { reality: CLOUD })
    expect(unconfigured.diagnostics[0].summary).toBe('Configuration for import target does not exist')
  })

  it('errors when the import target instance is not in the expansion', () => {
    const counted = 'resource "aws_s3_bucket" "b" {\n  count  = 2\n  bucket = "legacy-bucket"\n}\n'
    const keyed = 'resource "aws_s3_bucket" "b" {\n  for_each = toset(["a"])\n  bucket   = "legacy-bucket"\n}\n'
    for (const [tf, to] of [[counted, 'aws_s3_bucket.b[5]'], [counted, 'aws_s3_bucket.b'], [keyed, 'aws_s3_bucket.b["A"]']]) {
      const r = plan(tf + IMPORT('"legacy-bucket"', to), { reality: CLOUD })
      expect(r.diagnostics.map((d) => d.summary)).toEqual(['Configuration for import target does not exist'])
      expect(r.items).toEqual([])
    }
  })

  it('converts a number id, and rejects a null id', () => {
    const num = plan(BUCKET_TF() + IMPORT('123'), { reality: { [realityKey('aws_s3_bucket', '123')]: LEGACY } })
    expect(num.items[0].importing).toBe('123')
    const nul = plan(BUCKET_TF() + IMPORT('null'), { reality: CLOUD })
    expect(nul.diagnostics[0]).toMatchObject({ summary: 'Invalid import id argument', detail: 'The given import id for aws_s3_bucket.b must be a known string value.' })
  })

  it('evaluates the id without the target instance context', () => {
    const tf = 'resource "aws_s3_bucket" "b" {\n  for_each = toset(["x"])\n  bucket   = "legacy-bucket"\n}\n' + IMPORT('each.key', 'aws_s3_bucket.b["x"]')
    expect(plan(tf, { reality: CLOUD }).diagnostics[0].summary).toBe('Reference to "each" in context without for_each')
  })

  it('ignores an import for something already in state', () => {
    const state = stateOf({ type: 'aws_s3_bucket', name: 'b', attrs: LEGACY })
    const r = plan(BUCKET_TF() + IMPORT(), { state, reality: CLOUD })
    expect(r.items).toMatchObject([{ action: 'noop' }])
    expect(r.items[0].importing).toBeUndefined()
    expect(r.imported).toBe(0)
  })
})

describe('planConfig: facts for the renderer', () => {
  it('records the unchanged non-null attributes of an updated instance', () => {
    const r = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  enable_dns_hostnames = true\n}', { state: stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }) })
    const item = r.items[0]
    expect(item.action).toBe('update')
    expect(item.unchanged).toEqual({ id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, default_security_group_id: 'sg-1' })
  })

  it('has no unchanged facts for a create or a destroy', () => {
    expect(plan(NETWORK('10.0.0.0/16')).items.every((i) => i.unchanged === undefined)).toBe(true)
    expect(plan('# none\n', { state: stateOf({ type: 'aws_vpc', name: 'old', attrs: VPC }) }).items[0].unchanged).toBeUndefined()
  })

  it('says why an instance is destroyed', () => {
    const gone = plan('# none\n', { state: stateOf({ type: 'aws_vpc', name: 'old', attrs: VPC }) })
    expect(gone.items[0].destroyReason).toBe('not-in-config')
    const buckets = stateOf(...[0, 1, 2].map((n) => ({ type: 'aws_s3_bucket', name: 'b', key: n, attrs: BUCKET(n) })))
    const counted = plan('resource "aws_s3_bucket" "b" {\n  count = 2\n  bucket = "logs-${count.index}"\n}', { state: buckets })
    expect(counted.items.find((i) => i.action === 'destroy')).toMatchObject({ address: 'aws_s3_bucket.b[2]', destroyReason: 'count-index' })
    const keyed = stateOf(...['a', 'b'].map((k) => ({ type: 'aws_s3_bucket', name: 'b', key: k, attrs: { id: `b-${k}`, arn: `arn:b-${k}`, bucket: `b-${k}`, force_destroy: false } })))
    const fe = plan('resource "aws_s3_bucket" "b" {\n  for_each = toset(["a"])\n  bucket = "b-${each.key}"\n}', { state: keyed })
    expect(fe.items.find((i) => i.action === 'destroy')).toMatchObject({ address: 'aws_s3_bucket.b["b"]', destroyReason: 'for-each-key' })
  })

  it('says wrong repetition when count or for_each was added or removed but the block remains', () => {
    const reason = (tf: string, st: State) => plan(tf, { state: st }).items.find((i) => i.action === 'destroy')
    const single = stateOf({ type: 'aws_s3_bucket', name: 'b', attrs: BUCKET(0) })
    const counted = stateOf({ type: 'aws_s3_bucket', name: 'b', key: 1, attrs: BUCKET(1) })
    const keyed = stateOf({ type: 'aws_s3_bucket', name: 'b', key: 'a', attrs: BUCKET(0) })
    const addedFor = reason('resource "aws_s3_bucket" "b" {\n  for_each = toset(["a"])\n  bucket = "x-${each.key}"\n}', single)
    expect(addedFor).toMatchObject({ address: 'aws_s3_bucket.b', destroyReason: 'wrong-repetition' })
    const removedCount = reason('resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}', counted)
    expect(removedCount).toMatchObject({ address: 'aws_s3_bucket.b[1]', destroyReason: 'wrong-repetition' })
    const removedFor = reason('resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}', keyed)
    expect(removedFor).toMatchObject({ address: 'aws_s3_bucket.b["a"]', destroyReason: 'wrong-repetition' })
    const swapped = reason('resource "aws_s3_bucket" "b" {\n  count = 1\n  bucket = "x"\n}', keyed)
    expect(swapped).toMatchObject({ destroyReason: 'wrong-repetition' })
    expect(reason('# none\n', counted)).toMatchObject({ destroyReason: 'not-in-config' })
  })
})

describe('planConfig: facts for apply', () => {
  it('exposes the state it planned from, with moves applied', () => {
    const state = stateOf({ type: 'aws_db_instance', name: 'orders', attrs: { id: 'db-1', arn: 'a', identifier: 'orders-prod', engine: 'postgres', instance_class: 'db.r6g.large', storage_encrypted: false } })
    const tf = 'resource "aws_db_instance" "primary" {\n  identifier = "orders-prod"\n  engine = "postgres"\n  instance_class = "db.r6g.large"\n  storage_encrypted = false\n}\nmoved {\n  from = aws_db_instance.orders\n  to   = aws_db_instance.primary\n}\n'
    const r = plan(tf, { state })
    expect(r.baseState.resources.map((x) => x.name)).toEqual(['primary'])
    expect(r.refreshed.resources.map((x) => x.name)).toEqual(['orders'])
    expect(plan('# nothing\n').baseState.resources).toEqual([])
    expect(plan('resource "aws_vpc" "a" {\n  cidr_block\n}\n').baseState).toBeDefined()
  })

  it('lists the resources an item depends on, through locals and variables', () => {
    const tf = 'locals {\n  vpc = aws_vpc.main.id\n}\nvariable "cidr" {\n  default = "10.0.1.0/24"\n}\nresource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\nresource "aws_subnet" "a" {\n  vpc_id     = local.vpc\n  cidr_block = var.cidr\n}\n'
    const r = plan(tf)
    expect(r.items.find((i) => i.address === 'aws_subnet.a')!.dependsOn).toEqual(['aws_vpc.main'])
    expect(r.items.find((i) => i.address === 'aws_vpc.main')!.dependsOn).toEqual([])
  })

  it('takes the dependencies of an orphan destroy from state, and records where a resource is declared', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_subnet', name: 'a', attrs: SUBNET })
    state.resources[1].instances[0].dependencies = ['aws_vpc.main']
    const r = plan('# none\n', { state })
    expect(r.items.find((i) => i.address === 'aws_subnet.a')).toMatchObject({ action: 'destroy', dependsOn: ['aws_vpc.main'] })
    expect(r.items.find((i) => i.address === 'aws_subnet.a')!.block).toBeUndefined()
    const c = plan(NETWORK('10.0.0.0/16'))
    expect(c.items.find((i) => i.address === 'aws_vpc.main')!.block).toEqual({ file: 'main.tf', line: 2, col: 1 })
  })
})

describe('planConfig: destroy mode', () => {
  it('destroys everything in state, dependents first by dependsOn, ignoring the configuration values', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_subnet', name: 'a', attrs: SUBNET })
    const r = plan(NETWORK('10.9.9.0/24'), { state, destroy: true })
    expect(r.diagnostics).toEqual([])
    expect(r.items.map((i) => `${i.action} ${i.address}`).sort()).toEqual(['destroy aws_subnet.a', 'destroy aws_vpc.main'])
    expect(r.items.find((i) => i.address === 'aws_subnet.a')!.dependsOn).toEqual(['aws_vpc.main'])
  })
  it('works with an empty configuration and drops outputs', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC })
    state.outputs = { id: { value: 'vpc-1', sensitive: false } }
    const r = plan('# none\n', { state, destroy: true })
    expect(r.items.map((i) => i.action)).toEqual(['destroy'])
    expect(r.outputs.find((o) => o.name === 'id')).toBeUndefined()
  })
  it('refuses prevent_destroy resources', () => {
    const state = stateOf({ type: 'aws_db_instance', name: 'orders', attrs: { id: 'orders', arn: 'a', identifier: 'orders', engine: 'postgres', instance_class: 'db.t3.micro', storage_encrypted: false } })
    const tf = 'resource "aws_db_instance" "orders" {\n  identifier = "orders"\n  engine = "postgres"\n  instance_class = "db.t3.micro"\n  storage_encrypted = false\n  lifecycle {\n    prevent_destroy = true\n  }\n}\n'
    const r = plan(tf, { state, destroy: true })
    expect(r.diagnostics[0].summary).toBe('Instance cannot be destroyed')
  })
  it('ignores moved/import/removed blocks and -replace', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC })
    const r = plan(NETWORK('10.0.0.0/16') + 'moved {\n  from = aws_vpc.old\n  to = aws_vpc.main\n}\n', { state, destroy: true, replace: ['aws_vpc.main'] })
    expect(r.diagnostics).toEqual([])
    expect(r.items.map((i) => `${i.action} ${i.address}`)).toEqual(['destroy aws_vpc.main'])
  })
  it('does not evaluate arguments: unset variables are fine, and data sources leave state', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_ami', name: 'x', mode: 'data', attrs: { id: 'ami-1' } })
    const r = plan('variable "cidr" {}\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}\n', { state, destroy: true })
    expect(r.diagnostics).toEqual([])
    expect(r.items.map((i) => `${i.action} ${i.address}`)).toEqual(['destroy aws_vpc.main'])
    expect(r.baseState.resources.map((x) => x.mode)).toEqual(['managed'])
    expect(r.summary).toEqual({ add: 0, change: 0, destroy: 1 })
  })
})
