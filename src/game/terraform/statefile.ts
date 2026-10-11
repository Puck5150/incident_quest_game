// terraform.tfstate on the simulated disk and the backend block's changes: both opt-in (terraform.state_file).
import type { CliContext } from './cli.ts'
import { formatDiagnostic } from './diag.ts'
import type { Lab } from './lab.ts'
import { parseHcl } from './parse.ts'
import { evalExpr, UNKNOWN, type Value } from './eval.ts'
import { emptyState, stateJson } from './state.ts'
import type { Block } from './types.ts'

export const STATE_FILE = 'terraform.tfstate'
export const STATE_BACKUP = 'terraform.tfstate.backup'

// What `init` last recorded (.terraform/terraform.tfstate): the backend's type and its configuration, canonical text.
export interface BackendRec {
  type: string
  config: string
  // The block's own literal attributes (nested blocks and unresolvable expressions left out), for the `backend` predicate.
  attrs: Record<string, Value>
}
type File = { name: string; text: string }

// Every `terraform { backend "TYPE" { ... } }` block of the root module's files, in order. A file that does not parse is skipped.
function backendBlocks(files: File[]): Block[] {
  const out: Block[] = []
  for (const f of files) for (const b of parseHcl(f.name, f.text).blocks) if (b.type === 'terraform') out.push(...b.blocks.filter((x) => x.type === 'backend' && x.labels.length === 1))
  return out
}
const literalAttrs = (be: Block): Record<string, Value> => {
  const out: Record<string, Value> = {}
  for (const a of be.attrs) {
    try {
      out[a.name] = evalExpr(a.value, { ref: () => UNKNOWN })
    } catch {
      // not a literal: left out
    }
  }
  return out
}
export function backendOf(files: File[]): BackendRec | undefined {
  const be = backendBlocks(files)[0]
  if (!be) return undefined
  return { type: be.labels[0], config: JSON.stringify(be.attrs.map((a) => [a.name, a.value]).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))), attrs: literalAttrs(be) }
}
// Where the first backend block is, when a second one makes the configuration invalid.
export function backendDuplicate(files: File[]): string | undefined {
  const all = backendBlocks(files)
  return all.length > 1 ? `${all[0].file}:${all[0].pos.line}` : undefined
}
const DUPLICATE = (at: string) => ({ summary: 'Duplicate backend configuration', detail: `A module may have only one backend configuration. The backend was previously configured at ${at}.` })
const same = (a?: BackendRec, b?: BackendRec) => a?.type === b?.type && a?.config === b?.config

// The default workspace's state: what the local backend keeps in terraform.tfstate (other workspaces live elsewhere).
const defaultOf = (lab: Lab) => (lab.workspace === 'default' ? { state: lab.state, hasState: lab.hasState } : lab.workspaces.get('default'))

// The file is a view of the state `state pull` shows: written after every command, never read back.
export function stateFileText(lab: Lab): string {
  const d = defaultOf(lab)
  if (!d?.hasState) return ''
  const text = stateJson(d.state)
  return text.endsWith('\n') ? text : `${text}\n`
}

// Where the state sits: in the file (no backend recorded) or in the remote backend (the file is left emptied).
export const localState = (lab: Lab) => lab.stateFile && !lab.savedBackend

// The error a command that opens the backend gives when the configuration names a different backend than init recorded.
export function backendRequired(lab: Lab, files: File[]): { summary: string; detail: string } | undefined {
  if (!lab.stateFile) return undefined
  const dup = backendDuplicate(files)
  if (dup) return DUPLICATE(dup)
  const cur = backendOf(files)
  const saved = lab.savedBackend
  if (same(cur, saved)) return undefined
  const [summary, reason] = !saved
    ? ['Backend initialization required, please run "terraform init"', `Initial configuration of the requested backend "${cur!.type}"`]
    : !cur
      ? ['Backend initialization required, please run "terraform init"', `Unsetting the previously set backend "${saved.type}"`]
      : ['Backend initialization required: please run "terraform init"', saved.type !== cur.type ? `Backend type changed from "${saved.type}" to "${cur.type}"` : 'Backend configuration block has changed']
  return { summary, detail: `Reason: ${reason}\n\n${INIT_TEXT}` }
}
const INIT_TEXT = `The "backend" is the interface that Terraform uses to store state,
perform operations, etc. If this message is showing up, it means that the
Terraform configuration you're using is using a custom configuration for
the Terraform backend.

Changes to backend configurations require reinitialization. This allows
Terraform to set up the new configuration, copy existing state, etc. Please run
"terraform init" with either the "-reconfigure" or "-migrate-state" flags to
use the current configuration.

If the change reason above is incorrect, please verify your configuration
hasn't changed and try again. At this point, no changes to your existing
configuration or state have been made.`

