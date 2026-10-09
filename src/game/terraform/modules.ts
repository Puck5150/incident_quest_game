// Module sources, the installed-module manifest and the module tree (TF6a: local sources only).
// Pure: the caller supplies a directory reader, so nothing here touches a disk.
import { formatManifest, isRegistrySource, MANIFEST_PATH, normalizeRegistry, registryDir, type ManifestEntry, type RegistryModule } from './layout.ts'
import { parseHcl } from './parse.ts'
import type { Block, Diagnostic, Pos } from './types.ts'
import { compareVersions, INVALID_CONSTRAINT, isValidConstraint, newestSatisfying, parseVersion, satisfies } from './versions.ts'

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
  sourcePos?: Pos // the `source` attribute (where Terraform points "Module version requirements have changed")
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
  entries: ManifestEntry[] // what init records: every module whose directory was read
  lines: string[] // the install hook output, in walk order: Downloading ..., - key in dir
  downloads: Download[] // registry modules installed by this run: init writes their files
  install: Diagnostic[] // not installed, source changed, unreadable, unsupported source
  syntax: Diagnostic[] // syntax errors in child module files
  rootBad: boolean // the root has a syntax error: nothing else is checked
}
export interface Download {
  key: string
  dir: string // lab-relative install directory
  files: { path: string; content: string }[] // the selected version's files, relative to dir
  stale: string[] // files of the previously installed version that the new one lacks (relative to dir)
}
export interface InstallOptions {
  registry?: RegistryModule[] // the authored registry (install mode)
  upgrade?: boolean // re-resolve registry modules to the newest satisfying version
}
export type SourceKind = 'local' | 'registry' | 'git' | 'other'

