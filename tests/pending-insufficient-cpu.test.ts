import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('pending-insufficient-cpu')
const label = sc.actions.find((x) => x.id === 'right-size')!.label

describe('pending-insufficient-cpu', () => {
  it('the only route right-sizes the request in Git', () => {
    expect(sc.solution_paths).toEqual([['right-size']])
    expect(label).toMatch(/Git/)
  })
  it('the credited request is derived from the lab data: peak plus modest headroom', () => {
    const history = sc.files!.map((f) => f.content).join('\n')
    const peak = Number(/label-printer\s+\d+m\s+\d+m\s+(\d+)m/.exec(history)![1])
    const request = Number(/about (\d+)m/.exec(label)![1])
    expect(request).toBeGreaterThanOrEqual(peak * 1.2)
    expect(request).toBeLessThanOrEqual(peak * 1.5)
    expect(request).toBeLessThan(2000 / 4) // far below the 2 CPUs requested now
  })
  it('keeps the shortcuts non-fixes', () => {
    for (const id of ['add-nodes', 'no-requests']) expect(sc.actions.find((a) => a.id === id)?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'delete-others')?.kind).toBe('destructive')
  })
})
