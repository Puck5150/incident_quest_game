// The `terraform` command: init, validate, plan, apply, destroy, show, state
// (list, show, pull, mv, rm), output, import, taint, untaint, refresh, workspace,
// force-unlock and version read the player's working directory and the lab's
// state; everything else answers honestly that it is not simulated yet. Nothing here throws on
// player input: a failure is a boxed diagnostic or a plain message with exit 1.
import { executeApply, type ApplyResult } from './apply.ts'
import { evalExpr, EvalError, type Value } from './eval.ts'
import { formatDiagnostic } from './diag.ts'
import { buildGraph } from './graph.ts'
import type { Lab, SavedPlan } from './lab.ts'
import { parseHcl } from './parse.ts'
import { planConfig, type PlanResult } from './plan.ts'
import { hex } from './provider.ts'
import { refresh as refreshState } from './refresh.ts'
import { renderPlan } from './render.ts'
import { renderApplyEnd, renderApplyErrors, renderProgress } from './render-apply.ts'
import { schemaFor } from './resources.ts'
import { importObject, NO_SUCH_INSTANCE, parseAddress, stateMove, stateRemove, taintInstance, untaintInstance, type OpResult } from './state-ops.ts'
import { emptyState, findInstance, instanceAddress, listAddresses, stateJson } from './state.ts'
import type { State } from './state.ts'
import type { Block, Diagnostic } from './types.ts'
import { outputsText, showState, stateShow } from './views.ts'
import { lockBlock, lockFile, PROVIDER_VERSION } from './layout.ts'

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

