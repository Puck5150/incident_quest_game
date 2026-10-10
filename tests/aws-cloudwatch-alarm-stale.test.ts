import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-cloudwatch-alarm-stale')

describe('aws-cloudwatch-alarm-stale', () => {
  it('requires IaC repoint, INSUFFICIENT_DATA notification and a scale-out policy', () => expect(sc.solution_paths).toEqual([['repoint', 'notify-insufficient', 'scale-out-policy']]))
  it('keeps the loosening alternatives wrong or destructive', () => {
    for (const id of ['lower-threshold', 'missing-as-breaching']) expect(sc.actions.find((a) => a.id === id)?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'delete-alarm')?.kind).toBe('destructive')
  })
  it('puts the fix in IaC', () => expect(sc.actions.find((a) => a.id === 'repoint')?.label).toMatch(/infrastructure code/))
})
