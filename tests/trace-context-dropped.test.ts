import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('trace-context-dropped')

describe('trace-context-dropped', () => {
  it('propagation alone does not complete it: the slow query and a guard test are required', () => {
    expect(sc.solution_paths).toEqual([['propagate', 'fix-scan', 'propagation-test']])
  })
  it('scaling out discount-service is wrong', () => {
    expect(sc.actions.find((a) => a.id === 'scale-discount')?.kind).toBe('wrong')
  })
  it('the index is built concurrently', () => {
    expect(sc.actions.find((a) => a.id === 'fix-scan')?.label).toMatch(/CONCURRENTLY/)
  })
})
