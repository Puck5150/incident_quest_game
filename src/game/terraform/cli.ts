// The `terraform` command: init, validate, plan, apply, destroy, show, state
// (list, show, pull, mv, rm), output, import, taint, untaint, refresh, workspace,
// force-unlock and version read the player's working directory and the lab's
// state; everything else answers honestly that it is not simulated yet. Nothing here throws on
// player input: a failure is a boxed diagnostic or a plain message with exit 1.
import { compareAddresses, formatModule, parseResAddr, staticKey } from './address.ts'
import { executeApply, type ApplyResult } from './apply.ts'
import { evalExpr, EvalError, type Value } from './eval.ts'
import { formatDiagnostic } from './diag.ts'
import { buildGraph } from './graph.ts'
import type { Lab, SavedPlan } from './lab.ts'
import { parseHcl } from './parse.ts'
import { planConfig, type PlanResult } from './plan.ts'
import { hex } from './provider.ts'
import { realityKey, refresh as refreshState } from './refresh.ts'
import { renderPlan, renderPlanErrors } from './render.ts'
import { destroyScope, parseTargetArg, targetScope, type Target, type TargetScope } from './target.ts'
import { renderApplyEnd, renderApplyErrors, renderProgress } from './render-apply.ts'
import { schemaFor } from './resources.ts'
import { importObject, INVALID_ADDRESS, invalidAddressDetail, NO_IMPORT_CONFIG, noImportConfigDetail, NO_SUCH_INSTANCE, parseAddress, parseTarget, stateMove, stateRemove, taintInstance, untaintInstance, type OpResult } from './state-ops.ts'
import { emptyState, findInstance, instanceAddress, listAddresses, stateJson } from './state.ts'
import type { State } from './state.ts'
import type { Block, Diagnostic } from './types.ts'
import { outputsText, showState, stateShow } from './views.ts'
import { cachedPackage, lockFile, PROVIDER_CACHE_DIR, providerHash, type LockEntry } from './layout.ts'
import { formatManifest, loadModuleTree, MANIFEST_PATH, parseManifest, type LoadedModules, type ModuleTree } from './modules.ts'
import { LOCK_BYPASSED } from './predicates.ts'
import { availableOf, coreDiagnostics, modulesOf, parseLock, providerNeeds, updateLock } from './providers.ts'
import { newestSatisfying, parseVersion, satisfies } from './versions.ts'

export { LOCK_FILE } from './layout.ts'

export interface CliContext {
  lab: Lab
  cwd: string
  // True on the scenario's main host; other hosts have no lab state or directory.
  mainHost: boolean
  listFiles(dir: string): Promise<{ name: string; text: string }[]>
  readFile(path: string): Promise<string | undefined>
  write(dir: string, name: string, text: string): Promise<void>
  env: Record<string, string>
  taken: Set<string> // actions the player has taken (fault gating)
  stdin?: string // piped input, if any
  confirm?: (prompt: string) => Promise<string | undefined> // interactive answer; undefined = no way to ask
}
export interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
  evidence: string[]
  // The command as typed ("terraform plan"), empty when it is not one the simulator runs.
  ran: string
  // Print stdout exactly: no newline is added (`output -raw`).
  raw?: boolean
}
type Out = Omit<CliResult, 'evidence' | 'ran'>
type File = { name: string; text: string }
interface Config {
  dir: string
  tf: File[]
  tfvars: File[]
  hasLock: boolean
  lockText: string
  modules: LoadedModules // the module calls of tf, checked against the installed manifest
}

const USAGE = `Usage: terraform [global options] <subcommand> [args]

The available commands for execution are listed below.
The primary workflow commands are given first, followed by
less common or more advanced commands.

Main commands:
  init          Prepare your working directory for other commands
  validate      Check whether the configuration is valid
  plan          Show changes required by the current configuration
  apply         Create or update infrastructure
  destroy       Destroy previously-created infrastructure

All other commands:
  console       Try Terraform expressions at an interactive command prompt
  fmt           Reformat your configuration in the standard style
  force-unlock  Release a stuck lock on the current workspace
  get           Install or upgrade remote Terraform modules
  graph         Generate a Graphviz graph of the steps in an operation
  import        Associate existing infrastructure with a Terraform resource
  login         Obtain and save credentials for a remote host
  logout        Remove locally-stored credentials for a remote host
  metadata      Metadata related commands
  output        Show output values from your root module
  providers     Show the providers required for this configuration
  refresh       Update the state to match remote systems
  show          Show the current state or a saved plan
  state         Advanced state management
  taint         Mark a resource instance as not fully functional
  test          Execute integration tests for Terraform modules
  untaint       Remove the 'tainted' state from a resource instance
  version       Show the current Terraform version
  workspace     Workspace management

Global options (use these before the subcommand, if any):
  -chdir=DIR    Switch to a different working directory before executing the
                given subcommand.
  -help         Show this help output, or the help for a specified subcommand.
  -version      An alias for the "version" subcommand.`

const NOT_YET = new Set(['console', 'fmt', 'graph', 'login', 'logout', 'metadata', 'test'])
const REGISTRY = 'registry.terraform.io/'
const RULE = '─'.repeat(77)
const NO_STATE_SUMMARY = 'No state file was found!'
const NO_STATE_DETAIL =
  'State management commands require a state file. Run this command in a directory where Terraform has been run or use the -state flag to point the command to a specific state location.'
const NO_STATE = `${NO_STATE_SUMMARY}\n\n${NO_STATE_DETAIL}`

const NO_CONFIG_DETAIL =
  'Plan requires configuration to be present. Planning without a configuration would mark everything for destruction, which is normally not what is desired. If you would like to destroy everything, run plan with the -destroy option. Otherwise, create a Terraform configuration file (.tf file) and try again.'
const EMPTY_INIT =
  '\nTerraform initialized in an empty directory!\n\nThe directory has no Terraform configuration files. You may begin working\nwith Terraform immediately by creating Terraform configuration files.\n'
const ONE_INSTANCE =
  'This command requires that the address references one specific instance.\nTo view the available instances, use "terraform state list". Please modify \nthe address to reference a specific instance.'
const HELP: Record<string, string> = {
  init: 'Initialize a new or existing Terraform working directory by creating initial files, loading any remote state, downloading modules, etc.',
  validate: 'Validate the configuration files in a directory, referring only to the configuration and not accessing any remote services.',
  plan: 'Generates a speculative execution plan, showing what actions Terraform would take to apply the current configuration. This command will not actually perform the planned actions.',
  apply: 'Creates or updates infrastructure according to Terraform configuration files in the current directory.',
  destroy: 'Destroy Terraform-managed infrastructure.',
  show: 'Reads and outputs a Terraform state or plan file in a human-readable form.',
  state: 'This command has subcommands for advanced state management.',
  output: 'Reads an output variable from a Terraform state file and prints the value.',
  workspace: 'new, list, show, select and delete Terraform workspaces.',
  version: 'Displays the version of Terraform and all installed plugins.',
  providers: 'Prints out a tree of modules in the referenced configuration annotated with their provider requirements.',
}

const byName = (a: File, b: File) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
const ok = (stdout: string, stderr = ''): Out => ({ stdout, stderr, exitCode: 0 })
const fail = (stderr: string, exitCode = 1): Out => ({ stdout: '', stderr, exitCode })

function box(severity: 'error' | 'warning', summary: string, detail: string, preserveLines = false): string {
  return formatDiagnostic({ severity, summary, detail, file: '', line: 0, col: 0 }, '', { preserveLines })
}
const boxFail = (summary: string, detail: string) => fail(box('error', summary, detail))
// Warnings go to stdout ahead of the command's own text; errors stay on stderr.
const withWarn = (warn: string, o: Out): Out => (warn ? { ...o, stdout: [warn, o.stdout].filter(Boolean).join('\n\n') } : o)
const notYet = (sub: string) =>
  boxFail(
    'Not available in this lab yet',
    `"terraform ${sub}" is not simulated yet in this lab. You can still use: init, validate, plan, apply, destroy, show, state list, state show, state pull, state mv, state rm, import, taint, untaint, refresh, force-unlock, get, output, providers, workspace, version.`,
  )
const sourcesOf = (files: File[]) => Object.fromEntries(files.map((f) => [f.name, f.text]))
const boxes = (list: Diagnostic[], files: File[]) => {
  const src = sourcesOf(files)
  return list.map((d) => formatDiagnostic(d, Object.hasOwn(src, d.file) ? src[d.file] : '')).join('\n')
}

function resolvePath(base: string, p: string): string {
  const parts: string[] = []
  for (const s of (p.startsWith('/') ? p : `${base}/${p}`).split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') parts.pop()
    else parts.push(s)
  }
  return `/${parts.join('/')}`
}

const moduleReader = (ctx: CliContext, dir: string) => (rel: string) => ctx.listFiles(resolvePath(dir, rel))
// Every file the configuration is made of, for snippets in diagnostics: root files and installed module files.
const treeFiles = (t: ModuleTree): File[] => [...t.root.files, ...[...t.children.values()].flatMap((c) => c.files.files)]
const allFiles = (cfg: Config): File[] => treeFiles(cfg.modules.tree)
// Module problems stop every command that loads the configuration (a root syntax error is reported by the usual path).
// Syntax errors in child files are reported once, by the graph.
const moduleErrors = (cfg: Config): Diagnostic[] => (cfg.modules.rootBad ? [] : cfg.modules.install)

