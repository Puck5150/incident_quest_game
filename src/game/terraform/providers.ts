// Provider requirements (`required_providers`), `required_version`, and the dependency lock file text.
// Pure: nothing here touches a disk. Provider versions never change what a resource does in this lab; they only
// decide what the lock file says and which constraint errors the player sees.
import type { TerraformBlock } from '../../schema/scenario.ts'
import { AWS_SOURCE, isRegistrySource, lockBlock, lockFile, normalizeRegistry, PROVIDER_VERSION, type LockEntry } from './layout.ts'
import type { ModuleTree } from './modules.ts'
import { parseHcl } from './parse.ts'
import type { Block, Diagnostic, Expr } from './types.ts'
import { INVALID_CONSTRAINT, isValidConstraint, newestSatisfying, parseVersion, satisfies } from './versions.ts'

export const REGISTRY = 'registry.terraform.io/'
type File = { name: string; text: string }
export interface ModuleFiles {
  key: string // dotted call key, '' for the root
  source?: string // the call's source as Terraform prints it (children only)
  files: File[]
}
export interface ProviderInfo {
  lock?: string
  available?: string[]
}

export const modulesOf = (tree: ModuleTree): ModuleFiles[] => [
  { key: '', files: tree.root.files },
  ...[...tree.children].map(([key, c]) => ({ key, source: isRegistrySource(c.call.source) ? normalizeRegistry(c.call.source) : c.call.source, files: c.files.files })),
]

// hashicorp/aws -> registry.terraform.io/hashicorp/aws; a three-part address already names its host.
const sourceAddress = (s: string) => (s.split('/').length === 2 ? `${REGISTRY}${s}` : s)
const str = (e: Expr | undefined) => (e?.kind === 'lit' && typeof e.value === 'string' ? e.value : undefined)
const keyName = (e: Expr) => (e.kind === 'ref' && e.path.length === 1 ? e.path[0] : str(e))

function terraformBlocks(files: File[]): { file: string; block: Block }[] {
  return files.flatMap((f) => parseHcl(f.name, f.text).blocks.filter((b) => b.type === 'terraform').map((block) => ({ file: f.name, block })))
}

export interface Need {
  source: string
  constraints: string // every module's constraints for it, joined with ", " ('' for none)
}
// What the configuration needs from the lock file: the providers its resources use plus every one a
// required_providers block names, in any module, with the constraints combined. Sorted by source.
export function providerNeeds(mods: ModuleFiles[], implicit: string[]): { needs: Need[]; diagnostics: Diagnostic[] } {
  const found = new Map<string, string[]>(implicit.map((s) => [s, []]))
  const diagnostics: Diagnostic[] = []
  for (const m of mods) {
    for (const { file, block } of terraformBlocks(m.files)) {
      for (const rp of block.blocks.filter((b) => b.type === 'required_providers')) {
        for (const a of rp.attrs) {
          let source = `${REGISTRY}hashicorp/${a.name}`
          let version = str(a.value) // the old `aws = ">= 4"` form
          if (a.value.kind === 'obj') {
            for (const { key, value } of a.value.entries) {
              const k = keyName(key)
              if (k === 'source' && str(value) !== undefined) source = sourceAddress(str(value)!)
              else if (k === 'version') version = str(value)
            }
          }
          const list = found.get(source) ?? []
          found.set(source, list)
          if (version === undefined) continue
          if (!isValidConstraint(version)) diagnostics.push({ severity: 'error', summary: 'Invalid version constraint', detail: INVALID_CONSTRAINT, file, line: a.pos.line, col: a.pos.col, context: 'terraform' })
          else if (!list.includes(version.trim())) list.push(version.trim())
        }
      }
    }
  }
  const needs = [...found].map(([source, list]) => ({ source, constraints: list.join(', ') })).sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
  return { needs, diagnostics }
}

