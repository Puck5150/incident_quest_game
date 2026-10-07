import { describe, expect, it } from 'vitest'
import { diffInstance, SCHEMAS, schemaFor, unsupportedType } from '../src/game/terraform/resources.ts'
import { UNKNOWN } from '../src/game/terraform/eval.ts'

describe('resource schemas', () => {
  it('knows the AWS types the incidents use', () => {
    for (const t of ['aws_vpc', 'aws_subnet', 'aws_security_group', 'aws_instance', 'aws_db_instance', 'aws_s3_bucket', 'aws_sqs_queue', 'aws_iam_role', 'aws_ecs_service', 'aws_cloudwatch_log_group']) {
      expect(schemaFor(t), t).toBeDefined()
    }
  })

  it('marks the attributes that force replacement', () => {
    expect(schemaFor('aws_db_instance')!.attrs.storage_encrypted.forceNew).toBe(true)
    expect(schemaFor('aws_db_instance')!.attrs.instance_class.forceNew).toBeFalsy()
    expect(schemaFor('aws_s3_bucket')!.attrs.bucket.forceNew).toBe(true)
    expect(schemaFor('aws_subnet')!.attrs.vpc_id.forceNew).toBe(true)
    expect(schemaFor('aws_instance')!.attrs.instance_type.forceNew).toBeFalsy()
  })

  it('gives every schema a read-only id and arn, and marks secrets', () => {
    for (const [t, s] of Object.entries(SCHEMAS)) {
      expect(s.attrs.id?.readOnly, `${t}.id`).toBe(true)
      expect(s.attrs.arn?.readOnly, `${t}.arn`).toBe(true)
    }
    expect(schemaFor('aws_db_instance')!.attrs.password.sensitive).toBe(true)
  })

  it('does not find inherited names, and reports an unmodeled type honestly', () => {
    expect(schemaFor('constructor')).toBeUndefined()
    expect(schemaFor('aws_nope')).toBeUndefined()
    expect(unsupportedType('aws_nope')).toEqual({
      summary: 'Invalid resource type',
      detail: 'The provider hashicorp/aws does not support resource type "aws_nope". (This lab only models some resource types.)',
    })
  })
})

const vpc = schemaFor('aws_vpc')!
const VPC_PRIOR = {
  id: 'vpc-1',
  arn: 'arn:aws:ec2:us-east-1:111111111111:vpc/vpc-1',
  cidr_block: '10.0.0.0/16',
  enable_dns_support: true,
  enable_dns_hostnames: false,
  tags: { Name: 'main' },
  tags_all: { Name: 'main' },
  default_security_group_id: 'sg-1',
}