async function loadConfig(ctx: CliContext, dir: string): Promise<Config> {
  const all = await ctx.listFiles(dir)
  const tf = all.filter((f) => f.name.endsWith('.tf')).sort(byName)
  return {
    dir,
    tf,
    modules: await loadModuleTree(tf, moduleReader(ctx, dir), parseManifest(await ctx.readFile(resolvePath(dir, MANIFEST_PATH))), false),
    tfvars: [...all.filter((f) => f.name === 'terraform.tfvars'), ...all.filter((f) => f.name.endsWith('.auto.tfvars')).sort(byName)],
    hasLock: all.some((f) => f.name === '.terraform.lock.hcl'),
    lockText: all.find((f) => f.name === '.terraform.lock.hcl')?.text ?? '',
  }
}

// Provider source addresses the configuration's resources and data sources need.
function providersOf(files: File[]): string[] {
  const out = new Set<string>()
  for (const f of files) {
    for (const b of parseHcl(f.name, f.text).blocks) {
      if ((b.type !== 'resource' && b.type !== 'data') || !b.labels[0]) continue
      const type = b.labels[0]
      if (b.type === 'data' && type === 'terraform_remote_state') continue // the built-in provider: no lock entry
      out.add(schemaFor(type)?.provider ?? `${REGISTRY}hashicorp/${type.split('_')[0]}`)
    }
  }
  return [...out].sort()
}
const shortName = (source: string) => (source.startsWith(REGISTRY) ? source.slice(REGISTRY.length) : source)
// Whether a version string meets a constraint string (an unparsable version never does).
const meets = (version: string, constraints: string) => {
  const v = parseVersion(version)
  return v !== undefined && satisfies(v, constraints).ok
}
// Requirement problems that are the configuration's own: bad constraints and an unsupported required_version.
const configDiags = (tree: ModuleTree, version: string): Diagnostic[] => {
  const mods = modulesOf(tree)
  return [...providerNeeds(mods, []).diagnostics, ...coreDiagnostics(mods, version)]
}
// Syntax errors are reported by the usual path, so a configuration that does not parse has no requirements to check.
const configErrors = (cfg: Config, version: string): Out | undefined => {
  if (cfg.modules.rootBad || cfg.modules.syntax.length) return undefined
  const d = configDiags(cfg.modules.tree, version)
  return d.length ? fail(boxes(d, allFiles(cfg))) : undefined
}

// Resources need provider selections in the lock file; without one `init` has not run. With `versions`, a selection
// that no longer meets the combined constraints is inconsistent too (backend_local.go, Config.VerifyDependencySelections).
function lockError(cfg: Config, versions = true): Out | undefined {
  const lock = parseLock(cfg.lockText)
  const errs: string[] = []
  for (const n of providerNeeds(modulesOf(cfg.modules.tree), providersOf(allFiles(cfg))).needs) {
    const e = lock.get(n.source)
    if (!e) errs.push(`provider ${n.source}: required by this configuration but no version is selected`)
    else if (versions && n.constraints && e.version !== undefined && !meets(e.version, n.constraints)) {
      const q = JSON.stringify(n.constraints)
      errs.push(e.constraints !== n.constraints ? `provider ${n.source}: locked version selection ${e.version} doesn't match the updated version constraints ${q}` : `provider ${n.source}: version constraints ${q} don't match the locked version selection ${e.version}`)
    }
  }
  if (!errs.length) return undefined
  const list = errs.sort().map((m) => `  - ${m}`).join('\n')
  const suggestion = lock.size ? 'To update the locked dependency selections to match a changed configuration, run:\n  terraform init -upgrade' : 'To make the initial dependency selections that will initialize the dependency lock file, run:\n  terraform init'
  return fail(box('error', 'Inconsistent dependency lock file', `The following dependency selections recorded in the lock file are inconsistent with the current configuration:\n${list}\n\n${suggestion}`, true))
}

// Meta.providerFactories: every provider the lock file selects must have its package in .terraform/providers, and the
// package must match one of the lock file's h1: hashes. Absent outside the lab directory, where no cache is modelled.
function cacheIssues(cfg: Config, ctx: CliContext): string[] {
  const cache = ctx.lab.providerCache
  if (!cache) return []
  const out: string[] = []
  // ponytail: Terraform checks every provider in the lock file; only those the configuration needs are checked here, so a stray lock entry is not an error.
  const needed = new Set(providerNeeds(modulesOf(cfg.modules.tree), providersOf(allFiles(cfg))).needs.map((n) => n.source))
  for (const [source, e] of [...parseLock(cfg.lockText)].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (e.version === undefined || !needed.has(source)) continue
    const hash = cache.get(source)?.get(e.version)
    const allowed = e.hashes.filter((h) => h.startsWith('h1:'))
    if (hash === undefined) out.push(`${source}: there is no package for ${source} ${e.version} cached in ${PROVIDER_CACHE_DIR}`)
    else if (allowed.length && !allowed.includes(hash)) out.push(`${source}: the cached package for ${source} ${e.version} (in ${PROVIDER_CACHE_DIR}) does not match any of the checksums recorded in the dependency lock file`)
  }
  return out
}
// Meta.Backend turns those problems into this error for every command that opens the backend.
function pluginsError(cfg: Config, ctx: CliContext): Out | undefined {
  const issues = cacheIssues(cfg, ctx)
  if (!issues.length) return undefined
  return fail(box('error', 'Required plugins are not installed', `The installed provider plugins are not consistent with the packages selected in the dependency lock file:\n${issues.map((i) => `  - ${i}`).join('\n')}\n\nTerraform uses external plugins to integrate with a variety of different infrastructure services. To download the plugins required for this configuration, run:\n  terraform init`, true))
}

// statemgr.LockInfo.String(): the held lock's fields under a "Lock Info:" line.
const lockInfo = (ctx: CliContext) => {
  const l = ctx.lab.lock!
  return ['Lock Info:', ...[['ID', l.id], ['Path', l.path], ['Operation', l.operation], ['Who', l.who], ['Version', ctx.lab.version], ['Created', l.created], ['Info', l.info]].map(([k, v]) => `  ${`${k}:`.padEnd(11)}${v}`)]
}

// The commands that write state take the lock first; a held lock stops them unless -lock=false.
function checkLock(ctx: CliContext, lock: boolean): Out | undefined {
  const l = ctx.lab.lock
  if (!lock || !l) return undefined
  const info = lockInfo(ctx)
  const tail =
    'Terraform acquires a state lock to protect the state from being written\nby multiple users at the same time. Please resolve the issue above and try\nagain. For most commands, you can disable locking with the "-lock=false"\nflag, but this is not recommended.'
  return fail(box('error', 'Error acquiring the state lock', `Error message: ${l.message}\n${info.join('\n')}\n\n\n${tail}`, true))
}

function cmdVersion(ctx: CliContext, cfg: Config): Out {
  const lines = [`Terraform v${ctx.lab.version}`, 'on linux_amd64']
  for (const [p, e] of [...parseLock(cfg.lockText)].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) if (e.version !== undefined) lines.push(`+ provider ${p} v${e.version}`)
  return ok(lines.join('\n'))
}

// Provider addresses a module's own resources need, plus the built-in terraform provider for terraform_remote_state.
const usesRemoteState = (files: File[]) => files.some((f) => parseHcl(f.name, f.text).blocks.some((b) => b.type === 'data' && b.labels[0] === 'terraform_remote_state'))
const BUILTIN_TERRAFORM = 'terraform.io/builtin/terraform'

// providers.go: the tree of modules annotated with their provider requirements, then the providers the state records.
function cmdProviders(args: string[], ctx: CliContext, cfg: Config): Out {
  const pos = args.filter((a) => !a.startsWith('-'))
  if (pos.length) return notYet(`providers ${pos[0]}`)
  if (!cfg.tf.length) return boxFail('No configuration files', `The directory ${cfg.dir} contains no Terraform configuration files.`)
  const syntax = cfg.tf.flatMap((f) => parseHcl(f.name, f.text).diagnostics)
  if (syntax.length) return fail(boxes(syntax, cfg.tf))
  const mod = moduleErrors(cfg)
  if (mod.length) return fail(boxes(mod, allFiles(cfg)))
  const plugins = pluginsError(cfg, ctx)
  if (plugins) return plugins
  const tree = cfg.modules.tree
  const diagnostics: Diagnostic[] = []
  type Node = { text: string; kids: Node[] }
  const build = (key: string, files: File[]): Node[] => {
    const r = providerNeeds([{ key, files }], [...providersOf(files), ...(usesRemoteState(files) ? [BUILTIN_TERRAFORM] : [])])
    diagnostics.push(...r.diagnostics)
    const names = [...tree.children.keys()].filter((k) => k.startsWith(key ? `${key}.` : '') && !k.slice(key ? key.length + 1 : 0).includes('.')).sort()
    return [
      ...r.needs.map((n) => ({ text: `provider[${n.source}]${n.constraints ? ` ${n.constraints}` : ''}`, kids: [] })),
      ...names.map((k) => ({ text: `module.${k.slice(key ? key.length + 1 : 0)}`, kids: build(k, tree.children.get(k)!.files.files) })),
    ]
  }
  const nodes = build('', tree.root.files)
  if (diagnostics.length) return fail(boxes(diagnostics, allFiles(cfg)))
  // treeprint: "├── " and "└── " per node, "│   " or four spaces carried down for the children.
  const draw = (list: Node[], prefix: string): string[] =>
    list.flatMap((n, i) => {
      const last = i === list.length - 1
      return [`${prefix}${last ? '└── ' : '├── '}${n.text}`, ...draw(n.kids, prefix + (last ? '    ' : '│   '))]
    })
  const fromState = [...new Set(ctx.lab.hasState ? ctx.lab.state.resources.map((r) => /^provider\["(.*)"\]$/.exec(r.provider)?.[1]).filter((x): x is string => x !== undefined) : [])].sort()
  const state = fromState.length ? `Providers required by state:\n\n${fromState.map((p) => `    provider[${p}]\n\n`).join('')}` : ''
  return ok(`\nProviders required by configuration:\n${['.', ...draw(nodes, '')].join('\n')}\n\n${state}`)
}

