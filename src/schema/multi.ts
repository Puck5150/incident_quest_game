// "Pick your cloud" canvas challenges (PLAN_PICK_YOUR_CLOUD.md): one brief and
// one set of stress tests, with per-provider names, facts and sources.
// resolveProvider() turns one into an ordinary CanvasChallenge, so every
// engine, screen and check downstream is reused unchanged.

import { z } from 'zod'
import { AnalogySchema, HintsSchema, SourcesSchema, id } from './scenario.ts'
import { DesignSchema, type CanvasChallenge, type Design } from './canvas.ts'
import { type Challenge } from './challenge.ts'

import { PROVIDERS, PROVIDER_NAMES, ROLES, RPO_LEVELS, type Provider } from './constants.ts'

export { PROVIDERS, PROVIDER_NAMES, type Provider } from './constants.ts'

const perProvider = <T extends z.ZodType>(schema: T) =>
  z.strictObject({ aws: schema.optional(), azure: schema.optional(), gcp: schema.optional() })

const Naming = z.strictObject({
  label: z.string().min(1),
  short: z.string().min(1).max(22).optional(),
  facts: z.array(z.string().min(1)).min(1),
})

const EventSchema = z.union([
  z.strictObject({ none: z.literal(true) }),
  z.strictObject({ zone_outage: id }),
  z.strictObject({ region_outage: id }),
  z.strictObject({ single_failure: id }),
])

export const MultiCanvasSchema = z
  .strictObject({
    type: z.literal('challenge'),
    mode: z.literal('canvas'),
    providers: z.array(z.enum(PROVIDERS)).min(2),
    id,
    track: id,
    difficulty: z.int().min(1).max(5),
    title: z.string().min(1),
    par_minutes: z.number().positive(),

    // Text fields may use {provider}, {region}, {zone:<lane id>} and {service:<palette id>}.
    brief: z.string().min(1),
    requirements: z.array(z.string().min(1)).min(1),
    budget: z.number().positive(),

    layout: z.strictObject({
      regions: z.array(z.strictObject({ id, zones: z.array(id).min(1) })).min(1),
      global: z.boolean().default(false),
    }),
    labels: perProvider(z.record(id, z.string().min(1))), // lane id -> provider's name for it

    palette: z
      .array(
        z.strictObject({
          id,
          scope: z.enum(['zonal', 'regional', 'global']),
          roles: z.array(z.enum(ROLES)).min(1),
          capacity: z.number().min(0).default(0),
          cost: z.number().min(0),
          overkill: z.string().optional(),
          as: perProvider(Naming),
          // Required: what isn't equivalent across providers. "None that matter here" is fine.
          differences: z.string().min(1),
        }),
      )
      .min(2),
    link_facts: perProvider(z.strictObject({ sync: z.array(z.string().min(1)).min(1), async: z.array(z.string().min(1)).min(1) })),

    stress_tests: z
      .array(
        z.strictObject({
          id,
          label: z.string().min(1),
          event: EventSchema,
          check: z.strictObject({
            reach: z.array(z.enum(['serve', 'write-store'])).min(1),
            capacity: z.number().positive().optional(),
          }),
        }),
      )
      .min(1),
    reference_designs: z.array(z.strictObject({ name: z.string().min(1), why: z.string().min(1), design: DesignSchema })).min(1),
    counter_examples: z
      .array(z.strictObject({ name: z.string().min(1), fails: z.array(id).min(1), design: DesignSchema }))
      .min(1),

    // Only for real, sourced differences in behavior. Validated per provider.
    overrides: perProvider(
      z.strictObject({
        palette: z.record(id, z.strictObject({ capacity: z.number().min(0).optional(), cost: z.number().min(0).optional() })).optional(),
        reference_designs: z.array(z.strictObject({ name: z.string().min(1), why: z.string().min(1), design: DesignSchema })).optional(),
        counter_examples: z
          .array(z.strictObject({ name: z.string().min(1), fails: z.array(id).min(1), design: DesignSchema }))
          .optional(),
      }),
    ).default({}),

    hints: HintsSchema,
    analogy: AnalogySchema,
    debrief: z.strictObject({ summary: z.string().min(1), real_world: z.string().optional() }),
    sources: perProvider(SourcesSchema),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path, input: m })
    const laneIds = [...m.layout.regions.flatMap((r) => [r.id, ...r.zones]), ...(m.layout.global ? ['global'] : [])]
    m.providers.forEach((p) => {
      const labels = m.labels[p]
      if (!labels) issue(`no lane labels for ${p}`, ['labels'])
      else laneIds.filter((l) => l !== 'global' && !labels[l]).forEach((l) => issue(`no ${p} label for lane "${l}"`, ['labels', p]))
      if (!m.link_facts[p]) issue(`no link facts for ${p}`, ['link_facts'])
      if (!m.sources[p]) issue(`no sources for ${p}`, ['sources'])
      m.palette.forEach((item, i) => {
        if (!item.as[p]) issue(`palette item "${item.id}" has no ${p} name`, ['palette', i, 'as'])
      })
    })
  })

