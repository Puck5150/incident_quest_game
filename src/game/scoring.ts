// Turns a finished incident's event log into an itemized score (PLAN.md §6).
// Pure: same log in, same score out. The debrief shows every line, so the
// player can see exactly why they got the number they got.

import type { Scenario } from '../schema/scenario.ts'
import {
  HINT_TIERS,
  actionsTaken,
  evidenceSeen,
  fixComplete,
  hintsUsed,
  runCommand,
  type GameEvent,
} from './engine.ts'
import { atStage, stageCount } from '../schema/stages.ts'

export type ScoreLine = { label: string; xp: number }

export type Score = {
  lines: ScoreLine[]
  total: number
  elapsedMs: number
  hintsUsed: number
  mistakes: { wrongHypotheses: number; wrongActions: number; destructive: number }
  methodical: boolean // saw every key_evidence before the correct hypothesis
  verified: boolean // re-checked the system after the fix, before closing
  clean: boolean // no hints and no destructive actions
  relaxed: boolean // played without the clock: no time bonus
  inShift: boolean // part of an on-call shift: the shift's targets replace the time bonus
}

// All percentages are of the base XP.
const TIME_BONUS = 20
const METHODICAL_BONUS = 20
const VERIFY_BONUS = 10
const WRONG_HYPOTHESIS = 10
const WRONG_ACTION = 10
const DESTRUCTIVE_ACTION = 25
const FLOOR = 10

// `relaxed` turns the time bonus off rather than awarding it, so switching it
// on can never raise a score. In an on-call shift the time bonus is replaced
// by the shift's response targets (shift.ts), which count only active time.
export function score(scenario: Scenario, log: GameEvent[], relaxed = false, inShift = false): Score {
  const base = 100 * scenario.difficulty
  const pct = (p: number) => Math.round((base * p) / 100)
  const lines: ScoreLine[] = [{ label: `Base (difficulty ${scenario.difficulty})`, xp: base }]
  const add = (label: string, xp: number) => xp !== 0 && lines.push({ label, xp })

  // Time: full bonus up to par, then linear down to zero at 2x par. Capped
  // low on purpose so rushing never beats being methodical.
  const start = log.find((e) => e.type === 'START')?.at ?? 0
  const end = log.at(-1)?.at ?? start
  const elapsedMs = end - start
  const par = scenario.par_minutes * 60_000
  const timeFactor = Math.min(1, Math.max(0, 2 - elapsedMs / par))
  if (inShift) lines.push({ label: 'Time bonus: see shift response targets', xp: 0 })
  else if (relaxed) lines.push({ label: 'Time bonus: off (relaxed mode)', xp: 0 })
  else add(elapsedMs <= par ? 'Time bonus (under par)' : 'Time bonus (partial)', Math.round(pct(TIME_BONUS) * timeFactor))

  // Multi-stage incidents (PLAN_MULTI_STAGE.md): methodical, verified and hints
  // are judged per stage; the bonuses are shared out evenly across stages.
  const n = stageCount(scenario)
  const closes = log.flatMap((e, i) => (e.type === 'CLOSE_INCIDENT' ? [i] : []))
  const stages = Array.from({ length: n }, (_, k) => {
    const view = atStage(scenario, k)
    const from = k === 0 ? 0 : closes[k - 1] + 1
    const to = closes[k] ?? log.length // this stage's events are log[from..to)
    const inStage = (i: number) => i >= from && i < to
    const correctAt = log.findIndex((e, i) => inStage(i) && e.type === 'DECLARE_HYPOTHESIS' && view.hypotheses.some((h) => h.id === e.id && h.correct))
    const seenBefore = correctAt < 0 ? new Set<string>() : evidenceSeen(scenario, log.slice(0, correctAt))
    const methodical = correctAt >= 0 && view.key_evidence.every((t) => seenBefore.has(t))
    // Verified = after this stage's fix was complete, ran a command the scenario
    // scripts (typos and `help` don't count), before closing the stage.
    const fixedAt = log.findIndex((_, i) => inStage(i) && fixComplete(view, log.slice(0, i + 1)))
    const verified =
      fixedAt >= 0 &&
      log.some(
        (e, i) =>
          i > fixedAt &&
          inStage(i) &&
          ((e.type === 'RUN_COMMAND' && !!runCommand(view, e.input, actionsTaken(log.slice(0, i))).scripted) ||
            (e.type === 'SHELL_RAN' && e.commands.length > 0)),
      )
    return { methodical, verified, hints: hintsUsed(log.slice(from, to)) }
  })
  const share = (count: number, label: string, all: string, bonus: number) => {
    if (!count) return
    add(n === 1 || count === n ? all : `${label}: ${count} of ${n} stages`, Math.round((pct(bonus) * count) / n))
  }
  const methodical = stages.every((x) => x.methodical)
  const verified = stages.every((x) => x.verified)
  share(stages.filter((x) => x.methodical).length, 'Methodical', 'Methodical: found all key evidence before deciding', METHODICAL_BONUS)
  share(stages.filter((x) => x.verified).length, 'Verified the fix', 'Verified the fix before closing', VERIFY_BONUS)

  const hints = stages.reduce((t, x) => t + x.hints, 0)
  stages.forEach((x, k) =>
    HINT_TIERS.slice(0, x.hints).forEach((t) => add(`Hint: ${t.label.toLowerCase()}${n > 1 ? ` (stage ${k + 1})` : ''}`, -pct(t.cost))),
  )

  const allHypotheses = [scenario, ...(scenario.stages ?? [])].flatMap((x) => x.hypotheses)
  const allActions = [scenario, ...(scenario.stages ?? [])].flatMap((x) => x.actions)
  const isCorrect = (id: string) => allHypotheses.find((h) => h.id === id)?.correct
  const count = (pred: (e: GameEvent) => boolean) => log.filter(pred).length
  const kindOf = (id: string) => allActions.find((a) => a.id === id)?.kind
  const wrongHyp = count((e) => e.type === 'DECLARE_HYPOTHESIS' && !isCorrect(e.id))
  const wrongAct = count((e) => e.type === 'TAKE_ACTION' && kindOf(e.id) === 'wrong')
  const destructive = count((e) => e.type === 'TAKE_ACTION' && kindOf(e.id) === 'destructive')
  add(`Wrong hypothesis ×${wrongHyp}`, -pct(WRONG_HYPOTHESIS) * wrongHyp)
  add(`Wrong action ×${wrongAct}`, -pct(WRONG_ACTION) * wrongAct)
  add(`Destructive action ×${destructive}`, -pct(DESTRUCTIVE_ACTION) * destructive)

  // Resolving always earns something, however rough the path.
  const sum = lines.reduce((t, l) => t + l.xp, 0)
  add('Minimum award for resolving', Math.max(0, pct(FLOOR) - sum))

  return {
    lines,
    total: Math.max(sum, pct(FLOOR)),
    elapsedMs,
    hintsUsed: hints,
    mistakes: { wrongHypotheses: wrongHyp, wrongActions: wrongAct, destructive },
    methodical,
    verified,
    clean: hints === 0 && destructive === 0,
    relaxed,
    inShift,
  }
}
