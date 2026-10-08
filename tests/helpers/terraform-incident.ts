import path from 'node:path'
import { loadContent } from '../../vite-plugin-content.ts'
import { IncidentShell, type ShellResult } from '../../src/game/shell.ts'
import type { Scenario } from '../../src/schema/scenario.ts'
import { atStage } from '../../src/schema/stages.ts'

export const loadIncident = (id: string): Scenario => loadContent(path.resolve(import.meta.dirname, '../../content')).scenarios.find((s) => s.id === id)!

export function playbook(scenario: Scenario) {
  // A fresh shell, lines run at stage 0 with no actions taken.
  const play = async (...lines: string[]) => {
    const sh = new IncidentShell(scenario)
    const out: ShellResult[] = []
    for (const l of lines) out.push(await sh.run(l, atStage(scenario, 0), new Set()))
    return { sh, out }
  }
  // Mirrors src/components/terminal/detect.ts: file check (if any) AND done_when (if any), false if neither.
  const detected = async (sh: IncidentShell, id: string) => {
    const a = scenario.actions.find((x) => x.id === id)!
    if (!a.file && !a.done_when) return false
    if (a.file && !new RegExp(a.file.matches, 'm').test((await sh.read(a.file.path)) ?? '')) return false
    return !a.done_when || (await sh.doneWhen(a.done_when))
  }
  const detectedAll = async (sh: IncidentShell): Promise<Record<string, boolean>> =>
    Object.fromEntries(await Promise.all(scenario.actions.map(async (a) => [a.id, await detected(sh, a.id)])))
  return { play, detected, detectedAll }
}
