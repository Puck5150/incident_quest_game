import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-access-keys-to-role')
const D = 'aws iam delete-access-key --user-name backup-bot --access-key-id AKIAIOSFODNN7EXAMPLE'
const A = 'aws ec2 associate-iam-instance-profile --instance-id i-0backup01 --iam-instance-profile Name=backup-writer'

describe('aws-access-keys-to-role', () => {
  it('requires deleting the leaked key and reviewing CloudTrail', () => expect(sc.solution_paths).toEqual([['attach-role', 'remove-keys', 'delete-leaked-key', 'review-cloudtrail']]))
  it('credits the delete', () => expect(actionFor(sc, D)?.id).toBe('delete-leaked-key'))
  it.each([`${D}; aws iam delete-user --user-name x`, `${D} && echo`, D.replace('backup-bot', 'admin'), D.replace('EXAMPLE', 'EXAMPLF'), D.replace('delete', 'update').replace('--access-key-id', '--status Inactive --access-key-id'), `${D}x`])('does not credit %s', (c) =>
    expect(actionFor(sc, c)?.id).not.toBe('delete-leaked-key'),
  )
  it('credits only the exact association', () => {
    expect(actionFor(sc, A)?.id).toBe('attach-role')
    expect(actionFor(sc, `${A}; echo`)?.id).not.toBe('attach-role')
    expect(actionFor(sc, A.replace('backup-writer', 'AdminRole'))?.id).not.toBe('attach-role')
  })
})
