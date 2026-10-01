// Canvas design challenges: the player builds the architecture's shape
// (components in zone/region lanes, traffic and replication links), then
// stress tests knock things out. See PLAN_DESIGN_CANVAS.md.
//
// Structural checks live here. Checks that need the graph engine (reference
// designs pass, counter-examples fail exactly what they claim) live in
// vite-plugin-content.ts.

import { z } from 'zod'
import { AnalogySchema, HintsSchema, SourcesSchema, id } from './scenario.ts'

import { MAX_NODES, ROLES, USERS } from './constants.ts'

export { MAX_NODES, ROLES, USERS } from './constants.ts'

const PaletteItemSchema = z.strictObject({
  id,
  label: z.string().min(1),
  short: z.string().min(1).max(22).optional(),
  scope: z.enum(['zonal', 'regional', 'global']), // which lanes accept it
  roles: z.array(z.enum(ROLES)).min(1),
  capacity: z.number().min(0).default(0), // multiples of normal traffic, for `serve`
  cost: z.number().min(0),
  facts: z.array(z.string().min(1)).min(1),
  overkill: z.string().optional(),
})

const NodeSchema = z.strictObject({ id, type: id, lane: id })
const EdgeSchema = z.strictObject({
  from: id,
  to: id,
  // traffic: requests flow from -> to. sync/async: data replicates from -> to.
  kind: z.enum(['traffic', 'sync', 'async']),
})
export const DesignSchema = z.strictObject({ nodes: z.array(NodeSchema), edges: z.array(EdgeSchema) })

const EventSchema = z.union([
  z.strictObject({ none: z.literal(true) }),
  z.strictObject({ zone_outage: id }),
  z.strictObject({ region_outage: id }),
  z.strictObject({ single_failure: id }), // each component of this palette type, one at a time
])

const CheckSchema = z.strictObject({
  reach: z.array(z.enum(['serve', 'write-store'])).min(1),
  capacity: z.number().positive().optional(), // surviving `serve` capacity needed
})

export const CanvasChallengeSchema = z
  .strictObject({
    type: z.literal('challenge'),
    mode: z.literal('canvas'),
    id,
    track: id,
    difficulty: z.int().min(1).max(5),
    title: z.string().min(1),
    provider: z.enum(['aws', 'azure', 'gcp']),
    par_minutes: z.number().positive(),

    brief: z.string().min(1),
    requirements: z.array(z.string().min(1)).min(1),
    budget: z.number().positive(),

    layout: z.strictObject({
      regions: z
        .array(
          z.strictObject({
            id,
            label: z.string().min(1),
            zones: z.array(z.strictObject({ id, label: z.string().min(1) })).min(1),
          }),
        )
        .min(1),
      global: z.boolean().default(false),
    }),
    palette: z.array(PaletteItemSchema).min(2),
    // Facts about the two replication link types, shown next to the connect controls.
    link_facts: z.strictObject({ sync: z.array(z.string().min(1)).min(1), async: z.array(z.string().min(1)).min(1) }),

    stress_tests: z
      .array(z.strictObject({ id, label: z.string().min(1), event: EventSchema, check: CheckSchema }))
      .min(1),
    reference_designs: z
      .array(z.strictObject({ name: z.string().min(1), why: z.string().min(1), design: DesignSchema }))
      .min(1),
    // Designs that must fail exactly the listed tests ("budget" counts as a test).
    // They prove each stress test catches a real mistake.
    counter_examples: z
      .array(z.strictObject({ name: z.string().min(1), fails: z.array(id).min(1), design: DesignSchema }))
      .min(1),

    hints: HintsSchema,
    analogy: AnalogySchema,
    debrief: z.strictObject({ summary: z.string().min(1), real_world: z.string().optional() }),
    sources: SourcesSchema,
  })
  .superRefine((c, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path, input: c })

    const zones = new Set(c.layout.regions.flatMap((r) => r.zones.map((z) => z.id)))
    const regions = new Set(c.layout.regions.map((r) => r.id))
    const laneIds = [...zones, ...regions, ...(c.layout.global ? ['global'] : [])]
    if (new Set(laneIds).size !== laneIds.length) issue('lane ids must be unique across regions and zones', ['layout'])
    const palette = new Map(c.palette.map((p) => [p.id, p]))
    if (palette.size !== c.palette.length) issue('duplicate palette id', ['palette'])
    const testIds = new Set(c.stress_tests.map((t) => t.id))

    c.stress_tests.forEach((t, i) => {
      const e = t.event
      if ('zone_outage' in e && !zones.has(e.zone_outage)) issue(`unknown zone "${e.zone_outage}"`, ['stress_tests', i, 'event'])
      if ('region_outage' in e && !regions.has(e.region_outage))
        issue(`unknown region "${e.region_outage}"`, ['stress_tests', i, 'event'])
      if ('single_failure' in e && !palette.has(e.single_failure))
        issue(`unknown palette type "${e.single_failure}"`, ['stress_tests', i, 'event'])
    })

    const checkDesign = (d: z.infer<typeof DesignSchema>, path: (string | number)[]) => {
      const nodes = new Map(d.nodes.map((n) => [n.id, n]))
      if (nodes.size !== d.nodes.length) issue('duplicate node id', path)
      if (nodes.has(USERS)) issue(`"${USERS}" is reserved`, path)
      if (d.nodes.length > MAX_NODES) issue(`more than ${MAX_NODES} components`, path)
      d.nodes.forEach((n, i) => {
        const p = palette.get(n.type)
        if (!p) return issue(`unknown palette type "${n.type}"`, [...path, 'nodes', i])
        const ok =
          (p.scope === 'zonal' && zones.has(n.lane)) ||
          (p.scope === 'regional' && regions.has(n.lane)) ||
          (p.scope === 'global' && n.lane === 'global' && c.layout.global)
        if (!ok) issue(`${p.scope} component "${n.id}" can't go in lane "${n.lane}"`, [...path, 'nodes', i])
      })
      d.edges.forEach((e, i) => {
        if (e.from !== USERS && !nodes.has(e.from)) issue(`unknown node "${e.from}"`, [...path, 'edges', i])
        if (!nodes.has(e.to)) issue(`unknown node "${e.to}"`, [...path, 'edges', i])
        if (e.kind !== 'traffic') {
          const isStore = (nid: string) => palette.get(nodes.get(nid)?.type ?? '')?.roles.includes('write-store')
          if (!isStore(e.from) || !isStore(e.to)) issue('replication links must join two databases', [...path, 'edges', i])
        }
      })
    }
    c.reference_designs.forEach((r, i) => checkDesign(r.design, ['reference_designs', i, 'design']))
    c.counter_examples.forEach((x, i) => {
      checkDesign(x.design, ['counter_examples', i, 'design'])
      x.fails.forEach((f) => {
        if (f !== 'budget' && !testIds.has(f)) issue(`unknown stress test "${f}"`, ['counter_examples', i, 'fails'])
      })
    })
  })

export type CanvasChallenge = z.infer<typeof CanvasChallengeSchema>
export type Design = z.infer<typeof DesignSchema>
export type CanvasTest = CanvasChallenge['stress_tests'][number]
