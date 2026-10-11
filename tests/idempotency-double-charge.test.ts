import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('idempotency-double-charge')
const act = (id: string) => sc.actions.find((a) => a.id === id)!
describe('idempotency-double-charge', () => {
  it('key is per attempt, honoured server-side, refunds are reconciled', () => {
    expect(sc.solution_paths).toEqual([['idempotency-keys', 'refund']])
    expect(act('idempotency-keys').label).toMatch(/per payment attempt/)
    expect(act('idempotency-keys').label).toMatch(/payment-service store/)
    expect(act('idempotency-keys').label).not.toMatch(/order id/)
    expect(act('refund').label).toMatch(/Reconcile/)
  })
  it('weak routes stay rejected', () => {
    expect(act('no-retries').kind).toBe('wrong')
    expect(act('dedupe-amount').kind).toBe('destructive')
  })
})
