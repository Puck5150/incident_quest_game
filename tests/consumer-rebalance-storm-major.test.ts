import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('consumer-rebalance-storm-major')
describe('consumer-rebalance-storm-major', () => {
  it('stage 1 also needs idempotent sends and a rebalance/lag alert', () => {
    expect(sc.solution_paths).toEqual([['cap-records', 'idempotent-sends', 'rebalance-alert']])
  })
  it('skip log never holds codes or PII', () => {
    const a = sc.stages!.flatMap((s) => s.actions).find((x) => x.id === 'skip-stale')!
    expect(a.label).toMatch(/event id and customer id only/)
  })
  it('weak routes stay rejected', () => {
    expect(sc.actions.find((a) => a.id === 'raise-interval')?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'reset-latest')?.kind).toBe('destructive')
  })
})
