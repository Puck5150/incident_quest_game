// Module sources, the installed-module manifest and the module tree (TF6a: local sources only).
// Pure: the caller supplies a directory reader, so nothing here touches a disk.
import { formatManifest, MANIFEST_PATH, type ManifestEntry } from './layout.ts'
import { parseHcl } from './parse.ts'
import type { Block, Diagnostic, Pos } from './types.ts'

export { formatManifest, MANIFEST_PATH, type ManifestEntry }

type File = { name: string; text: string }
export interface ModuleFiles {
  dir: string // lab-relative, '' for the root
  files: File[] // names are lab-relative paths, e.g. 'modules/net/main.tf'
}
export interface ModuleCall {
  name: string
  source: string
  version?: string
  pos: Pos
  file: string
  moduleDir: string // of the calling module
}
export interface ModuleTree {
  root: ModuleFiles
  children: Map<string, { call: ModuleCall; files: ModuleFiles }> // by dotted call key ('net', 'net.inner'), every level
}
export interface LoadedModules {
  tree: ModuleTree
  calls: ModuleCall[]
  entries: ManifestEntry[] // what init records: the local calls whose directory was read
  install: Diagnostic[] // not installed, source changed, unreadable, unsupported source
  syntax: Diagnostic[] // syntax errors in child module files
  rootBad: boolean // the root has a syntax error: nothing else is checked
}
export type SourceKind = 'local' | 'registry' | 'git' | 'other'

export const isLocalSource = (s: string) => s.startsWith('./') || s.startsWith('../')
export function sourceKind(s: string): SourceKind {
  if (isLocalSource(s)) return 'local'
  if (/^(git::|git@|github\.com\/|bitbucket\.org\/)/.test(s)) return 'git'
  if (/^([a-z0-9.-]+\.[a-z]+\/)?[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(s)) return 'registry'
  return 'other'
}

// A local source resolved against the calling module's directory; undefined when it leaves the lab directory.
export function resolveLocal(fromDir: string, source: string): string | undefined {
  const parts = fromDir ? fromDir.split('/') : []
  for (const s of source.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') {
      if (!parts.pop()) return undefined
    } else parts.push(s)
  }
  return parts.join('/') || '.'
}

export function parseManifest(text: string | undefined): ManifestEntry[] | undefined {
  if (text === undefined) return undefined
  try {
    const mods = (JSON.parse(text) as { Modules?: unknown } | null)?.Modules
    if (!Array.isArray(mods)) return undefined
    return mods.flatMap((m: { Key?: unknown; Source?: unknown; Dir?: unknown; Version?: unknown } | null) =>
      typeof m?.Key === 'string' && typeof m.Source === 'string' && typeof m.Dir === 'string' ? [{ key: m.Key, source: m.Source, dir: m.Dir, ...(typeof m.Version === 'string' ? { version: m.Version } : {}) }] : [],
    )
  } catch {
    return undefined
  }
}

const strAttr = (b: Block, name: string) => {
  const e = b.attrs.find((a) => a.name === name)?.value
  return e === undefined ? undefined : e.kind === 'lit' && typeof e.value === 'string' ? e.value : null // null: present but not a plain string
}

// The module calls of one module's files, plus diagnostics for calls that cannot be used.
function moduleCalls(files: File[], moduleDir: string): { calls: ModuleCall[]; diagnostics: Diagnostic[]; bad: boolean } {
  const calls: ModuleCall[] = []
  const diagnostics: Diagnostic[] = []
  let bad = false
  const seen = new Set<string>()
  for (const f of files) {
    const r = parseHcl(f.name, f.text)
    if (r.diagnostics.length) bad = true
    for (const b of r.blocks) {
      const name = b.labels[0]
      if (b.type !== 'module' || name === undefined || seen.has(name)) continue
      seen.add(name)
      const loc = { severity: 'error' as const, file: f.name, line: b.pos.line, col: b.pos.col, context: `module "${name}"` }
      const source = strAttr(b, 'source')
      if (source === undefined) diagnostics.push({ ...loc, summary: 'Missing required argument', detail: 'The argument "source" is required, but no definition was found.' })
      else if (source === null) diagnostics.push({ ...loc, summary: 'Invalid module source', detail: 'The module source must be a literal string in this lab.' })
      else {
        const version = strAttr(b, 'version')
        calls.push({ name, source, ...(typeof version === 'string' ? { version } : {}), pos: b.pos, file: f.name, moduleDir })
      }
    }
  }
  return { calls, diagnostics, bad }
}

const FIX = 'Run "terraform init" to install all modules required by this configuration.'
const at = (c: ModuleCall) => ({ severity: 'error' as const, file: c.file, line: c.pos.line, col: c.pos.col, context: `module "${c.name}"` })
const unsupported = (c: ModuleCall, detail: string): Diagnostic => ({ ...at(c), summary: 'Unsupported module source', detail })
const where = (c: ModuleCall) => `${c.file}:${c.pos.line}`