const box = (summary: string, detail: string) => formatDiagnostic({ severity: 'error', summary, detail, file: '', line: 0, col: 0 }, '', { preserveLines: true })

// After a command: the file shows the state again, and `.backup` the state it had before this command changed it.
export async function syncStateFile(ctx: CliContext, before: string | undefined): Promise<void> {
  if (!localState(ctx.lab)) return
  const text = stateFileText(ctx.lab)
  if (before && before !== text) await ctx.write(ctx.lab.dir, STATE_BACKUP, before)
  await ctx.write(ctx.lab.dir, STATE_FILE, text)
}

const COPY_PROMPT = (from: string, to: string) =>
  `Do you want to copy existing state to the new backend?\n  Pre-existing state was found while migrating the previous "${from}" backend to the\n  newly configured "${to}" backend. No existing state was found in the newly\n  configured "${to}" backend. Do you want to copy this state to the new "${to}"\n  backend? Enter "yes" to copy and "no" to start with an empty state.\n\n  Enter a value: `

// The state a fresh backend holds: none.
function forget(lab: Lab): void {
  const fresh = emptyState(lab.version)
  if (lab.workspace === 'default') {
    lab.state = fresh
    lab.hasState = false
  } else lab.workspaces.set('default', { state: fresh, hasState: false })
}

// The backend step of `terraform init` (meta_backend.go, backend_C_r_s / backend_C_r_S_changed / backend_c_r_S).
// `lines` go under "Initializing the backend..."; `stderr` is the error that stops init there.
export async function initBackend(args: string[], ctx: CliContext, files: File[]): Promise<{ lines: string[] } | { stderr: string }> {
  const lab = ctx.lab
  const dup = lab.stateFile ? backendDuplicate(files) : undefined
  if (dup) return { stderr: box(DUPLICATE(dup).summary, DUPLICATE(dup).detail) }
  const cur = backendOf(files)
  const saved = lab.savedBackend
  if (!lab.stateFile || same(cur, saved)) return { lines: [] }
  const reconfigure = args.includes('-reconfigure')
  const force = args.includes('-force-copy')
  const migrate = args.includes('-migrate-state') || force
  if (args.includes('-migrate-state') && reconfigure) return { stderr: box('Invalid init options', 'The -migrate-state and -reconfigure options are mutually-exclusive.') }
  if (saved && !reconfigure && !migrate) {
    return {
      stderr: box(
        'Backend configuration changed',
        'A change in the backend configuration has been detected, which may require migrating existing state.\n\nIf you wish to attempt automatic migration of the state, use "terraform init -migrate-state".\nIf you wish to store the current configuration with no changes to the state, use "terraform init -reconfigure".',
      ),
    }
  }
  const from = saved?.type ?? 'local'
  const to = cur?.type ?? 'local'
  const lines: string[] = []
  // -reconfigure forgets the old backend's state without asking; a first configuration still looks at the local file.
  const copy = !reconfigure || !saved
  const d = defaultOf(lab)
  const hasState = !!d?.hasState && d.state.resources.length > 0
  if (saved) {
    if (!cur) lines.push(`Terraform has detected you're unconfiguring your previously set "${saved.type}" backend.`)
    else if (saved.type !== cur.type) lines.push(`Terraform detected that the backend type changed from "${saved.type}" to "${cur.type}".`)
    else lines.push('Backend configuration changed!', '', 'Terraform has detected that the configuration specified for the backend', 'has changed. Terraform will now check for existing state in the backends.')
    if (!reconfigure) lines.push('')
  }
  const wasLocal = localState(lab)
  const before = wasLocal ? stateFileText(lab) : ''
  if (copy && hasState) {
    let yes = true
    if (!force) {
      const prompt = COPY_PROMPT(from, to)
      const answer = ctx.stdin !== undefined ? ctx.stdin.split('\n')[0].trim() : ctx.confirm ? await ctx.confirm(prompt) : undefined
      if (answer === undefined) return { stderr: box("Can't ask approval for state migration when interactive input is disabled.", 'Please remove the "-input=false" option and try again.') }
      lines.push(`${prompt}${answer}`)
      yes = answer === 'yes'
    }
    if (yes) lab.history.push(`init-migrate ${to}`)
    else forget(lab)
  } else if (saved && reconfigure) forget(lab)
  if (wasLocal && hasState) {
    // Whatever the answer, the local state is cleared: an empty file and the old state in the backup.
    await ctx.write(lab.dir, STATE_BACKUP, before)
    await ctx.write(lab.dir, STATE_FILE, '')
  }
  if (cur) lab.savedBackend = cur
  else delete lab.savedBackend
  lines.push('', cur ? `Successfully configured the backend "${cur.type}"! Terraform will automatically\nuse this backend unless the backend configuration changes.` : `Successfully unset the backend "${saved!.type}". Terraform will now operate locally.`)
  return { lines }
}
