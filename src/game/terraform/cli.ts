// The `terraform` command: init, validate, plan, show, state, output and
// workspace read the player's working directory and the lab's state; everything
// else answers honestly that it is not simulated yet. Nothing here throws on
// player input: a failure is a boxed diagnostic or a plain message with exit 1.
import { evalExpr, EvalError, type Value } from './eval.ts'
import { formatDiagnostic } from './diag.ts'
import { buildGraph } from './graph.ts'
import type { Lab } from './lab.ts'
import { parseHcl } from './parse.ts'
import { planConfig } from './plan.ts'
import { renderPlan } from './render.ts'
import { schemaFor } from './resources.ts'
import { findInstance, instanceAddress, listAddresses, stateJson } from './state.ts'
import type { Diagnostic } from './types.ts'
import { outputsText, showState, stateShow } from './views.ts'

export interface CliContext {
  lab: Lab
  cwd: string
  listFiles(dir: string): Promise<{ name: string; text: string }[]>
  readFile(path: string): Promise<string | undefined>
  write(dir: string, name: string, text: string): Promise<void>
  env: Record<string, string>
}
export interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
  evidence: string[]
}
type Out = Omit<CliResult, 'evidence'>
type File = { name: string; text: string }
interface Config {
  dir: string
  tf: File[]
  tfvars: File[]
  hasLock: boolean
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

const NOT_YET = new Set(['apply', 'destroy', 'import', 'taint', 'untaint', 'refresh', 'force-unlock', 'console', 'fmt', 'get', 'graph', 'login', 'logout', 'metadata', 'providers', 'test'])
const REGISTRY = 'registry.terraform.io/'
const PROVIDER_VERSION = '5.67.0'
const RULE = '─'.repeat(77)
const NO_STATE =
  'No state file was found!\n\nState management commands require a state file. Run this command in a directory where Terraform has been run or use the -state flag to point the command to a specific state location.'

const byName = (a: File, b: File) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
const ok = (stdout: string, stderr = ''): Out => ({ stdout, stderr, exitCode: 0 })
const fail = (stderr: string, exitCode = 1): Out => ({ stdout: '', stderr, exitCode })

function box(severity: 'error' | 'warning', summary: string, detail: string, preserveLines = false): string {
  return formatDiagnostic({ severity, summary, detail, file: '', line: 0, col: 0 }, '', { preserveLines })
}
const boxFail = (summary: string, detail: string) => fail(box('error', summary, detail))
const notYet = (sub: string) =>
  boxFail(
    'Not available in this lab yet',
    `"terraform ${sub}" is not simulated yet in this lab. You can still read the configuration, plan and state with: init, validate, plan, show, state list, state show, state pull, output, workspace show, workspace list, version.`,
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
  }
}

// Provider source addresses the configuration's resources and data sources need.
function providersOf(files: File[]): string[] {
  const out = new Set<string>()
  for (const n of buildGraph(files).nodes.values()) {
    if ((n.kind !== 'resource' && n.kind !== 'data') || !n.block) continue
    const type = n.block.labels[0]
    out.add(schemaFor(type)?.provider ?? `${REGISTRY}hashicorp/${type.split('_')[0]}`)
  }
  return [...out].sort()
}
const shortName = (source: string) => (source.startsWith(REGISTRY) ? source.slice(REGISTRY.length) : source)

const noConfig = (verb: string) =>
  box(
    'warning',
    'No configuration files',
    `${verb} requires configuration to be present. Planning without a configuration would mark everything for destruction, which is normally not what is desired. If you would like to destroy everything, run plan with the -destroy option. Otherwise, create a Terraform configuration file (.tf file) and try again.`,
  )