describe('diffInstance', () => {
  it('treats an attribute missing from older state as holding its default', () => {
    const sg = schemaFor('aws_security_group')!
    expect(diffInstance(sg, { name: 'web', vpc_id: 'vpc-1' }, { id: 'sg-1', name: 'web', vpc_id: 'vpc-1' }).action).toBe('noop')
    const role = schemaFor('aws_iam_role')!
    expect(diffInstance(role, { name: 'r' }, { id: 'r', name: 'r' }).action).toBe('noop')
    const q = schemaFor('aws_sqs_queue')!
    expect(diffInstance(q, { name: 'q' }, { id: 'q', name: 'q', fifo_queue: null }).action).toBe('noop')
    const p = diffInstance(role, { name: 'r', path: '/svc/' }, { id: 'r', name: 'r' })
    expect(p.action).toBe('replace')
    expect(p.changes.find((c) => c.name === 'path')).toMatchObject({ before: '/', after: '/svc/', forcesReplacement: true })
  })

  it('keeps prior values of ignored attributes on a replace', () => {
    const inst = schemaFor('aws_instance')!
    const prior = { id: 'i-1', ami: 'ami-1', tags: { a: 'old' } }
    const p = diffInstance(inst, { ami: 'ami-2', tags: { a: 'new' } }, prior, ['tags'])
    expect(p.action).toBe('replace')
    expect(p.planned.tags).toEqual({ a: 'old' })
    expect(p.changes.find((c) => c.name === 'tags')).toBeUndefined()
  })

  it('creates, with defaults filled in and provider-set values unknown', () => {
    const p = diffInstance(vpc, { cidr_block: '10.0.0.0/16', tags: { Name: 'main' } }, undefined)
    expect(p.action).toBe('create')
    expect(p.changes.map((c) => c.name)).toEqual(['arn', 'cidr_block', 'default_security_group_id', 'enable_dns_hostnames', 'enable_dns_support', 'id', 'tags', 'tags_all'])
    expect(p.planned).toMatchObject({ id: UNKNOWN, arn: UNKNOWN, cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, tags: { Name: 'main' } })
    expect(p.changes.every((c) => c.before === undefined && !c.forcesReplacement)).toBe(true)
  })

  it('is a no-op when configuration matches state, and ignores what the provider fills in', () => {
    const p = diffInstance(vpc, { cidr_block: '10.0.0.0/16', tags: { Name: 'main' } }, VPC_PRIOR)
    expect(p).toMatchObject({ action: 'noop', changes: [] })
    expect(p.planned).toEqual(VPC_PRIOR)
  })

  it('updates in place when a non-forcing attribute changes, keeping computed values', () => {
    const inst = schemaFor('aws_instance')!
    const prior = { id: 'i-1', arn: 'arn:i-1', ami: 'ami-1', instance_type: 't3.micro', private_ip: '10.0.1.5', availability_zone: 'us-east-1a' }
    const p = diffInstance(inst, { ami: 'ami-1', instance_type: 't3.small' }, prior)
    expect(p.action).toBe('update')
    expect(p.changes).toEqual([{ name: 'instance_type', before: 't3.micro', after: 't3.small', forcesReplacement: false, sensitive: false }])
    expect(p.planned).toMatchObject({ id: 'i-1', instance_type: 't3.small', private_ip: '10.0.1.5' })
  })

  it('replaces when a forcing attribute changes, and shows what will be recomputed', () => {
    const db = schemaFor('aws_db_instance')!
    const prior = { id: 'db-1', arn: 'arn:db-1', identifier: 'orders-prod', engine: 'postgres', instance_class: 'db.r6g.large', storage_encrypted: false, endpoint: 'orders.example:5432' }
    const p = diffInstance(db, { identifier: 'orders-prod', engine: 'postgres', instance_class: 'db.r6g.large', storage_encrypted: true }, prior)
    expect(p.action).toBe('replace')
    const byName = Object.fromEntries(p.changes.map((c) => [c.name, c]))
    expect(byName.storage_encrypted).toMatchObject({ before: false, after: true, forcesReplacement: true })
    expect(byName.id).toMatchObject({ before: 'db-1', after: UNKNOWN, forcesReplacement: false })
    expect(byName.endpoint).toMatchObject({ before: 'orders.example:5432', after: UNKNOWN })
    expect(p.planned).toMatchObject({ id: UNKNOWN, identifier: 'orders-prod', storage_encrypted: true })
  })

  it('treats an unknown configured value as a change, and a replacement if the attribute forces one', () => {
    const subnet = schemaFor('aws_subnet')!
    const prior = { id: 'subnet-1', arn: 'arn:s', vpc_id: 'vpc-1', cidr_block: '10.0.1.0/24', availability_zone: 'us-east-1a' }
    const p = diffInstance(subnet, { vpc_id: UNKNOWN, cidr_block: '10.0.1.0/24' }, prior)
    expect(p.action).toBe('replace')
    expect(p.changes.find((c) => c.name === 'vpc_id')).toMatchObject({ before: 'vpc-1', after: UNKNOWN, forcesReplacement: true })
  })

  it('turns a removed attribute into a change to null', () => {
    const p = diffInstance(vpc, { cidr_block: '10.0.0.0/16' }, VPC_PRIOR)
    expect(p.action).toBe('update')
    expect(p.changes).toEqual([{ name: 'tags', before: { Name: 'main' }, after: null, forcesReplacement: false, sensitive: false }])
  })

  it('applies provider defaults when an attribute is omitted', () => {
    const q = schemaFor('aws_sqs_queue')!
    const prior = { id: 'q-1', arn: 'arn:q', name: 'jobs', fifo_queue: false, visibility_timeout_seconds: 30, message_retention_seconds: 345600 }
    expect(diffInstance(q, { name: 'jobs' }, prior).action).toBe('noop')
    const p = diffInstance(q, { name: 'jobs', visibility_timeout_seconds: 60 }, prior)
    expect(p).toMatchObject({ action: 'update', changes: [{ name: 'visibility_timeout_seconds', before: 30, after: 60 }] })
  })

  it('suppresses changes to ignored attributes only, by name or all', () => {
    const inst = schemaFor('aws_instance')!
    const prior = { id: 'i-1', arn: 'a', ami: 'ami-1', instance_type: 't3.micro' }
    const cfg = { ami: 'ami-2', instance_type: 't3.small' }
    const partly = diffInstance(inst, cfg, prior, ['instance_type'])
    expect(partly.action).toBe('replace')
    expect(partly.changes.map((c) => c.name)).toContain('ami')
    expect(partly.changes.map((c) => c.name)).not.toContain('instance_type')
    expect(diffInstance(inst, { ami: 'ami-1', instance_type: 't3.small' }, prior, ['instance_type']).action).toBe('noop')
    expect(diffInstance(inst, cfg, prior, 'all').action).toBe('noop')
  })

  it('a forced replacement under ignore_changes = all still gets a new id', () => {
    const inst = schemaFor('aws_instance')!
    const prior = { id: 'i-1', arn: 'a', ami: 'ami-1', instance_type: 't3.micro' }
    const p = diffInstance(inst, { ami: 'ami-2', instance_type: 't3.micro' }, prior, 'all', true)
    expect(p.action).toBe('replace')
    expect(p.planned.id).toBe(UNKNOWN)
    expect(p.planned.ami).toBe('ami-1')
    expect(p.changes.find((c) => c.name === 'id')).toMatchObject({ before: 'i-1', after: UNKNOWN })
  })

  it('still creates a missing resource whatever is ignored', () => {
    expect(diffInstance(vpc, { cidr_block: '10.0.0.0/16' }, undefined, 'all').action).toBe('create')
  })

  it('marks sensitive attributes and passes unmodeled attributes through unforced', () => {
    const db = schemaFor('aws_db_instance')!
    const prior = { id: 'db-1', arn: 'a', identifier: 'x', engine: 'postgres', password: 'old' }
    const p = diffInstance(db, { identifier: 'x', engine: 'postgres', password: 'new', future_flag: true }, prior)
    expect(p.action).toBe('update')
    expect(p.changes.find((c) => c.name === 'password')).toMatchObject({ sensitive: true })
    expect(p.changes.find((c) => c.name === 'future_flag')).toMatchObject({ before: undefined, after: true, forcesReplacement: false })
  })

  it('survives an attribute named __proto__ without touching prototypes', () => {
    const cfg = Object.defineProperty({ cidr_block: '10.0.0.0/16' }, '__proto__', { value: 1, enumerable: true, configurable: true, writable: true })
    const p = diffInstance(vpc, cfg, undefined)
    expect(Object.getPrototypeOf(p.planned)).toBe(Object.prototype)
    expect(Object.keys(p.planned)).toContain('__proto__')
  })
})