export type MultiCanvas = z.infer<typeof MultiCanvasSchema>

// Turn a multi-provider challenge into an ordinary one for provider `p`.
// The result is re-validated with CanvasChallengeSchema by the loader.
export function resolveProvider(m: MultiCanvas, p: Provider): CanvasChallenge {
  const labels = m.labels[p] ?? {}
  const ov = m.overrides[p] ?? {}
  const palette = m.palette.map((item) => ({
    id: item.id,
    label: item.as[p]!.label,
    short: item.as[p]!.short,
    scope: item.scope,
    roles: item.roles,
    capacity: ov.palette?.[item.id]?.capacity ?? item.capacity,
    cost: ov.palette?.[item.id]?.cost ?? item.cost,
    facts: item.as[p]!.facts,
    overkill: item.overkill,
  }))
  const fill = filler(p, labels, labels[m.layout.regions[0].id] ?? m.layout.regions[0].id, (id) => palette.find((x) => x.id === id)?.label)

  return {
    type: 'challenge',
    mode: 'canvas',
    id: m.id,
    track: m.track,
    difficulty: m.difficulty,
    title: m.title,
    provider: p,
    par_minutes: m.par_minutes,
    brief: fill(m.brief),
    requirements: m.requirements.map(fill),
    budget: m.budget,
    layout: {
      global: m.layout.global,
      regions: m.layout.regions.map((r) => ({
        id: r.id,
        label: labels[r.id] ?? r.id,
        zones: r.zones.map((z) => ({ id: z, label: labels[z] ?? z })),
      })),
    },
    palette,
    link_facts: m.link_facts[p]!,
    stress_tests: m.stress_tests.map((t) => ({ ...t, label: fill(t.label) })),
    reference_designs: (ov.reference_designs ?? m.reference_designs).map((r) => ({ ...r, why: fill(r.why) })),
    counter_examples: (ov.counter_examples ?? m.counter_examples) as { name: string; fails: string[]; design: Design }[],
    hints: { nudge: fill(m.hints.nudge), direction: fill(m.hints.direction), answer: fill(m.hints.answer) },
    analogy: m.analogy,
    debrief: { summary: fill(m.debrief.summary), real_world: m.debrief.real_world && fill(m.debrief.real_world) },
    sources: m.sources[p]!,
  }
}

// Fills {provider}, {region}, {zone:<label key>} and {service:<palette or option id>}.
function filler(p: Provider, labels: Record<string, string>, region: string, service: (id: string) => string | undefined) {
  return (text: string) =>
    text
      .replaceAll('{provider}', PROVIDER_NAMES[p])
      .replaceAll('{region}', region)
      .replace(/\{zone:([a-z0-9-]+)\}/g, (t, key: string) => labels[key] ?? t)
      .replace(/\{service:([a-z0-9-]+)\}/g, (t, id: string) => service(id) ?? t)
}

// Any {token} left anywhere in a resolved challenge is an authoring mistake.
export const unresolvedTokens = (c: CanvasChallenge | Challenge) =>
  JSON.stringify(c).match(/\{(provider|region|zone:[a-z0-9-]+|service:[a-z0-9-]+)\}/g) ?? []

// ---------------------------------------------------------------------------
// Slot challenges on the cloud of your choice
// ---------------------------------------------------------------------------

