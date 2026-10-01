// Design challenges: pick one option per architecture tier, then run stress
// tests. See PLAN_DESIGN_CHALLENGES.md. Checks that need the rules engine
// (every reference design really passes) live in vite-plugin-content.ts.

import { z } from 'zod'
import { AnalogySchema, HintsSchema, SourcesSchema, id } from './scenario.ts'

import { RPO_LEVELS } from './constants.ts'

export { RPO_LEVELS } from './constants.ts'

const OptionSchema = z.strictObject({
  id,
  label: z.string().min(1),
  short: z.string().min(1).max(22).optional(), // label for the live diagram box
  cost: z.number().min(0), // illustrative units per month, not real prices
  facts: z.array(z.string().min(1)).min(1), // shown to the player; each should be sourced
  // Hidden from the player. Stress tests check these.
  capabilities: z
    .strictObject({
      survives: z.array(id).default([]), // failure events this option rides out
      scales: z.number().min(0).default(1), // multiple of normal traffic it absorbs
      rpo: z.enum(RPO_LEVELS).optional(), // data loss if it fails (data tiers)
    })
    .default({ survives: [], scales: 1 }),
  overkill: z.string().optional(), // why this is more than the brief needs
})

// One rule per stress test. Kept deliberately small; add a rule type only
// when a challenge needs it.
const RuleSchema = z.union([
  z.strictObject({ every_tier_survives: id }),
  z.strictObject({ tier: id, min_scales: z.number().positive() }),
  z.strictObject({ tier: id, rpo_at_most: z.enum(RPO_LEVELS) }),
])

export const ChallengeSchema = z
  .strictObject({
    type: z.literal('challenge'),
    id,
    track: id,
    difficulty: z.int().min(1).max(5),
    title: z.string().min(1),
    provider: z.enum(['aws', 'azure', 'gcp']),
    par_minutes: z.number().positive(),

    brief: z.string().min(1),
    requirements: z.array(z.string().min(1)).min(1),
    budget: z.number().positive(),

    tiers: z
      .array(z.strictObject({ id, label: z.string().min(1), options: z.array(OptionSchema).min(2) }))
      .min(1),
    stress_tests: z.array(z.strictObject({ id, label: z.string().min(1), requires: RuleSchema })).min(1),
    // Optional hand-written reasons: option id -> stress test id -> explanation.
    failure_feedback: z.record(id, z.record(id, z.string().min(1))).default({}),
    reference_designs: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          picks: z.record(id, id),
          why: z.string().min(1),
        }),
      )
      .min(1),

    hints: HintsSchema,
    analogy: AnalogySchema,
    debrief: z.strictObject({ summary: z.string().min(1), real_world: z.string().optional() }),
    sources: SourcesSchema,
  })
  .superRefine((c, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path, input: c })
    const tiers = new Map(c.tiers.map((t) => [t.id, new Set(t.options.map((o) => o.id))]))
    const optionIds = c.tiers.flatMap((t) => t.options.map((o) => o.id))
    const testIds = new Set(c.stress_tests.map((t) => t.id))

    if (tiers.size !== c.tiers.length) issue('duplicate tier id', ['tiers'])
    if (new Set(optionIds).size !== optionIds.length) issue('option ids must be unique across all tiers', ['tiers'])
    if (testIds.size !== c.stress_tests.length) issue('duplicate stress test id', ['stress_tests'])

    c.stress_tests.forEach((t, i) => {
      if ('tier' in t.requires && !tiers.has(t.requires.tier))
        issue(`unknown tier "${t.requires.tier}"`, ['stress_tests', i, 'requires', 'tier'])
    })
    c.reference_designs.forEach((d, i) => {
      tiers.forEach((opts, tier) => {
        if (!d.picks[tier]) issue(`no pick for tier "${tier}"`, ['reference_designs', i, 'picks'])
        else if (!opts.has(d.picks[tier])) issue(`"${d.picks[tier]}" is not an option in tier "${tier}"`, ['reference_designs', i, 'picks', tier])
      })
    })
    Object.entries(c.failure_feedback).forEach(([opt, byTest]) => {
      if (!optionIds.includes(opt)) issue(`unknown option "${opt}"`, ['failure_feedback', opt])
      Object.keys(byTest).forEach((t) => {
        if (!testIds.has(t)) issue(`unknown stress test "${t}"`, ['failure_feedback', opt, t])
      })
    })
  })

export type Challenge = z.infer<typeof ChallengeSchema>
export type Picks = Record<string, string> // tier id -> option id
