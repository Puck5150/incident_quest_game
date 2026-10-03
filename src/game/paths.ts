// Where an incident's files live on the simulated disk (PLAN_TERMINAL.md).
// Shared by the engine (which leaves reading those files to the real shell)
// and the shell (which puts them there).
import type { Scenario } from '../schema/scenario.ts'

// The user the terminal prompt logs in as ("ops@web-01:~$" -> ops), and home.
export const userOf = (scenario: Scenario) => scenario.terminal?.prompt.match(/^([\w.-]+)@/)?.[1] ?? 'ops'
export const homeOf = (scenario: Scenario) => (userOf(scenario) === 'root' ? '/root' : `/home/${userOf(scenario)}`)

// An artifact's path on disk, if its name is one: "/etc/fstab",
// "~/notes.txt", or "deploy/main.tf (excerpt)" relative to the home directory.
export function diskPath(name: string, home: string): string | undefined {
  const bare = name.replace(/ \([^)]*\)$/, '')
  if (/\s/.test(bare)) return undefined
  if (bare.startsWith('/')) return bare
  if (bare.startsWith('~/')) return home + bare.slice(1)
  if (/^\.?[\w.-]+(\/[\w.@-]+)+$/.test(bare)) return `${home}/${bare}`
  return undefined
}

// Every file the scenario (at its current stage) puts on disk, with its
// initial content: files and logs with path-like names, and the output of
// scripted `cat /path` commands (before any fix).
export function filesOnDisk(scenario: Scenario): Map<string, string> {
  const home = homeOf(scenario)
  const out = new Map<string, string>()
  for (const f of scenario.files ?? []) {
    const p = diskPath(f.path, home)
    if (p && !out.has(p)) out.set(p, f.content)
  }
  for (const l of scenario.logs ?? []) {
    const p = diskPath(l.name, home)
    if (p && !out.has(p)) out.set(p, l.lines)
  }
  for (const c of scenario.terminal?.commands ?? []) {
    const p = (c.match ?? c.example ?? '').trim().replace(/\s+/g, ' ').match(/^(?:sudo )?cat (\/\S+)$/)?.[1]
    if (p && !c.when_actions?.length && !out.has(p)) out.set(p, c.output)
  }
  return out
}

// Commands that only read a file: when it's on disk, the real shell runs them,
// so they show what's really there (including the player's own edits).
const READERS = /^(?:sudo )?(?:cat|grep|egrep|fgrep|head|tail|wc|sed -n|awk|less|more|nl|tac|sort|uniq|cut|diff|md5sum|sha256sum|stat|ls)\b/
export function readsFileOnDisk(scenario: Scenario, cmd: string): boolean {
  if (!READERS.test(cmd) || /[|;&<>`$]/.test(cmd)) return false
  const onDisk = filesOnDisk(scenario)
  const home = homeOf(scenario)
  const args = cmd.split(' ').slice(1).filter((a) => !a.startsWith('-'))
  return args.some((a) => {
    const p = a.startsWith('~/') ? home + a.slice(1) : a
    return onDisk.has(p.replace(/^['"]|['"]$/g, ''))
  })
}
