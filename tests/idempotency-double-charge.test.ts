import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'
import { runCommand } from '../src/game/engine.ts'

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
  it('the replay script shows a per-attempt key (not the order id) once fixed, and two charges before', () => {
    const fixed = runCommand(sc, './replay-slow-charge.sh ord_test_42', new Set(['idempotency-keys']))
    expect(fixed.output).toMatch(/provider charges for ord_test_42: 1/)
    expect(fixed.output).not.toMatch(/Idempotency-Key ord_/)
    expect(runCommand(sc, './replay-slow-charge.sh ord_test_42', new Set()).output).toMatch(/: 2/)
  })
})