// What init and get share: read each local module from its source, install registry modules from the lab's
// registry (or keep the installed version while it still satisfies the constraint) and record all in the manifest.
async function installModules(ctx: CliContext, cfg: Config, upgrade: boolean): Promise<{ lines: string[]; files: File[]; calls: boolean; tree: ModuleTree } | Out> {
  const manifest = parseManifest(await ctx.readFile(resolvePath(cfg.dir, MANIFEST_PATH)))
  const m = await loadModuleTree(cfg.tf, moduleReader(ctx, cfg.dir), manifest, true, { registry: ctx.lab.registry, upgrade })
  if (!m.calls.length && !m.install.length) return { lines: [], files: cfg.tf, calls: false, tree: m.tree }
  const errors = [...m.install, ...m.syntax]
  const files = [...cfg.tf, ...[...m.tree.children.values()].flatMap((c) => c.files.files)]
  if (errors.length) return { stdout: '', stderr: boxes(errors, files), exitCode: 1 }
  // Registry downloads: write the selected version's files; a file only the previous version had is emptied (no delete here).
  for (const d of m.downloads) {
    for (const [path, text] of [...d.files.map((f) => [f.path, f.content] as const), ...d.stale.map((p) => [p, ''] as const)]) {
      const cut = path.lastIndexOf('/')
      await ctx.write(resolvePath(cfg.dir, cut < 0 ? d.dir : `${d.dir}/${path.slice(0, cut)}`), path.slice(cut + 1), text)
    }
  }
  await ctx.write(resolvePath(cfg.dir, '.terraform/modules'), 'modules.json', formatManifest(m.entries))
  return { lines: m.lines, files, calls: true, tree: m.tree }
}

const hasFlag = (args: string[], name: string) => args.some((a) => a === name || a === `${name}=true`)

async function cmdGet(args: string[], ctx: CliContext, cfg: Config): Promise<Out> {
  const syntax = cfg.tf.flatMap((f) => parseHcl(f.name, f.text).diagnostics)
  if (syntax.length) return fail(boxes(syntax, cfg.tf))
  const r = await installModules(ctx, cfg, hasFlag(args, '-update'))
  return 'lines' in r ? ok(r.lines.join('\n')) : r
}

async function cmdInit(args: string[], ctx: CliContext, cfg: Config): Promise<Out> {
  if (!cfg.tf.length) return ok(EMPTY_INIT)
  // Only syntax stops init; undeclared references and cycles are for validate and plan.
  const syntax = cfg.tf.flatMap((f) => parseHcl(f.name, f.text).diagnostics)
  if (syntax.length) return fail(boxes(syntax, cfg.tf))
  const upgrade = hasFlag(args, '-upgrade')
  const mods = await installModules(ctx, cfg, upgrade)
  if (upgrade && args.includes('-lockfile=readonly') && 'lines' in mods) return { stdout: '', stderr: '╷\n│ Error: The -upgrade flag conflicts with -lockfile=readonly.\n╵', exitCode: 1 }
  const header = upgrade ? 'Upgrading modules...' : 'Initializing modules...'
  if (!('lines' in mods)) return { ...mods, stdout: header }
  const bad = configDiags(mods.tree, ctx.lab.version)
  if (bad.length) return fail(boxes(bad, mods.files))
  const lockMap = parseLock(cfg.lockText)
  const { needs } = providerNeeds(modulesOf(mods.tree), providersOf(mods.files))
  const readonly = args.includes('-lockfile=readonly')
  const lines = [...(mods.calls ? [header, ...mods.lines] : []), '', 'Initializing the backend...', '', 'Initializing provider plugins...']
  const errs: { summary: string; msg: string }[] = []
  const queryFail = (msg: string) => errs.push({ summary: 'Failed to query available provider packages', msg })
  const entries: LockEntry[] = []
  const installs: { source: string; version: string; hash: string }[] = [] // packages written to the cache once init succeeds
  const cache = ctx.lab.providerCache
  let moved = false // a provider was added or its version changed (a constraint hint alone is not a change)
  const h1 = (hashes: string[]) => hashes.filter((h) => h.startsWith('h1:'))
  // installer.go: a package already in the cache is kept when it matches a recorded hash (outside the lab directory no cache is modelled).
  const cached = (source: string, version: string, prior: string[]) => {
    if (!cache) return true
    const hash = cache.get(source)?.get(version)
    return hash !== undefined && (!prior.length || prior.includes(hash))
  }
  // Installs from the lab's registry, whose package for a version always has providerHash; the lock's recorded hashes for that version must include it.
  const fetchPackage = (source: string, name: string, version: string, prior: string[]): boolean => {
    lines.push(`- Installing ${name} v${version}...`)
    const hash = providerHash(source, version)
    if (prior.length && !prior.includes(hash)) {
      errs.push({ summary: 'Failed to install provider', msg: `Error while installing ${name} v${version}: the current package for ${source} ${version} doesn't match any of the checksums previously recorded in the dependency lock file; for more information: https://www.terraform.io/language/provider-checksum-verification` })
      return false
    }
    lines.push(`- Installed ${name} v${version} (signed by HashiCorp)`)
    installs.push({ source, version, hash })
    return true
  }
  const union = (...lists: string[][]) => [...new Set(lists.flat())].sort()
  for (const n of needs) {
    const name = shortName(n.source)
    const cur = lockMap.get(n.source)
    const constraints = n.constraints ? { constraints: n.constraints } : {}
    if (cur?.version !== undefined && !upgrade) {
      if (n.constraints && !meets(cur.version, n.constraints)) {
        queryFail(`Could not retrieve the list of available versions for provider ${name}: locked provider ${n.source} ${cur.version} does not match configured version constraint ${n.constraints}; must use terraform init -upgrade to allow selection of new versions`)
        continue
      }
      lines.push(`- Reusing previous version of ${name} from the dependency lock file`)
      if (cached(n.source, cur.version, h1(cur.hashes))) {
        lines.push(`- Using previously-installed ${name} v${cur.version}`)
        entries.push({ source: n.source, version: cur.version, ...constraints, hashes: cur.hashes })
        continue
      }
      // The locked package is not in the cache (or is not the recorded one): install it, checked against the recorded hashes.
      if (!availableOf(ctx.lab.providers, n.source).includes(cur.version)) {
        queryFail(`Could not retrieve the list of available versions for provider ${name}: the previously-selected version ${cur.version} is no longer available`)
        continue
      }
      if (!fetchPackage(n.source, name, cur.version, h1(cur.hashes))) continue
      entries.push({ source: n.source, version: cur.version, ...constraints, hashes: union([providerHash(n.source, cur.version)], cur.hashes) })
      continue
    }
    lines.push(n.constraints ? `- Finding ${name} versions matching "${n.constraints}"...` : `- Finding latest version of ${name}...`)
    const pick = newestSatisfying(availableOf(ctx.lab.providers, n.source), n.constraints || '>= 0.0.0')
    if (pick === undefined) {
      queryFail(`Could not retrieve the list of available versions for provider ${name}: no available releases match the given constraints ${n.constraints || '>= 0.0.0'}`)
      continue
    }
    const same = cur?.version === pick
    const prior = same ? h1(cur.hashes) : []
    if (same && cached(n.source, pick, prior)) {
      lines.push(`- Using previously-installed ${name} v${pick}`)
      entries.push({ source: n.source, version: pick, ...constraints, hashes: cur.hashes })
      continue
    }
    if (!fetchPackage(n.source, name, pick, prior)) continue
    entries.push({ source: n.source, version: pick, ...constraints, ...(same ? { hashes: union([providerHash(n.source, pick)], cur.hashes) } : {}) })
    if (!same) moved = true
  }
  if (errs.length) return { stdout: lines.join('\n'), stderr: errs.map((e) => box('error', e.summary, e.msg)).join('\n'), exitCode: 1 }
  const added = needs.filter((n) => !lockMap.has(n.source)).length > 0
  if (readonly && added) {
    return { stdout: lines.join('\n'), stderr: box('error', 'Provider dependency changes detected', 'Changes to the required provider dependencies were detected, but the lock file is read-only. To use and record these requirements, run "terraform init" without the "-lockfile=readonly" flag.'), exitCode: 1 }
  }
  for (const i of installs) {
    const pkg = cachedPackage(i.source, i.version, i.hash)
    if (!pkg) continue
    if (cache) cache.set(i.source, (cache.get(i.source) ?? new Map<string, string>()).set(i.version, i.hash))
    await ctx.write(resolvePath(cfg.dir, pkg.dir), pkg.name, pkg.content)
  }
  const text = !cfg.hasLock ? (entries.length ? lockFile(entries) : '') : updateLock(cfg.lockText, entries)
  if (!readonly && text !== cfg.lockText && (entries.length || cfg.hasLock)) await ctx.write(cfg.dir, '.terraform.lock.hcl', text)
  if (added && !cfg.hasLock) {
    lines.push(
      '',
      'Terraform has created a lock file .terraform.lock.hcl to record the provider',
      'selections it made above. Include this file in your version control repository',
      'so that Terraform can guarantee to make the same selections by default when',
      'you run "terraform init" in the future.',
    )
  } else if (added || moved) {
    lines.push(
      '',
      'Terraform has made some changes to the provider dependency selections recorded',
      'in the .terraform.lock.hcl file. Review those changes and commit them to your',
      'version control system if they represent changes you intended to make.',
    )
  }
  lines.push(
    '',
    'Terraform has been successfully initialized!',
    '',
    'You may now begin working with Terraform. Try running "terraform plan" to see',
    'any changes that are required for your infrastructure. All Terraform commands',
    'should now work.',
    '',
    'If you ever set or change modules or backend configuration for Terraform,',
    'rerun this command to reinitialize your working directory. If you forget, other',
    'commands will detect it and remind you to do so if necessary.',
  )
  return ok(lines.join('\n'))
}

