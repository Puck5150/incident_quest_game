// Parses and validates ONE content file: every check that needs nothing but
// the file itself. Shared by the build (vite-plugin-content.ts, which adds the
// checks that span files: unique ids, known tracks, id matches filename) and
// the in-browser preview page, so both report exactly the same errors.
// No Node APIs here: this also runs in the browser.

import { parse } from 'yaml'
import { z } from 'zod'
import { ScenarioSchema, type Scenario } from '../schema/scenario.ts'
import type { Breakdown } from '../schema/commands.ts'
import { ChallengeSchema, type Challenge } from '../schema/challenge.ts'
import { CanvasChallengeSchema, type CanvasChallenge } from '../schema/canvas.ts'
import { MultiCanvasSchema, MultiSlotSchema, resolveProvider, resolveSlot, unresolvedTokens, type Provider } from '../schema/multi.ts'
import { evaluate } from '../game/challenge.ts'
import { evaluateCanvas } from '../game/canvas.ts'

// A "pick your cloud" challenge after resolving: one ordinary canvas or slot
// challenge per provider, plus what the debrief needs to compare them.
type MultiBase = {
  id: string
  track: string
  title: string
  difficulty: number
  published?: boolean
  providers: Provider[]
  differences: Record<string, string> // palette or option id -> what isn't equivalent
}
export type MultiChallenge =
  | (MultiBase & { kind: 'canvas'; variants: Partial<Record<Provider, CanvasChallenge>> })
  | (MultiBase & { kind: 'slot'; variants: Partial<Record<Provider, Challenge>> })

// One playable item's full content, tagged with how it plays.
export type Item =
  | { kind: 'incident'; scenario: Scenario; breakdown?: Breakdown } // breakdown: added by the build (not in preview)
  | { kind: 'challenge'; challenge: Challenge }
  | { kind: 'canvas'; canvas: CanvasChallenge }
  | { kind: 'multi'; multi: MultiChallenge }

export const itemMeta = (item: Item) =>
  item.kind === 'incident' ? item.scenario : item.kind === 'challenge' ? item.challenge : item.kind === 'canvas' ? item.canvas : item.multi

// Which schema a content file uses. `type: challenge` files are design
// challenges (`mode: canvas` for the canvas kind, `providers:` for "pick your
// cloud"); everything else is an incident. Top-level keys only: block text is
// indented, so it can't match these. Also names the file in schemas/.
export type ContentKind = 'incident' | 'challenge' | 'canvas' | 'pick-cloud-canvas' | 'pick-cloud-slot'
export function contentKind(raw: string): ContentKind {
  const challenge = /^type:\s*challenge\s*$/m.test(raw)
  const canvas = challenge && /^mode:\s*canvas\s*$/m.test(raw)
  const multi = /^providers:/m.test(raw)
  return canvas ? (multi ? 'pick-cloud-canvas' : 'canvas') : challenge ? (multi ? 'pick-cloud-slot' : 'challenge') : 'incident'
}

// Parse YAML text and check it against a schema. Returns undefined (and
// records errors) on failure, so callers can report every problem at once.
export function checkRaw<T>(raw: string, schema: z.ZodType<T>, where: string, errors: string[]): T | undefined {
  let data: unknown
  try {
    data = parse(raw)
  } catch (e) {
    errors.push(`${where}: ${(e as Error).message}`)
    return undefined
  }
  const result = schema.safeParse(data)
  if (!result.success) {
    errors.push(`${where}:\n${z.prettifyError(result.error)}`)
    return undefined
  }
  return result.data
}

const failedIds = (e: ReturnType<typeof evaluateCanvas>) => [
  ...e.tests.filter((t) => !t.pass).map((t) => t.id),
  ...(e.withinBudget ? [] : ['budget']),
]