export const MAX_MODULE_DEPTH = 8

// readDir gets a lab-relative directory and returns the files in it. With install, the manifest is ignored and
// local directories are read from the source (what `init` and `get` do); otherwise the manifest says what is installed.
// Module calls inside child modules are followed: a local source is relative to the CALLING module's directory, and a
// call's key is the dotted path of call names (`net`, `net.inner`), as in the manifest.
export async function loadModuleTree(rootFiles: File[], readDir: (dir: string) => Promise<File[]>, manifest: ManifestEntry[] | undefined, install: boolean): Promise<LoadedModules> {
  const root = moduleCalls(rootFiles, '')
  const out: LoadedModules = { tree: { root: { dir: '', files: rootFiles }, children: new Map() }, calls: root.calls, entries: [], install: root.diagnostics, syntax: [], rootBad: root.bad }
  if (root.bad) return out
  const installed = new Map((manifest ?? []).map((m) => [m.key, m]))
  const read = async (dir: string) => {
    const tf = (await readDir(dir)).filter((f) => f.name.endsWith('.tf')).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return tf.map((f) => ({ name: `${dir}/${f.name}`, text: f.text }))
  }
  const walk = async (calls: ModuleCall[], prefix: string, chain: string[]): Promise<void> => {
    for (const call of calls) {
      const key = prefix ? `${prefix}.${call.name}` : call.name
      const kind = sourceKind(call.source)
      if (kind !== 'local') {
        out.install.push(unsupported(call, `Module source "${call.source}" is a ${kind === 'registry' ? 'registry' : kind === 'git' ? 'git' : 'remote'} address, and this lab only installs local modules such as "./modules/net".`))
        continue
      }
      const rel = resolveLocal(call.moduleDir, call.source)
      if (rel === undefined) {
        out.install.push(unsupported(call, `Module source "${call.source}" is outside the lab directory, which this lab does not model.`))
        continue
      }
      let dir = rel
      if (!install) {
        const m = installed.get(key)
        if (!m) {
          out.install.push({ ...at(call), summary: 'Module not installed', detail: `This module is not yet installed. ${FIX}` })
          continue
        }
        if (m.source !== call.source) {
          out.install.push({ ...at(call), summary: 'Module source has changed', detail: `The source address was changed since this module was installed. ${FIX}` })
          continue
        }
        dir = resolveLocal('', m.dir) ?? m.dir
      }
      // Lab-specific guards: real Terraform has none for local sources (it would never finish).
      const here = [...chain, dir === '.' ? '' : dir]
      if (chain.includes(dir === '.' ? '' : dir)) {
        out.install.push({ ...at(call), summary: 'Module cycle', detail: `Module "${call.name}" calls the module in "${dir}", which is already being loaded: ${here.map((d) => d || '.').join(' -> ')}.` })
        continue
      }
      if (here.length - 1 > MAX_MODULE_DEPTH) {
        out.install.push({ ...at(call), summary: 'Module stack level too deep', detail: `This configuration has nested modules more than ${MAX_MODULE_DEPTH} levels deep.` })
        continue
      }
      const files = await read(dir)
      if (!files.length) {
        const err = (summary: string, detail: string): Diagnostic => ({ severity: 'error', summary, detail, file: '', line: 0, col: 0 })
        if (install) {
          out.install.push(err('Unreadable module directory', `Unable to evaluate directory symlink: lstat ${rel}: no such file or directory`))
          out.install.push(err('Unreadable module directory', `The directory  could not be read for module "${call.name}" at ${where(call)}.`))
        } else out.install.push({ ...at(call), summary: 'Module not installed', detail: `This module's local cache directory ${dir} could not be read. ${FIX}` })
        continue
      }
      out.entries.push({ key, source: call.source, dir })
      out.tree.children.set(key, { call, files: { dir, files } })
      let bad = false
      for (const f of files) {
        const d = parseHcl(f.name, f.text).diagnostics
        out.syntax.push(...d)
        if (d.length) bad = true
      }
      if (!bad) {
        const sub = moduleCalls(files, dir)
        out.install.push(...sub.diagnostics)
        await walk(sub.calls, key, here)
      }
    }
  }
  await walk(root.calls, '', [''])
  // A directory called from two places is walked twice: report each identical problem once.
  const seen = new Set<string>()
  out.install = out.install.filter((d) => {
    const k = JSON.stringify([d.file, d.line, d.col, d.summary, d.detail])
    return !seen.has(k) && (seen.add(k), true)
  })
  out.syntax = out.syntax.filter((d) => {
    const k = JSON.stringify([d.file, d.line, d.col, d.summary])
    return !seen.has(k) && (seen.add(k), true)
  })
  out.entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return out
}