function cmdValidate(cfg: Config, ctx: CliContext): Out {
  if (!cfg.tf.length) return ok('Success! The configuration is valid.\n')
  const mod = moduleErrors(cfg)
  if (mod.length) return fail(boxes(mod, allFiles(cfg)))
  // validate builds its context without a backend: the same problem is a plain error.
  const issues = cacheIssues(cfg, ctx)
  if (issues.length) return fail(box('error', issues.length === 1 ? issues[0] : `missing or corrupted provider plugins:${issues.map((i) => `\n  - ${i}`).join('')}`, ''))
  const core = configErrors(cfg, ctx.lab.version)
  if (core) return core
  const g = buildGraph(cfg.modules.tree)
  const diags = [...g.diagnostics]
  if (!diags.length) {
    for (const n of g.nodes.values()) {
      if (n.kind !== 'resource' || !n.block || schemaFor(n.block.labels[0])) continue
      const type = n.block.labels[0]
      diags.push({
        severity: 'error',
        summary: 'Invalid resource type',
        detail: `The provider hashicorp/${type.split('_')[0]} does not support resource type "${type}". (This lab only models some resource types.)`,
        file: n.file,
        line: n.block.pos.line,
        col: n.block.pos.col,
        context: `resource "${type}" "${n.block.labels[1]}"`,
      })
    }
  }
  if (diags.length) return fail(boxes(diags, allFiles(cfg)))
  // Real validate never reads the lock's versions (only operations do); a missing selection is kept from before.
  return lockError(cfg, false) ?? ok('Success! The configuration is valid.\n')
}

// A tfvars file is `name = literal` lines; parse it as the body of a locals block.
function parseVarsFile(name: string, text: string): { values: [string, Value][] } | { diags: Diagnostic[] } {
  const bad = (summary: string, detail: string, line: number): { diags: Diagnostic[] } => ({ diags: [{ severity: 'error', summary, detail, file: name, line, col: 1 }] })
  const r = parseHcl(name, `locals {\n${text}\n}`)
  if (r.diagnostics.length) return { diags: r.diagnostics.map((d) => ({ ...d, line: Math.max(1, d.line - 1) })) }
  const b = r.blocks[0]
  if (r.blocks.length !== 1 || b.type !== 'locals' || b.blocks.length) return bad('Invalid variables file', 'A variables file may only contain lines of the form name = value.', 1)
  const values: [string, Value][] = []
  for (const a of b.attrs) {
    try {
      values.push([a.name, evalExpr(a.value, { ref: () => { throw new EvalError('Variables not allowed', 'Variables may not be used here.') } })])
    } catch (e) {
      if (!(e instanceof EvalError)) throw e
      return bad(e.summary, e.detail, Math.max(1, a.pos.line - 1))
    }
  }
  return { values }
}

type VarSource = { kind: 'var'; arg: string } | { kind: 'file'; path: string }
type Origin = 'cli' | 'env' | { file: string }
type Resolved = { warnings: string } & ({ vars: Record<string, Value> } | { error: string })

// Convert a string, number or bool to a declared primitive type, as Terraform does.
function convertTo(v: Value, type: string): { v: Value } | undefined {
  if (type === 'string') return typeof v === 'string' ? { v } : typeof v === 'number' || typeof v === 'boolean' ? { v: String(v) } : undefined
  if (type === 'number') return typeof v === 'number' ? { v } : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? { v: Number(v) } : undefined
  return typeof v === 'boolean' ? { v } : v === 'true' || v === '1' ? { v: true } : v === 'false' || v === '0' ? { v: false } : undefined
}

// Variables in Terraform's precedence, lowest first; later sources override earlier ones.
// `declared` (the root module's variable blocks) is absent when the configuration does not parse.
async function resolveVars(ctx: CliContext, cfg: Config, cmdline: VarSource[], declared: Block[] | undefined): Promise<Resolved> {
  const vars = new Map<string, { v: Value; from: Origin }>()
  for (const [k, v] of Object.entries(ctx.lab.vars)) vars.set(k, { v, from: 'env' })
  for (const [k, v] of Object.entries(ctx.env)) if (k.startsWith('TF_VAR_') && k.length > 7) vars.set(k.slice(7), { v, from: 'env' })
  const errors: string[] = []
  const load = (file: File) => {
    const r = parseVarsFile(file.name, file.text)
    if ('diags' in r) errors.push(boxes(r.diags, [file]))
    else for (const [k, v] of r.values) vars.set(k, { v, from: { file: file.name } })
  }
  cfg.tfvars.forEach(load)
  for (const s of cmdline) {
    if (s.kind === 'var') {
      const eq = s.arg.indexOf('=')
      if (eq < 1) errors.push(box('error', 'Invalid -var option', `Given variable option "${s.arg}" is not correctly specified. Must be a variable name and value separated by an equals sign, like -var="key=value".`))
      else vars.set(s.arg.slice(0, eq), { v: s.arg.slice(eq + 1), from: 'cli' })
      continue
    }
    const path = resolvePath(cfg.dir, s.path)
    const text = await ctx.readFile(path)
    if (text === undefined) errors.push(box('error', 'Failed to read variables file', `Given variables file ${s.path} does not exist.`))
    else load({ name: s.path, text })
  }
  const final = new Map<string, Value>()
  const undeclared: { name: string; file: string }[] = []
  for (const [name, { v, from }] of vars) {
    if (!declared) {
      final.set(name, v)
      continue
    }
    const decl = declared.find((b) => b.labels[0] === name)
    if (!decl) {
      if (from === 'cli') errors.push(box('error', 'Value for undeclared variable', `A variable named "${name}" was assigned on the command line, but the root module does not declare a variable of that name. To use this value, add a "variable" block to the configuration.`))
      else if (from !== 'env') undeclared.push({ name, file: from.file })
      continue
    }
    const t = decl.attrs.find((a) => a.name === 'type')?.value
    const word = t?.kind === 'ref' && t.path.length === 1 ? t.path[0] : undefined
    const type = word !== undefined && ['bool', 'number', 'string'].includes(word) ? word : undefined
    const where =
      from === 'cli' ? `Unsuitable value for var.${name} set using -var="${name}=${String(v)}"` : from === 'env' ? `Unsuitable value for var.${name} set using the TF_VAR_${name} environment variable` : `The given value is not suitable for var.${name} declared at ${decl.file}:${decl.pos.line}`
    const invalid = (reason: string) => errors.push(box('error', 'Invalid value for input variable', `${where}: ${reason}`))
    // Null passes conversion; a non-nullable variable drops it so the default applies.
    if (v === null) {
      const n = decl.attrs.find((a) => a.name === 'nullable')?.value
      if (!(n?.kind === 'lit' && n.value === false)) final.set(name, v)
      continue
    }
    // Command-line and environment values are text; a collection type parses them as an expression.
    let val: Value = v
    if (t && !type && word !== 'any' && (from === 'cli' || from === 'env') && typeof v === 'string') {
      const r = parseVarsFile(name, `${name} = ${v}`)
      if ('diags' in r) {
        invalid(r.diags[0].detail || r.diags[0].summary)
        continue
      }
      val = r.values[0][1]
    }
    const c = type ? convertTo(val, type) : { v: val }
    if (!c) invalid(`a ${type} is required${type === 'bool' && (v === 'True' || v === 'False') ? `; to convert from string, use lowercase "${v.toLowerCase()}"` : ''}.`)
    else final.set(name, c.v)
  }
  undeclared.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const warns = undeclared.slice(0, 2).map((w) =>
    box('warning', 'Value for undeclared variable', `The root module does not declare a variable named "${w.name}" but a value was found in file "${w.file}". If you meant to use this value, add a "variable" block to the configuration.\n\nTo silence these warnings, use TF_VAR_... environment variables to provide certain "global" settings to all configurations in your organization. To reduce the verbosity of these warnings, use the -compact-warnings option.`, true),
  )
  if (undeclared.length > 2) warns.push(box('warning', 'Values for undeclared variables', `In addition to the other similar warnings shown, ${undeclared.length - 2} other variable(s) defined without being declared.`))
  const warnings = warns.join('\n')
  return errors.length ? { warnings, error: errors.join('\n') } : { warnings, vars: Object.fromEntries(final) }
}

type Cmd = 'plan' | 'apply' | 'destroy'
interface PlanFlags {
  sources: VarSource[]
  replace: string[]
  refresh: boolean
  out?: string
  detailed: boolean
  autoApprove: boolean
  lock: boolean
  planFile?: string
  targets: Target[]
}
const PLAN_VALUE_FLAGS = new Set(['-var', '-var-file', '-replace', '-out', '-lock-timeout', '-parallelism', '-target'])
const PLAN_BOOL_FLAGS = new Set(['-no-color', '-input', '-lock', '-compact-warnings', '-refresh', '-detailed-exitcode', '-destroy', '-refresh-only', '-auto-approve'])
// Flags each command does not take, as Terraform's own flag parser rejects them.
const NOT_FOR: Record<Cmd, string[]> = { plan: ['-auto-approve'], apply: ['-out', '-detailed-exitcode'], destroy: ['-out', '-detailed-exitcode', '-replace'] }

