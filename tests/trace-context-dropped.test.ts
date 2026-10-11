import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'
import { fixComplete, type GameEvent } from '../src/game/engine.ts'

const sc = loadIncident('trace-context-dropped')
const take = (...ids: string[]): GameEvent[] => ids.map((id, i) => ({ type: 'TAKE_ACTION', id, at: i }))

describe('trace-context-dropped', () => {
  it('propagation alone does not complete it', () => {
    expect(fixComplete(sc, take('propagate'))).toBe(false)
    expect(fixComplete(sc, take('propagate', 'fix-scan'))).toBe(false)
    expect(fixComplete(sc, take('propagate', 'fix-scan', 'propagation-test'))).toBe(true)
  })
  it('scaling out discount-service is wrong; the index is built concurrently', () => {
    expect(sc.actions.find((a) => a.id === 'scale-discount')?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'fix-scan')?.label).toMatch(/CONCURRENTLY/)
  })
})