// Resources need provider selections; without a lock file `init` has not run.
function lockError(cfg: Config): Out | undefined {
  const providers = cfg.hasLock ? [] : providersOf(cfg.tf)
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

function cmdVersion(ctx: CliContext, cfg: Config): Out {
  const lines = [`Terraform v${ctx.lab.version}`, 'on linux_amd64']
  if (cfg.hasLock) for (const p of providersOf(cfg.tf)) lines.push(`+ provider ${p} v${PROVIDER_VERSION}`)
  return ok(lines.join('\n'))
}

async function cmdInit(ctx: CliContext, cfg: Config): Promise<Out> {
  const g = buildGraph(cfg.tf)
  if (g.diagnostics.length) return fail(boxes(g.diagnostics, cfg.tf))
  const providers = providersOf(cfg.tf)
  const create = !cfg.hasLock && providers.length > 0
  const lines = ['', 'Initializing the backend...', '', 'Initializing provider plugins...']
  for (const p of providers) {
    const n = shortName(p)
    lines.push(...(cfg.hasLock ? [`- Reusing previous version of ${n} from the dependency lock file`, `- Using previously-installed ${n} v${PROVIDER_VERSION}`] : [`- Finding latest version of ${n}...`, `- Installing ${n} v${PROVIDER_VERSION}...`, `- Installed ${n} v${PROVIDER_VERSION} (signed by HashiCorp)`]))
  }
  if (create) {
    lines.push(
      '',
      'Terraform has created a lock file .terraform.lock.hcl to record the provider',
      'selections it made above. Include this file in your version control repository',
      'so that Terraform can guarantee to make the same selections by default when',
      'you run "terraform init" in the future.',
    )
    const blocks = providers.map((p) => `provider "${p}" {\n  version = "${PROVIDER_VERSION}"\n  hashes = [\n    "h1:Zq0uB8Zc1nS5eYpR3m7KpTz2W0k6YV3d8J4bN1xQwLs=",\n  ]\n}\n`)
    await ctx.write(cfg.dir, '.terraform.lock.hcl', `# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\n${blocks.join('\n')}`)
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
  const warn = cfg.tf.length ? '' : box('warning', 'No configuration files', 'The directory has no Terraform configuration files. You may begin working with Terraform immediately by creating Terraform configuration files.')
  return ok(lines.join('\n'), warn)
}

function cmdValidate(cfg: Config): Out {
  if (!cfg.tf.length) return ok('Success! The configuration is valid, but there were some validation warnings as shown above.\n', noConfig('Validate'))
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

// Variables in Terraform's precedence, lowest first; later sources override earlier ones.
async function resolveVars(ctx: CliContext, cfg: Config, cmdline: VarSource[]): Promise<{ vars: Record<string, Value> } | { error: string }> {
  const vars = new Map<string, Value>(Object.entries(ctx.lab.vars))
  for (const [k, v] of Object.entries(ctx.env)) if (k.startsWith('TF_VAR_') && k.length > 7) vars.set(k.slice(7), v)
  const errors: string[] = []
  const load = (file: File) => {
    const r = parseVarsFile(file.name, file.text)
    if ('diags' in r) errors.push(boxes(r.diags, [file]))
    else for (const [k, v] of r.values) vars.set(k, v)
  }
  cfg.tfvars.forEach(load)
  for (const s of cmdline) {
    if (s.kind === 'var') {
      const eq = s.arg.indexOf('=')
      if (eq < 1) errors.push(box('error', 'Invalid -var option', `Given variable option "${s.arg}" is not correctly specified. Must be a variable name and value separated by an equals sign, like -var="key=value".`))
      else vars.set(s.arg.slice(0, eq), s.arg.slice(eq + 1))
      continue
    }
    const path = resolvePath(cfg.dir, s.path)
    const text = await ctx.readFile(path)
    if (text === undefined) errors.push(box('error', 'Failed to read variables file', `Given variables file ${s.path} does not exist.`))
    else load({ name: s.path, text })
  }
  return errors.length ? { error: errors.join('\n\n') } : { vars: Object.fromEntries(vars) }
}

interface PlanFlags {
  sources: VarSource[]
  replace: string[]
  refresh: boolean
  out?: string
  detailed: boolean
}
const PLAN_VALUE_FLAGS = new Set(['-var', '-var-file', '-replace', '-out', '-lock-timeout', '-parallelism', '-target'])
const PLAN_BOOL_FLAGS = new Set(['-no-color', '-input', '-lock', '-compact-warnings', '-refresh', '-detailed-exitcode', '-destroy', '-refresh-only'])

function parsePlanFlags(args: string[]): PlanFlags | Out {
  const f: PlanFlags = { sources: [], replace: [], refresh: true, detailed: false }
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    if (!raw.startsWith('-') || raw === '-') return boxFail('Too many command line arguments', 'Expected no positional arguments. Did you mean to use -chdir?')
    const eq = raw.indexOf('=')
    const name = (eq < 0 ? raw : raw.slice(0, eq)).replace(/^--/, '-')
    let value = eq < 0 ? undefined : raw.slice(eq + 1)
    if (PLAN_VALUE_FLAGS.has(name)) {
      if (value === undefined) {
        value = args[++i]
        if (value === undefined) return boxFail('Failed to parse command-line flags', `flag needs an argument: ${name}`)
      }
      if (name === '-var') f.sources.push({ kind: 'var', arg: value })
      else if (name === '-var-file') f.sources.push({ kind: 'file', path: value })
      else if (name === '-replace') f.replace.push(value)
      else if (name === '-out') f.out = value
      else if (name === '-target') return notYet('plan -target')
    } else if (PLAN_BOOL_FLAGS.has(name)) {
      if (name === '-refresh') f.refresh = value !== 'false'
      else if (name === '-detailed-exitcode') f.detailed = true
      else if (name === '-destroy' || name === '-refresh-only') return notYet(`plan ${name}`)
    } else return boxFail('Failed to parse command-line flags', `flag provided but not defined: ${name}`)
  }
  return f
}

async function cmdPlan(args: string[], ctx: CliContext, cfg: Config): Promise<Out> {
  const f = parsePlanFlags(args)
  if (!('sources' in f)) return f
  const warning = cfg.tf.length ? '' : noConfig('Plan')
  if (cfg.tf.length) {
    const g = buildGraph(cfg.tf)
    if (!g.diagnostics.length) {
      const lock = lockError(cfg)
      if (lock) return lock
    }
  }
  const v = await resolveVars(ctx, cfg, f.sources)
  if ('error' in v) return fail(v.error)
  const result = planConfig({ files: cfg.tf, state: ctx.lab.state, reality: ctx.lab.reality, vars: v.vars, replace: f.replace, refresh: f.refresh })
  const rendered = renderPlan(result, sourcesOf(cfg.tf))
  if (result.diagnostics.length) return fail([warning, rendered].filter(Boolean).join('\n\n'))

  const refreshLines = ctx.lab.state.resources
    .flatMap((r) =>
      r.instances.map((i) => {
        const addr = instanceAddress(r, i.index_key)
        const id = typeof i.attributes.id === 'string' ? ` [id=${i.attributes.id}]` : ''
        return { addr, lines: r.mode === 'data' ? [`${addr}: Reading...`, `${addr}: Read complete after 0s${id}`] : f.refresh ? [`${addr}: Refreshing state...${id}`] : [] }
      }),
    )
    .sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
    .flatMap((x) => x.lines)
  let stdout = refreshLines.length ? `${refreshLines.join('\n')}\n\n${rendered}` : rendered
  const changes = !/(^|\n)No changes\. Your infrastructure matches/.test(rendered)
  if (changes) {
    stdout += f.out
      ? `\n\n${RULE}\n\nSaved the plan to: ${f.out}\n\nTo perform exactly these actions, run the following command to apply:\n    terraform apply "${f.out}"`
      : `\n\n${RULE}\n\nNote: You didn't use the -out option to save this plan, so Terraform can't\nguarantee to take exactly these actions if you run "terraform apply" now.`
  }
  return { stdout, stderr: warning, exitCode: f.detailed && changes ? 2 : 0 }
}

const sensitiveAttr = (type: string, attr: string) => {
  const attrs = schemaFor(type)?.attrs
  return attrs !== undefined && Object.hasOwn(attrs, attr) && attrs[attr].sensitive === true
}

function cmdState(args: string[], ctx: CliContext): Out {
  const [sub, ...rest] = args
  const { lab } = ctx
  if (sub === 'list') {
    if (!lab.hasState) return fail(NO_STATE)
    const wanted = rest.filter((a) => !a.startsWith('-'))
    const all = listAddresses(lab.state)
    const hit = wanted.length ? all.filter((a) => wanted.some((w) => a === w || a.startsWith(`${w}.`) || a.startsWith(`${w}[`))) : all
    return wanted.length && !hit.length ? fail('No matching objects found.') : ok(hit.join('\n'))
  }
  if (sub === 'show') {
    if (!lab.hasState) return fail(NO_STATE)
    const addrs = rest.filter((a) => !a.startsWith('-'))
    if (addrs.length !== 1) return fail('Exactly one argument expected.')
    const found = findInstance(lab.state, addrs[0])
    if (!found) {
      return boxFail('No instance found for the given address!', 'This command requires that the address references one specific instance. To view the available instances, use "terraform state list". Please modify the address to reference a specific instance.')
    }
    return ok(stateShow(found.resource, found.instance, (a) => sensitiveAttr(found.resource.type, a)))
  }
  if (sub === 'pull') return lab.hasState ? ok(stateJson(lab.state)) : fail(NO_STATE)
  if (sub === 'mv' || sub === 'rm' || sub === 'replace-provider' || sub === 'push') return notYet(`state ${sub}`)
  return fail('Usage: terraform [global options] state <subcommand> [options] [args]\n\nSubcommands: list, show, pull (mv, rm, replace-provider and push are not simulated yet).')
}

function cmdOutput(args: string[], ctx: CliContext): Out {
  const mode = args.includes('-json') || args.includes('--json') ? 'json' : args.includes('-raw') || args.includes('--raw') ? 'raw' : 'hcl'
  return outputsText(ctx.lab.state.outputs, args.find((a) => !a.startsWith('-')), mode)
}

function cmdWorkspace(args: string[]): Out {
  const sub = args[0]
  if (sub === 'show') return ok('default')
  if (sub === 'list') return ok('* default\n')
  if (sub === 'new' || sub === 'select' || sub === 'delete') return notYet(`workspace ${sub}`)
  return fail('Usage: terraform [global options] workspace <subcommand> [options] [args]\n\nSubcommands: show, list (new, select and delete are not simulated yet).')
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
  const cfg = await loadConfig(ctx, dir)
  const more = rest.slice(1)
  switch (sub) {
    case 'version':
    case '-version':
    case '--version':
      return cmdVersion(ctx, cfg)
    case 'init':
      return cmdInit(ctx, cfg)
    case 'validate':
      return cmdValidate(cfg)
    case 'plan':
      return cmdPlan(more, ctx, cfg)
    case 'show':
      return more.some((a) => !a.startsWith('-')) ? notYet('show <plan file>') : ok(ctx.lab.hasState ? showState(ctx.lab.state, sensitiveAttr) : 'No state.')
    case 'state':
      return cmdState(more, ctx)
    case 'output':
      return cmdOutput(more, ctx)
    case 'workspace':
      return cmdWorkspace(more)
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
  const evidence = ctx.lab.evidence.filter((e) => e.command === command && text.includes(e.contains)).map((e) => `evidence:${e.evidence}`)
  return { ...out, evidence }
}