function parsePlanFlags(args: string[], cmd: Cmd = 'plan'): PlanFlags | Out {
  const f: PlanFlags = { sources: [], replace: [], refresh: true, detailed: false, autoApprove: false, lock: true, targets: [] }
  const rawTargets: string[] = []
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    if (!raw.startsWith('-') || raw === '-') {
      // apply takes one saved plan file; nothing else takes positional arguments.
      if (cmd === 'apply' && f.planFile === undefined) {
        f.planFile = raw
        continue
      }
      return boxFail('Too many command line arguments', cmd === 'apply' ? 'Expected at most one positional argument.' : 'Expected no positional arguments. Did you mean to use -chdir?')
    }
    const eq = raw.indexOf('=')
    const name = (eq < 0 ? raw : raw.slice(0, eq)).replace(/^--/, '-')
    let value = eq < 0 ? undefined : raw.slice(eq + 1)
    if (NOT_FOR[cmd].includes(name)) return boxFail('Failed to parse command-line flags', `flag provided but not defined: ${name}`)
    if (PLAN_VALUE_FLAGS.has(name)) {
      if (value === undefined) {
        value = args[++i]
        if (value === undefined) return boxFail('Failed to parse command-line flags', `flag needs an argument: ${name}`)
      }
      if (name === '-var') f.sources.push({ kind: 'var', arg: value })
      else if (name === '-var-file') f.sources.push({ kind: 'file', path: value })
      else if (name === '-replace') f.replace.push(value)
      else if (name === '-out') f.out = value
      else if (name === '-target') rawTargets.push(value)
    } else if (PLAN_BOOL_FLAGS.has(name)) {
      if (name === '-refresh') f.refresh = value !== 'false'
      else if (name === '-lock') f.lock = value !== 'false'
      else if (name === '-detailed-exitcode') f.detailed = true
      else if (name === '-auto-approve') f.autoApprove = value !== 'false'
      else if (name === '-destroy' || name === '-refresh-only') return notYet(`${cmd} ${name}`)
    } else return boxFail('Failed to parse command-line flags', `flag provided but not defined: ${name}`)
  }
  // Terraform parses -target before anything else runs; a bad address is an error with the address quoted.
  const badTargets = rawTargets.filter((t) => parseTargetArg(t) === undefined)
  if (badTargets.length) return fail(badTargets.map((t) => box('error', `Invalid target ${JSON.stringify(t)}`, 'Resource specification must include a resource type and name.')).join('\n'))
  f.targets = rawTargets.flatMap((t) => parseTargetArg(t) ?? [])
  const bad = f.replace.find((a) => parseResAddr(a)?.mode !== 'managed')
  if (bad !== undefined) return boxFail(`Invalid force-replace address "${bad}"`, `The force-replace address "${bad}" is not a valid resource instance address.`)
  return f
}

interface Planned {
  warning: string
  vars: Record<string, Value>
  result: PlanResult
  stdout: string // refresh lines and the rendered plan
  changes: boolean
}

type Prepared = { warning: string; vars: Record<string, Value>; graph: ReturnType<typeof buildGraph> }

// What plan, apply, destroy, import and refresh share: configuration, lock file and variables.
async function prepare(sources: VarSource[], ctx: CliContext, cfg: Config): Promise<Prepared | Out> {
  if (!cfg.tf.length) return boxFail('No configuration files', NO_CONFIG_DETAIL)
  const mod = moduleErrors(cfg)
  if (mod.length) return fail(boxes(mod, allFiles(cfg)))
  const plugins = pluginsError(cfg, ctx)
  if (plugins) return plugins
  const g = buildGraph(cfg.modules.tree)
  if (!g.diagnostics.length) {
    const lock = lockError(cfg) ?? configErrors(cfg, ctx.lab.version)
    if (lock) return lock
  }
  const v = await resolveVars(ctx, cfg, sources, g.diagnostics.length ? undefined : g.blocks.filter((b) => b.type === 'variable'))
  if ('error' in v) return { stdout: v.warnings, stderr: v.error, exitCode: 1 }
  return { warning: v.warnings, vars: v.vars, graph: g }
}

// The plan `terraform plan` would make in the lab directory, for done_when predicates: no lock
// check, nothing committed. Undefined when there is no configuration, no lock file or bad variables.
export async function worldPlan(ctx: CliContext): Promise<PlanResult | undefined> {
  const cfg = await loadConfig(ctx, resolvePath('/', ctx.lab.dir))
  const s = await prepare([], ctx, cfg)
  if (!('vars' in s)) return undefined
  return planConfig({ tree: cfg.modules.tree, state: ctx.lab.state, reality: ctx.lab.reality, vars: s.vars, workspace: ctx.lab.workspace, remoteStates: ctx.lab.remoteStates, replace: [], refresh: true })
}

// The lines a plan prints while it reads the state's objects back from the cloud.
const refreshLines = (state: State, refresh: boolean, reads: string[] = [], planned?: State, scope?: TargetScope) =>
  state.resources
    .filter((r) => !scope || r.instances.some((i) => scope.includes(r, i.index_key)))
    // a data source whose block was removed is dropped by the plan: no Reading line for it
    .filter((r) => !planned || r.mode !== 'data' || r.type !== 'terraform_remote_state' || planned.resources.some((p) => p.mode === 'data' && p.type === r.type && p.name === r.name && (p.module ?? '') === (r.module ?? '')))
    .flatMap((r) =>
      r.instances.filter((i) => !scope || scope.includes(r, i.index_key)).map((i) => {
        const addr = instanceAddress(r, i.index_key)
        const id = typeof i.attributes.id === 'string' ? ` [id=${i.attributes.id}]` : ''
        return { addr, lines: r.mode === 'data' ? [`${addr}: Reading...`, `${addr}: Read complete after 0s${id}`] : refresh ? [`${addr}: Refreshing state...${id}`] : [] }
      }),
    )
    .concat(reads.filter((a) => !listAddresses(state).includes(a)).map((addr) => ({ addr, lines: [`${addr}: Reading...`, `${addr}: Read complete after 0s`] })))
    .sort((a, b) => compareAddresses(a.addr, b.addr))
    .flatMap((x) => x.lines)

// What plan, apply, destroy and refresh share: setup checks, variables, the plan and its refresh lines.
async function makePlan(f: PlanFlags, ctx: CliContext, cfg: Config, destroy: boolean): Promise<Planned | Out> {
  const s = await prepare(f.sources, ctx, cfg)
  if (!('vars' in s)) return s
  // Graph diagnostics are configuration errors: they come before the lock, and the plan below reports them.
  const locked = !s.graph.diagnostics.length && checkLock(ctx, f.lock)
  if (locked) return locked
  const warning = s.warning
  const result = planConfig({ tree: cfg.modules.tree, state: ctx.lab.state, reality: ctx.lab.reality, vars: s.vars, workspace: ctx.lab.workspace, remoteStates: ctx.lab.remoteStates, replace: f.replace, refresh: f.refresh, destroy, ...(f.targets.length ? { targets: f.targets } : {}) })
  const rendered = renderPlan(result, sourcesOf(allFiles(cfg)))
  const scope = f.targets.length ? (destroy ? destroyScope(s.graph.nodes, ctx.lab.state, f.targets) : targetScope(s.graph.nodes, f.targets)) : undefined
  const lines = refreshLines(ctx.lab.state, f.refresh, result.reads, destroy ? undefined : result.baseState, scope)
  // Terraform prints the targeting warning after the plan, with the plan's other diagnostics.
  const warn = scope ? `\n\n${TARGET_WARNING}` : ''
  const stdout = (lines.length ? `${lines.join('\n')}\n\n${rendered}` : rendered) + warn
  // A configuration error stops before planning; prevent_destroy fails after it, so the partial plan prints first (apply asks nothing).
  if (result.diagnostics.length) return withWarn(warning, { stdout: result.partial ? stdout : warn.trim(), stderr: renderPlanErrors(result, sourcesOf(allFiles(cfg))), exitCode: 1 })
  return { warning, vars: s.vars, result, stdout, changes: !/(^|\n)No changes\. Your infrastructure matches/.test(rendered) }
}

const TARGET_WARNING = box(
  'warning',
  'Resource targeting is in effect',
  'You are creating a plan with the -target option, which means that the result of this plan may not represent all of the changes requested by the current configuration.\n\nThe -target option is not for routine use, and is provided only for exceptional situations such as recovering from errors or mistakes, or when Terraform specifically suggests to use it as part of an error message.',
  true,
)
const TARGETED_APPLY_WARNING = box(
  'warning',
  'Applied changes may be incomplete',
  'The plan was created with the -target option in effect, so some changes requested in the configuration may have been ignored and the output values may not be fully updated. Run the following command to verify that no other changes are pending:\n    terraform plan\n\nNote that the -target option is not suitable for routine use, and is provided only for exceptional situations such as recovering from errors or mistakes, or when Terraform specifically suggests to use it as part of an error message.',
  true,
)

const planId = (lineage: string, serial: number, name: string) => `p${hex(`${lineage}:${serial}:${name}`, 8)}`

async function cmdPlan(args: string[], ctx: CliContext, cfg: Config, here: boolean): Promise<Out> {
  const f = parsePlanFlags(args)
  if (!('sources' in f)) return f
  const p = await makePlan(f, ctx, cfg, false)
  if (!('result' in p)) return p
  let stdout = p.stdout
  if (p.changes) {
    stdout += f.out
      ? `\n\n${RULE}\n\nSaved the plan to: ${f.out}\n\nTo perform exactly these actions, run the following command to apply:\n    terraform apply "${f.out}"`
      : `\n\n${RULE}\n\nNote: You didn't use the -out option to save this plan, so Terraform can't\nguarantee to take exactly these actions if you run "terraform apply" now.`
  }
  // Saved even with no changes, so an older plan file under the same name can't be applied later.
  if (f.out !== undefined && here) {
    const { lineage, serial } = ctx.lab.state
    const path = resolvePath(cfg.dir, f.out)
    const id = planId(lineage, serial, path)
    ctx.lab.savedPlans.set(id, { tree: cfg.modules.tree, vars: p.vars, replace: f.replace, destroy: false, targets: f.targets, serial, lineage, workspace: ctx.lab.workspace })
    const slash = path.lastIndexOf('/')
    await ctx.write(path.slice(0, slash) || '/', path.slice(slash + 1), `TFPLAN1\n${id}\n`)
  }
  return { ...withWarn(p.warning, ok(stdout)), exitCode: f.detailed && p.changes ? 2 : 0 }
}

