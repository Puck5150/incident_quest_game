// The game rules for one incident, as a pure function:
//   step(scenario, session, event) -> new session
//
// UI components never decide anything themselves; they send events here.
// Every accepted event is appended to `log`, which later drives scoring and
// the "what you did" section of the debrief.

import type { Scenario } from '../schema/scenario.ts'

export type Phase = 'briefing' | 'investigating' | 'acting' | 'resolved'

export type GameEvent =
  | { type: 'START'; at: number }
  | { type: 'DECLARE_HYPOTHESIS'; id: string; at: number }
  | { type: 'TAKE_ACTION'; id: string; at: number }

export type Feedback = { tone: 'good' | 'bad' | 'danger'; text: string }

export type Session = {
  phase: Phase
  log: GameEvent[]
  feedback?: Feedback
}

export const newSession = (): Session => ({ phase: 'briefing', log: [] })

export function step(scenario: Scenario, s: Session, e: GameEvent): Session {
  // Events that don't fit the current phase are ignored rather than thrown:
  // a double-click shouldn't crash the game.
  switch (e.type) {
    case 'START':
      if (s.phase !== 'briefing') return s
      return { ...s, phase: 'investigating', log: [...s.log, e], feedback: undefined }

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
      return { phase: isResolved(scenario, log) ? 'resolved' : 'acting', log, feedback: { tone, text: a.feedback } }
    }
  }
}

export function actionsTaken(log: GameEvent[]): Set<string> {
  return new Set(log.flatMap((e) => (e.type === 'TAKE_ACTION' ? [e.id] : [])))
}

// Resolved when every action of ANY one solution path has been taken, in any order.
function isResolved(scenario: Scenario, log: GameEvent[]): boolean {
  const taken = actionsTaken(log)
  return scenario.solution_paths.some((path) => path.every((a) => taken.has(a)))
}
