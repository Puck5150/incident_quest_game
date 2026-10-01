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
import { z } from 'zod'
import type { Plugin } from 'vite'
import { TrackSchema, type Scenario, type Track } from './src/schema/scenario.ts'
import type { Challenge } from './src/schema/challenge.ts'
import type { CanvasChallenge } from './src/schema/canvas.ts'
import { checkRaw, itemMeta, parseItem, type MultiChallenge } from './src/content/item.ts'

export { contentKind, type ContentKind, type MultiChallenge } from './src/content/item.ts'

export type Content = {
  tracks: Track[]
  scenarios: Scenario[]
  challenges: Challenge[]
  canvases: CanvasChallenge[]
  multis: MultiChallenge[]
}

export function loadContent(dir: string): Content {
  const errors: string[] = []
  const tracks = check(path.join(dir, 'tracks.yaml'), z.array(TrackSchema), errors) ?? []
  const trackIds = new Set(tracks.map((t) => t.id))
  const seen = new Set<string>()
  const content: Content = { tracks, scenarios: [], challenges: [], canvases: [], multis: [] }

  for (const file of scenarioFiles(dir)) {
    const rel = path.relative(dir, file)
    const where = path.relative(process.cwd(), file)
    const { item, errors: fileErrors } = parseItem(fs.readFileSync(file, 'utf8'), where)
    errors.push(...fileErrors)
    if (!item) continue

    // Checks that span files. Progress is saved by id, so ids must be stable and
    // unique across every kind of content. Tying id to filename and track to
    // folder makes both obvious.
    const { id, track } = itemMeta(item)
    const fileId = path.basename(file).replace(/\.ya?ml$/, '')
    if (id !== fileId) errors.push(`${where}: id "${id}" must match the filename ("${fileId}")`)
    if (track !== path.dirname(rel)) errors.push(`${where}: track "${track}" must match the folder ("${path.dirname(rel)}")`)
    if (!trackIds.has(track)) errors.push(`${where}: track "${track}" is not defined in tracks.yaml`)
    if (seen.has(id)) errors.push(`${where}: duplicate id "${id}"`)
    seen.add(id)

    if (item.kind === 'incident') content.scenarios.push(item.scenario)
    else if (item.kind === 'challenge') content.challenges.push(item.challenge)
    else if (item.kind === 'canvas') content.canvases.push(item.canvas)
    else content.multis.push(item.multi)
  }

  tracks.forEach((t) =>
    t.requires.forEach((r) => {
      if (!trackIds.has(r)) errors.push(`tracks.yaml: track "${t.id}" requires unknown track "${r}"`)
    }),
  )

  if (errors.length) throw new Error(`Invalid content:\n\n${errors.join('\n\n')}`)
  return content
}

// Parse + validate one file against one schema (used for tracks.yaml and by
// tests on the templates).
export const check = <T>(file: string, schema: z.ZodType<T>, errors: string[]): T | undefined =>
  checkRaw(fs.readFileSync(file, 'utf8'), schema, path.relative(process.cwd(), file), errors)

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
