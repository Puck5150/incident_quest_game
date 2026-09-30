// Loads every YAML file under /content, validates it, and exposes the result
// to the app as `import content from 'virtual:content'`.
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
import { MultiCanvasSchema, resolveProvider, unresolvedTokens, type Provider } from './src/schema/multi.ts'

// A "pick your cloud" challenge after resolving: one ordinary canvas
// challenge per provider, plus what the debrief needs to compare them.
export type MultiChallenge = {
  id: string
  track: string
  title: string
  difficulty: number
  providers: Provider[]
  variants: Partial<Record<Provider, CanvasChallenge>>
  differences: Record<string, string> // palette id -> what isn't equivalent
}

export type Content = {
  tracks: Track[]
  scenarios: Scenario[]
  challenges: Challenge[]
  canvases: CanvasChallenge[]
  multis: MultiChallenge[]
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

  const scenarios: Scenario[] = []
  const challenges: Challenge[] = []
  const canvases: CanvasChallenge[] = []
  const multis: MultiChallenge[] = []
  for (const file of scenarioFiles(dir)) {
    const rel = path.relative(dir, file)
    // `type: challenge` files are design challenges (`mode: canvas` for the
    // canvas kind); everything else is an incident. Top-level keys only: block
    // text is indented, so it can't match these.
    const raw = fs.readFileSync(file, 'utf8')
    const isChallenge = /^type:\s*challenge\s*$/m.test(raw)
    const isCanvas = isChallenge && /^mode:\s*canvas\s*$/m.test(raw)
    if (isCanvas && /^providers:/m.test(raw)) {
      const m = check(file, MultiCanvasSchema, errors)
      if (!m) continue
      commonChecks(rel, file, m.id, m.track)
      const variants: MultiChallenge['variants'] = {}
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
    const s = isCanvas
      ? check(file, CanvasChallengeSchema, errors)
      : isChallenge
        ? check(file, ChallengeSchema, errors)
        : check(file, ScenarioSchema, errors)
    if (!s) continue
    commonChecks(rel, file, s.id, s.track)

    if ('mode' in s) {
      canvasChecks(rel, s)
      canvases.push(s)
    } else if (s.type === 'challenge') {
      // Every reference design must actually pass, or the debrief would teach a wrong answer.
      s.reference_designs.forEach((d) => {
        const e = evaluate(s, d.picks)
        if (!e.pass) {
          const failed = e.tests.filter((t) => !t.pass).map((t) => t.id)
          if (!e.withinBudget) failed.push(`budget (${e.cost} > ${s.budget})`)
          errors.push(`${rel}: reference design "${d.name}" fails: ${failed.join(', ')}`)
        }
      })
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

const VIRTUAL_ID = 'virtual:content'
const RESOLVED_ID = '\0' + VIRTUAL_ID

export function contentPlugin(dir: string): Plugin {
  return {
    name: 'incident-quest-content',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
    },
    load(id) {
      if (id === RESOLVED_ID) return `export default ${JSON.stringify(loadContent(dir))}`
    },
    // YAML files aren't imported modules, so Vite doesn't know to reload when
    // they change. Watch the folder ourselves and force a full reload.
    configureServer(server) {
      server.watcher.add(dir)
      server.watcher.on('all', (_event, file) => {
        if (!file.startsWith(dir)) return
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID)
        if (mod) server.moduleGraph.invalidateModule(mod)
        server.ws.send({ type: 'full-reload' })
      })
    },
  }
}
