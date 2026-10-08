import { describe, expect, it } from 'vitest'
import { UNKNOWN, type Value } from '../src/game/terraform/eval.ts'
import { emptyState, findInstance, instanceAddress, listAddresses, stateJson, type State } from '../src/game/terraform/state.ts'
import { realityKey, refresh } from '../src/game/terraform/refresh.ts'

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]'
const sample = (): State => ({
  ...emptyState(),
  serial: 7,
  resources: [
    { mode: 'managed', type: 'aws_vpc', name: 'main', provider: AWS, instances: [{ attributes: { id: 'vpc-1', cidr_block: '10.0.0.0/16', tags: { Name: 'main' } } }] },
    {
      mode: 'managed',
      type: 'aws_s3_bucket',
      name: 'b',
      provider: AWS,
      instances: [
        { index_key: 'b', attributes: { id: 'bkt-b', bucket: 'bkt-b' } },
        { index_key: 'a', attributes: { id: 'bkt-a', bucket: 'bkt-a' } },
      ],
    },
    { mode: 'managed', type: 'aws_subnet', name: 's', provider: AWS, instances: [{ index_key: 0, attributes: { id: 'subnet-0', vpc_id: 'vpc-1' } }] },
    { mode: 'data', type: 'aws_ami', name: 'x', provider: AWS, instances: [{ attributes: { id: 'ami-1' } }] },
  ],
})

describe('state model', () => {
  it('builds addresses for single, counted, keyed and data instances', () => {
    expect(instanceAddress({ mode: 'managed', type: 'aws_vpc', name: 'main' })).toBe('aws_vpc.main')
    expect(instanceAddress({ mode: 'managed', type: 'aws_subnet', name: 's' }, 0)).toBe('aws_subnet.s[0]')
    expect(instanceAddress({ mode: 'managed', type: 'aws_s3_bucket', name: 'b' }, 'a')).toBe('aws_s3_bucket.b["a"]')
    expect(instanceAddress({ mode: 'data', type: 'aws_ami', name: 'x' })).toBe('data.aws_ami.x')
  })

  it('lists addresses sorted, and finds an instance by address', () => {
    expect(listAddresses(sample())).toEqual(['aws_s3_bucket.b["a"]', 'aws_s3_bucket.b["b"]', 'aws_subnet.s[0]', 'aws_vpc.main', 'data.aws_ami.x'])
    expect(findInstance(sample(), 'aws_vpc.main')!.instance.attributes.id).toBe('vpc-1')
    expect(findInstance(sample(), 'aws_s3_bucket.b["a"]')!.instance.attributes.id).toBe('bkt-a')
    expect(findInstance(sample(), 'aws_vpc.nope')).toBeUndefined()
  })

  it('renders tfstate-shaped JSON with sorted attributes, and refuses unknown values', () => {
    const json = JSON.parse(stateJson(sample()))
    expect(json).toMatchObject({ version: 4, serial: 7, terraform_version: '1.9.8' })
    expect(json.resources[0]).toMatchObject({ mode: 'managed', type: 'aws_vpc', name: 'main', provider: AWS })
    expect(json.resources[0].instances[0]).toMatchObject({ schema_version: 0, sensitive_attributes: [] })
    expect(Object.keys(json.resources[0].instances[0].attributes)).toEqual(['cidr_block', 'id', 'tags'])
    expect(stateJson(sample())).toContain('\n  "version": 4,')
    const bad = sample()
    bad.resources[0].instances[0].attributes.id = UNKNOWN
    expect(() => stateJson(bad)).toThrow(/unknown/i)
  })

  it('refuses an unknown output value', () => {
    const bad = sample()
    bad.outputs = { vpc: { value: UNKNOWN } }
    expect(() => stateJson(bad)).toThrow(/output "vpc".*unknown value/)
  })
})

