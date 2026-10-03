import { describe, expect, it } from 'vitest'
import { newShift, shiftReport, shiftStep, type Shift, type ShiftEvent } from '../src/game/shift.ts'

const MIN = 60_000
// A fixed "random" so picks and arrival gaps are exact: 0.5 gives 5-minute gaps.
const half = () => 0.5
const inc = (id: string, severity: 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4' | 'SEV5', resolved = false) => ({ id, severity, difficulty: 1, resolved })
const run = (s: Shift, ...events: ShiftEvent[]) => events.reduce(shiftStep, s)
const tick = (minutes: number): ShiftEvent => ({ type: 'TICK', ms: minutes * MIN })
const resolve = (id: string, parMinutes = 10): ShiftEvent => ({ type: 'RESOLVE', id, total: 100, clean: true, parMinutes })

describe('picking pages', () => {
  it('prefers unresolved incidents and takes the requested number', () => {
    const s = newShift([inc('a', 'SEV4', true), inc('b', 'SEV3'), inc('c', 'SEV4'), inc('d', 'SEV2', true)], 2, false, half)
    expect(s.pages.map((p) => p.id).sort()).toEqual(['b', 'c'])
  })

  it('always includes a SEV1-SEV3 when one exists', () => {
    const s = newShift([inc('a', 'SEV4'), inc('b', 'SEV5'), inc('c', 'SEV4'), inc('d', 'SEV2', true)], 3, false, half)
    expect(s.pages.some((p) => p.severity === 'SEV2' || p.severity === 'SEV3')).toBe(true)
    expect(s.pages).toHaveLength(3)
  })
})

describe('timed shift', () => {
  const start = () => newShift([inc('a', 'SEV4'), inc('b', 'SEV2'), inc('c', 'SEV3')], 3, false, half)

  it('pages arrive on schedule, the first at once', () => {
    let s = start()
    expect(s.pages.map((p) => p.arrivesAt)).toEqual([0, 5 * MIN, 10 * MIN])
    expect(s.pages.filter((p) => p.arrivedAt !== undefined)).toHaveLength(1)
    s = run(s, tick(7))
    expect(s.pages.filter((p) => p.arrivedAt !== undefined)).toHaveLength(2)
    expect(s.pages[1].arrivedAt).toBe(5 * MIN) // its scheduled time, not the end of the tick
  })

  it('counts active time only for the incident on screen', () => {
    const first = start().pages[0].id
    const s = run(start(), { type: 'OPEN', id: first }, tick(3), { type: 'LEAVE' }, tick(4))
    expect(s.pages[0].activeMs).toBe(3 * MIN)
    expect(s.clock).toBe(7 * MIN)
  })

  it("can't open a page that hasn't arrived", () => {
    const s = start()
    expect(run(s, { type: 'OPEN', id: s.pages[2].id }).focus).toBeUndefined()
  })

  it('response targets and triage', () => {
    // Order the pages so a SEV4 comes first and a SEV2 arrives while it's open.
    const s0: Shift = { ...start(), pages: start().pages.map((p, i) => ({ ...p, severity: (['SEV4', 'SEV2', 'SEV3'] as const)[i] })) }
    const [p3, p1, p2] = s0.pages.map((p) => p.id)
    const s = run(
      s0,
      { type: 'OPEN', id: p3 }, // SEV4 acknowledged at once
      tick(5), // SEV2 arrives
      { type: 'OPEN', id: p1 }, // switched straight to it
      tick(8),
      resolve(p1, 10), // 8 active minutes, under par: met
      tick(2), // SEV3 arrived at 10 min (during the SEV2); acknowledged at 15
      { type: 'OPEN', id: p2 },
      tick(16),
      resolve(p2, 10), // 16 active minutes, over 1.5 x par: missed
      { type: 'OPEN', id: p3 },
      tick(5),
      resolve(p3, 10),
    )
    expect(s.ended).toBe(true)
    const r = shiftReport(s)
    const page = (id: string) => r.pages.find((p) => p.id === id)!
    expect(page(p1)).toMatchObject({ ackMet: true, resolveMet: true, bonus: 10 })
    expect(page(p2)).toMatchObject({ responseMs: 5 * MIN, ackMet: true, resolveMet: false, bonus: 5 })
    expect(page(p3)).toMatchObject({ ackMet: true, resolveMet: true })
    expect(r.triage).toBe(true)
    expect(r.triageBonus).toBe(30)
    expect(r.clean).toBe(true)
  })

  it('acknowledging a lower severity while a higher one waits misses triage', () => {
    let s = newShift([inc('a', 'SEV2'), inc('b', 'SEV4')], 2, false, half)
    s = { ...s, pages: s.pages.map((p) => ({ ...p, arrivesAt: 0, arrivedAt: 0 })) } // both waiting
    const low = s.pages.find((p) => p.severity === 'SEV4')!.id
    s = run(s, { type: 'OPEN', id: low })
    expect(s.triageMissed).toEqual([low])
    expect(shiftReport(s).triage).toBe(false)
  })

  it('ending early: unresolved pages earn no bonus and the shift is over', () => {
    const s = run(start(), { type: 'END' }, { type: 'OPEN', id: start().pages[0].id })
    expect(s.ended).toBe(true)
    expect(s.focus).toBeUndefined()
    expect(shiftReport(s).pages.every((p) => p.bonus === 0)).toBe(true)
  })

  it('keeps an incident\'s session while the player is elsewhere', () => {
    const id = start().pages[0].id
    const session = { phase: 'investigating' as const, log: [] }
    expect(run(start(), { type: 'SAVE', id, session }).pages[0].session).toBe(session)
  })
})

describe('relaxed shift', () => {
  it('the next page arrives only once the queue is clear, with no targets or triage', () => {
    let s = newShift([inc('a', 'SEV3'), inc('b', 'SEV4')], 2, true, half)
    const [first, second] = s.pages.map((p) => p.id)
    s = run(s, tick(30))
    expect(s.pages[1].arrivedAt).toBeUndefined()
    s = run(s, { type: 'OPEN', id: first }, resolve(first))
    expect(s.pages[1].arrivedAt).toBe(30 * MIN)
    s = run(s, { type: 'OPEN', id: second }, resolve(second))
    const r = shiftReport(s)
    expect(r.bonus).toBe(0)
    expect(r.triage).toBe(false)
  })
})
