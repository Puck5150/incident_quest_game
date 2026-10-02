// Builds an incident's command breakdown from the command library: which of
// its terminal commands are explained by which entry, and why each is listed.
// Runs at build time (vite-plugin-content.ts); kept free of zod.

import type { Scenario } from '../schema/scenario.ts'
import type { Breakdown, CommandEntry } from '../schema/commands.ts'
import { normalize } from './engine.ts'

// A terminal command as written: its exact match, or a pattern command's example.
export const canonical = (c: { match?: string; example?: string }) => c.match ?? c.example

export function breakdownFor(s: Scenario, library: CommandEntry[]): Breakdown {
  const parts = [s, ...(s.stages ?? [])]
  const keyTags = new Set(parts.flatMap((p) => p.key_evidence))
  const byCommand = new Map<string, { key: boolean; verify: boolean }>()
  for (const p of parts)
    for (const c of p.terminal?.commands ?? []) {
      const cmd = canonical(c)
      if (!cmd) continue
      const prev = byCommand.get(cmd) ?? { key: false, verify: false }
      byCommand.set(cmd, {
        key: prev.key || (!!c.evidence && keyTags.has(c.evidence)),
        verify: prev.verify || !!c.when_actions?.length,
      })
    }
  const commands: Breakdown['commands'] = []
  const entries: Breakdown['entries'] = {}
  byCommand.forEach((flags, command) => {
    const entry = library.find((e) => new RegExp(e.match).test(normalize(command)))
    if (!entry) return
    entries[entry.id] = entry
    commands.push({ command, entry: entry.id, ...flags })
  })
  return { commands, entries }
}

// Key-evidence and verification commands no library entry explains: the
// build reports these (PLAN_COMMAND_BREAKDOWN.md, check becomes an error in B3).
export function uncovered(s: Scenario, library: CommandEntry[]): string[] {
  const covered = new Set(breakdownFor(s, library).commands.map((c) => c.command))
  const parts = [s, ...(s.stages ?? [])]
  const keyTags = new Set(parts.flatMap((p) => p.key_evidence))
  return [
    ...new Set(
      parts.flatMap((p) =>
        (p.terminal?.commands ?? [])
          .filter((c) => (c.evidence && keyTags.has(c.evidence)) || c.when_actions?.length)
          .map((c) => canonical(c)!)
          .filter((cmd) => cmd && !covered.has(cmd)),
      ),
    ),
  ]
}