describe('refresh', () => {
  const vpcKey = realityKey('aws_vpc', 'vpc-1')
  // A cloud that matches the sample state exactly (every managed instance exists).
  const cloud = (vpc: Record<string, Value> = { id: 'vpc-1', cidr_block: '10.0.0.0/16', tags: { Name: 'main' } }) => ({
    [vpcKey]: vpc,
    [realityKey('aws_s3_bucket', 'bkt-a')]: { id: 'bkt-a', bucket: 'bkt-a' },
    [realityKey('aws_s3_bucket', 'bkt-b')]: { id: 'bkt-b', bucket: 'bkt-b' },
    [realityKey('aws_subnet', 'subnet-0')]: { id: 'subnet-0', vpc_id: 'vpc-1' },
  })

  it('reports no drift when the cloud matches state', () => {
    expect(refresh(sample(), cloud()).drift).toEqual([])
  })

  it('reports an attribute changed outside Terraform and updates the refreshed state, without mutating the input', () => {
    const before = sample()
    const r = refresh(before, cloud({ id: 'vpc-1', cidr_block: '10.0.0.0/16', tags: { Name: 'main', Owner: 'ops' } }))
    expect(r.drift).toEqual([{ address: 'aws_vpc.main', kind: 'changed', changes: [{ name: 'tags', before: { Name: 'main' }, after: { Name: 'main', Owner: 'ops' } }] }])
    expect(findInstance(r.state, 'aws_vpc.main')!.instance.attributes.tags).toEqual({ Name: 'main', Owner: 'ops' })
    expect(before).toEqual(sample())
  })

  it('drops a resource deleted in the cloud from the refreshed state and reports it', () => {
    const r = refresh(sample(), {})
    const d = r.drift.find((x) => x.address === 'aws_vpc.main')!
    expect(d).toEqual({ address: 'aws_vpc.main', kind: 'deleted', changes: [], before: { id: 'vpc-1', cidr_block: '10.0.0.0/16', tags: { Name: 'main' } } })
    expect(findInstance(r.state, 'aws_vpc.main')).toBeUndefined()
    expect(r.state.resources.some((x) => x.type === 'aws_vpc')).toBe(false)
  })

  it('leaves data sources alone and keeps state attributes the cloud does not report', () => {
    const r = refresh(sample(), { [vpcKey]: { id: 'vpc-1' } })
    expect(findInstance(r.state, 'data.aws_ami.x')).toBeDefined()
    expect(findInstance(r.state, 'aws_vpc.main')!.instance.attributes.cidr_block).toBe('10.0.0.0/16')
    expect(r.drift.find((x) => x.address === 'data.aws_ami.x')).toBeUndefined()
  })

  it('reports only the instances missing from the cloud as deleted, keeping the survivors', () => {
    const r = refresh(sample(), { [vpcKey]: { id: 'vpc-1' }, [realityKey('aws_s3_bucket', 'bkt-a')]: { id: 'bkt-a' } })
    expect(r.drift.filter((d) => d.kind === 'deleted').map((d) => d.address).sort()).toEqual(['aws_s3_bucket.b["b"]', 'aws_subnet.s[0]'])
    expect(findInstance(r.state, 'aws_s3_bucket.b["a"]')).toBeDefined()
  })
})

describe('state dependencies in JSON', () => {
  it('writes dependencies after sensitive_attributes only when present', () => {
    const s = emptyState()
    s.resources.push({ mode: 'managed', type: 'aws_subnet', name: 's', provider: 'p', instances: [{ attributes: { id: 'subnet-1' }, dependencies: ['aws_vpc.main'] }, { index_key: 1, attributes: { id: 'subnet-2' } }] })
    const inst = JSON.parse(stateJson(s)).resources[0].instances
    expect(inst[0]).toMatchObject({ dependencies: ['aws_vpc.main'] })
    expect(Object.keys(inst[0])).toEqual(['schema_version', 'attributes', 'sensitive_attributes', 'dependencies'])
    expect(inst[1].dependencies).toBeUndefined()
  })
})