const NO_CHANGES =
  'No changes. Your infrastructure matches the configuration.\n\nTerraform has compared your real infrastructure against your configuration\nand found no differences, so no changes are needed.'
const NO_DESTROY = 'No changes. No objects need to be destroyed.\n\nEither you have not created any objects yet or the existing objects were already deleted outside of Terraform.'
const APPLY_PROMPT = "\nDo you want to perform these actions?\n  Terraform will perform the actions described above.\n  Only 'yes' will be accepted to approve.\n\n  Enter a value: "
const DESTROY_PROMPT =
  "\nDo you really want to destroy all resources?\n  Terraform will destroy all your managed infrastructure, as shown above.\n  There is no undo. Only 'yes' will be accepted to confirm.\n\n  Enter a value: "

// A saved plan file: its marker line and id, checked against what plan -out stored.
async function loadSavedPlan(ctx: CliContext, cfg: Config, name: string): Promise<SavedPlan | Out> {
  const text = await ctx.readFile(resolvePath(cfg.dir, name))
  const failLoad = (detail: string) => boxFail(`Failed to load "${name}" as a plan file`, detail)
  if (text === undefined) return failLoad(`Error: stat ${name}: no such file or directory`)
  const [marker, id] = text.split('\n')
  const saved = marker === 'TFPLAN1' && id !== undefined ? ctx.lab.savedPlans.get(id) : undefined
  return saved ?? failLoad('Error: zip: not a valid zip file')
}

async function cmdApply(args: string[], ctx: CliContext, cfg: Config, mode: 'apply' | 'destroy'): Promise<Out> {
  const f = parsePlanFlags(args, mode)
  if (!('sources' in f)) return f
  const destroy = mode === 'destroy'
  let input: { tree: ModuleTree; vars: Record<string, Value>; replace: string[]; destroy: boolean; targets: Target[] }
  let head: string
  let warning = ''
  if (f.planFile !== undefined) {
    if (f.replace.length) return boxFail("Can't set -replace when applying a saved plan", 'The -replace option cannot be used when applying a saved plan file, because a saved plan already records which objects it replaces. Create a new plan with -replace instead.')
    if (f.sources.length) return boxFail("Can't set variables when applying a saved plan", 'The -var and -var-file options cannot be used when applying a saved plan file, because a saved plan includes the variable values that were set when it was created.')
    const plugins = pluginsError(cfg, ctx)
    if (plugins) return plugins
    const saved = await loadSavedPlan(ctx, cfg, f.planFile)
    if (!('serial' in saved)) return saved
    const locked = checkLock(ctx, f.lock)
    if (locked) return locked
    if (saved.serial !== ctx.lab.state.serial || saved.lineage !== ctx.lab.state.lineage || saved.workspace !== ctx.lab.workspace)
      return boxFail('Saved plan is stale', 'The given plan file can no longer be applied because the state was changed by another operation after the plan was created.')
    input = { tree: saved.tree, vars: saved.vars, replace: saved.replace, destroy: saved.destroy, targets: saved.targets ?? [] }
    head = '' // a saved plan was already reviewed: no plan text, no question
  } else {
    const p = await makePlan(f, ctx, cfg, destroy)
    if (!('result' in p)) return p
    warning = p.warning
    input = { tree: cfg.modules.tree, vars: p.vars, replace: f.replace, destroy, targets: f.targets }
    // No changes: nothing to ask, but the apply still runs so the refreshed state is saved.
    head = p.changes || !destroy ? p.stdout : p.stdout.replace(NO_CHANGES, NO_DESTROY)
    if (p.changes && !f.autoApprove) {
      const prompt = destroy ? DESTROY_PROMPT : APPLY_PROMPT
      // The hook gets everything a player must see to decide; stdout still carries it all for the transcript.
      const shown = withWarn(warning, ok(`${head}\n${prompt}`)).stdout
      const answer = ctx.stdin !== undefined ? ctx.stdin.split('\n')[0].trim() : ctx.confirm ? await ctx.confirm(shown) : undefined
      head += `\n${prompt}${answer ?? ''}\n`
      if (answer !== 'yes') return { ...withWarn(warning, ok(`${head}\n${destroy ? 'Destroy' : 'Apply'} cancelled.`)), exitCode: 1 }
    }
  }
  const r: ApplyResult = executeApply(
    { ...input, state: ctx.lab.state, reality: ctx.lab.reality, workspace: ctx.lab.workspace, remoteStates: ctx.lab.remoteStates, refresh: f.refresh, ...(input.targets.length ? { targets: input.targets } : {}) },
    { faults: ctx.lab.faults, taken: ctx.taken, attempts: ctx.lab.attempts, seed: `${ctx.lab.state.lineage}:${ctx.lab.state.serial}` },
  )
  // Outside the lab directory ctx.lab is a throwaway copy, so this commit is discarded.
  ctx.lab.state = r.state
  ctx.lab.reality = r.reality
  ctx.lab.hasState = true
  // A step applied with -lock=false while someone else held the lock is marked, for done_when.
  const bypassed = !f.lock && ctx.lab.lock ? LOCK_BYPASSED : ''
  for (const st of r.steps) if (st.ok) ctx.lab.history.push(`${st.op} ${st.address}${bypassed}`)
  const progress = renderProgress(r)
  // The apply's own warning comes just before the summary (backend/local/backend_apply.go).
  const stdout = [head, progress, input.targets.length ? `\n${TARGETED_APPLY_WARNING}` : '', renderApplyEnd(r, mode)].filter(Boolean).join('\n')
  return { ...withWarn(warning, ok(stdout.replace(/^\n/, ''))), stderr: renderApplyErrors(r, sourcesOf(treeFiles(input.tree))), exitCode: r.errors.length ? 1 : 0 }
}

const sensitiveAttr = (type: string, attr: string) => {
  const attrs = schemaFor(type)?.attrs
  return attrs !== undefined && Object.hasOwn(attrs, attr) && attrs[attr].sensitive === true
}

// Flags for the state-changing commands. -lock=false skips the lock check; -lock-timeout
// and the state-path flags are accepted and have no effect: the lab has one local state.
const IGNORED_VALUE_FLAGS = ['-lock-timeout', '-state', '-state-out', '-backup']
const IGNORED_BOOL_FLAGS = ['-no-color', '-input', '-lock']
type Parsed = { pos: string[]; set: Set<string>; sources: VarSource[]; lock: boolean }
function parseArgs(args: string[], bools: string[], values: string[] = []): Parsed | Out {
  const p: Parsed = { pos: [], set: new Set(), sources: [], lock: true }
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    if (!raw.startsWith('-') || raw === '-') {
      p.pos.push(raw)
      continue
    }
    const eq = raw.indexOf('=')
    const name = (eq < 0 ? raw : raw.slice(0, eq)).replace(/^--/, '-')
    let value = eq < 0 ? undefined : raw.slice(eq + 1)
    if (values.includes(name) || IGNORED_VALUE_FLAGS.includes(name)) {
      if (value === undefined) {
        value = args[++i]
        if (value === undefined) return boxFail('Failed to parse command-line flags', `flag needs an argument: ${name}`)
      }
      if (name === '-var') p.sources.push({ kind: 'var', arg: value })
      else if (name === '-var-file') p.sources.push({ kind: 'file', path: value })
    } else if (bools.includes(name) || IGNORED_BOOL_FLAGS.includes(name)) {
      if (name === '-lock') p.lock = value !== 'false'
      if (value !== 'false') p.set.add(name)
    } else return boxFail('Failed to parse command-line flags', `flag provided but not defined: ${name}`)
  }
  return p
}
const opFail = (r: { summary: string; detail: string }) => (r.detail ? boxFail(r.summary, r.detail) : fail(r.summary))
// A successful change becomes the lab's state; outside the lab directory ctx.lab is a throwaway copy.
const commit = (ctx: CliContext, r: OpResult) => {
  if (!r.ok) return
  ctx.lab.state = r.state
  ctx.lab.hasState = true
}

function cmdStateMv(args: string[], ctx: CliContext): Out {
  const a = parseArgs(args, ['-dry-run'])
  if (!('pos' in a)) return a
  if (a.pos.length !== 2) return fail('Exactly two arguments expected.')
  // An unparseable address is an argument error, reported before locking.
  const locked = a.pos.every((x) => parseTarget(x).ok) && checkLock(ctx, a.lock)
  if (locked) return locked
  if (!ctx.lab.hasState) return fail(NO_STATE)
  const r = stateMove(ctx.lab.state, a.pos[0], a.pos[1])
  if (!r.ok) return opFail(r)
  const dry = a.set.has('-dry-run')
  const lines = r.moved.map((m) => `${dry ? 'Would move' : 'Move'} "${m.from}" to "${m.to}"`)
  if (dry) return ok(lines.join('\n'))
  commit(ctx, r)
  return ok([...lines, `Successfully moved ${r.moved.length} object(s).`].join('\n'))
}

