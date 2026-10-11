import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-cross-account-replication-dr')
const s1 = atStage(sc, 0)
const s2 = atStage(sc, 1)
const s3 = atStage(sc, 2)
const KEY = 'arn:aws:kms:us-west-2:444455556666:key/9f8e7d6c-5b4a-4321-8fed-cba987654321'
const K = `aws kms put-key-policy --key-id ${KEY} --policy-name default --policy file://dr-key-policy.json --profile dr`

describe('aws-cross-account-replication-dr stage 1', () => {
  it('requires codifying the key policy', () => expect(s1.solution_paths).toEqual([['grant-key', 'codify-key-policy']]))
  it.each([K, `  ${K}`, K.replace('dr-key-policy.json', 'key.v2.json')])('credits %s', (c) => expect(actionFor(s1, c)?.id).toBe('grant-key'))
  it.each([
    K.replace(KEY, 'arn:aws:kms:us-east-1:111122223333:key/1a2b3c4d-1111-2222-3333-444455556666'),
    K.replace(KEY, 'alias/other'),
    K.replace('--profile dr', ''),
    K.replace('--profile dr', '--profile prod'),
    `${K}; aws kms schedule-key-deletion --key-id ${KEY}`,
    `${K} && echo`,
    K.replace('file://dr-key-policy.json', 'file://$(curl x)'),
    K.replace('file://dr-key-policy.json', 'file://a;b'),
    K.replace('file://dr-key-policy.json', 'file://*'),
    K.replace('file://dr-key-policy.json', 'file:///etc/passwd'),
    K.replace('file://dr-key-policy.json', 'file://../key.json'),
    K.replace('file://dr-key-policy.json', 'file://a/b.json'),
    K.replace('file://dr-key-policy.json', 'file://..'),
    K.replace('--policy-name default', '--policy-name other'),
    `${K} --bypass-policy-lockout-safety-check`,
    `${K} --profile prod`,
  ])('does not credit %s', (c) => expect(actionFor(s1, c)?.id).not.toBe('grant-key'))
  it.each([
    `aws kms put-key-policy --key-id ${KEY} --policy-name default --policy '{"Statement":[{"Effect":"Allow","Principal":"*","Action":"kms:Encrypt","Resource":"*"}]}' --profile dr`,
    `aws kms put-key-policy --key-id ${KEY} --policy-name default --policy '{"Statement":[{"Effect":"Allow","Principal":{"AWS":"*"},"Action":"kms:*","Resource":"*"}]}' --profile dr`,
    `aws kms put-key-policy --key-id ${KEY} --policy-name default --policy '{"Statement":[{"Effect":"Allow","Principal":{"AWS":["*"]},"Action":"kms:*","Resource":"*"}]}' --profile dr`,
    `aws kms put-key-policy --key-id ${KEY} --policy-name default --policy '{"Statement":[{"Effect":"Allow","Principal":["*"],"Action":"kms:*","Resource":"*"}]}' --profile dr`,
    `aws kms put-key-policy --key-id ${KEY} --policy-name default --policy "{\\"Statement\\":[{\\"Principal\\":\\"*\\"}]}" --profile dr`,
  ])('flags a wildcard principal as destructive: %s', (c) => expect(actionFor(s1, c)).toMatchObject({ id: 'open-key', kind: 'destructive' }))
})

describe('aws-cross-account-replication-dr stage 2', () => {
  it('requires the module fix too', () => expect(s2.solution_paths).toEqual([['enforce-owner', 'fix-module']]))
  it('keeps owner override as a non-credited, honestly explained route', () => {
    const a = s2.actions.find((x) => x.id === 'owner-override')!
    expect(a.kind).toBe('wrong')
    expect(a.feedback).toMatch(/insufficient here/)
  })
})