describe('diffInstance: forced replacement', () => {
  const inst = schemaFor('aws_instance')!
  const prior = { id: 'i-1', arn: 'arn:i-1', ami: 'ami-1', instance_type: 't3.micro', private_ip: '10.0.1.5', tags: { Name: 'web' } }
  const cfg = { ami: 'ami-1', instance_type: 't3.micro', tags: { Name: 'web' } }

  it('replaces an unchanged instance when forced, recomputing what the provider sets', () => {
    const p = diffInstance(inst, cfg, prior, [], true)
    expect(p.action).toBe('replace')
    const byName = Object.fromEntries(p.changes.map((c) => [c.name, c]))
    expect(byName.id).toMatchObject({ before: 'i-1', after: UNKNOWN, forcesReplacement: false })
    expect(byName.private_ip).toMatchObject({ before: '10.0.1.5', after: UNKNOWN })
    expect(byName.instance_type).toBeUndefined()
    expect(p.planned).toMatchObject({ id: UNKNOWN, ami: 'ami-1', instance_type: 't3.micro', tags: { Name: 'web' } })
  })

  it('is not forced when force is false, and ignores force for something that does not exist yet', () => {
    expect(diffInstance(inst, cfg, prior, [], false).action).toBe('noop')
    expect(diffInstance(inst, cfg, undefined, [], true).action).toBe('create')
  })

  it('keeps the prior values of ignored attributes on a forced replacement', () => {
    const p = diffInstance(inst, { ...cfg, tags: { Name: 'changed' } }, prior, ['tags'], true)
    expect(p.action).toBe('replace')
    expect(p.planned.tags).toEqual({ Name: 'web' })
    expect(p.changes.some((c) => c.name === 'tags')).toBe(false)
  })

  it('still reports the changed attributes when a forced replacement also has real changes', () => {
    const p = diffInstance(inst, { ...cfg, instance_type: 't3.small' }, prior, [], true)
    expect(p.action).toBe('replace')
    expect(p.changes.find((c) => c.name === 'instance_type')).toMatchObject({ before: 't3.micro', after: 't3.small' })
  })
})
