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

const plan = (tf: string, o: { state?: State; reality?: Reality; vars?: Record<string, Value>; replace?: string[] } = {}): PlanResult => {
  const state = o.state ?? emptyState()
  return planConfig({ files: [{ name: 'main.tf', text: tf }], state, reality: o.reality ?? cloudOf(state), vars: o.vars ?? {}, ...(o.replace ? { replace: o.replace } : {}) })
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
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: { ...VPC, tags: { Name: 'main' } } })
    const reality = cloudOf(state)
    reality[realityKey('aws_vpc', 'vpc-1')] = { ...VPC, tags: { Name: 'main', Owner: 'ops' } }
    const r = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  tags = { Name = "main" }\n}', { state, reality })
    expect(r.drift).toEqual([{ address: 'aws_vpc.main', kind: 'changed', changes: [{ name: 'tags', before: { Name: 'main' }, after: { Name: 'main', Owner: 'ops' } }] }])
    expect(r.items[0]).toMatchObject({ action: 'update', changes: [{ name: 'tags', before: { Name: 'main', Owner: 'ops' }, after: { Name: 'main' } }] })
  })

  it('plans a create for something deleted outside Terraform', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC })
    const r = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}', { state, reality: {} })
    expect(r.drift).toEqual([{ address: 'aws_vpc.main', kind: 'deleted', changes: [] }])
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

  it('records no reason when the instance would be replaced anyway', () => {
    const tf = 'resource "aws_instance" "web" {\n  ami           = "ami-2"\n  instance_type = "t3.micro"\n}\n'
    const r = plan(tf, { state: webState(), replace: ['aws_instance.web'] })
    expect(r.items[0].action).toBe('replace')
    expect(r.items[0].reason).toBeUndefined()
  })

  it('keeps a forced replacement of something that does not exist a plain create', () => {
    const r = plan(WEB, { replace: ['aws_instance.web'] })
    expect(r.items).toMatchObject([{ action: 'create' }])
    expect(r.items[0].reason).toBeUndefined()
    expect(r.warnings).toEqual([])
  })

  it('warns about a -replace address that matches nothing, without changing the plan', () => {
    const r = plan(WEB, { state: webState(), replace: ['aws_instance.nope'] })
    expect(r.diagnostics).toEqual([])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatchObject({ severity: 'warning', summary: 'Incompletely-matched force-replace resource instance' })
    expect(r.warnings[0].detail).toContain('aws_instance.nope')
    expect(r.items).toMatchObject([{ action: 'noop' }])
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