const NOT_YET = new Set(['console', 'fmt', 'get', 'graph', 'login', 'logout', 'metadata', 'providers', 'test'])
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
const ADDRESS = /^(data\.)?[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*(\[(\d+|"[^"]*")\])?$/
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
    `"terraform ${sub}" is not simulated yet in this lab. You can still use: init, validate, plan, apply, destroy, show, state list, state show, state pull, state mv, state rm, import, taint, untaint, refresh, force-unlock, output, workspace show, workspace list, version.`,
  )
const sourcesOf = (files: File[]) => Object.fromEntries(files.map((f) => [f.name, f.text]))
const boxes = (list: Diagnostic[], files: File[]) => {
  const src = sourcesOf(files)
  return list.map((d) => formatDiagnostic(d, Object.hasOwn(src, d.file) ? src[d.file] : '')).join('\n\n')
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

async function loadConfig(ctx: CliContext, dir: string): Promise<Config> {
  const all = await ctx.listFiles(dir)
  return {
    dir,
    tf: all.filter((f) => f.name.endsWith('.tf')).sort(byName),
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
      out.add(schemaFor(type)?.provider ?? `${REGISTRY}hashicorp/${type.split('_')[0]}`)
    }
  }
  return [...out].sort()
}
const shortName = (source: string) => (source.startsWith(REGISTRY) ? source.slice(REGISTRY.length) : source)
const lockedProviders = (cfg: Config) => [...cfg.lockText.matchAll(/^provider\s+"([^"]+)"/gm)].map((m) => m[1])

// Resources need provider selections in the lock file; without one `init` has not run.
function lockError(cfg: Config): Out | undefined {
  const locked = lockedProviders(cfg)
  const providers = providersOf(cfg.tf).filter((p) => !locked.includes(p))
  if (!providers.length) return undefined
  const list = providers.map((p) => `  - provider ${p}: required by this configuration but no version is selected`).join('\n')
  return fail(
    box(
      'error',
      'Inconsistent dependency lock file',
      `The following dependency selections recorded in the lock file are inconsistent with the current configuration:\n${list}\n\nTo make the initial dependency selections that will initialize the dependency lock file, run:\n  terraform init`,
      true,
    ),
  )
}

// The commands that write state take the lock first; a held lock stops them unless -lock=false.
function checkLock(ctx: CliContext, lock: boolean): Out | undefined {
  const l = ctx.lab.lock
  if (!lock || !l) return undefined
  const info = [['ID', l.id], ['Path', l.path], ['Operation', l.operation], ['Who', l.who], ['Version', ctx.lab.version], ['Created', l.created], ['Info', l.info]].map(([k, v]) => `  ${`${k}:`.padEnd(11)}${v}`)
  const tail =
    'Terraform acquires a state lock to protect the state from being written\nby multiple users at the same time. Please resolve the issue above and try\nagain. For most commands, you can disable locking with the "-lock=false"\nflag, but this is not recommended.'
  return fail(box('error', 'Error acquiring the state lock', `Error message: ${l.message}\nLock Info:\n${info.join('\n')}\n\n\n${tail}`, true))
}

function cmdVersion(ctx: CliContext, cfg: Config): Out {
  const lines = [`Terraform v${ctx.lab.version}`, 'on linux_amd64']
  for (const p of lockedProviders(cfg).sort()) lines.push(`+ provider ${p} v${PROVIDER_VERSION}`)
  return ok(lines.join('\n'))
}

async function cmdInit(ctx: CliContext, cfg: Config): Promise<Out> {
  if (!cfg.tf.length) return ok(EMPTY_INIT)
  // Only syntax stops init; undeclared references and cycles are for validate and plan.
  const syntax = cfg.tf.flatMap((f) => parseHcl(f.name, f.text).diagnostics)
  if (syntax.length) return fail(boxes(syntax, cfg.tf))
  const providers = providersOf(cfg.tf)
  const locked = lockedProviders(cfg)
  const missing = providers.filter((p) => !locked.includes(p))
  const lines = ['', 'Initializing the backend...', '', 'Initializing provider plugins...']
  for (const p of providers) {
    const n = shortName(p)
    lines.push(...(locked.includes(p) ? [`- Reusing previous version of ${n} from the dependency lock file`, `- Using previously-installed ${n} v${PROVIDER_VERSION}`] : [`- Finding latest version of ${n}...`, `- Installing ${n} v${PROVIDER_VERSION}...`, `- Installed ${n} v${PROVIDER_VERSION} (signed by HashiCorp)`]))
  }
  if (missing.length && !cfg.hasLock) {
    lines.push(
      '',
      'Terraform has created a lock file .terraform.lock.hcl to record the provider',
      'selections it made above. Include this file in your version control repository',
      'so that Terraform can guarantee to make the same selections by default when',
      'you run "terraform init" in the future.',
    )
    await ctx.write(cfg.dir, '.terraform.lock.hcl', lockFile(missing))
  } else if (missing.length) {
    lines.push(
      '',
      'Terraform has made some changes to the provider dependency selections recorded',
      'in the .terraform.lock.hcl file. Review those changes and commit them to your',
      'version control system if they represent changes you intended to make.',
    )
    await ctx.write(cfg.dir, '.terraform.lock.hcl', `${cfg.lockText.replace(/\n*$/, '\n')}\n${missing.map(lockBlock).join('\n')}`)
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

function cmdValidate(cfg: Config): Out {
  if (!cfg.tf.length) return ok('Success! The configuration is valid.\n')
  const g = buildGraph(cfg.tf)
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
  if (diags.length) return fail(boxes(diags, cfg.tf))
  return lockError(cfg) ?? ok('Success! The configuration is valid.\n')
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
  const warnings = warns.join('\n\n')
  return errors.length ? { warnings, error: errors.join('\n\n') } : { warnings, vars: Object.fromEntries(final) }
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
}
const PLAN_VALUE_FLAGS = new Set(['-var', '-var-file', '-replace', '-out', '-lock-timeout', '-parallelism', '-target'])
const PLAN_BOOL_FLAGS = new Set(['-no-color', '-input', '-lock', '-compact-warnings', '-refresh', '-detailed-exitcode', '-destroy', '-refresh-only', '-auto-approve'])
// Flags each command does not take, as Terraform's own flag parser rejects them.
const NOT_FOR: Record<Cmd, string[]> = { plan: ['-auto-approve'], apply: ['-out', '-detailed-exitcode'], destroy: ['-out', '-detailed-exitcode', '-replace'] }

function parsePlanFlags(args: string[], cmd: Cmd = 'plan'): PlanFlags | Out {
  const f: PlanFlags = { sources: [], replace: [], refresh: true, detailed: false, autoApprove: false, lock: true }
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
      else if (name === '-target') return notYet(`${cmd} -target`)
    } else if (PLAN_BOOL_FLAGS.has(name)) {
      if (name === '-refresh') f.refresh = value !== 'false'
      else if (name === '-lock') f.lock = value !== 'false'
      else if (name === '-detailed-exitcode') f.detailed = true
      else if (name === '-auto-approve') f.autoApprove = value !== 'false'
      else if (name === '-destroy' || name === '-refresh-only') return notYet(`${cmd} ${name}`)
    } else return boxFail('Failed to parse command-line flags', `flag provided but not defined: ${name}`)
  }
  const bad = f.replace.find((a) => !ADDRESS.test(a) || a.startsWith('data.'))
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
  const g = buildGraph(cfg.tf)
  if (!g.diagnostics.length) {
    const lock = lockError(cfg)
    if (lock) return lock
  }
  const v = await resolveVars(ctx, cfg, sources, g.diagnostics.length ? undefined : g.blocks.filter((b) => b.type === 'variable'))
  if ('error' in v) return { stdout: v.warnings, stderr: v.error, exitCode: 1 }
  return { warning: v.warnings, vars: v.vars, graph: g }
}

// The lines a plan prints while it reads the state's objects back from the cloud.
const refreshLines = (state: State, refresh: boolean) =>
  state.resources
    .flatMap((r) =>
      r.instances.map((i) => {
        const addr = instanceAddress(r, i.index_key)
        const id = typeof i.attributes.id === 'string' ? ` [id=${i.attributes.id}]` : ''
        return { addr, lines: r.mode === 'data' ? [`${addr}: Reading...`, `${addr}: Read complete after 0s${id}`] : refresh ? [`${addr}: Refreshing state...${id}`] : [] }
      }),
    )
    .sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
    .flatMap((x) => x.lines)

// What plan, apply, destroy and refresh share: setup checks, variables, the plan and its refresh lines.
async function makePlan(f: PlanFlags, ctx: CliContext, cfg: Config, destroy: boolean): Promise<Planned | Out> {
  const s = await prepare(f.sources, ctx, cfg)
  if (!('vars' in s)) return s
  // Graph diagnostics are configuration errors: they come before the lock, and the plan below reports them.
  const locked = !s.graph.diagnostics.length && checkLock(ctx, f.lock)
  if (locked) return locked
  const warning = s.warning
  const result = planConfig({ files: cfg.tf, state: ctx.lab.state, reality: ctx.lab.reality, vars: s.vars, replace: f.replace, refresh: f.refresh, destroy })
  const rendered = renderPlan(result, sourcesOf(cfg.tf))
  if (result.diagnostics.length) return { stdout: warning, stderr: rendered, exitCode: 1 }

  const lines = refreshLines(ctx.lab.state, f.refresh)
  const stdout = lines.length ? `${lines.join('\n')}\n\n${rendered}` : rendered
  return { warning, vars: s.vars, result, stdout, changes: !/(^|\n)No changes\. Your infrastructure matches/.test(rendered) }
}

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
    ctx.lab.savedPlans.set(id, { files: cfg.tf, vars: p.vars, replace: f.replace, destroy: false, serial, lineage })
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
  let input: { files: File[]; vars: Record<string, Value>; replace: string[]; destroy: boolean }
  let head: string
  let warning = ''
  if (f.planFile !== undefined) {
    if (f.replace.length) return boxFail("Can't set -replace when applying a saved plan", 'The -replace option cannot be used when applying a saved plan file, because a saved plan already records which objects it replaces. Create a new plan with -replace instead.')
    if (f.sources.length) return boxFail("Can't set variables when applying a saved plan", 'The -var and -var-file options cannot be used when applying a saved plan file, because a saved plan includes the variable values that were set when it was created.')
    const saved = await loadSavedPlan(ctx, cfg, f.planFile)
    if (!('serial' in saved)) return saved
    const locked = checkLock(ctx, f.lock)
    if (locked) return locked
    if (saved.serial !== ctx.lab.state.serial || saved.lineage !== ctx.lab.state.lineage)
      return boxFail('Saved plan is stale', 'The given plan file can no longer be applied because the state was changed by another operation after the plan was created.')
    input = { files: saved.files, vars: saved.vars, replace: saved.replace, destroy: saved.destroy }
    head = '' // a saved plan was already reviewed: no plan text, no question
  } else {
    const p = await makePlan(f, ctx, cfg, destroy)
    if (!('result' in p)) return p
    warning = p.warning
    input = { files: cfg.tf, vars: p.vars, replace: f.replace, destroy }
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
    { ...input, state: ctx.lab.state, reality: ctx.lab.reality, refresh: f.refresh },
    { faults: ctx.lab.faults, taken: ctx.taken, attempts: ctx.lab.attempts, seed: String(ctx.lab.state.serial) },
  )
  // Outside the lab directory ctx.lab is a throwaway copy, so this commit is discarded.
  ctx.lab.state = r.state
  ctx.lab.reality = r.reality
  ctx.lab.hasState = true
  const progress = renderProgress(r)
  const stdout = [head, progress, renderApplyEnd(r, mode)].filter(Boolean).join('\n')
  return { ...withWarn(warning, ok(stdout.replace(/^\n/, ''))), stderr: renderApplyErrors(r, sourcesOf(input.files)), exitCode: r.errors.length ? 1 : 0 }
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
  const locked = a.pos.every((x) => parseAddress(x).ok) && checkLock(ctx, a.lock)
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
  const locked = t.ok && t.mode === 'managed' && checkLock(ctx, a.lock)
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
  if (s.graph.diagnostics.length) return withWarn(s.warning, fail(boxes(s.graph.diagnostics, cfg.tf)))
  const t = parseAddress(addr)
  // A keyed address needs only its resource block; count and for_each are not checked.
  const declared = t.ok && s.graph.blocks.some((b) => b.type === 'resource' && b.labels[0] === t.type && b.labels[1] === t.name)
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
  if (p.graph.diagnostics.length) return withWarn(p.warning, fail(boxes(p.graph.diagnostics, cfg.tf)))
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
      if (!w.startsWith('module.') && !ADDRESS.test(w)) return boxFail('Invalid address', 'Resource specification must include a resource type and name.')
      if (!all.some((a) => matches(a, w))) {
        if (w.endsWith(']')) return boxFail('Unknown resource instance', `The current state contains no resource instance ${w}. If you've just added its resource to the configuration or have changed the count or for_each arguments, you must run "terraform apply" first to update the resource's entry in the state.`)
        return boxFail('Unknown resource', `The current state contains no resource ${w}. If you've just added this resource to the configuration, you must run "terraform apply" first to create the resource's entry in the state.`)
      }
    }
    return ok((wanted.length ? all.filter((a) => wanted.some((w) => matches(a, w))) : all).join('\n'))
  }
  if (sub === 'show') {
    if (!lab.hasState) return fail(NO_STATE)
    const addrs = rest.filter((a) => !a.startsWith('-'))
    if (addrs.length !== 1) return fail('Exactly one argument expected.')
    if (!ADDRESS.test(addrs[0])) return fail(`Error parsing instance address: ${addrs[0]}\n\n${ONE_INSTANCE}`)
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

function cmdWorkspace(args: string[]): Out {
  const sub = args[0]
  if (sub === 'show') return ok('default')
  if (sub === 'list') return ok('* default\n')
  if (sub === 'new' || sub === 'select' || sub === 'delete') return notYet(`workspace ${sub}`)
  return fail('Usage: terraform [global options] workspace <subcommand> [options] [args]\n\nSubcommands: show, list (new, select and delete are not simulated yet).')
}

const UNLOCK_PROMPT =
  "Do you really want to force-unlock?\n  Terraform will remove the lock on the remote state.\n  This will allow local Terraform commands to modify this state, even though it\n  may be still be in use. Only 'yes' will be accepted to confirm.\n\n  Enter a value: "
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
  if (pos.length !== 1) return fail('Expected a single argument: LOCK_ID.')
  // Terraform asks first and only finds out whether the lock exists when it tries to remove it.
  let head = ''
  if (!force) {
    const answer = ctx.stdin !== undefined ? ctx.stdin.split('\n')[0].trim() : ctx.confirm ? await ctx.confirm(UNLOCK_PROMPT) : undefined
    head = `${UNLOCK_PROMPT}${answer ?? ''}\n\n`
    if (answer !== 'yes') return { ...ok(`${head}force-unlock cancelled.`), exitCode: 1 }
  }
  const held = ctx.lab.lock
  const error = !held
    ? 'no lock is held on this state'
    : held.id !== pos[0]
      ? `failed to unlock state: lock ID "${pos[0]}" does not match existing lock ID "${held.id}"`
      : undefined
  if (error) return { ...boxFail('Failed to unlock state', error), stdout: head }
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
  if (!here) ctx = { ...ctx, lab: { ...ctx.lab, hasState: false, state: emptyState(ctx.lab.version), reality: {}, vars: {}, faults: [], attempts: new Map(), savedPlans: new Map(), lock: undefined } }
  const cfg = await loadConfig(ctx, dir)
  switch (sub) {
    case 'version':
    case '-version':
    case '--version':
    case '-v':
      return cmdVersion(ctx, cfg)
    case 'init':
      return cmdInit(ctx, cfg)
    case 'validate':
      return cmdValidate(cfg)
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
    case 'workspace':
      return cmdWorkspace(more)
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
