// The game rules for one incident, as a pure function:
//   step(scenario, session, event) -> new session
//
// UI components never decide anything themselves; they send events here.
// Every accepted event is appended to `log`. The log holds only what the
// player DID; anything derived (evidence found, hints used) is recomputed
// from it by the helpers at the bottom, so there's one source of truth.

import { artifacts } from '../schema/constants.ts'
import type { ArtifactKind, Scenario } from '../schema/scenario.ts'
import { atStage, sinceStageStart, stageAt, stageCount } from '../schema/stages.ts'
import { isShellPrompt, readsFileOnDisk } from './paths.ts'

export type Phase = 'briefing' | 'investigating' | 'acting' | 'resolved'

export type GameEvent =
  | { type: 'START'; at: number }
  | { type: 'RUN_COMMAND'; input: string; at: number }
  // The real shell ran these scripted commands inside a pipeline or script
  // (each as written in the scenario). They count like typing them alone.
  | { type: 'SHELL_RAN'; commands: string[]; at: number }
  // The player saved a file in the editor (path, new content). Recorded so a
  // remounted terminal can replay the edit; no effect on game state.
  | { type: 'EDITED'; path: string; content: string; at: number }
  // The player answered an interactive prompt (terraform's "Enter a value:").
  // Recorded so a remounted terminal can replay it; no effect on game state.
  | { type: 'ANSWERED'; value: string; at: number }
  | { type: 'OPEN_ARTIFACT'; kind: ArtifactKind; name: string; at: number }
  | { type: 'REQUEST_HINT'; at: number }
  | { type: 'DECLARE_HYPOTHESIS'; id: string; at: number }
  | { type: 'TAKE_ACTION'; id: string; at: number }
  | { type: 'CLOSE_INCIDENT'; at: number }

// `reopened`: a multi-stage incident moved to its next stage on close-out.
export type Feedback = { tone: 'good' | 'bad' | 'danger' | 'reopened'; text: string }

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

// Multi-stage incidents: everything below works on the current stage as a
// plain scenario (schema/stages.ts); the stage itself comes from the log.
export function step(scenario: Scenario, s: Session, e: GameEvent): Session {
  // Events that don't fit the current phase are ignored rather than thrown:
  // a double-click shouldn't crash the game.
  const working = s.phase === 'investigating' || s.phase === 'acting'
  const stage = stageAt(s.log)
  const cur = atStage(scenario, stage)
  switch (e.type) {
    case 'START':
      if (s.phase !== 'briefing') return s
      return { ...s, phase: 'investigating', log: [...s.log, e], feedback: undefined }

    // Investigation is allowed while acting too, so the player can verify a fix.
    // A command that matches an action's match_regex takes that action, but
    // only once the root cause is named: the same gate as the action buttons.
    case 'RUN_COMMAND': {
      if (!working) return s
      const ran = { ...s, log: [...s.log, e] }
      const a = actionFor(cur, e.input)
      if (!a) return ran
      if (s.phase === 'investigating') return { ...ran, feedback: { tone: 'bad', text: NOT_YET } }
      return step(scenario, ran, { type: 'TAKE_ACTION', id: a.id, at: e.at })
    }
    case 'OPEN_ARTIFACT':
    case 'SHELL_RAN':
    case 'EDITED':
    case 'ANSWERED':
      return working ? { ...s, log: [...s.log, e] } : s

    case 'REQUEST_HINT':
      // Each stage has its own three tiers.
      return working && hintsUsed(sinceStageStart(s.log)) < HINT_TIERS.length ? { ...s, log: [...s.log, e] } : s

    case 'DECLARE_HYPOTHESIS': {
      if (s.phase !== 'investigating') return s
      const h = cur.hypotheses.find((x) => x.id === e.id)
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
      const a = cur.actions.find((x) => x.id === e.id)
      if (!a) return s
      const log = [...s.log, e]
      const tone = a.kind === 'fix' ? 'good' : a.kind === 'wrong' ? 'bad' : 'danger'
      const done = fixComplete(cur, log) && !fixComplete(cur, s.log)
      const text = done ? `${a.feedback} All fixes applied. Verify, then close the incident.` : a.feedback
      return { ...s, log, feedback: { tone, text } }
    }

    // Fixing doesn't auto-resolve: the player closes the ticket themselves,
    // which leaves room to verify the fix first (rewarded in scoring). In a
    // multi-stage incident, closing a stage reopens it into the next one.
    case 'CLOSE_INCIDENT': {
      if (s.phase !== 'acting' || !fixComplete(cur, s.log)) return s
      const log = [...s.log, e]
      if (stage + 1 < stageCount(scenario))
        return { phase: 'investigating', log, feedback: { tone: 'reopened', text: scenario.stages![stage].update } }
      return { ...s, phase: 'resolved', log, feedback: undefined }
    }
  }
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

// Collapse runs of spaces so "df  -h " matches "df -h".
export const normalize = (input: string) => input.trim().replace(/\s+/g, ' ')

// Whether a line uses shell operators (pipes, lists, redirection) outside quotes.
export function hasShellOperators(cmd: string): boolean {
  let quote: string | undefined
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = undefined
    } else if (ch === '"' || ch === "'") quote = ch
    else if ('|;&<>'.includes(ch)) return true
  }
  return false
}

