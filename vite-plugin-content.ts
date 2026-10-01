// Loads every YAML file under /content, validates it, and exposes it to the
// app as `virtual:content`: a small index (tracks plus queue metadata) and
// `loadItem(id)`, which imports one item's full content as its own chunk.
//
// Why a plugin instead of importing YAML at runtime: validation happens at
// BUILD time. A broken scenario fails `npm run build` (and shows Vite's error
// overlay in dev) instead of shipping and breaking in the player's browser.
// The same loadContent() function is used by the Vitest content test.

import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Plugin } from 'vite'
import { ScenarioSchema, TrackSchema, type Scenario, type Track } from './src/schema/scenario.ts'
import { ChallengeSchema, type Challenge } from './src/schema/challenge.ts'
import { evaluate } from './src/game/challenge.ts'
import { CanvasChallengeSchema, type CanvasChallenge } from './src/schema/canvas.ts'
import { evaluateCanvas } from './src/game/canvas.ts'
import { MultiCanvasSchema, MultiSlotSchema, resolveProvider, resolveSlot, unresolvedTokens, type Provider } from './src/schema/multi.ts'

// A "pick your cloud" challenge after resolving: one ordinary canvas
// challenge per provider, plus what the debrief needs to compare them.
type MultiBase = {
  id: string
  track: string
  title: string
  difficulty: number
  providers: Provider[]
  differences: Record<string, string> // palette or option id -> what isn't equivalent
}
export type MultiChallenge =
  | (MultiBase & { kind: 'canvas'; variants: Partial<Record<Provider, CanvasChallenge>> })
  | (MultiBase & { kind: 'slot'; variants: Partial<Record<Provider, Challenge>> })

export type Content = {
  tracks: Track[]
  scenarios: Scenario[]
  challenges: Challenge[]
  canvases: CanvasChallenge[]
  multis: MultiChallenge[]
}

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

export function loadContent(dir: string): Content {
  const errors: string[] = []

  const tracksFile = path.join(dir, 'tracks.yaml')
  const tracks = check(tracksFile, z.array(TrackSchema), errors) ?? []
  const trackIds = new Set(tracks.map((t) => t.id))

  const seen = new Set<string>()
  // Progress is saved by id, so ids must be stable and unique across every
  // kind of content. Tying id to filename and track to folder makes both obvious.
  const commonChecks = (rel: string, file: string, id: string, track: string) => {
    const fileId = path.basename(file).replace(/\.ya?ml$/, '')
    const folder = path.dirname(rel)
    if (id !== fileId) errors.push(`${rel}: id "${id}" must match the filename ("${fileId}")`)
    if (track !== folder) errors.push(`${rel}: track "${track}" must match the folder ("${folder}")`)
    if (!trackIds.has(track)) errors.push(`${rel}: track "${track}" is not defined in tracks.yaml`)
    if (seen.has(id)) errors.push(`${rel}: duplicate id "${id}"`)
    seen.add(id)
  }
  // Reference designs must pass; counter-examples must fail exactly the tests
  // they name, proving each test catches the mistake it's meant to.
  const canvasChecks = (where: string, c: CanvasChallenge) => {
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
  const slotChecks = (where: string, c: Challenge) => {
    c.reference_designs.forEach((d) => {
      const e = evaluate(c, d.picks)
      if (!e.pass) {
        const failed = e.tests.filter((t) => !t.pass).map((t) => t.id)
        if (!e.withinBudget) failed.push(`budget (${e.cost} > ${c.budget})`)
        errors.push(`${where}: reference design "${d.name}" fails: ${failed.join(', ')}`)
      }
    })
  }

  const scenarios: Scenario[] = []
  const challenges: Challenge[] = []
  const canvases: CanvasChallenge[] = []
  const multis: MultiChallenge[] = []
  for (const file of scenarioFiles(dir)) {
    const rel = path.relative(dir, file)
    const raw = fs.readFileSync(file, 'utf8')
    const kind = contentKind(raw)
    if (kind === 'pick-cloud-canvas') {
      const m = check(file, MultiCanvasSchema, errors)
      if (!m) continue
      commonChecks(rel, file, m.id, m.track)
      const variants: Partial<Record<Provider, CanvasChallenge>> = {}
      for (const p of m.providers) {
        // Re-validate each resolved variant exactly like a hand-written canvas challenge.
        const parsed = CanvasChallengeSchema.safeParse(resolveProvider(m, p))
        if (!parsed.success) {
          errors.push(`${rel} [${p}]:\n${z.prettifyError(parsed.error)}`)
          continue
        }
        const tokens = unresolvedTokens(parsed.data)
        if (tokens.length) errors.push(`${rel} [${p}]: unresolved ${tokens.join(', ')}`)
        canvasChecks(`${rel} [${p}]`, parsed.data)
        variants[p] = parsed.data
      }
      multis.push({
        kind: 'canvas',
        id: m.id,
        track: m.track,
        title: m.title,
        difficulty: m.difficulty,
        providers: m.providers,
        variants,
        differences: Object.fromEntries(m.palette.map((x) => [x.id, x.differences])),
      })
      continue
    }
    if (kind === 'pick-cloud-slot') {
      const m = check(file, MultiSlotSchema, errors)
      if (!m) continue
      commonChecks(rel, file, m.id, m.track)
      const variants: Partial<Record<Provider, Challenge>> = {}
      for (const p of m.providers) {
        const parsed = ChallengeSchema.safeParse(resolveSlot(m, p))
        if (!parsed.success) {
          errors.push(`${rel} [${p}]:\n${z.prettifyError(parsed.error)}`)
          continue
        }
        const tokens = unresolvedTokens(parsed.data)
        if (tokens.length) errors.push(`${rel} [${p}]: unresolved ${tokens.join(', ')}`)
        slotChecks(`${rel} [${p}]`, parsed.data)
        variants[p] = parsed.data
      }
      multis.push({
        kind: 'slot',
        id: m.id,
        track: m.track,
        title: m.title,
        difficulty: m.difficulty,
        providers: m.providers,
        variants,
        differences: Object.fromEntries(m.tiers.flatMap((t) => t.options.map((o) => [o.id, o.differences]))),
      })
      continue
    }
    const s = kind === 'canvas'
      ? check(file, CanvasChallengeSchema, errors)
      : kind === 'challenge'
        ? check(file, ChallengeSchema, errors)
        : check(file, ScenarioSchema, errors)
    if (!s) continue
    commonChecks(rel, file, s.id, s.track)

    if ('mode' in s) {
      canvasChecks(rel, s)
      canvases.push(s)
    } else if (s.type === 'challenge') {
      slotChecks(rel, s)
      challenges.push(s)
    } else scenarios.push(s)
  }

  tracks.forEach((t) =>
    t.requires.forEach((r) => {
      if (!trackIds.has(r)) errors.push(`tracks.yaml: track "${t.id}" requires unknown track "${r}"`)
    }),
  )

  if (errors.length) throw new Error(`Invalid content:\n\n${errors.join('\n\n')}`)
  return { tracks, scenarios, challenges, canvases, multis }
}

const failedIds = (e: ReturnType<typeof evaluateCanvas>) => [
  ...e.tests.filter((t) => !t.pass).map((t) => t.id),
  ...(e.withinBudget ? [] : ['budget']),
]

// Parse + validate one file. Returns undefined (and records errors) on failure
// so we can report every broken file at once, not just the first.
export function check<T>(file: string, schema: z.ZodType<T>, errors: string[]): T | undefined {
  let data: unknown
  try {
    data = parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    errors.push(`${path.relative(process.cwd(), file)}: ${(e as Error).message}`)
    return undefined
  }
  const result = schema.safeParse(data)
  if (!result.success) {
    errors.push(`${path.relative(process.cwd(), file)}:\n${z.prettifyError(result.error)}`)
    return undefined
  }
  return result.data
}

// Every .yaml under dir except tracks.yaml and files starting with "_"
// (like _template.yaml), which are not playable scenarios.
function scenarioFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.ya?ml$/.test(f) && f !== 'tracks.yaml' && !path.basename(f).startsWith('_'))
    .sort()
    .map((f) => path.join(dir, f))
}

