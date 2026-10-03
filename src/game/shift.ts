// On-call shift mode (PLAN_ONCALL_SHIFT.md): several incidents arrive over
// time and the player triages between them. Pure like the engine: the UI
// feeds in ticks of shift time and player actions; nothing here reads a clock.
// Each incident's own play (and score) is unchanged; this layer adds
// arrivals, focus, active time, response targets and the shift bonus.

import type { Session } from './engine.ts'

export type Severity = 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4' | 'SEV5'
export const SHIFT_LENGTHS = [2, 3, 5] as const
export const SHIFT_UNLOCK = 3 // resolved incidents before shifts open up

const MIN = 60_000
// Response targets per severity: acknowledge within (shift time), resolve
// within a multiple of par (active time on that incident only).
// SEV1-SEV3 need prompt attention; SEV1 and SEV2 are shown as critical.
export const isUrgent = (s: Severity) => s === 'SEV1' || s === 'SEV2' || s === 'SEV3'
export const isCritical = (s: Severity) => s === 'SEV1' || s === 'SEV2'
export const ACK_TARGET: Record<Severity, number> = { SEV1: 1 * MIN, SEV2: 2 * MIN, SEV3: 5 * MIN, SEV4: 10 * MIN, SEV5: 10 * MIN }
export const RESOLVE_FACTOR: Record<Severity, number> = { SEV1: 1, SEV2: 1, SEV3: 1.5, SEV4: 2, SEV5: 2 }
const TARGET_BONUS = 5 // % of the incident's base XP, per target met
const TRIAGE_BONUS = 10 // % of the shift's total base XP

export type Page = {
  id: string // incident id
  severity: Severity
  difficulty: number
  arrivesAt: number // planned, in shift time (timed shifts)
  arrivedAt?: number // when it actually reached the queue
  ackAt?: number
  activeMs: number // time with this incident on screen
  session?: Session // saved progress while the player is elsewhere
  result?: { total: number; clean: boolean; parMinutes: number }
}

export type Shift = {
  relaxed: boolean // no clock or targets; each page arrives once the queue is clear
  clock: number // shift time in ms; the UI stops ticking while the tab is hidden
  pages: Page[]
  focus?: string
  triageMissed: string[] // pages acknowledged while a more severe page waited
  ended: boolean
}

export type ShiftEvent =
  | { type: 'TICK'; ms: number }
  | { type: 'OPEN'; id: string }
  | { type: 'LEAVE' } // back to the queue
  | { type: 'SAVE'; id: string; session: Session }
  | { type: 'RESOLVE'; id: string; total: number; clean: boolean; parMinutes: number }
  | { type: 'END' }

// Pick and schedule the shift's pages. `random` is injected so tests are exact.
export function newShift(
  candidates: { id: string; severity: Severity; difficulty: number; resolved: boolean }[],
  length: number,
  relaxed: boolean,
  random: () => number = Math.random,
): Shift {
  const shuffled = [...candidates]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  // Unresolved incidents first, then replays; at least one SEV1-SEV3 if possible.
  const pool = [...shuffled.filter((c) => !c.resolved), ...shuffled.filter((c) => c.resolved)]
  const picked = pool.slice(0, length)
  const urgent = pool.find((c) => isUrgent(c.severity))
  if (urgent && !picked.some((c) => isUrgent(c.severity))) picked[picked.length - 1] = urgent

  let at = 0
  const pages = picked.map((c, i) => {
    if (i > 0) at += (4 + 2 * random()) * MIN // the next page 4 to 6 minutes later
    return { id: c.id, severity: c.severity, difficulty: c.difficulty, arrivesAt: Math.round(at), activeMs: 0 }
  })
  return arrive({ relaxed, clock: 0, pages, triageMissed: [], ended: false })
}

