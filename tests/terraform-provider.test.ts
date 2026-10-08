import { describe, expect, it } from 'vitest'
import { UNKNOWN } from '../src/game/terraform/eval.ts'
import { alreadyExists, dependencyViolation, fillOnCreate, fillOnUpdate, formatDuration, hex, referencedBy, requestId, seconds } from '../src/game/terraform/provider.ts'
import { realityKey, type Reality } from '../src/game/terraform/refresh.ts'

describe('deterministic helpers', () => {
  it('hex is stable, the right length, and varies with the seed', () => {
    expect(hex('a', 8)).toBe(hex('a', 8))
    expect(hex('a', 8)).toMatch(/^[0-9a-f]{8}$/)
    expect(hex('a', 20)).toMatch(/^[0-9a-f]{20}$/)
    expect(hex('a', 8)).not.toBe(hex('b', 8))
    expect(hex('a', 20).startsWith(hex('a', 8))).toBe(true)
  })
  it('request ids look like uuids', () => {
    expect(requestId('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
  it('formats durations like Terraform', () => {
    expect([formatDuration(0), formatDuration(7), formatDuration(60), formatDuration(65), formatDuration(252)]).toEqual(['0s', '7s', '1m0s', '1m5s', '4m12s'])
  })
  it('knows how long things take', () => {
    expect([seconds('aws_vpc', 'create'), seconds('aws_instance', 'delete'), seconds('aws_db_instance', 'create'), seconds('aws_nope', 'create'), seconds('aws_nope', 'update')]).toEqual([1, 33, 130, 2, 1])
  })
})

describe('fillOnCreate', () => {
  it('generates ids and arns by type', () => {
    const vpc = fillOnCreate('aws_vpc', 'aws_vpc.main', { id: UNKNOWN, arn: UNKNOWN, cidr_block: '10.0.0.0/16', default_security_group_id: UNKNOWN, tags_all: UNKNOWN }, 's1')
    expect(vpc.id).toMatch(/^vpc-0[0-9a-f]{8}$/)
    expect(vpc.arn).toBe(`arn:aws:ec2:us-east-1:123456789012:vpc/${vpc.id}`)
    expect(vpc.default_security_group_id).toMatch(/^sg-0[0-9a-f]{8}$/)
    expect(vpc.cidr_block).toBe('10.0.0.0/16')
    expect(vpc.tags_all).toBeNull()
  })

  it('uses natural names for ids where the provider does', () => {
    const db = fillOnCreate('aws_db_instance', 'aws_db_instance.o', { id: UNKNOWN, arn: UNKNOWN, identifier: 'orders-db', endpoint: UNKNOWN, engine_version: UNKNOWN, multi_az: true }, 's')
    expect(db).toMatchObject({ id: 'orders-db', arn: 'arn:aws:rds:us-east-1:123456789012:db:orders-db', engine_version: '15.4', allocated_storage: 20, multi_az: true })
    expect(db.endpoint).toMatch(/^orders-db\.c[0-9a-f]{10}\.us-east-1\.rds\.amazonaws\.com:5432$/)
    expect(fillOnCreate('aws_s3_bucket', 'a.b', { id: UNKNOWN, arn: UNKNOWN, bucket: 'logs' }, 's')).toMatchObject({ id: 'logs', arn: 'arn:aws:s3:::logs', bucket_domain_name: 'logs.s3.amazonaws.com' })
    expect(fillOnCreate('aws_sqs_queue', 'a.b', { id: UNKNOWN, arn: UNKNOWN, name: 'jobs' }, 's')).toMatchObject({ id: 'https://sqs.us-east-1.amazonaws.com/123456789012/jobs', url: 'https://sqs.us-east-1.amazonaws.com/123456789012/jobs', arn: 'arn:aws:sqs:us-east-1:123456789012:jobs' })
    expect(fillOnCreate('aws_iam_role', 'a.b', { id: UNKNOWN, arn: UNKNOWN, name: 'app', path: '/svc/' }, 's').arn).toBe('arn:aws:iam::123456789012:role/svc/app')
    expect(fillOnCreate('aws_iam_role', 'a.b', { id: UNKNOWN, arn: UNKNOWN, name: 'app' }, 's').arn).toBe('arn:aws:iam::123456789012:role/app')
    expect(fillOnCreate('aws_ecs_service', 'a.b', { id: UNKNOWN, arn: UNKNOWN, name: 'web', cluster: 'prod' }, 's')).toMatchObject({ id: 'arn:aws:ecs:us-east-1:123456789012:service/prod/web' })
  })

  it('does not overwrite configured values, is deterministic, and varies by address and seed', () => {
    const a = fillOnCreate('aws_instance', 'aws_instance.w', { id: UNKNOWN, arn: UNKNOWN, ami: 'ami-1', private_ip: UNKNOWN, availability_zone: 'us-east-1b' }, 's1')
    expect(a.availability_zone).toBe('us-east-1b')
    expect(a.private_ip).toMatch(/^10\.0\.\d{1,3}\.\d{1,3}$/)
    expect(fillOnCreate('aws_instance', 'aws_instance.w', { id: UNKNOWN, arn: UNKNOWN }, 's1').id).toBe(fillOnCreate('aws_instance', 'aws_instance.w', { id: UNKNOWN, arn: UNKNOWN }, 's1').id)
    expect(fillOnCreate('aws_instance', 'aws_instance.w', { id: UNKNOWN, arn: UNKNOWN }, 's2').id).not.toBe(fillOnCreate('aws_instance', 'aws_instance.w', { id: UNKNOWN, arn: UNKNOWN }, 's1').id)
    expect(fillOnCreate('aws_instance', 'aws_instance.x', { id: UNKNOWN, arn: UNKNOWN }, 's1').id).not.toBe(fillOnCreate('aws_instance', 'aws_instance.w', { id: UNKNOWN, arn: UNKNOWN }, 's1').id)
  })

  it('handles unknown types and does not mutate its input', () => {
    const input = { id: UNKNOWN, thing: UNKNOWN, keep: 1 }
    const out = fillOnCreate('aws_new_thing', 'aws_new_thing.t', input, 's')
    expect(out.id).toMatch(/^new-thing-0[0-9a-f]{8}$/)
    expect(out).toMatchObject({ thing: null, keep: 1 })
    expect(input.id).toBe(UNKNOWN)
  })
})

describe('fillOnUpdate', () => {
  it('keeps prior values for attributes that are unknown after the update', () => {
    expect(fillOnUpdate({ id: 'i-1', ip: '10.0.0.5' }, { id: 'i-1', ip: UNKNOWN, extra: UNKNOWN, t: 'x' })).toEqual({ id: 'i-1', ip: '10.0.0.5', extra: null, t: 'x' })
  })
})

describe('alreadyExists', () => {
  const reality: Reality = {
    [realityKey('aws_s3_bucket', 'legacy')]: { id: 'legacy', bucket: 'legacy' },
    [realityKey('aws_iam_role', 'app')]: { id: 'app', name: 'app' },
    [realityKey('aws_sqs_queue', 'https://q/jobs')]: { id: 'https://q/jobs', name: 'jobs' },
    [realityKey('aws_db_instance', 'db-ORDERS1234')]: { id: 'db-ORDERS1234', identifier: 'orders-db' },
  }
  it('returns the provider error when the natural name is taken', () => {
    expect(alreadyExists('aws_s3_bucket', { bucket: 'legacy' }, reality, 's')).toMatch(/^creating S3 Bucket \(legacy\): operation error S3: CreateBucket, https response error StatusCode: 409, RequestID: [0-9a-f-]{36}, BucketAlreadyOwnedByYou: /)
    expect(alreadyExists('aws_iam_role', { name: 'app' }, reality, 's')).toContain('EntityAlreadyExists: Role with name app already exists.')
    expect(alreadyExists('aws_sqs_queue', { name: 'jobs' }, reality, 's')).toContain('creating SQS Queue (jobs): QueueNameExists')
  })
  it('matches the natural-key attribute, not only the reality key (an RDS instance keyed by its resource id)', () => {
    expect(alreadyExists('aws_db_instance', { identifier: 'orders-db' }, reality, 's')).toContain('creating RDS DB Instance (orders-db): operation error RDS: CreateDBInstance')
    expect(alreadyExists('aws_db_instance', { identifier: 'other-db' }, reality, 's')).toBeUndefined()
    expect(alreadyExists('aws_iam_role', { name: 'orders-db' }, reality, 's')).toBeUndefined() // only objects of the same type
  })
  it('is undefined when the name is free or the type has no natural key', () => {
    expect(alreadyExists('aws_s3_bucket', { bucket: 'fresh' }, reality, 's')).toBeUndefined()
    expect(alreadyExists('aws_vpc', { cidr_block: 'x' }, reality, 's')).toBeUndefined()
    expect(alreadyExists('aws_s3_bucket', {}, reality, 's')).toBeUndefined()
  })
})

describe('referencedBy and dependencyViolation', () => {
  const reality: Reality = {
    [realityKey('aws_vpc', 'vpc-1')]: { id: 'vpc-1' },
    [realityKey('aws_subnet', 'subnet-1')]: { id: 'subnet-1', vpc_id: 'vpc-1' },
    [realityKey('aws_instance', 'i-1')]: { id: 'i-1', nics: [{ subnet: 'subnet-1' }] },
  }
  it('finds the first object that mentions the id, ignoring the object itself', () => {
    expect(referencedBy(reality, 'aws_vpc', 'vpc-1')).toEqual({ type: 'aws_subnet', id: 'subnet-1' })
    expect(referencedBy(reality, 'aws_subnet', 'subnet-1')).toEqual({ type: 'aws_instance', id: 'i-1' })
    expect(referencedBy(reality, 'aws_instance', 'i-1')).toBeUndefined()
  })
  it('words the refusal per type', () => {
    expect(dependencyViolation('aws_vpc', 'vpc-1', 's')).toMatch(/^deleting EC2 VPC \(vpc-1\): operation error EC2: DeleteVpc, https response error StatusCode: 400, RequestID: [0-9a-f-]{36}, api error DependencyViolation: The vpc 'vpc-1' has dependencies and cannot be deleted\.$/)
    expect(dependencyViolation('aws_subnet', 'subnet-1', 's')).toContain("The subnet 'subnet-1' has dependencies and cannot be deleted.")
    expect(dependencyViolation('aws_security_group', 'sg-1', 's')).toBe('deleting Security Group (sg-1): DependencyViolation: resource sg-1 has a dependent object')
    expect(dependencyViolation('aws_other', 'x-1', 's')).toBe('deleting aws_other (x-1): DependencyViolation: the object has dependencies and cannot be deleted')
  })
})
