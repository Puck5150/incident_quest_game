// Where an incident's files live on the simulated disk (PLAN_TERMINAL.md).
// Shared by the engine (which leaves reading those files to the real shell)
// and the shell (which puts them there).
import type { Scenario } from '../schema/scenario.ts'
import { labDir, labFiles } from './terraform/layout.ts'
import { mountedLock } from './terraform/providers.ts'

// The user the terminal prompt logs in as ("ops@web-01:~$" -> ops), and home.
export const userOf = (scenario: Scenario) => scenario.terminal?.prompt.match(/^([\w.-]+)@/)?.[1] ?? 'ops'
export const homeOf = (scenario: Scenario) => (userOf(scenario) === 'root' ? '/root' : `/home/${userOf(scenario)}`)

// Whether the terminal is a shell at all: "you@laptop:~/infra$" is; a
// database prompt ("postgres=#", "mysql>") isn't, and stays scripted only.
export const isShellPrompt = (scenario: Scenario) => /^[\w.-]+@[\w.-]+:/.test(scenario.terminal?.prompt ?? '')

// The directory the prompt starts in: "you@laptop:~/infra$" -> /home/you/infra.
export function startDir(scenario: Scenario): string {
  const home = homeOf(scenario)
  const p = scenario.terminal?.prompt.match(/^[\w.-]+@[\w.-]+:(\S+?)(?:\s.*)?[$#]\s*$/)?.[1]
  if (!p || p === '~') return home
  if (p.startsWith('~/')) return home + p.slice(1)
  return p.startsWith('/') ? p : home
}

// Resolve a path as typed at the starting prompt.
export function resolveFrom(scenario: Scenario, p: string): string {
  const clean = p.replace(/^['"]|['"]$/g, '')
  if (clean.startsWith('/')) return clean
  if (clean.startsWith('~/')) return homeOf(scenario) + clean.slice(1)
  return `${startDir(scenario)}/${clean.replace(/^\.\//, '')}`
}

// An artifact's path on disk, if its name is one: "/etc/fstab",
// "~/notes.txt", or "deploy/main.tf (excerpt)" relative to the home directory.
export function diskPath(name: string, home: string, cwd = home): string | undefined {
  const bare = name.replace(/ \([^)]*\)$/, '')
  if (/\s/.test(bare)) return undefined
  if (bare.startsWith('/')) return bare
  if (bare.startsWith('~/')) return home + bare.slice(1)
  // A relative path, or a bare file name with an extension ("backend.tf"):
  // in the directory the prompt starts in.
  if (/^\.?[\w.-]+(\/[\w.@-]+)+$/.test(bare) || /^[\w-][\w.-]*\.[\w]+$/.test(bare)) return `${cwd}/${bare}`
  return undefined
}

// Every file the scenario (at its current stage) puts on disk, with its
// initial content: files and logs with path-like names, and the output of
// scripted `cat /path` commands (before any fix).
export function filesOnDisk(scenario: Scenario): Map<string, string> {
  const home = homeOf(scenario)
  const cwd = startDir(scenario)
  const out = new Map<string, string>()
  // Files only the terminal sees come first: they're written to match the scripted commands.
  for (const f of scenario.terminal?.files ?? []) out.set(resolveFrom(scenario, f.path), f.content)
  for (const f of scenario.files ?? []) {
    const p = diskPath(f.path, home, cwd)
    if (p && !out.has(p)) out.set(p, f.content)
  }
  for (const l of scenario.logs ?? []) {
    const p = diskPath(l.name, home, cwd)
    if (p && !out.has(p)) out.set(p, l.lines)
  }
  // What a scripted `cat FILE` (or tail/head/less of it) prints is the file.
  for (const c of scenario.terminal?.commands ?? []) {
    if (c.when_actions?.length) continue
    const p = impliedFile(c.match ?? c.example ?? '')
    if (p) {
      const at = resolveFrom(scenario, p)
      if (!out.has(at)) out.set(at, c.output)
    }
  }
  const tf = scenario.terraform
  if (tf) {
    const files = labFiles(tf, cwd, home)
    for (const f of files) if (!out.has(f.path)) out.set(f.path, f.content)
    const lock = `${labDir(tf, cwd, home)}/.terraform.lock.hcl`
    if (tf.initialized !== false && !out.has(lock)) out.set(lock, mountedLock(tf, files))
  }
  return out
}

// The file a scripted command prints whole, if it does: cat/less/more FILE,
// or tail/head with a line count (an author shows the whole short file).
export function impliedFile(line: string): string | undefined {
  const l = line.trim().replace(/\s+/g, ' ')
  return l.match(/^(?:sudo )?(?:cat|less|more) ([^\s|;&<>]+)$/)?.[1] ?? l.match(/^(?:sudo )?(?:tail|head)(?: -n ?\d+| -\d+)? ([^\s|;&<>-][^\s|;&<>]*)$/)?.[1]
}

// Commands that only read a file: when it's on disk, the real shell runs them,
// so they show what's really there (including the player's own edits). Not ls
// or stat: the simulated disk doesn't keep real owners and modes.
const READERS = /^(?:sudo )?(?:cat|grep|egrep|fgrep|head|tail|wc|sed -n|awk|less|more|nl|tac|sort|uniq|cut|diff|md5sum|sha256sum)\b/
export function readsFileOnDisk(scenario: Scenario, cmd: string): boolean {
  if (!READERS.test(cmd) || /[|;&<>`$]/.test(cmd)) return false
  const onDisk = filesOnDisk(scenario)
  const args = cmd.split(' ').slice(1).filter((a) => !a.startsWith('-'))
  return args.some((a) => onDisk.has(resolveFrom(scenario, a)))
}
