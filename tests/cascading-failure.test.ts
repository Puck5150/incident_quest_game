import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('cascading-failure')
describe('cascading-failure', () => {
  it('restores the index, bounds the client, bulkheads and guards migrations', () => {
    expect(sc.solution_paths).toEqual([['restore-index', 'add-timeout', 'bulkhead', 'migration-guard']])
  })
  it('a code rollback is wrong, retries are destructive', () => {
    expect(sc.actions.find((a) => a.id === 'rollback-inventory')?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'restore-index')?.label).toMatch(/CONCURRENTLY/)
    expect(sc.actions.find((a) => a.id === 'more-retries')?.kind).toBe('destructive')
  })
})
