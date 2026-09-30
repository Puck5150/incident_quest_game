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

export type Content = { tracks: Track[]; scenarios: Scenario[] }

export function loadContent(dir: string): Content {
  const errors: string[] = []

  const tracksFile = path.join(dir, 'tracks.yaml')
  const tracks = check(tracksFile, z.array(TrackSchema), errors) ?? []
  const trackIds = new Set(tracks.map((t) => t.id))

  const scenarios: Scenario[] = []
  for (const file of scenarioFiles(dir)) {
    const s = check(file, ScenarioSchema, errors)
    if (!s) continue
    const rel = path.relative(dir, file)
    const fileId = path.basename(file).replace(/\.ya?ml$/, '')
    const folder = path.dirname(rel)

    // Progress is saved by scenario id, so ids must be stable and unique.
    // Tying id to filename and track to folder makes both obvious at a glance.
    if (s.id !== fileId) errors.push(`${rel}: id "${s.id}" must match the filename ("${fileId}")`)
    if (s.track !== folder) errors.push(`${rel}: track "${s.track}" must match the folder ("${folder}")`)
    if (!trackIds.has(s.track)) errors.push(`${rel}: track "${s.track}" is not defined in tracks.yaml`)
    if (scenarios.some((o) => o.id === s.id)) errors.push(`${rel}: duplicate scenario id "${s.id}"`)
    scenarios.push(s)
  }

  tracks.forEach((t) =>
    t.requires.forEach((r) => {
      if (!trackIds.has(r)) errors.push(`tracks.yaml: track "${t.id}" requires unknown track "${r}"`)
    }),
  )

  if (errors.length) throw new Error(`Invalid content:\n\n${errors.join('\n\n')}`)
  return { tracks, scenarios }
}

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
