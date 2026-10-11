import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { credit } = load('gcp-cloud-run-connection-exhaustion')
const c = 'gcloud run services update signup-api'
describe('gcp-cloud-run-connection-exhaustion', () => {
  it('credits a sensible cap in either flag order and spelling', () => {
    for (const l of [`${c} --max-instances 20`, `${c} --max-instances=20`, `${c} --region us-central1 --max-instances 25`, `${c} --max-instances=30 --region=us-central1`, `${c} --max-instances 16`, `${c} --max-instances 40`])
      expect(credit(l)?.id).toBe('cap-instances')
  })
  it('rejects caps that break the budget, repeats and shell tricks', () => {
    for (const l of [`${c} --max 20`, `${c} --max 100`, `${c} --max-instances 41`, `${c} --max-instances 20 --max 300`, `${c} --max-instances 20; true`, `${c} --max-instances 2`, `${c} --max-instances 4`, `${c} --max-instances 15`])
      expect(credit(l)?.id).not.toBe('cap-instances')
    expect(credit(`${c} --max 300`)?.id).toBe('raise-max')
  })
})
