import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-s3-glacier-lifecycle')

describe('aws-s3-glacier-lifecycle', () => {
  it('keeps both fixes required and the shortcuts wrong or destructive', () => {
    expect(sc.solution_paths).toEqual([['rule-to-ir', 'convert-existing']])
    expect(sc.actions.find((a) => a.id === 'expedited-each-time')?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'delete-archived')?.kind).toBe('destructive')
  })
  it('puts the rule change in IaC and covers versioned copies', () => {
    expect(sc.actions.find((a) => a.id === 'rule-to-ir')?.label).toMatch(/infrastructure code/)
    expect(sc.actions.find((a) => a.id === 'convert-existing')?.feedback).toMatch(/noncurrent versions/)
  })
})
