import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('gcp-regional-cpu-quota')
const c = 'gcloud compute instance-groups managed resize analytics-workers'
describe('gcp-regional-cpu-quota', () => {
  it('pausing alone does not complete it', () => {
    expect(sc.solution_paths).toEqual([['pause-analytics', 'request-quota', 'alert-quota', 'isolate-batch']])
  })
  it('accepts either flag order and = forms, nothing else', () => {
    for (const l of [`${c} --size 0 --region us-central1`, `${c} --region=us-central1 --size=0`]) expect(credit(l)?.id).toBe('pause-analytics')
    for (const l of [`${c} --size 5 --region us-central1`, `${c} --size 0 --region us-central1 --size 0`, `${c} --size 0 --region us-central1; true`]) expect(credit(l)).toBeUndefined()
  })
})