export const NOT_YET = 'Not run: that changes the system. Declare a root cause first, then fix it.'

// The action a typed command takes, if any (first match wins).
export const actionFor = (scenario: Scenario, input: string) =>
  scenario.actions.find((a) => a.match_regex !== undefined && new RegExp(a.match_regex).test(normalize(input)))

// What the fake shell prints for `input`, given which actions have been taken.
// `clear` and `history` are handled by the Terminal component because they
// only affect the on-screen transcript, not the simulated system.
export function runCommand(
  scenario: Scenario,
  input: string,
  taken: Set<string>,
): { output: string; evidence?: string; scripted?: boolean; command?: string } {
  const cmd = normalize(input)
  const t = scenario.terminal
  if (!t) return { output: '' }

  if (cmd === 'help') {
    // Every investigation command is listed: exact ones as written, pattern
    // ones by their example. (Typed fixes aren't: they're action buttons.)
    const known = [...new Set(t.commands.flatMap((c) => (c.match ? [c.match] : c.example ? [c.example] : [])))]
    const tf = scenario.terraform ? [
          'init',
          'validate',
          'plan',
          'apply',
          'destroy',
          'show',
          'state list',
          'state show ADDRESS',
          'state mv SOURCE DESTINATION',
          'state rm ADDRESS',
          'import ADDRESS ID',
          'taint ADDRESS',
          'untaint ADDRESS',
          'refresh',
          'force-unlock LOCK_ID',
          'output',
          'workspace list',
          'workspace new NAME',
          'workspace select NAME',
          'workspace delete NAME',
          'version',
        ].map((c) => `terraform ${c}`) : []
    return { output: ['Commands you might try here:', ...[...known, ...tf].map((k) => `  ${k}`), '  clear, history'].join('\n') }
  }

  // A pattern command answers a single command; a pipeline or list that
  // merely starts with one is the real shell's to run (the tool inside it
  // still answers from the pattern there). Patterns written for a pipeline
  // (their example has one) still answer it.
  const compound = hasShellOperators(cmd)
  const hit = t.commands.find(
    (c) =>
      (c.match !== undefined ? normalize(c.match) === cmd : (!compound || hasShellOperators(c.example ?? '')) && new RegExp(c.match_regex!).test(cmd)) &&
      (c.when_actions ?? []).every((a) => taken.has(a)),
  )
  // `command`: the scripted command as written (its match, or a pattern's example).
  if (hit) return { output: hit.output.replace(/\n$/, ''), evidence: hit.evidence, scripted: true, command: hit.match ?? hit.example }

  // Default is honest rather than realistic: a real command we didn't script
  // shouldn't pretend to be "command not found".
  const name = cmd.split(' ')[0]
  return { output: (t.unknown_output ?? '{cmd}: no simulated output for that here. Type help for commands that work.').replaceAll('{cmd}', name) }
}

// Tab completion, bash-style. Draws only on what `help` already reveals
// (exact commands and pattern commands' examples) plus the scenario's file and
// log paths, so it never gives away typed fixes.
export function complete(scenario: Scenario, input: string): { input: string; options?: string[] } {
  const exact = (scenario.terminal?.commands ?? []).flatMap((c) => (c.match ? [normalize(c.match)] : c.example ? [normalize(c.example)] : []))
  const words = input.replace(/^\s+/, '').split(' ')
  const word = words.at(-1)!
  const first = words.length === 1
  const vocabulary = first
    ? [...exact.map((c) => c.split(' ')[0]), 'help', 'clear', 'history']
    : [
        ...exact.flatMap((c) => c.split(' ').slice(1)),
        ...[...(scenario.files ?? []).map((x) => x.path), ...(scenario.logs ?? []).map((x) => x.name)].filter((p) => p.startsWith('/') && !p.includes(' ')),
      ]
  if (!word && first) return { input } // nothing typed yet: nothing to complete
  const options = [...new Set(vocabulary)].filter((v) => v.startsWith(word)).sort()
  if (options.length === 0) return { input }
  const head = input.slice(0, input.length - word.length)
  if (options.length === 1) return { input: head + options[0] + (options[0].endsWith('/') ? '' : ' ') }
  const common = options.reduce(commonPrefix)
  return common.length > word.length ? { input: head + common } : { input, options }
}

