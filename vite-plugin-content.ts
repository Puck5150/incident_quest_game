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
import { SandboxSchema, type SandboxChallenge } from './src/schema/sandbox.ts'
import { resolveSandbox } from './src/game/sandbox.ts'
import { checkRaw, itemMeta, parseItem, type MultiChallenge } from './src/content/item.ts'
import { CommandLibrarySchema, type CommandEntry } from './src/schema/commands.ts'
import { breakdownFor, uncovered } from './src/game/breakdown.ts'

export { contentKind, type ContentKind, type MultiChallenge } from './src/content/item.ts'

export type Content = {
  tracks: Track[]
  scenarios: Scenario[]
  challenges: Challenge[]
  canvases: CanvasChallenge[]
  multis: MultiChallenge[]
  library: CommandEntry[] // content/commands/*.yaml: the command breakdown library
  sandboxes: SandboxChallenge[] // content/sandbox/*.yaml, resolved against their canvas challenge
}

export function loadContent(dir: string): Content {
  const errors: string[] = []
  const tracks = check(path.join(dir, 'tracks.yaml'), z.array(TrackSchema), errors) ?? []
  const trackIds = new Set(tracks.map((t) => t.id))
  const seen = new Set<string>()
  const content: Content = { tracks, scenarios: [], challenges: [], canvases: [], multis: [], library: [], sandboxes: [] }

  // The command library: one file per tool family, entry ids unique across all.
  const libDir = path.join(dir, COMMANDS_DIR)
  if (fs.existsSync(libDir))
    for (const f of fs.readdirSync(libDir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      const entries = check(path.join(libDir, f), CommandLibrarySchema, errors) ?? []
      for (const e of entries) {
        if (content.library.some((x) => x.id === e.id)) errors.push(`${COMMANDS_DIR}/${f}: duplicate command entry id "${e.id}"`)
        content.library.push(e)
      }
    }

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

    if (item.kind === 'incident') {
      content.scenarios.push(item.scenario)
      // Every command that finds key evidence or verifies a fix is explained in the debrief.
      for (const cmd of uncovered(item.scenario, content.library))
        errors.push(`${where}: command "${cmd}" has no entry in content/commands/ (see AUTHORING.md, Command breakdown library)`)
    }
    else if (item.kind === 'challenge') content.challenges.push(item.challenge)
    else if (item.kind === 'canvas') content.canvases.push(item.canvas)
    else content.multis.push(item.multi)
  }

  // Sandbox files: one per cloud, resolved against the canvas challenge they extend.
  const sandboxDir = path.join(dir, SANDBOX_DIR)
  if (fs.existsSync(sandboxDir))
    for (const f of fs.readdirSync(sandboxDir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      const file = path.join(sandboxDir, f)
      const where = path.relative(process.cwd(), file)
      const s = check(file, SandboxSchema, errors)
      if (!s) continue
      if (s.id !== f.replace(/\.ya?ml$/, '')) errors.push(`${where}: id "${s.id}" must match the filename`)
      if (seen.has(s.id)) errors.push(`${where}: duplicate id "${s.id}"`)
      seen.add(s.id)
      const base = content.canvases.find((c) => c.id === s.extends)
      if (!base) {
        errors.push(`${where}: extends "${s.extends}", which is not a canvas challenge`)
        continue
      }
      const resolved = resolveSandbox(s, base)
      if (typeof resolved === 'string') errors.push(`${where}: ${resolved}`)
      else content.sandboxes.push(resolved)
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

// Every .yaml under dir except tracks.yaml, files starting with "_" (like
// _template.yaml), the command library and the sandbox files, which are not playable scenarios.
const COMMANDS_DIR = 'commands'
const SANDBOX_DIR = 'sandbox'

function scenarioFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.ya?ml$/.test(f) && f !== 'tracks.yaml' && !path.basename(f).startsWith('_') && !f.startsWith(COMMANDS_DIR + path.sep) && !f.startsWith(SANDBOX_DIR + path.sep))
    .sort()
    .map((f) => path.join(dir, f))
}

// What the queue, skill tree and unlocks need, without the full content.
function indexOf(c: Content) {
  const base = (x: { id: string; track: string; title: string; difficulty: number; published?: boolean }) => ({
    id: x.id,
    track: x.track,
    title: x.title,
    difficulty: x.difficulty,
    published: x.published !== false,
  })
  return {
    tracks: c.tracks,
    items: [
      ...c.scenarios.map((s) => ({ ...base(s), kind: 'incident' as const, tag: s.ticket.severity })),
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
  if (s) return { kind: 'incident', scenario: s, breakdown: breakdownFor(s, c.library) }
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
const SANDBOX_PREFIX = VIRTUAL_ID + '/sandbox/'

export function contentPlugin(dir: string): Plugin {
  // Validated once per build (and again after a YAML change in dev), not once per module.
  let cached: Content | undefined
  const content = () => (cached ??= loadContent(dir))
  return {
    name: 'incident-quest-content',
    resolveId(id) {
      if (id === VIRTUAL_ID || id.startsWith(ITEM_PREFIX) || id.startsWith(SANDBOX_PREFIX)) return '\0' + id
    },
    load(id) {
      if (id === RESOLVED_ID) {
        const c = content()
        const all = [...c.scenarios, ...c.challenges, ...c.canvases, ...c.multis]
        const loaders = all.map((x) => `${JSON.stringify(x.id)}: () => import(${JSON.stringify(ITEM_PREFIX + x.id)})`)
        const sandboxes = c.sandboxes.map((s) => `${JSON.stringify(s.provider)}: () => import(${JSON.stringify(SANDBOX_PREFIX + s.provider)})`)
        return [
          `export default ${JSON.stringify(indexOf(c))}`,
          `const loaders = {${loaders.join(',')}}`,
          `export const loadItem = (id) => loaders[id]().then((m) => m.default)`,
          `const sandboxLoaders = {${sandboxes.join(',')}}`,
          `export const loadSandbox = (provider) => sandboxLoaders[provider]?.().then((m) => m.default)`,
        ].join('\n')
      }
      if (id.startsWith('\0' + SANDBOX_PREFIX)) {
        const provider = id.slice(1 + SANDBOX_PREFIX.length)
        return `export default ${JSON.stringify(content().sandboxes.find((s) => s.provider === provider))}`
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