// Pages whose time has come join the queue. Relaxed shifts ignore the clock:
// the next page arrives once every page before it is resolved.
function arrive(s: Shift): Shift {
  let changed = false
  const pages = s.pages.map((p, i) => {
    if (p.arrivedAt !== undefined) return p
    const due = s.relaxed ? s.pages.slice(0, i).every((q) => q.result) : p.arrivesAt <= s.clock
    if (!due) return p
    changed = true
    // A timed page arrived at its scheduled time, even if the tick that noticed ran past it.
    return { ...p, arrivedAt: s.relaxed ? s.clock : p.arrivesAt }
  })
  return changed ? { ...s, pages } : s
}

const rank = (p: Severity) => Number(p.slice(3))
const update = (s: Shift, id: string, f: (p: Page) => Page): Shift => ({
  ...s,
  pages: s.pages.map((p) => (p.id === id ? f(p) : p)),
})

export function shiftStep(s: Shift, e: ShiftEvent): Shift {
  if (s.ended) return s
  switch (e.type) {
    case 'TICK': {
      const ticked = s.focus ? update(s, s.focus, (p) => ({ ...p, activeMs: p.activeMs + e.ms })) : s
      return arrive({ ...ticked, clock: s.clock + e.ms })
    }
    case 'OPEN': {
      const page = s.pages.find((p) => p.id === e.id)
      if (!page || page.arrivedAt === undefined || page.result) return s
      if (page.ackAt !== undefined) return { ...s, focus: e.id }
      // Triage: acknowledging this while a more urgent page waits unacknowledged.
      const skipped = s.pages.some(
        (p) => p.arrivedAt !== undefined && p.ackAt === undefined && !p.result && rank(p.severity) < rank(page.severity),
      )
      return {
        ...update(s, e.id, (p) => ({ ...p, ackAt: s.clock })),
        focus: e.id,
        triageMissed: skipped ? [...s.triageMissed, e.id] : s.triageMissed,
      }
    }
    case 'LEAVE':
      return { ...s, focus: undefined }
    case 'SAVE':
      return update(s, e.id, (p) => ({ ...p, session: e.session }))
    case 'RESOLVE': {
      const resolved = update(s, e.id, (p) => ({
        ...p,
        session: undefined,
        result: { total: e.total, clean: e.clean, parMinutes: e.parMinutes },
      }))
      const next = arrive({ ...resolved, focus: undefined })
      return next.pages.every((p) => p.result) ? { ...next, ended: true } : next
    }
    case 'END':
      return { ...s, focus: undefined, ended: true }
  }
}

// What the shift report shows. Unresolved pages earn nothing and miss their
// targets; targets and triage don't apply in relaxed shifts.
export function shiftReport(s: Shift) {
  const pages = s.pages.map((p) => {
    const base = 100 * p.difficulty
    const acked = p.ackAt !== undefined && p.arrivedAt !== undefined
    const responseMs = acked ? p.ackAt! - p.arrivedAt! : undefined
    const ackMet = !s.relaxed && responseMs !== undefined && responseMs <= ACK_TARGET[p.severity]
    const resolveMet =
      !s.relaxed && !!p.result && p.activeMs <= p.result.parMinutes * MIN * RESOLVE_FACTOR[p.severity]
    const bonus = Math.round((base * TARGET_BONUS * (Number(ackMet) + Number(resolveMet))) / 100)
    return { id: p.id, severity: p.severity, responseMs, activeMs: p.activeMs, resolved: !!p.result, ackMet, resolveMet, bonus }
  })
  const triage = !s.relaxed && s.pages.length > 1 && s.triageMissed.length === 0 && pages.every((p) => p.responseMs !== undefined)
  const triageBonus = triage ? Math.round((s.pages.reduce((t, p) => t + 100 * p.difficulty, 0) * TRIAGE_BONUS) / 100) : 0
  return {
    pages,
    triage,
    triageBonus,
    bonus: pages.reduce((t, p) => t + p.bonus, 0) + triageBonus,
    clean: s.pages.every((p) => p.result?.clean),
    durationMs: s.clock,
  }
}