const CORE_TAIL = 'To proceed, either choose another supported Terraform version or update this version constraint. Version constraints are normally set for good reason, so updating the constraint may lead to other errors or unexpected behavior.'
// Config.CheckCoreVersionRequirements: each module's required_version against the lab's Terraform version.
export function coreDiagnostics(mods: ModuleFiles[], version: string): Diagnostic[] {
  const v = parseVersion(version)
  const out: Diagnostic[] = []
  for (const m of mods) {
    for (const { file, block } of terraformBlocks(m.files)) {
      const a = block.attrs.find((x) => x.name === 'required_version')
      const c = str(a?.value)
      if (!a || c === undefined) continue
      const at = { severity: 'error' as const, file, line: a.pos.line, col: a.pos.col, context: 'terraform' }
      if (!isValidConstraint(c)) out.push({ ...at, summary: 'Invalid version constraint', detail: INVALID_CONSTRAINT })
      else if (v && !satisfies(v, c).ok) {
        const who = m.key === '' ? 'This configuration' : `Module module.${m.key.split('.').join('.module.')} (from ${m.source})`
        out.push({ ...at, summary: 'Unsupported Terraform Core version', detail: `${who} does not support Terraform version ${version}. ${CORE_TAIL}` })
      }
    }
  }
  return out
}

export interface ParsedLockEntry {
  version?: string
  constraints: string
  hashes: string[]
}
// The provider blocks of a .terraform.lock.hcl, by source address.
export function parseLock(text: string): Map<string, ParsedLockEntry> {
  const out = new Map<string, ParsedLockEntry>()
  for (const chunk of text.split(/^(?=provider\s+")/m)) {
    const name = /^provider\s+"([^"]+)"/.exec(chunk)?.[1]
    if (name === undefined) continue
    const version = /^\s*version\s*=\s*"([^"]*)"/m.exec(chunk)?.[1]
    out.set(name, { ...(version === undefined ? {} : { version }), constraints: /^\s*constraints\s*=\s*"([^"]*)"/m.exec(chunk)?.[1] ?? '', hashes: [...chunk.matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((m) => m[1]) })
  }
  return out
}

// The lock text after init: new providers are appended, changed ones rewritten in place, the rest left alone.
export function updateLock(text: string, entries: LockEntry[]): string {
  const old = parseLock(text)
  let out = text
  for (const e of entries) {
    const cur = old.get(e.source)
    if (!cur) out = `${out.replace(/\n*$/, '\n')}\n${lockBlock(e)}`
    else if (cur.version !== e.version || cur.constraints !== (e.constraints ?? '')) {
      out = out
        .split(/^(?=provider\s+")/m)
        .map((chunk) => (/^provider\s+"([^"]+)"/.exec(chunk)?.[1] === e.source ? lockBlock(e) + (/\n\n$/.test(chunk) ? '\n' : '') : chunk))
        .join('')
    }
  }
  return out
}

const nameOf = (source: string) => source.split('/').pop() ?? source
// The versions the lab's registry offers for a provider: the scenario's list, else only the one it locks
// (the default 5.67.0). Providers without an entry offer 5.67.0.
export const availableOf = (info: Map<string, ProviderInfo>, source: string): string[] => {
  const p = info.get(nameOf(source))
  return p?.available ?? [p?.lock ?? PROVIDER_VERSION]
}

// The lock file a lab starts with when it is initialised: AWS only, at the scenario's locked version (else the
// newest authored version that meets the constraints found in the lab's .tf files, else the default).
// ponytail: every .tf file counts, called or not; a stale module directory could add a constraint.
export function mountedLock(tf: TerraformBlock, files: { path: string; content: string }[]): string {
  const info = new Map(Object.entries(tf.providers ?? {}))
  const tfs = files.filter((f) => f.path.endsWith('.tf')).map((f) => ({ name: f.path, text: f.content }))
  const constraints = providerNeeds([{ key: '', files: tfs }], []).needs.find((n) => n.source === AWS_SOURCE)?.constraints ?? ''
  const avail = availableOf(info, AWS_SOURCE)
  const version = info.get('aws')?.lock ?? newestSatisfying(avail, constraints || '>= 0.0.0') ?? avail[avail.length - 1] ?? PROVIDER_VERSION
  return lockFile([{ source: AWS_SOURCE, version, ...(constraints ? { constraints } : {}) }])
}
