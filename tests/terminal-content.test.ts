// Every incident, run through the real shell (PLAN_TERMINAL.md T5): what the
// shell shows must agree with what the incident scripts.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getCommandNames } from 'just-bash'
import { loadContent } from '../vite-plugin-content.ts'
import { IncidentShell, words } from '../src/game/shell.ts'
import { atStage, stageCount } from '../src/schema/stages.ts'
import { isShellPrompt, readsFileOnDisk } from '../src/game/paths.ts'
import { normalize } from '../src/game/engine.ts'

const content = loadContent(path.resolve(import.meta.dirname, '../content'))
const builtins = new Set<string>(getCommandNames())
// Typed exactly, these get the scripted answer from the engine; only the
// shell's own answer differs (custom tools live in /usr/bin there).
const KNOWN = new Set(['command -v aws'])

describe('scripted commands agree with the real shell', () => {
  it.each(content.scenarios.filter((s) => s.terminal && isShellPrompt(s)).map((s) => [s.id, s] as const))('%s', async (_id, s) => {
    const wrong: string[] = []
    for (let k = 0; k < stageCount(s); k++) {
      const view = atStage(s, k)
      for (const c of view.terminal!.commands) {
        const line = normalize(c.match ?? c.example ?? '')
        if (!line || KNOWN.has(line)) continue
        const w = words(line)
        const first = w[0] === 'sudo' ? w[1] : w[0]
        // File reads the shell answers (they must match), and tools (they should).
        const reader = readsFileOnDisk(view, line)
        if (!reader && (line.includes('|') || builtins.has(first))) continue
        const taken = new Set(c.when_actions ?? [])
        const sh = new IncidentShell(s)
        await sh.update(view, taken)
        const got = (await sh.run(line, view, taken)).output.trim()
        if (got !== c.output.trim()) wrong.push(`${line} [${[...taken]}]\n    got: ${got.split('\n')[0]}`)
      }
    }
    expect(wrong).toEqual([])
  })
})
