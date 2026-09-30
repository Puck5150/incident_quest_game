// The game rules for one incident, as a pure function:
//   step(scenario, session, event) -> new session
//
// UI components never decide anything themselves; they send events here.
// Every accepted event is appended to `log`. The log holds only what the
// player DID; anything derived (evidence found, hints used) is recomputed
// from it by the helpers at the bottom, so there's one source of truth.

import { artifacts, type ArtifactKind, type Scenario } from '../schema/scenario.ts'

export type Phase = 'briefing' | 'investigating' | 'acting' | 'resolved'

export type GameEvent =
  | { type: 'START'; at: number }
  | { type: 'RUN_COMMAND'; input: string; at: number }
  | { type: 'OPEN_ARTIFACT'; kind: ArtifactKind; name: string; at: number }
  | { type: 'REQUEST_HINT'; at: number }
  | { type: 'DECLARE_HYPOTHESIS'; id: string; at: number }
  | { type: 'TAKE_ACTION'; id: string; at: number }
  | { type: 'CLOSE_INCIDENT'; at: number }

export type Feedback = { tone: 'good' | 'bad' | 'danger'; text: string }

export type Session = {
  phase: Phase
  log: GameEvent[]
  feedback?: Feedback
}

// Cost is a percentage of the incident's base XP (applied in scoring, Milestone 4).
export const HINT_TIERS = [
  { key: 'nudge', label: 'Nudge', cost: 10 },
  { key: 'direction', label: 'Direction', cost: 25 },
  { key: 'answer', label: 'Answer', cost: 50 },
] as const

export const newSession = (): Session => ({ phase: 'briefing', log: [] })

export function step(scenario: Scenario, s: Session, e: GameEvent): Session {
  // Events that don't fit the current phase are ignored rather than thrown:
  // a double-click shouldn't crash the game.
  const working = s.phase === 'investigating' || s.phase === 'acting'
  switch (e.type) {
    case 'START':
      if (s.phase !== 'briefing') return s
      return { ...s, phase: 'investigating', log: [...s.log, e], feedback: undefined }

    // Investigation is allowed while acting too, so the player can verify a fix.
    case 'RUN_COMMAND':
    case 'OPEN_ARTIFACT':
      return working ? { ...s, log: [...s.log, e] } : s

    case 'REQUEST_HINT':
      return working && hintsUsed(s.log) < HINT_TIERS.length ? { ...s, log: [...s.log, e] } : s

    case 'DECLARE_HYPOTHESIS': {
      if (s.phase !== 'investigating') return s
      const h = scenario.hypotheses.find((x) => x.id === e.id)
      if (!h) return s
      const log = [...s.log, e]
      // The hypothesis gate: fix actions stay locked until the player names
      // the right root cause. Wrong guesses send them back to investigate.
      return h.correct
        ? { phase: 'acting', log, feedback: { tone: 'good', text: 'Hypothesis confirmed. Now fix it.' } }
        : { phase: 'investigating', log, feedback: { tone: 'bad', text: h.feedback ?? 'The evidence does not support that. Keep investigating.' } }
    }

    case 'TAKE_ACTION': {
      if (s.phase !== 'acting') return s
      const a = scenario.actions.find((x) => x.id === e.id)
      if (!a) return s
      const log = [...s.log, e]
      const tone = a.kind === 'fix' ? 'good' : a.kind === 'wrong' ? 'bad' : 'danger'
      const done = fixComplete(scenario, log) && !fixComplete(scenario, s.log)
      const text = done ? `${a.feedback} All fixes applied. Verify, then close the incident.` : a.feedback
      return { ...s, log, feedback: { tone, text } }
    }

    // Fixing doesn't auto-resolve: the player closes the ticket themselves,
    // which leaves room to verify the fix first (rewarded in scoring).
    case 'CLOSE_INCIDENT':
      if (s.phase !== 'acting' || !fixComplete(scenario, s.log)) return s
      return { ...s, phase: 'resolved', log: [...s.log, e], feedback: undefined }
  }
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

// Collapse runs of spaces so "df  -h " matches "df -h".
export const normalize = (input: string) => input.trim().replace(/\s+/g, ' ')

// What the fake shell prints for `input`, given which actions have been taken.
// `clear` and `history` are handled by the Terminal component because they
// only affect the on-screen transcript, not the simulated system.
export function runCommand(
  scenario: Scenario,
  input: string,
  taken: Set<string>,
): { output: string; evidence?: string; scripted?: boolean } {
  const cmd = normalize(input)
  const t = scenario.terminal
  if (!t) return { output: '' }

  if (cmd === 'help') {
    // Lists only exact-match commands. Regex entries are left for the player
    // to discover (see AUTHORING.md).
    const known = [...new Set(t.commands.flatMap((c) => (c.match ? [c.match] : [])))]
    return { output: ['Commands you might try here:', ...known.map((k) => `  ${k}`), '  clear, history'].join('\n') }
  }

  const hit = t.commands.find(
    (c) =>
      (c.match !== undefined ? normalize(c.match) === cmd : new RegExp(c.match_regex!).test(cmd)) &&
      (c.when_actions ?? []).every((a) => taken.has(a)),
  )
  if (hit) return { output: hit.output.replace(/\n$/, ''), evidence: hit.evidence, scripted: true }

  // Default is honest rather than realistic: a real command we didn't script
  // shouldn't pretend to be "command not found".
  const name = cmd.split(' ')[0]
  return { output: (t.unknown_output ?? '{cmd}: no simulated output for that here. Type help for commands that work.').replaceAll('{cmd}', name) }
}

// ---------------------------------------------------------------------------
// Derived from the log
// ---------------------------------------------------------------------------

export function actionsTaken(log: GameEvent[]): Set<string> {
  return new Set(log.flatMap((e) => (e.type === 'TAKE_ACTION' ? [e.id] : [])))
}

export const hintsUsed = (log: GameEvent[]) => log.filter((e) => e.type === 'REQUEST_HINT').length

// Evidence tags the player has seen. Replays the log in order because a
// command's output (and so its evidence) depends on which actions came before.
export function evidenceSeen(scenario: Scenario, log: GameEvent[]): Set<string> {
  const seen = new Set<string>()
  const taken = new Set<string>()
  for (const e of log) {
    let tag: string | undefined
    if (e.type === 'TAKE_ACTION') taken.add(e.id)
    if (e.type === 'RUN_COMMAND') tag = runCommand(scenario, e.input, taken).evidence
    if (e.type === 'OPEN_ARTIFACT') tag = artifacts(scenario).find((a) => a.kind === e.kind && a.name === e.name)?.evidence
    if (tag) seen.add(tag)
  }
  return seen
}

// Fixed when every action of ANY one solution path has been taken, in any order.
export function fixComplete(scenario: Scenario, log: GameEvent[]): boolean {
  const taken = actionsTaken(log)
  return scenario.solution_paths.some((path) => path.every((a) => taken.has(a)))
}