export const MultiSlotSchema = z
  .strictObject({
    type: z.literal('challenge'),
    providers: z.array(z.enum(PROVIDERS)).min(2),
    id,
    track: id,
    difficulty: z.int().min(1).max(5),
    title: z.string().min(1),
    par_minutes: z.number().positive(),
    brief: z.string().min(1),
    requirements: z.array(z.string().min(1)).min(1),
    budget: z.number().positive(),
    labels: perProvider(z.record(z.string(), z.string().min(1))).default({}), // e.g. region: "us-east-1"
    tiers: z
      .array(
        z.strictObject({
          id,
          label: z.string().min(1),
          options: z
            .array(
              z.strictObject({
                id,
                cost: z.number().min(0),
                capabilities: z
                  .strictObject({
                    survives: z.array(id).default([]),
                    scales: z.number().min(0).default(1),
                    rpo: z.enum(RPO_LEVELS).optional(),
                  })
                  .default({ survives: [], scales: 1 }),
                overkill: z.string().optional(),
                as: perProvider(Naming),
                differences: z.string().min(1),
              }),
            )
            .min(2),
        }),
      )
      .min(1),
    stress_tests: z.array(z.strictObject({ id, label: z.string().min(1), requires: z.any() })).min(1),
    failure_feedback: z.record(id, z.record(id, z.string().min(1))).default({}),
    reference_designs: z.array(z.strictObject({ name: z.string().min(1), picks: z.record(id, id), why: z.string().min(1) })).min(1),
    hints: HintsSchema,
    analogy: AnalogySchema,
    debrief: z.strictObject({ summary: z.string().min(1), real_world: z.string().optional() }),
    sources: perProvider(SourcesSchema),
  })
  .superRefine((m, ctx) => {
    m.providers.forEach((p) => {
      if (!m.sources[p]) ctx.addIssue({ code: 'custom', message: `no sources for ${p}`, path: ['sources'], input: m })
      m.tiers.forEach((t, i) =>
        t.options.forEach((o, j) => {
          if (!o.as[p])
            ctx.addIssue({ code: 'custom', message: `option "${o.id}" has no ${p} name`, path: ['tiers', i, 'options', j, 'as'], input: m })
        }),
      )
    })
  })

export type MultiSlot = z.infer<typeof MultiSlotSchema>

// Stress-test rules are left loose here (z.any) and checked for real when the
// resolved challenge is validated with ChallengeSchema.
export function resolveSlot(m: MultiSlot, p: Provider): Challenge {
  const labels = m.labels[p] ?? {}
  const options = m.tiers.flatMap((t) => t.options)
  const fill = filler(p, labels, labels.region ?? '{region}', (id) => options.find((o) => o.id === id)?.as[p]?.label)
  return {
    type: 'challenge',
    id: m.id,
    track: m.track,
    difficulty: m.difficulty,
    title: m.title,
    provider: p,
    par_minutes: m.par_minutes,
    brief: fill(m.brief),
    requirements: m.requirements.map(fill),
    budget: m.budget,
    tiers: m.tiers.map((t) => ({
      id: t.id,
      label: fill(t.label),
      options: t.options.map((o) => ({
        id: o.id,
        label: o.as[p]!.label,
        short: o.as[p]!.short,
        cost: o.cost,
        facts: o.as[p]!.facts,
        capabilities: o.capabilities,
        overkill: o.overkill && fill(o.overkill),
      })),
    })),
    stress_tests: m.stress_tests.map((t) => ({ ...t, label: fill(t.label) })),
    failure_feedback: Object.fromEntries(
      Object.entries(m.failure_feedback).map(([o, byTest]) => [o, Object.fromEntries(Object.entries(byTest).map(([k, v]) => [k, fill(v)]))]),
    ),
    reference_designs: m.reference_designs.map((r) => ({ ...r, why: fill(r.why) })),
    hints: { nudge: fill(m.hints.nudge), direction: fill(m.hints.direction), answer: fill(m.hints.answer) },
    analogy: m.analogy,
    debrief: { summary: fill(m.debrief.summary), real_world: m.debrief.real_world && fill(m.debrief.real_world) },
    sources: m.sources[p]!,
  } as Challenge
}