// Reference designs must pass; counter-examples must fail exactly the tests
// they name, proving each test catches the mistake it's meant to.
function canvasChecks(where: string, c: CanvasChallenge, errors: string[]) {
  c.reference_designs.forEach((d) => {
    const e = evaluateCanvas(c, d.design)
    if (!e.pass) errors.push(`${where}: reference design "${d.name}" fails: ${failedIds(e).join(', ')}`)
  })
  c.counter_examples.forEach((x) => {
    const got = failedIds(evaluateCanvas(c, x.design)).sort()
    const want = [...x.fails].sort()
    if (JSON.stringify(got) !== JSON.stringify(want))
      errors.push(`${where}: counter-example "${x.name}" should fail [${want.join(', ')}] but fails [${got.join(', ')}]`)
  })
}

// Every reference design must actually pass, or the debrief would teach a wrong answer.
function slotChecks(where: string, c: Challenge, errors: string[]) {
  c.reference_designs.forEach((d) => {
    const e = evaluate(c, d.picks)
    if (!e.pass) {
      const failed = e.tests.filter((t) => !t.pass).map((t) => t.id)
      if (!e.withinBudget) failed.push(`budget (${e.cost} > ${c.budget})`)
      errors.push(`${where}: reference design "${d.name}" fails: ${failed.join(', ')}`)
    }
  })
}

// Resolve a "pick your cloud" file into one ordinary challenge per provider,
// and re-validate each exactly like a hand-written one.
function variantsOf<M extends { providers: Provider[] }, C extends Challenge | CanvasChallenge>(
  m: M,
  resolve: (m: M, p: Provider) => unknown,
  schema: z.ZodType<C>,
  checks: (where: string, c: C, errors: string[]) => void,
  where: string,
  errors: string[],
): Partial<Record<Provider, C>> {
  const variants: Partial<Record<Provider, C>> = {}
  for (const p of m.providers) {
    const parsed = schema.safeParse(resolve(m, p))
    if (!parsed.success) {
      errors.push(`${where} [${p}]:\n${z.prettifyError(parsed.error)}`)
      continue
    }
    const tokens = unresolvedTokens(parsed.data)
    if (tokens.length) errors.push(`${where} [${p}]: unresolved ${tokens.join(', ')}`)
    checks(`${where} [${p}]`, parsed.data, errors)
    variants[p] = parsed.data
  }
  return variants
}

// `where` prefixes every error (a file path in the build, "your file" in the preview).
export function parseItem(raw: string, where: string): { item?: Item; errors: string[] } {
  const errors: string[] = []
  const kind = contentKind(raw)
  const base = (m: MultiBase) => ({ id: m.id, track: m.track, title: m.title, difficulty: m.difficulty, published: m.published, providers: m.providers })

  if (kind === 'pick-cloud-canvas') {
    const m = checkRaw(raw, MultiCanvasSchema, where, errors)
    if (!m) return { errors }
    const variants = variantsOf(m, resolveProvider, CanvasChallengeSchema, canvasChecks, where, errors)
    const differences = Object.fromEntries(m.palette.map((x) => [x.id, x.differences]))
    return { item: { kind: 'multi', multi: { ...base({ ...m, differences }), kind: 'canvas', variants, differences } }, errors }
  }
  if (kind === 'pick-cloud-slot') {
    const m = checkRaw(raw, MultiSlotSchema, where, errors)
    if (!m) return { errors }
    const variants = variantsOf(m, resolveSlot, ChallengeSchema, slotChecks, where, errors)
    const differences = Object.fromEntries(m.tiers.flatMap((t) => t.options.map((o) => [o.id, o.differences])))
    return { item: { kind: 'multi', multi: { ...base({ ...m, differences }), kind: 'slot', variants, differences } }, errors }
  }
  if (kind === 'canvas') {
    const c = checkRaw(raw, CanvasChallengeSchema, where, errors)
    if (c) canvasChecks(where, c, errors)
    return { item: c && { kind: 'canvas', canvas: c }, errors }
  }
  if (kind === 'challenge') {
    const c = checkRaw(raw, ChallengeSchema, where, errors)
    if (c) slotChecks(where, c, errors)
    return { item: c && { kind: 'challenge', challenge: c }, errors }
  }
  const s = checkRaw(raw, ScenarioSchema, where, errors)
  return { item: s && { kind: 'incident', scenario: s }, errors }
}
