import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('gcp-service-account-no-role')
const b = 'gcloud storage buckets add-iam-policy-binding gs://shop-invoice-templates'
const m = '--member=serviceAccount:invoice-renderer@shop-prod.iam.gserviceaccount.com'
const r = '--role=roles/storage.objectViewer'
describe('gcp-service-account-no-role', () => {
  it('also requires dealing with the default SA Editor grant', () => {
    expect(sc.solution_paths).toEqual([['grant-viewer', 'audit-default-sa']])
  })
  it('credits either flag order, --condition=None, space form', () => {
    for (const l of [`${b} ${m} ${r}`, `${b} ${r} ${m}`, `${b} ${m} ${r} --condition=None`, `${b} --role roles/storage.objectViewer --member serviceAccount:invoice-renderer@shop-prod.iam.gserviceaccount.com`])
      expect(credit(l)?.id).toBe('grant-viewer')
  })
  it('rejects other roles, repeats and metacharacters', () => {
    for (const l of [`${b} ${m} --role=roles/storage.admin`, `${b} ${m} ${r} ${r}`, `${b} ${m} ${r}; true`, `${b} --member=allUsers ${r}`])
      expect(credit(l)).toBeUndefined()
  })
})