// What the queue, skill tree and unlocks need, without the full content.
function indexOf(c: Content) {
  const base = (x: { id: string; track: string; title: string; difficulty: number }) => ({
    id: x.id,
    track: x.track,
    title: x.title,
    difficulty: x.difficulty,
  })
  return {
    tracks: c.tracks,
    items: [
      ...c.scenarios.map((s) => ({ ...base(s), kind: 'incident' as const, tag: s.ticket.priority })),
      ...c.challenges.map((x) => ({ ...base(x), kind: 'challenge' as const, tag: 'Design' })),
      ...c.canvases.map((x) => ({ ...base(x), kind: 'challenge' as const, tag: 'Design · canvas' })),
      ...c.multis.map((m) => ({ ...base(m), kind: 'challenge' as const, tag: 'Design · pick your cloud', providers: m.providers })),
    ],
  }
}

// One item's full content, tagged with how it plays.
function itemOf(c: Content, id: string) {
  const find = <T extends { id: string }>(xs: T[]) => xs.find((x) => x.id === id)
  const s = find(c.scenarios)
  if (s) return { kind: 'incident', scenario: s }
  const ch = find(c.challenges)
  if (ch) return { kind: 'challenge', challenge: ch }
  const cv = find(c.canvases)
  if (cv) return { kind: 'canvas', canvas: cv }
  const m = find(c.multis)
  if (m) return { kind: 'multi', multi: m }
}

const VIRTUAL_ID = 'virtual:content'
const RESOLVED_ID = '\0' + VIRTUAL_ID
const ITEM_PREFIX = VIRTUAL_ID + '/item/'

export function contentPlugin(dir: string): Plugin {
  // Validated once per build (and again after a YAML change in dev), not once per module.
  let cached: Content | undefined
  const content = () => (cached ??= loadContent(dir))
  return {
    name: 'incident-quest-content',
    resolveId(id) {
      if (id === VIRTUAL_ID || id.startsWith(ITEM_PREFIX)) return '\0' + id
    },
    load(id) {
      if (id === RESOLVED_ID) {
        const c = content()
        const all = [...c.scenarios, ...c.challenges, ...c.canvases, ...c.multis]
        const loaders = all.map((x) => `${JSON.stringify(x.id)}: () => import(${JSON.stringify(ITEM_PREFIX + x.id)})`)
        return [
          `export default ${JSON.stringify(indexOf(c))}`,
          `const loaders = {${loaders.join(',')}}`,
          `export const loadItem = (id) => loaders[id]().then((m) => m.default)`,
        ].join('\n')
      }
      if (id.startsWith('\0' + ITEM_PREFIX)) {
        return `export default ${JSON.stringify(itemOf(content(), id.slice(1 + ITEM_PREFIX.length)))}`
      }
    },
    // YAML files aren't imported modules, so Vite doesn't know to reload when
    // they change. Watch the folder ourselves and force a full reload.
    configureServer(server) {
      server.watcher.add(dir)
      server.watcher.on('all', (_event, file) => {
        if (!file.startsWith(dir)) return
        cached = undefined
        for (const [id, mod] of server.moduleGraph.idToModuleMap)
          if (id.startsWith(RESOLVED_ID)) server.moduleGraph.invalidateModule(mod)
        server.ws.send({ type: 'full-reload' })
      })
    },
  }
}
