// Design-challenge rules, as pure functions (PLAN_DESIGN_CHALLENGES.md).
//   evaluate(challenge, picks) -> which stress tests pass, and why not
//   scoreChallenge(challenge, runs, hints) -> itemized score

import { RPO_LEVELS, type Challenge, type Picks } from '../schema/challenge.ts'
import { HINT_TIERS } from './engine.ts'

export type TestResult = { id: string; label: string; pass: boolean; reasons: string[] }
export type Evaluation = {
  tests: TestResult[]
  cost: number
  withinBudget: boolean
  overkill: string[] // explanations for options that exceed the brief
  pass: boolean // every test passes and the design fits the budget
}

const pickedOptions = (c: Challenge, picks: Picks) =>
  c.tiers.flatMap((t) => {
    const o = t.options.find((x) => x.id === picks[t.id])
    return o ? [{ tier: t, option: o }] : []
  })

export const isComplete = (c: Challenge, picks: Picks) => c.tiers.every((t) => !!picks[t.id])

export function evaluate(c: Challenge, picks: Picks): Evaluation {
  const chosen = pickedOptions(c, picks)
  const reason = (optionId: string, testId: string, fallback: string) =>
    c.failure_feedback[optionId]?.[testId] ?? fallback

  // For each test: which picked options break it, and a default explanation.
  const failures = (r: Challenge['stress_tests'][number]['requires']) => {
    if ('every_tier_survives' in r)
      return chosen
        .filter(({ option }) => !option.capabilities.survives.includes(r.every_tier_survives))
        .map(({ option }) => ({ option, text: `${option.label} doesn't survive this.` }))
    if ('min_scales' in r)
      return chosen
        .filter(({ tier, option }) => tier.id === r.tier && option.capabilities.scales < r.min_scales)
        .map(({ option }) => ({ option, text: `${option.label} can't absorb ${r.min_scales}× traffic.` }))
    const worst = RPO_LEVELS.indexOf(r.rpo_at_most)
    return chosen
      .filter(({ tier, option }) => tier.id === r.tier && RPO_LEVELS.indexOf(option.capabilities.rpo ?? 'hours') > worst)
      .map(({ option }) => ({
        option,
        text: `${option.label} could lose more data than allowed (${option.capabilities.rpo ?? 'unknown'}).`,
      }))
  }

  const tests = c.stress_tests.map((t) => {
    const failing = failures(t.requires)
    return {
      id: t.id,
      label: t.label,
      pass: failing.length === 0,
      reasons: failing.map((f) => reason(f.option.id, t.id, f.text)),
    }
  })

  const cost = chosen.reduce((sum, { option }) => sum + option.cost, 0)
  const withinBudget = cost <= c.budget
  return {
    tests,
    cost,
    withinBudget,
    overkill: chosen.flatMap(({ option }) => (option.overkill ? [`${option.label}: ${option.overkill}`] : [])),
    pass: tests.every((t) => t.pass) && withinBudget,
  }
}

export type Run = { picks: Picks; at: number }

export type ChallengeScore = {
  lines: { label: string; xp: number }[]
  total: number
  hintsUsed: number
  clean: boolean
  firstRunPass: boolean
  lean: boolean // final design passed with nothing over-engineered
}

// Same shape and percentages as incident scoring, so XP means the same thing
// in both modes. `runs` are every design the player tested, in order; the
// last one is the passing design.
export function scoreChallenge(c: Challenge, runs: Run[], hintsUsed: number): ChallengeScore {
  const base = 100 * c.difficulty
  const pct = (p: number) => Math.round((base * p) / 100)
  const lines = [{ label: `Base (difficulty ${c.difficulty})`, xp: base }]
  const add = (label: string, xp: number) => xp !== 0 && lines.push({ label, xp })

  const firstRunPass = runs.length === 1 && evaluate(c, runs[0].picks).pass
  const final = runs.at(-1) ? evaluate(c, runs.at(-1)!.picks) : undefined
  const lean = !!final?.pass && final.overkill.length === 0

  if (firstRunPass) add('Passed every stress test on the first run', pct(20))
  if (lean) add('Met the brief without over-engineering', pct(20))
  add(`Extra test runs ×${Math.max(0, runs.length - 1)}`, -pct(10) * Math.max(0, runs.length - 1))
  HINT_TIERS.slice(0, hintsUsed).forEach((t) => add(`Hint: ${t.label.toLowerCase()}`, -pct(t.cost)))

  const sum = lines.reduce((t, l) => t + l.xp, 0)
  add('Minimum award for completing', Math.max(0, pct(10) - sum))
  return { lines, total: Math.max(sum, pct(10)), hintsUsed, clean: hintsUsed === 0, firstRunPass, lean }
}
