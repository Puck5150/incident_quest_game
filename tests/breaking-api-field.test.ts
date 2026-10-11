import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('breaking-api-field')
describe('breaking-api-field', () => {
  it('requires the compatible release and contract tests', () => {
    expect(sc.solution_paths).toEqual([['restore-field', 'contract-tests']])
    expect(sc.actions.find((a) => a.id === 'rollback-v5')?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'force-update')?.kind).toBe('wrong')
  })
})
