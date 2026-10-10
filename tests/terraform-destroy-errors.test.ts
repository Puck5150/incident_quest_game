import { describe, expect, it } from 'vitest'
import { executeApply, type ApplyContext } from '../src/game/terraform/apply.ts'
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
const cloudOf = (state: State): Reality =>
  Object.fromEntries(state.resources.flatMap((r) => r.instances.map((i) => [realityKey(r.type, i.attributes.id as string), structuredClone(i.attributes)] as const)))
const ctx = (): ApplyContext => ({ faults: [], taken: new Set(), attempts: new Map(), seed: '1' })
const run = (tf: string, state: State, reality: Reality, destroy: boolean) => executeApply({ files: [{ name: 'main.tf', text: tf }], state, reality, vars: {}, destroy }, ctx())
const obj = (b: string, k: string): [string, Record<string, Value>] => [realityKey('aws_s3_object', `${b}/${k}`), { id: `${b}/${k}`, bucket: b, key: k }]

const bucket = (force: boolean) => ({ id: 'logs-1', arn: 'arn:aws:s3:::logs-1', bucket: 'logs-1', force_destroy: force, tags: {}, tags_all: {}, bucket_domain_name: 'logs-1.s3.amazonaws.com' })
const bucketTf = (force: boolean) => `resource "aws_s3_bucket" "logs" {\n  bucket        = "logs-1"\n  force_destroy = ${force}\n}\n`
const withObjects = (state: State): Reality => ({ ...cloudOf(state), ...Object.fromEntries([obj('logs-1', 'a/1.log'), obj('logs-1', 'b.log')]) })

describe('BucketNotEmpty', () => {
  const state = stateOf({ type: 'aws_s3_bucket', name: 'logs', attrs: bucket(false) })
  it('refuses to delete a non-empty bucket with force_destroy false in state, even after editing the config', () => {
    for (const force of [false, true]) {
      const r = run(bucketTf(force), state, withObjects(state), true)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0].summary).toMatch(/^deleting S3 Bucket \(logs-1\): operation error S3: DeleteBucket, https response error StatusCode: 409, RequestID: [0-9a-f-]{36}, HostID: \S+, api error BucketNotEmpty: The bucket you tried to delete is not empty$/)
      expect(r.errors[0].context).toBe('resource "aws_s3_bucket" "logs"')
      expect(r.errors[0].address).toBe('aws_s3_bucket.logs')
      expect(r.errors[0].file).toBe('main.tf')
      expect(r.errors[0].line).toBe(1)
      expect(r.counts.destroyed).toBe(0)
      expect(listAddresses(r.state)).toEqual(['aws_s3_bucket.logs'])
      expect(Object.keys(r.reality)).toHaveLength(3)
    }
  })
  it('succeeds after an apply wrote force_destroy = true into state, removing the objects', () => {
    const up = run(bucketTf(true), state, withObjects(state), false)
    expect(up.errors).toEqual([])
    expect(up.counts.changed).toBe(1)
    const r = run(bucketTf(true), up.state, up.reality, true)
    expect(r.errors).toEqual([])
    expect(r.counts.destroyed).toBe(1)
    expect(r.reality).toEqual({})
    expect(listAddresses(r.state)).toEqual([])
  })
  it('deletes an empty bucket', () => {
    const r = run(bucketTf(false), state, cloudOf(state), true)
    expect(r.errors).toEqual([])
    expect(r.reality).toEqual({})
  })
})

const SG = { id: 'sg-9', arn: 'arn:sg-9', name: 'web', description: 'd', vpc_id: null, ingress: [], egress: [], tags: {}, tags_all: {} }
const SUBNET = { id: 'subnet-1', arn: 'arn:subnet-1', vpc_id: 'vpc-1', cidr_block: '10.0.1.0/24', tags: {}, tags_all: {} }
const VPC = { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', tags: {}, tags_all: {} }
const eni = (extra: Record<string, Value>): Reality => ({ [realityKey('aws_network_interface', 'eni-1')]: { id: 'eni-1', ...extra } })

describe('blockers', () => {
  it('subnet blocked by an ENI that mentions it', () => {
    const st = stateOf({ type: 'aws_subnet', name: 's', attrs: SUBNET })
    const re = { ...cloudOf(st), ...eni({ subnet_id: 'subnet-1' }) }
    const tf = 'resource "aws_subnet" "s" {\n  vpc_id     = "vpc-1"\n  cidr_block = "10.0.1.0/24"\n}\n'
    const r = run(tf, st, re, true)
    expect(r.errors[0].summary).toMatch(/^deleting EC2 Subnet \(subnet-1\): operation error EC2: DeleteSubnet, https response error StatusCode: 400, RequestID: [0-9a-f-]{36}, api error DependencyViolation: The subnet 'subnet-1' has dependencies and cannot be deleted\.$/)
    // second destroy after the blocker is gone
    const { [realityKey('aws_network_interface', 'eni-1')]: _, ...rest } = r.reality
    const again = run(tf, r.state, rest, true)
    expect(again.errors).toEqual([])
    expect(again.counts.destroyed).toBe(1)
  })
  it('SG blocked by an ENI with the wrapped text', () => {
    const st = stateOf({ type: 'aws_security_group', name: 'web', attrs: SG })
    const r = run('resource "aws_security_group" "web" {\n  name = "web"\n  description = "d"\n}\n', st, { ...cloudOf(st), ...eni({ groups: ['sg-9'] }) }, true)
    expect(r.errors[0].summary).toMatch(/^deleting Security Group \(sg-9\): operation error EC2: DeleteSecurityGroup, https response error StatusCode: 400, RequestID: [0-9a-f-]{36}, api error DependencyViolation: resource sg-9 has a dependent object$/)
  })
  it('VPC blocked by a subnet created out of band', () => {
    const st = stateOf({ type: 'aws_vpc', name: 'v', attrs: VPC })
    const r = run('resource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\n', st, { ...cloudOf(st), [realityKey('aws_subnet', 'subnet-x')]: { id: 'subnet-x', vpc_id: 'vpc-1' } }, true)
    expect(r.errors[0].summary).toContain("DeleteVpc, https response error StatusCode: 400")
    expect(r.counts.destroyed).toBe(0)
  })
  it('a failed delete skips what depends on the failed resource', () => {
    const st = stateOf({ type: 'aws_vpc', name: 'v', attrs: VPC }, { type: 'aws_subnet', name: 's', attrs: SUBNET })
    st.resources[1].instances[0].dependencies = ['aws_vpc.v']
    const tf = 'resource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\nresource "aws_subnet" "s" {\n  vpc_id     = aws_vpc.v.id\n  cidr_block = "10.0.1.0/24"\n}\n'
    const r = run(tf, st, { ...cloudOf(st), ...eni({ subnet_id: 'subnet-1' }) }, true)
    expect(r.steps.map((s) => `${s.ok ? '' : '!'}${s.op} ${s.address}`)).toEqual(['!delete aws_subnet.s'])
    expect(r.counts.destroyed).toBe(0)
  })
})
