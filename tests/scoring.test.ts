// Pins the scoring rules in PLAN.md §6 to numbers. full-disk is difficulty 1
// (base 100 XP) with par 8 minutes.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import type { GameEvent } from '../src/game/engine.ts'
import { score } from '../src/game/scoring.ts'

const scenario = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find(
  (s) => s.id === 'full-disk',
)!
const PAR = 8 * 60_000

// Builds a log from shorthand; every event is 1s apart unless `closeAt` says otherwise.
function log(steps: string[], closeAt = 60_000): GameEvent[] {
  const events: GameEvent[] = [{ type: 'START', at: 0 }]
  steps.forEach((s, i) => {
    const at = (i + 1) * 1000
    const [kind, ...rest] = s.split(' ')
    const arg = rest.join(' ')
    if (kind === 'run') events.push({ type: 'RUN_COMMAND', input: arg, at })
    if (kind === 'log') events.push({ type: 'OPEN_ARTIFACT', kind: 'log', name: arg, at })
    if (kind === 'hint') events.push({ type: 'REQUEST_HINT', at })
    if (kind === 'hyp') events.push({ type: 'DECLARE_HYPOTHESIS', id: arg, at })
    if (kind === 'act') events.push({ type: 'TAKE_ACTION', id: arg, at })
  })
  events.push({ type: 'CLOSE_INCIDENT', at: closeAt })
  return events
}

const FIX = ['hyp disk-full', 'act truncate-log', 'act fix-logrotate']
const EVIDENCE = ['run df -h', 'log journalctl -u checkout']
const lines = (l: GameEvent[]) => Object.fromEntries(score(scenario, l).lines.map((x) => [x.label, x.xp]))

describe('scoring', () => {
  it('perfect run: base + time + methodical + verified', () => {
    const s = score(scenario, log([...EVIDENCE, ...FIX, 'run df -h']))
    expect(lines(log([...EVIDENCE, ...FIX, 'run df -h']))).toEqual({
      'Base (difficulty 1)': 100,
      'Time bonus (under par)': 20,
      'Methodical: found all key evidence before deciding': 20,
      'Verified the fix before closing': 10,
    })
    expect(s.total).toBe(150)
    expect(s.clean).toBe(true)
  })

  it('time bonus fades linearly from par to 2x par', () => {
    expect(lines(log(FIX, PAR * 1.5))['Time bonus (partial)']).toBe(10)
    expect(Object.keys(lines(log(FIX, PAR * 2)))).not.toContain('Time bonus (partial)')
  })

  it('relaxed mode turns the time bonus off, so it never beats playing on the clock', () => {
    const fast = log([...EVIDENCE, ...FIX, 'run df -h'])
    const relaxed = score(scenario, fast, true)
    expect(relaxed.relaxed).toBe(true)
    expect(relaxed.lines.find((x) => x.label.startsWith('Time bonus'))).toEqual({ label: 'Time bonus: off (relaxed mode)', xp: 0 })
    expect(relaxed.total).toBe(score(scenario, fast).total - 20) // the 20% time bonus on base 100
  })

  it('in a shift the time bonus is replaced by the shift response targets', () => {
    const fast = log([...EVIDENCE, ...FIX, 'run df -h'])
    const shift = score(scenario, fast, false, true)
    expect(shift.lines.find((x) => x.label.startsWith('Time bonus'))).toEqual({ label: 'Time bonus: see shift response targets', xp: 0 })
    expect(shift.total).toBe(score(scenario, fast).total - 20)
  })

  it('evidence found only after deciding is not methodical', () => {
    expect(score(scenario, log(['hyp disk-full', ...EVIDENCE, 'act truncate-log', 'act fix-logrotate'])).methodical).toBe(false)
  })

  it('help and typos after the fix do not count as verifying', () => {
    expect(score(scenario, log([...FIX, 'run help', 'run dff -h'])).verified).toBe(false)
  })

  it('a terraform run after the fix verifies it (the shell reports it as a hit)', () => {
    const l = log(FIX)
    l.splice(-1, 0, { type: 'SHELL_RAN', commands: ['terraform plan'], at: 9000 })
    expect(score(scenario, l).verified).toBe(true)
  })

  it('penalties: hints are cumulative, mistakes count each time', () => {
    const s = score(
      scenario,
      log(['hint', 'hint', 'hyp db-down', 'hyp disk-full', 'act rm-log', 'act reboot', 'act truncate-log', 'act fix-logrotate']),
    )
    // 100 + 20 time - 10 nudge - 25 direction - 10 wrong hyp - 10 wrong act - 25 destructive
    expect(s.total).toBe(40)
    expect(s.clean).toBe(false)
    expect(s.mistakes).toEqual({ wrongHypotheses: 1, wrongActions: 1, destructive: 1 })
  })

  it('never drops below the 10% floor', () => {
    const s = score(scenario, log(['hint', 'hint', 'hint', 'hyp disk-full', 'act reboot', 'act reboot', ...FIX.slice(1)], PAR * 3))
    expect(s.total).toBe(10)
    expect(lines(log(['hint', 'hint', 'hint', 'hyp disk-full', 'act reboot', 'act reboot', ...FIX.slice(1)], PAR * 3))['Minimum award for resolving']).toBe(45)
  })
})