describe('aws-cross-account-replication-dr stage 3', () => {
  it('requires the alarm', () => expect(s3.solution_paths).toEqual([['batch-none-failed', 'alarm-failed-replication']]))
  const job = (statuses: string, extra = '') =>
    `aws s3control create-job --account-id 111122223333 --operation '{"S3ReplicateObject":{}}' --manifest-generator '{"S3JobManifestGenerator":{"ExpectedBucketOwner":"111122223333","SourceBucket":"arn:aws:s3:::acme-orders-docs","EnableManifestOutput":false,"Filter":{"EligibleForReplication":true,"ObjectReplicationStatuses":${statuses}}}}' --priority 10 --role-arn arn:aws:iam::111122223333:role/batch-repl --report '{"Enabled":false}'${extra}`
  const dq = job('["NONE","FAILED"]').replace(/--manifest-generator '(.*?)' --priority/, (_m, d: string) => `--manifest-generator "${d.replaceAll('"', '\\"')}" --priority`)
  it.each([job('["NONE","FAILED"]'), job('["FAILED","NONE"]'), job('[ "NONE", "FAILED" ]'), dq])('credits %s', (c) => expect(actionFor(s3, c)?.id).toBe('batch-none-failed'))
  it.each([
    job('["FAILED"]'),
    job('["NONE"]'),
    job('["NONE","FAILED","COMPLETED"]'),
    job('["NONE","FAILED"]', '; aws s3 rb s3://acme-dr-orders-docs --force'),
    job('["NONE","FAILED"]', ' && echo'),
    job('["NONE","FAILED"]').replace('111122223333 --operation', '999999999999 --operation'),
    job('["NONE","FAILED"]').replace('acme-orders-docs', 'other-bucket'),
    job('["NONE","FAILED"]', ' --account-id 999999999999'),
    job('["NONE","FAILED"]').replace('S3ReplicateObject', 'S3PutObjectCopy'),
    job('["NONE","FAILED"]').replace('"EligibleForReplication":true', '"EligibleForReplication":false'),
    job('["NONE","FAILED"]').replace('"EligibleForReplication":true,', ''),
    job('["NONE","FAILED"]').replace('"EligibleForReplication":true', '"EligibleForReplication":true,"CreatedAfter":"2026-09-29T00:00:00Z"'),
    job('["NONE","FAILED"]').replace('"EligibleForReplication":true', '"EligibleForReplication":true,"CreatedBefore":"2026-09-29T00:00:00Z"'),
    job('["NONE","FAILED"]').replace('"EligibleForReplication":true', '"EligibleForReplication":true,"KeyNameConstraint":{"MatchAnySuffix":[".pdf"]}'),
    job('["NONE","FAILED"]').replace('"EligibleForReplication":true', '"EligibleForReplication":true,"MatchAnyPrefix":["invoices/"]'),
    job('["NONE","FAILED"]').replace('"ExpectedBucketOwner":"111122223333"', '"ExpectedBucketOwner":"999999999999"'),
    job('["NONE","FAILED"]', ' --role-arn arn:aws:iam::111122223333:role/other'),
    job('["NONE","FAILED"]', ' --operation \'{"S3ReplicateObject":{}}\''),
    job('["NONE","FAILED"]', ' --manifest-generator \'{}\''),
  ])('does not credit %s', (c) => expect(actionFor(s3, c)?.id).not.toBe('batch-none-failed'))
  it.each([
    job('["NONE","FAILED"]').replace('"EligibleForReplication":true', '"EligibleForReplication":false'),
    job('["NONE","FAILED"]').replace('"EligibleForReplication":true', '"EligibleForReplication":true,"CreatedAfter":"2026-09-29T00:00:00Z"'),
    job('["NONE","FAILED"]').replace('"ExpectedBucketOwner":"111122223333"', '"ExpectedBucketOwner":"999999999999"'),
  ])('flags a job that does not cover every object as wrong: %s', (c) => expect(actionFor(s3, c)).toMatchObject({ id: 'batch-narrow-job', kind: 'wrong' }))
  it('flags FAILED-only as wrong', () => expect(actionFor(s3, job('["FAILED"]'))).toMatchObject({ id: 'batch-failed-only', kind: 'wrong' }))
})
