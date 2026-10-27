// Saved design-sandbox designs. Kept apart from the progress save so a bad value
// here can never touch progress. Saved data and imported files are untrusted: a
// player can edit them, and an old app version may have written a different
// shape. Anything that fails validation is backed up, not silently thrown away.
// Hand-written rather than Zod so no Zod code is in the startup bundle.
// `localStorage` is looked up inside the try because merely touching it can
// throw when storage is blocked.

import { PROVIDERS, type Provider } from '../schema/constants.ts'
import type { Design } from '../schema/canvas.ts'

export const KEY = 'incident-quest:sandbox'
export type Store = Pick<Storage, 'getItem' | 'setItem'>

export type SavedDesign = { id: string; name: string; provider: Provider; design: Design; updatedAt: string }
export type SandboxData = { version: 1; designs: SavedDesign[] }

export const emptySandbox = (): SandboxData => ({ version: 1, designs: [] })

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const isStr = (x: unknown): x is string => typeof x === 'string'
const isProvider = (x: unknown): x is Provider => PROVIDERS.includes(x as Provider)
const KINDS = ['traffic', 'sync', 'async']

// Rebuilds a design field by field, so unknown keys (including __proto__) never travel.
function readDesign(x: unknown): Design | undefined {
  if (!isObj(x) || !Array.isArray(x.nodes) || !Array.isArray(x.edges)) return undefined
  const nodes: Design['nodes'] = []
  for (const n of x.nodes) {
    if (!isObj(n) || !isStr(n.id) || !isStr(n.type) || !isStr(n.lane)) return undefined
    nodes.push({ id: n.id, type: n.type, lane: n.lane })
  }
  const edges: Design['edges'] = []
  for (const e of x.edges) {
    if (!isObj(e) || !isStr(e.from) || !isStr(e.to) || !KINDS.includes(e.kind as string)) return undefined
    edges.push({ from: e.from, to: e.to, kind: e.kind as Design['edges'][number]['kind'] })
  }
  return { nodes, edges }
}

function readData(x: unknown): SandboxData | undefined {
  if (!isObj(x) || x.version !== 1 || !Array.isArray(x.designs)) return undefined
  const designs: SavedDesign[] = []
  for (const d of x.designs) {
    if (!isObj(d) || !isStr(d.id) || !d.id || !isStr(d.name) || !isProvider(d.provider) || !isStr(d.updatedAt)) return undefined
    const design = readDesign(d.design)
    if (!design) return undefined
    if (designs.some((x) => x.id === d.id)) return undefined
    designs.push({ id: d.id, name: d.name, provider: d.provider, design, updatedAt: d.updatedAt })
  }
  return { version: 1, designs }
}

// Set when invalid data could not be backed up: saving then would overwrite the only copy.
let unsafeToSave = false
// The key invalid data was copied to on the latest load, so the player can be told.
let backupKey: string | undefined

export function loadSandbox(storage?: Store): SandboxData {
  unsafeToSave = false
  backupKey = undefined
  try {
    const store = storage ?? localStorage
    const raw = store.getItem(KEY)
    if (raw === null) return emptySandbox()
    try {
      const data = readData(JSON.parse(raw))
      if (data) return data
    } catch {
      // not JSON: fall through to the backup
    }
    const key = `${KEY}:backup-${Date.now()}`
    try {
      store.setItem(key, raw)
      backupKey = key
    } catch {
      unsafeToSave = true
      return emptySandbox()
    }
    // Replace the bad value so a reload does not pile up another backup.
    store.setItem(KEY, JSON.stringify(emptySandbox()))
  } catch {
    // storage blocked: fall through to an empty store
  }
  return emptySandbox()
}

// false after loadSandbox found bad data it couldn't back up: saves are refused until reload.
export const canSave = () => !unsafeToSave
export const recoveredBackupKey = () => backupKey

// false when the write failed (blocked or full): the designs last for this visit only.
export function saveSandbox(data: SandboxData, storage?: Store): boolean {
  if (unsafeToSave) return false
  try {
    const store = storage ?? localStorage
    store.setItem(KEY, JSON.stringify(data))
    return true
  } catch {
    return false
  }
}

const cleanName = (s: string) => s.trim().slice(0, 60) || 'Untitled design'
export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const createDesign = (data: SandboxData, a: { id: string; name: string; provider: Provider; now?: Date }): SandboxData => ({
  ...data,
  designs: [...data.designs, { id: data.designs.some((d) => d.id === a.id) ? newId() : a.id, name: cleanName(a.name), provider: a.provider, design: { nodes: [], edges: [] }, updatedAt: (a.now ?? new Date()).toISOString() }],
})
export const renameDesign = (data: SandboxData, id: string, name: string): SandboxData => ({
  ...data,
  designs: data.designs.map((d) => (d.id === id ? { ...d, name: cleanName(name) } : d)),
})
export const updateDesign = (data: SandboxData, id: string, design: Design, now = new Date()): SandboxData => ({
  ...data,
  designs: data.designs.map((d) => (d.id === id ? { ...d, design, updatedAt: now.toISOString() } : d)),
})
export const deleteDesign = (data: SandboxData, id: string): SandboxData => ({ ...data, designs: data.designs.filter((d) => d.id !== id) })

export const exportDesign = (d: SavedDesign): string => JSON.stringify({ version: 1, name: d.name, provider: d.provider, design: d.design }, null, 2)

// Shape only. The caller then runs validateDesign against that cloud's sandbox.
export function readExport(text: string): { name: string; provider: Provider; design: Design } | { error: string } {
  let x: unknown
  try {
    x = JSON.parse(text)
  } catch {
    return { error: "That file isn't valid JSON." }
  }
  if (!isObj(x)) return { error: "That isn't a design file." }
  if (x.version !== 1) return { error: `Unsupported design file version (${String(x.version)}).` }
  if (!isProvider(x.provider)) return { error: 'The design file names a cloud this game does not have.' }
  if (!isStr(x.name)) return { error: 'The design file has no name.' }
  const design = readDesign(x.design)
  if (!design) return { error: 'The design in the file is malformed.' }
  return { name: cleanName(x.name), provider: x.provider, design }
}