function commonPrefix(a: string, b: string): string {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return a.slice(0, i)
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
  let cur = scenario
  let stage = 0
  for (const e of log) {
    let tag: string | undefined
    if (e.type === 'TAKE_ACTION') taken.add(e.id)
    if (e.type === 'CLOSE_INCIDENT') cur = atStage(scenario, ++stage)
    if (e.type === 'RUN_COMMAND') tag = runCommand(cur, e.input, taken).evidence
    if (e.type === 'SHELL_RAN') e.commands.forEach((c) => {
      if (c.startsWith('evidence:')) return void seen.add(c.slice(9))
      const t = runCommand(cur, c, taken).evidence
      if (t) seen.add(t)
    })
    if (e.type === 'OPEN_ARTIFACT') tag = artifacts(cur).find((a) => a.kind === e.kind && a.name === e.name)?.evidence
    if (tag) seen.add(tag)
  }
  return seen
}

// What the terminal prints for a command typed after the events in `before`.
// The live terminal and a rebuilt transcript both use this, so they agree.
export function terminalOutput(scenario: Scenario, input: string, before: GameEvent[]): string {
  const cmd = normalize(input)
  if (cmd === 'history')
    return [...commandsRun(before), cmd].map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join('\n')
  const cur = atStage(scenario, stageAt(before))
  const ran = runCommand(cur, cmd, actionsTaken(before))
  // A command that takes an action reports the result in the terminal, so
  // it's visible without looking away.
  const action = ran.scripted ? undefined : actionFor(cur, cmd)
  if (!action) return ran.output
  return namedRootCause(scenario, before) ? action.feedback : NOT_YET
}

// Whether the player has named this stage's root cause (so fixes count).
export function namedRootCause(scenario: Scenario, log: GameEvent[]): boolean {
  const cur = atStage(scenario, stageAt(log))
  return sinceStageStart(log).some((e) => e.type === 'DECLARE_HYPOTHESIS' && cur.hypotheses.find((h) => h.id === e.id)?.correct)
}

// Whether the engine answers this line itself (help, history, clear, a
// scripted command, a typed fix) rather than the real shell (PLAN_TERMINAL.md).
// Everything the engine answers counts for evidence and scoring exactly as
// before; the shell handles the rest: pipes, files, cd, variables, tools.
export function engineHandles(scenario: Scenario, input: string, before: GameEvent[]): boolean {
  const cmd = normalize(input)
  if (cmd === 'help' || cmd === 'history' || cmd === 'clear') return true
  const cur = atStage(scenario, stageAt(before))
  if (!isShellPrompt(scenario) || actionFor(cur, cmd)) return true
  // Reading a file that's on disk: the real shell shows what's really there,
  // edits included. (It still counts as evidence: see evidenceSeen.)
  if (readsFileOnDisk(cur, cmd)) return false
  return !!runCommand(cur, cmd, actionsTaken(before)).scripted
}

export const commandsRun = (log: GameEvent[]) => log.flatMap((e) => (e.type === 'RUN_COMMAND' ? [normalize(e.input)] : []))

// The terminal's transcript, rebuilt from the log (so it survives a remount,
// such as switching between incidents in a shift). `clear` empties it.
export function transcript(scenario: Scenario, log: GameEvent[]): { input: string; output: string }[] {
  let lines: { input: string; output: string }[] = []
  log.forEach((e, i) => {
    if (e.type !== 'RUN_COMMAND') return
    const input = normalize(e.input)
    lines = input === 'clear' ? [] : [...lines, { input, output: terminalOutput(scenario, input, log.slice(0, i)) }]
  })
  return lines
}

// The scripted commands the player ran, as written in the scenario (so a typed
// variant of a pattern command maps to its example). For the command breakdown.
export function commandsHit(scenario: Scenario, log: GameEvent[]): Set<string> {
  const hit = new Set<string>()
  log.forEach((e, i) => {
    if (e.type === 'SHELL_RAN') return e.commands.forEach((c) => c.startsWith('evidence:') || hit.add(c))
    if (e.type !== 'RUN_COMMAND') return
    const before = log.slice(0, i)
    const cmd = runCommand(atStage(scenario, stageAt(before)), e.input, actionsTaken(before)).command
    if (cmd) hit.add(cmd)
  })
  return hit
}

// Fixed when every action of ANY one solution path has been taken, in any order.
export function fixComplete(scenario: Scenario, log: GameEvent[]): boolean {
  const taken = actionsTaken(log)
  return scenario.solution_paths.some((path) => path.every((a) => taken.has(a)))
}