function cmdStateRm(args: string[], ctx: CliContext): Out {
  const a = parseArgs(args, ['-dry-run'])
  if (!('pos' in a)) return a
  if (!a.pos.length) return fail('At least one address is required.')
  const bad = a.pos.find((x) => !parseTarget(x).ok)
  if (bad !== undefined) return boxFail(INVALID_ADDRESS, invalidAddressDetail(bad))
  const locked = checkLock(ctx, a.lock)
  if (locked) return locked
  if (!ctx.lab.hasState) return fail(NO_STATE)
  const r = stateRemove(ctx.lab.state, a.pos)
  if (!r.ok) return opFail(r)
  const dry = a.set.has('-dry-run')
  const lines = r.removed.map((x) => `${dry ? 'Would remove' : 'Removed'} ${x}`)
  if (dry) return ok(lines.join('\n'))
  commit(ctx, r)
  return ok([...lines, `Successfully removed ${r.removed.length} resource instance(s).`].join('\n'))
}

function cmdTaint(args: string[], ctx: CliContext, verb: 'taint' | 'untaint'): Out {
  const a = parseArgs(args, ['-allow-missing'])
  if (!('pos' in a)) return a
  if (a.pos.length !== 1) return fail('Exactly one argument expected.')
  const addr = a.pos[0]
  const allowMissing = a.set.has('-allow-missing')
  const t = parseAddress(addr)
  if (!t.ok) return boxFail(INVALID_ADDRESS, invalidAddressDetail(addr))
  const locked = t.mode === 'managed' && checkLock(ctx, a.lock)
  if (locked) return locked
  if (!ctx.lab.hasState) return allowMissing ? ok('') : boxFail(NO_STATE_SUMMARY, NO_STATE_DETAIL)
  const r = verb === 'taint' ? taintInstance(ctx.lab.state, addr) : untaintInstance(ctx.lab.state, addr)
  if (!r.ok) return allowMissing && r.summary === NO_SUCH_INSTANCE ? ok('') : opFail(r)
  commit(ctx, r)
  return ok(verb === 'taint' ? `Resource instance ${addr} has been marked as tainted.` : `Resource instance ${addr} has been successfully untainted.`)
}

async function cmdImport(args: string[], ctx: CliContext, cfg: Config): Promise<Out> {
  const a = parseArgs(args, [], ['-var', '-var-file'])
  if (!('pos' in a)) return a
  if (a.pos.length !== 2) return fail('Exactly two arguments expected.')
  const [addr, id] = a.pos
  const s = await prepare(a.sources, ctx, cfg)
  if (!('vars' in s)) return s
  if (s.graph.diagnostics.length) return withWarn(s.warning, fail(boxes(s.graph.diagnostics, allFiles(cfg))))
  const t = parseAddress(addr)
  // The block must exist in the module's configuration; module instances and resource keys are checked against what the
  // configuration expands to (count and for_each). If that can't be evaluated, the address is accepted.
  const ra = parseResAddr(addr)
  const declared = t.ok && !!ra && s.graph.nodes.has(staticKey(ra))
  if (declared && t.mode === 'managed' && (t.key !== undefined || ra.module.length > 0)) {
    const target = instanceAddress(t, t.key)
    const p = planConfig({ tree: cfg.modules.tree, state: ctx.lab.state, reality: ctx.lab.reality, vars: s.vars, workspace: ctx.lab.workspace, remoteStates: ctx.lab.remoteStates, refresh: false })
    const moduleOk = !ra.module.length || (p.instances ?? []).includes(formatModule(ra.module))
    const keyOk = t.key === undefined || p.items.some((i) => i.address === target && i.action !== 'destroy' && i.action !== 'forget')
    if (!p.diagnostics.length && !(moduleOk && keyOk)) return withWarn(s.warning, boxFail(NO_IMPORT_CONFIG, noImportConfigDetail(target)))
  }
  const locked = declared && t.mode === 'managed' && checkLock(ctx, a.lock)
  if (locked) return locked
  const r = importObject(ctx.lab.state, ctx.lab.reality, addr, id, declared)
  if (!r.ok) return withWarn(s.warning, opFail(r))
  commit(ctx, r)
  const type = t.ok ? t.type : ''
  return withWarn(
    s.warning,
    ok(
      `${addr}: Importing from ID "${id}"...\n${addr}: Import prepared!\n  Prepared ${type} for import\n${addr}: Refreshing state... [id=${id}]\n\nImport successful!\n\nThe resources that were imported are shown above. These resources are now in\nyour Terraform state and will henceforth be managed by Terraform.`,
    ),
  )
}

async function cmdRefresh(args: string[], ctx: CliContext, cfg: Config): Promise<Out> {
  const a = parseArgs(args, [], ['-var', '-var-file'])
  if (!('pos' in a)) return a
  if (a.pos.length) return boxFail('Too many command line arguments', 'Expected no positional arguments. Did you mean to use -chdir?')
  const p = await prepare(a.sources, ctx, cfg)
  if (!('vars' in p)) return p
  if (p.graph.diagnostics.length) return withWarn(p.warning, fail(boxes(p.graph.diagnostics, allFiles(cfg))))
  const locked = checkLock(ctx, a.lock)
  if (locked) return locked
  // Refresh-only: no resource changes are planned and no moved blocks apply, so plan errors don't stop it.
  const before = ctx.lab.state
  const lines = refreshLines(before, true)
  const refreshed = refreshState(before, ctx.lab.reality).state
  const content = (x: State) => JSON.stringify({ ...x, serial: 0 })
  // Like an apply with nothing to do: the refreshed state is saved, with a new serial only if it differs.
  if (content(refreshed) !== content(before)) commit(ctx, { ok: true, state: { ...refreshed, serial: before.serial + 1 } })
  const outputs = ctx.lab.state.outputs
  const tail = Object.keys(outputs).length ? `Outputs:\n\n${outputsText(outputs, undefined, 'hcl').stdout}` : ''
  return withWarn(p.warning, ok([lines.join('\n'), tail].filter(Boolean).join('\n\n')))
}

function cmdState(args: string[], ctx: CliContext): Out {
  const [sub, ...rest] = args
  const { lab } = ctx
  if (sub === 'list') {
    if (!lab.hasState) return fail(NO_STATE)
    const wanted = rest.filter((a) => !a.startsWith('-'))
    const all = listAddresses(lab.state)
    const matches = (a: string, w: string) => a === w || a.startsWith(`${w}.`) || a.startsWith(`${w}[`)
    for (const w of wanted) {
      if (!w.startsWith('module.') && !parseResAddr(w)) return boxFail('Invalid address', 'Resource specification must include a resource type and name.')
      if (!all.some((a) => matches(a, w))) {
        if (w.endsWith(']')) return boxFail('Unknown resource instance', `The current state contains no resource instance ${w}. If you've just added its resource to the configuration or have changed the count or for_each arguments, you must run "terraform apply" first to update the resource's entry in the state.`)
        return boxFail('Unknown resource', `The current state contains no resource ${w}. If you've just added this resource to the configuration, you must run "terraform apply" first to create the resource's entry in the state.`)
      }
    }
    const deposed = (a: string) => (findInstance(lab.state, a)?.instance.deposed ?? []).map((d) => `${a} (deposed object ${d.key})`)
    return ok((wanted.length ? all.filter((a) => wanted.some((w) => matches(a, w))) : all).flatMap((a) => [a, ...deposed(a)]).join('\n'))
  }
  if (sub === 'show') {
    if (!lab.hasState) return fail(NO_STATE)
    const addrs = rest.filter((a) => !a.startsWith('-'))
    if (addrs.length !== 1) return fail('Exactly one argument expected.')
    if (!parseResAddr(addrs[0])) return fail(`Error parsing instance address: ${addrs[0]}\n\n${ONE_INSTANCE}`)
    const found = findInstance(lab.state, addrs[0])
    if (!found) return fail(`No instance found for the given address!\n\n${ONE_INSTANCE}`)
    return ok(stateShow(found.resource, found.instance, (a) => sensitiveAttr(found.resource.type, a)))
  }
  if (sub === 'pull') return lab.hasState ? ok(stateJson(lab.state)) : fail(NO_STATE)
  if (sub === 'mv') return cmdStateMv(rest, ctx)
  if (sub === 'rm') return cmdStateRm(rest, ctx)
  if (sub === 'replace-provider' || sub === 'push') return notYet(`state ${sub}`)
  return fail('Usage: terraform [global options] state <subcommand> [options] [args]\n\nSubcommands: list, show, pull, mv, rm (replace-provider and push are not simulated yet).')
}

function cmdOutput(args: string[], ctx: CliContext): Out {
  const mode = args.includes('-json') || args.includes('--json') ? 'json' : args.includes('-raw') || args.includes('--raw') ? 'raw' : 'hcl'
  const r = outputsText(ctx.lab.state.outputs, args.find((a) => !a.startsWith('-')), mode)
  return mode === 'raw' && r.exitCode === 0 ? { ...r, raw: true } : r
}

const WORKSPACE_NAME = /^[A-Za-z0-9._-]+$/
const NEW_WORKSPACE = (name: string) =>
  `Created and switched to workspace "${name}"!\n\nYou're now on a new, empty workspace. Workspaces isolate their state,\nso if you run "terraform plan" Terraform will not see any existing state\nfor this configuration.`

// Store the current workspace's state under its name and load the target's. The cloud is shared: reality stays.
function switchWorkspace(lab: Lab, name: string, target: { state: State; hasState: boolean }) {
  if (name === lab.workspace) return
  lab.workspaces.set(lab.workspace, { state: lab.state, hasState: lab.hasState })
  lab.workspaces.delete(name)
  lab.workspace = name
  lab.state = target.state
  lab.hasState = target.hasState
}

function newWorkspace(lab: Lab, name: string): Out {
  const n = 10 + lab.workspacesCreated++
  switchWorkspace(lab, name, { state: emptyState(lab.version, `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`), hasState: false })
  return ok(NEW_WORKSPACE(name))
}

