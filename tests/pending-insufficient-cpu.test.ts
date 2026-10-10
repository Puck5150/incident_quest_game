import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('pending-insufficient-cpu')

describe('pending-insufficient-cpu', () => {
  it('the only route right-sizes the request, from peak plus headroom, in Git', () => {
    expect(sc.solution_paths).toEqual([['right-size']])
    const a = sc.actions.find((x) => x.id === 'right-size')!
    expect(a.label).toMatch(/peak/)
    expect(a.label).toMatch(/Git/)
  })
  it('keeps the shortcuts non-fixes', () => {
    for (const id of ['add-nodes', 'no-requests']) expect(sc.actions.find((a) => a.id === id)?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'delete-others')?.kind).toBe('destructive')
  })
})