export const isLocalSource = (s: string) => s.startsWith('./') || s.startsWith('../')
export function sourceKind(s: string): SourceKind {
  if (isLocalSource(s)) return 'local'
  if (/^(git::|git@|github\.com\/|bitbucket\.org\/)/.test(s)) return 'git'
  if (isRegistrySource(s)) return 'registry'
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
        if (typeof version === 'string' && !isValidConstraint(version)) {
          const vp = b.attrs.find((a) => a.name === 'version')?.pos ?? b.pos
          diagnostics.push({ ...loc, line: vp.line, col: vp.col, summary: 'Invalid version constraint', detail: INVALID_CONSTRAINT })
          continue
        }
        const sourcePos = b.attrs.find((a) => a.name === 'source')?.pos ?? b.pos
        calls.push({ name, source, ...(typeof version === 'string' ? { version } : {}), pos: b.pos, sourcePos, file: f.name, moduleDir })
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

// readDir gets a lab-relative directory and returns the files in it. With install, local directories are read from the
// source and registry modules are resolved against opts.registry (what `init` and `get` do); otherwise the manifest
// says what is installed. Module calls inside child modules are followed: a local source is relative to the CALLING
// module's directory, and a call's key is the dotted path of call names (`net`, `net.inner`), as in the manifest.
// In install mode the manifest (if any) tells which registry modules are already installed and may be kept.
export async function loadModuleTree(rootFiles: File[], readDir: (dir: string) => Promise<File[]>, manifest: ManifestEntry[] | undefined, install: boolean, opts: InstallOptions = {}): Promise<LoadedModules> {
  const root = moduleCalls(rootFiles, '')
  const out: LoadedModules = { tree: { root: { dir: '', files: rootFiles }, children: new Map() }, calls: root.calls, entries: [], lines: [], downloads: [], install: root.diagnostics, syntax: [], rootBad: root.bad }
  if (root.bad) return out
  const installed = new Map((manifest ?? []).map((m) => [m.key, m]))
  const items: { entry: ManifestEntry; lines: string[] }[] = []
  const virtual = new Map<string, File[]>() // directories of registry modules downloaded by this run
  const reinstalled: string[] = [] // keys of modules installed afresh: their descendants are installed afresh too
  const read = async (dir: string) => {
    const tf = (virtual.get(dir) ?? (await readDir(dir))).filter((f) => f.name.endsWith('.tf')).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return tf.map((f) => ({ name: `${dir}/${f.name}`, text: f.text }))
  }
  const walk = async (calls: ModuleCall[], prefix: string, chain: string[]): Promise<void> => {
    for (const call of calls) {
      const key = prefix ? `${prefix}.${call.name}` : call.name
      const kind = sourceKind(call.source)
      if (kind !== 'local' && kind !== 'registry') {
        out.install.push(unsupported(call, `Module source "${call.source}" is a ${kind === 'git' ? 'git' : 'remote'} address, and this lab only installs local modules such as "./modules/net" and registry modules from the lab's own registry.`))
        continue
      }
      let dir: string
      let version: string | undefined
      let source = call.source
      let lines: string[] = []
      if (kind === 'local') {
        if (install && call.version !== undefined) {
          out.install.push({ ...at(call), summary: 'Invalid version constraint', detail: `Cannot apply a version constraint to module "${call.name}" (at ${where(call)}) because it has a relative local path.` })
          continue
        }
        const rel = resolveLocal(call.moduleDir, call.source)
        if (rel === undefined) {
          out.install.push(unsupported(call, `Module source "${call.source}" is outside the lab directory, which this lab does not model.`))
          continue
        }
        dir = rel
        if (!install) {
          const m = installed.get(key)
          if (!m) {
            out.install.push({ ...at(call), summary: 'Module not installed', detail: `This module is not yet installed. ${FIX}` })
            continue
          }
          if (m.source !== call.source) {
            const sp = call.sourcePos ?? call.pos
            out.install.push({ ...at(call), line: sp.line, col: sp.col, summary: 'Module source has changed', detail: `The source address was changed since this module was installed. ${FIX}` })
            continue
          }
          dir = resolveLocal('', m.dir) ?? m.dir
        }
        lines = [`- ${key} in ${dir}`]
      } else {
        source = normalizeRegistry(call.source)
        const host = source.split('/')[0]
        const m = installed.get(key)
        if (!install) {
          if (!m) {
            out.install.push({ ...at(call), summary: 'Module not installed', detail: `This module is not yet installed. ${FIX}` })
            continue
          }
          const sp = call.sourcePos ?? call.pos
          const here = { ...at(call), line: sp.line, col: sp.col }
          if (m.source !== source) {
            out.install.push({ ...here, summary: 'Module source has changed', detail: `The source address was changed since this module was installed. ${FIX}` })
            continue
          }
          if (call.version !== undefined && m.version === undefined) {
            out.install.push({ ...here, summary: 'Module version requirements have changed', detail: `The version requirements have changed since this module was installed and the installed version is no longer acceptable. ${FIX}` })
            continue
          }
          const mv = m.version === undefined ? undefined : parseVersion(m.version)
          if (call.version !== undefined && mv && !satisfies(mv, call.version).ok) {
            out.install.push({ ...here, summary: 'Module version requirements have changed', detail: `The version requirements have changed since this module was installed and the installed version (${m.version}) is no longer acceptable. ${FIX}` })
            continue
          }
          dir = resolveLocal('', m.dir) ?? m.dir
          version = m.version
        } else {
          const stale = reinstalled.some((k) => key.startsWith(`${k}.`))
          const recVersion = m?.version === undefined ? undefined : parseVersion(m.version)
          const keep = !opts.upgrade && !stale && m !== undefined && m.source === source && (call.version === undefined || m.version === undefined || (recVersion !== undefined && satisfies(recVersion, call.version).ok))
          const kept = keep ? await read(m.dir) : []
          if (keep && kept.length) {
            // Already installed and still acceptable: nothing is downloaded and the installer prints nothing.
            dir = m.dir
            version = m.version
          } else {
            const mod = (opts.registry ?? []).find((r) => r.source === source)
            if (!mod) {
              out.install.push({ ...at(call), summary: 'Module not found', detail: `Module "${call.name}" (from ${where(call)}) cannot be found in the module registry at ${host}.` })
              continue
            }
            const constraint = call.version ?? '>= 0.0.0'
            const all = mod.versions.map((v) => v.version)
            const eligible = all.filter((v) => { const p = parseVersion(v); return p !== undefined && (p.pre === undefined || satisfies(p, constraint).ok) })
            if (!eligible.length) {
              out.install.push({ ...at(call), summary: 'Module has no versions', detail: `Module "${source}" (${where(call)}) has no versions available on ${host}.` })
              continue
            }
            // No constraint: any release (a prerelease is never chosen unless requested exactly).
            const pick = newestSatisfying(eligible, constraint)
            if (pick === undefined) {
              const newest = eligible.reduce((a, b) => (compareVersions(parseVersion(b)!, parseVersion(a)!) > 0 ? b : a))
              out.install.push({ ...at(call), summary: 'Unresolvable module version constraint', detail: `There is no available version of module "${source}" (${where(call)}) which matches the given version constraint. The newest available version is ${newest}.` })
              continue
            }
            dir = registryDir(key)
            version = pick
            const chosen = mod.versions.find((v) => v.version === pick)!
            const old = m?.version === undefined ? undefined : mod.versions.find((v) => v.version === m.version)
            const mine = new Set(chosen.files.map((f) => f.path))
            out.downloads.push({ key, dir, files: chosen.files, stale: (old?.files ?? []).map((f) => f.path).filter((p) => !mine.has(p)) })
            for (const f of chosen.files) {
              const cut = f.path.lastIndexOf('/')
              const d = cut < 0 ? dir : `${dir}/${f.path.slice(0, cut)}`
              virtual.set(d, [...(virtual.get(d) ?? []), { name: f.path.slice(cut + 1), text: f.content }])
            }
            reinstalled.push(key)
            lines = [`Downloading ${source} ${pick} for ${key}...`, `- ${key} in ${dir}`]
          }
        }
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
          out.install.push(err('Unreadable module directory', `Unable to evaluate directory symlink: lstat ${dir}: no such file or directory`))
          out.install.push(err('Unreadable module directory', `The directory  could not be read for module "${call.name}" at ${where(call)}.`))
        } else out.install.push({ ...at(call), summary: 'Module not installed', detail: `This module's local cache directory ${dir} could not be read. ${FIX}` })
        continue
      }
      items.push({ entry: { key, source, dir, ...(version === undefined ? {} : { version }) }, lines })
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
  // Depth first with call names sorted at each level, as Terraform loads them: net, net.inner, net-x.
  const segs = (k: string) => k.split('.')
  items.sort((a, b) => {
    const x = segs(a.entry.key)
    const y = segs(b.entry.key)
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    return x.length - y.length
  })
  out.entries = items.map((i) => i.entry)
  out.lines = items.flatMap((i) => i.lines)
  return out
}
