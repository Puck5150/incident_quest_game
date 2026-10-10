import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-dynamodb-gsi-throttle')

describe('aws-dynamodb-gsi-throttle', () => {
  it('requires the per-index throttle alarm on every route', () => {
    expect(sc.solution_paths).toEqual([
      ['raise-gsi', 'autoscale-gsi', 'alarm-gsi-throttle'],
      ['on-demand', 'alarm-gsi-throttle'],
    ])
  })
  it('keeps the table-only and retry shortcuts wrong', () => {
    for (const id of ['raise-table', 'retry-faster']) expect(sc.actions.find((a) => a.id === id)?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'drop-index')?.kind).toBe('destructive')
  })
  it('on-demand carries the cost caveat', () => expect(sc.actions.find((a) => a.id === 'on-demand')?.feedback).toMatch(/cost/))
})
