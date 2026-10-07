import { describe, expect, it } from 'vitest'
import { SCHEMAS, schemaFor, unsupportedType } from '../src/game/terraform/resources.ts'

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
