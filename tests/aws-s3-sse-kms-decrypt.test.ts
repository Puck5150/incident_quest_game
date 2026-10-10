import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-s3-sse-kms-decrypt')

describe('aws-s3-sse-kms-decrypt', () => {
  it('requires re-encrypting existing objects as well as the scoped grant', () => expect(sc.solution_paths).toEqual([['grant-decrypt', 'reencrypt-existing']]))
  it('keeps broad KMS access and key deletion out of the fix', () => {
    expect(sc.actions.find((a) => a.id === 'kms-star')?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'back-to-sse-s3')?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'delete-key')?.kind).toBe('destructive')
  })
  it('scopes the grant to the one key', () => expect(sc.actions.find((a) => a.id === 'grant-decrypt')?.label).toMatch(/kms:ViaService/))
})