// Outside the lab directory ctx.lab is a throwaway copy with only the default workspace.
function cmdWorkspace(args: string[], ctx: CliContext): Out {
  const [sub, ...rest] = args
  const { lab } = ctx
  if (sub === 'show') return ok(lab.workspace)
  if (sub === 'list') return ok([...lab.workspaces.keys(), lab.workspace].sort().map((n) => `${n === lab.workspace ? '*' : ' '} ${n}\n`).join(''))
  if (sub !== 'new' && sub !== 'select' && sub !== 'delete') return fail('Usage: terraform [global options] workspace <subcommand> [options] [args]\n\nSubcommands: delete, list, new, select, show.')
  const a = parseArgs(rest, sub === 'select' ? ['-or-create'] : sub === 'delete' ? ['-force'] : [])
  if (!('pos' in a)) return a
  if (a.pos.length !== 1) return fail('Expected a single argument: NAME.')
  const name = a.pos[0]
  if (!WORKSPACE_NAME.test(name)) return boxFail('Invalid workspace name', `The workspace name "${name}" is not allowed. The name must contain only URL safe characters, and no path separators.`)
  const exists = name === lab.workspace || lab.workspaces.has(name)
  if (sub === 'new') {
    if (exists) return fail(`Workspace "${name}" already exists`)
    return checkLock(ctx, a.lock) || newWorkspace(lab, name)
  }
  if (sub === 'select') {
    if (exists) {
      switchWorkspace(lab, name, lab.workspaces.get(name) ?? { state: lab.state, hasState: lab.hasState })
      return ok(`Switched to workspace "${name}".`)
    }
    if (a.set.has('-or-create')) return newWorkspace(lab, name)
    return fail(`Workspace "${name}" doesn't exist.\n\nYou can create this workspace with the "new" subcommand \nor include the "-or-create" flag with the "select" subcommand.`)
  }
  if (!exists) return fail(`Workspace "${name}" doesn't exist.`)
  if (name === lab.workspace) return boxFail('Workspace is your active workspace', 'You cannot delete the currently active workspace. Please switch to another workspace and try again.')
  if (name === 'default') return boxFail('Failed to delete workspace', "Can't delete default workspace")
  const locked = checkLock(ctx, a.lock)
  if (locked) return locked
  const target = lab.workspaces.get(name)!
  const tracked = target.hasState ? listAddresses(target.state) : []
  if (tracked.length && !a.set.has('-force'))
    return fail(
      box(
        'error',
        'Workspace is not empty',
      `Workspace "${name}" is currently tracking the following resource instances:\n${tracked.map((t) => `  - ${t}`).join('\n')}\n\nDeleting this workspace would cause Terraform to lose track of any associated remote objects, which would then require you to delete them manually outside of Terraform. You should destroy these objects with Terraform before deleting the workspace.\n\nIf you want to delete this workspace anyway, and have destroyed these objects, use the -force option.`,
        true,
      ),
    )
  lab.workspaces.delete(name)
  return ok(`Deleted workspace "${name}"!`)
}

const UNLOCK_PROMPT =
  "Do you really want to force-unlock?\n  Terraform will remove the lock on the remote state.\n  This will allow local Terraform commands to modify this state, even though it\n  may still be in use. Only 'yes' will be accepted to confirm.\n\n  Enter a value: "
const UNLOCKED =
  'Terraform state has been successfully unlocked!\n\nThe state has been unlocked, and Terraform commands should now be able to\nobtain a new lock on the remote state.'

// Outside the lab directory ctx.lab is a throwaway copy with no lock.
async function cmdForceUnlock(args: string[], ctx: CliContext): Promise<Out> {
  let force = false
  const pos: string[] = []
  for (const raw of args) {
    if (!raw.startsWith('-') || raw === '-') pos.push(raw)
    else if (/^--?force(=(true|false))?$/.test(raw)) force = !raw.endsWith('=false')
    else return boxFail('Failed to parse command-line flags', `flag provided but not defined: ${raw.replace(/^--/, '-').split('=')[0]}`)
  }
  if (pos.length !== 1) return fail('Expected a single argument: LOCK_ID')
  // Terraform asks first and only finds out whether the lock exists when it tries to remove it.
  let head = ''
  if (!force) {
    const answer = ctx.stdin !== undefined ? ctx.stdin.split('\n')[0].trim() : ctx.confirm ? await ctx.confirm(UNLOCK_PROMPT) : undefined
    head = `${UNLOCK_PROMPT}${answer ?? ''}\n\n`
    if (answer !== 'yes') return { ...ok(`${head}force-unlock cancelled.`), exitCode: 1 }
  }
  // The S3 backend's DynamoDB lock errors (Terraform 1.9), printed plainly, not as a diagnostic box.
  const held = ctx.lab.lock
  const error = !held
    ? `failed to retrieve lock info for lock ID "${pos[0]}": unexpected end of JSON input`
    : held.id !== pos[0]
      ? `lock ID "${pos[0]}" does not match existing lock ("${held.id}")\n${lockInfo(ctx).join('\n')}`
      : undefined
  if (error) return { stdout: head, stderr: `Failed to unlock state: ${error}`, exitCode: 1 }
  delete ctx.lab.lock
  return ok(`${head}${UNLOCKED}`)
}

async function dispatch(args: string[], ctx: CliContext): Promise<Out> {
  let dir = ctx.cwd
  let rest = args
  if (rest[0]?.startsWith('-chdir=')) {
    dir = resolvePath(ctx.cwd, rest[0].slice(7))
    rest = rest.slice(1)
  }
  const sub = rest[0]
  if (sub === undefined || sub === '-help' || sub === '--help' || sub === 'help') return ok(USAGE)
  const more = rest.slice(1)
  if (Object.hasOwn(HELP, sub) && more.some((a) => a === '-help' || a === '--help')) return ok(`Usage: terraform [global options] ${sub} [options]\n\n${HELP[sub]}`)
  // State lives per directory, on the host the scenario is about: anywhere else there is none.
  const here = ctx.mainHost && dir === resolvePath('/', ctx.lab.dir)
  if (!here) ctx = { ...ctx, lab: { ...ctx.lab, providerCache: undefined, hasState: false, state: emptyState(ctx.lab.version), reality: {}, vars: {}, faults: [], attempts: new Map(), savedPlans: new Map(), history: [], lock: undefined, workspace: 'default', workspaces: new Map() } }
  const cfg = await loadConfig(ctx, dir)
  // Every command that opens the backend first checks the provider cache against the lock file.
  if (['state', 'output', 'show', 'taint', 'untaint', 'force-unlock'].includes(sub) || (sub === 'workspace' && more[0] !== 'show')) {
    const plugins = pluginsError(cfg, ctx)
    if (plugins) return plugins
  }
  switch (sub) {
    case 'version':
    case '-version':
    case '--version':
    case '-v':
      return cmdVersion(ctx, cfg)
    case 'init':
      return cmdInit(more, ctx, cfg)
    case 'get':
      return cmdGet(more, ctx, cfg)
    case 'validate':
      return cmdValidate(cfg, ctx)
    case 'plan':
      return cmdPlan(more, ctx, cfg, here)
    case 'apply':
    case 'destroy':
      return cmdApply(more, ctx, cfg, sub)
    case 'show':
      return more.some((a) => !a.startsWith('-')) ? notYet('show <plan file>') : ok(ctx.lab.hasState ? showState(ctx.lab.state, sensitiveAttr) : 'No state.')
    case 'state':
      return cmdState(more, ctx)
    case 'output':
      return cmdOutput(more, ctx)
    case 'providers':
      return cmdProviders(more, ctx, cfg)
    case 'workspace':
      return cmdWorkspace(more, ctx)
    case 'import':
      return cmdImport(more, ctx, cfg)
    case 'taint':
    case 'untaint':
      return cmdTaint(more, ctx, sub)
    case 'refresh':
      return cmdRefresh(more, ctx, cfg)
    case 'force-unlock':
      return cmdForceUnlock(more, ctx)
    default:
      return NOT_YET.has(sub) ? notYet(sub) : fail(`Terraform has no command named "${sub}".\n\nTo see all of Terraform's top-level commands, run:\n  terraform -help`)
  }
}

export async function runTerraform(args: string[], ctx: CliContext): Promise<CliResult> {
  // The cloud the player has changed by their own actions: applied here once, before any command (idempotent).
  for (const r of ctx.lab.releases) if (r.when_actions.every((a) => ctx.taken.has(a))) delete ctx.lab.reality[realityKey(r.type, r.id)]
  let out: Out
  try {
    out = await dispatch(args, ctx)
  } catch {
    out = boxFail('Terraform could not complete the command', 'The simulator hit an unexpected problem reading the working directory or state. Check the files and try again.')
  }
  const first = args[0]?.startsWith('-chdir=') ? args.slice(1) : args
  const second = first[1]
  const command = (first[0] === 'state' || first[0] === 'workspace') && second !== undefined && !second.startsWith('-') ? `${first[0]} ${second}` : (first[0] ?? '')
  const text = out.stdout + out.stderr
  // Only a run in the lab directory on the main host can verify a fix or match evidence.
  const here = ctx.mainHost && (args[0]?.startsWith('-chdir=') ? resolvePath(ctx.cwd, args[0].slice(7)) : ctx.cwd) === resolvePath('/', ctx.lab.dir)
  const evidence = here ? ctx.lab.evidence.filter((e) => e.command === command && text.includes(e.contains)).map((e) => `evidence:${e.evidence}`) : []
  const helped = first.some((a) => a === '-help' || a === '--help')
  const verifies = ['init', 'validate', 'plan', 'apply', 'destroy', 'show', 'output', 'state list', 'state show']
  const ran = here && !helped && verifies.includes(command) ? `terraform ${command}` : ''
  return { ...out, evidence, ran }
}
