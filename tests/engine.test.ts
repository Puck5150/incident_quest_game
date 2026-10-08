import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import {
  actionsTaken,
  complete,
  evidenceSeen,
  hintsUsed,
  newSession,
  runCommand,
  step,
  terminalOutput,
  transcript,
  type GameEvent,
  type Session,
} from '../src/game/engine.ts'

const scenario = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find(
  (s) => s.id === 'full-disk',
)!

const play = (...events: GameEvent[]): Session => events.reduce((s, e) => step(scenario, s, e), newSession())
const start: GameEvent = { type: 'START', at: 0 }
const hyp = (id: string): GameEvent => ({ type: 'DECLARE_HYPOTHESIS', id, at: 0 })
const act = (id: string): GameEvent => ({ type: 'TAKE_ACTION', id, at: 0 })
const run = (input: string): GameEvent => ({ type: 'RUN_COMMAND', input, at: 0 })
const open = (kind: 'log' | 'file', name: string): GameEvent => ({ type: 'OPEN_ARTIFACT', kind, name, at: 0 })
const hint: GameEvent = { type: 'REQUEST_HINT', at: 0 }
const close: GameEvent = { type: 'CLOSE_INCIDENT', at: 0 }

describe('incident flow', () => {
  it('a typed fix command takes the action once the root cause is named', () => {
    const s = play(start, hyp('disk-full'), run(': > /var/log/app/app.log'))
    expect(actionsTaken(s.log).has('truncate-log')).toBe(true)
    expect(s.log.map((e) => e.type).slice(-2)).toEqual(['RUN_COMMAND', 'TAKE_ACTION'])
    expect(s.feedback?.tone).toBe('good')
  })

  it('typed commands that change the system are refused before the hypothesis', () => {
    const s = play(start, run('sudo reboot'))
    expect(actionsTaken(s.log).size).toBe(0)
    expect(s.feedback?.text).toMatch(/Declare a root cause first/)
  })

  it('a typed destructive command counts like the button', () => {
    const s = play(start, hyp('disk-full'), run('sudo  reboot '))
    expect(actionsTaken(s.log).has('reboot')).toBe(true)
    expect(s.feedback?.tone).toBe('danger')
  })

  it('happy path: fix, then close', () => {
    const s = play(start, hyp('disk-full'), act('truncate-log'), act('fix-logrotate'))
    expect(s.phase).toBe('acting')
    expect(s.feedback?.text).toMatch(/close the incident/)
    expect(play(start, hyp('disk-full'), act('truncate-log'), act('fix-logrotate'), close).phase).toBe('resolved')
  })

  it('cannot close before the fix is complete', () => {
    expect(play(start, hyp('disk-full'), act('truncate-log'), close).phase).toBe('acting')
  })

  it('wrong hypothesis keeps the player investigating, with feedback', () => {
    const s = play(start, hyp('db-down'))
    expect(s.phase).toBe('investigating')
    expect(s.feedback?.tone).toBe('bad')
  })

  it('actions are locked until the hypothesis is confirmed', () => {
    const s = play(start, act('truncate-log'))
    expect(s.log).toHaveLength(1)
  })

  it('wrong and destructive actions do not complete the fix', () => {
    const s = play(start, hyp('disk-full'), act('rm-log'), act('reboot'), act('fix-logrotate'), close)
    expect(s.phase).toBe('acting')
  })

  it('tools are unavailable before the incident is taken', () => {
    expect(play(run('df -h'), hint).log).toHaveLength(0)
  })
})

describe('terminal', () => {
  const none = new Set<string>()

  it('matches exact commands ignoring extra whitespace', () => {
    const r = runCommand(scenario, '  df   -h ', none)
    expect(r.output).toMatch(/100% \/$/m)
    expect(r.evidence).toBe('disk-full')
  })

  it('shows the post-fix variant once its action is taken', () => {
    expect(runCommand(scenario, 'df -h', new Set(['truncate-log'])).output).toMatch(/28% \/$/m)
  })

  it('matches regex commands', () => {
    expect(runCommand(scenario, 'du -sh /var/log/*', none).output).toMatch(/29G/)
  })

  it('unknown commands say so, using the command name', () => {
    expect(runCommand(scenario, 'foo --bar', none).output).toMatch(/^foo: no simulated output/)
  })

  it('help lists every investigation command once: exact ones, and pattern ones by their example', () => {
    const out = runCommand(scenario, 'help', none).output
    expect(out.match(/df -h/g)).toHaveLength(1)
    expect(out).toMatch(/journalctl -u checkout/) // a pattern command, listed by its example
    expect(out).not.toMatch(/truncate/) // typed fixes are action buttons, not listed
  })
})

describe('derived from the log', () => {
  it('collects evidence from commands and opened artifacts', () => {
    const s = play(start, run('df -h'), open('log', 'journalctl -u checkout'), open('file', '/etc/logrotate.d/app'))
    expect(evidenceSeen(scenario, s.log)).toEqual(new Set(['disk-full', 'write-failure', 'rotate-typo']))
  })

  it('post-fix output carries no evidence', () => {
    const s = play(start, hyp('disk-full'), act('truncate-log'), run('df -h'))
    expect(evidenceSeen(scenario, s.log).has('disk-full')).toBe(false)
  })

  it('hints cap at three tiers', () => {
    expect(hintsUsed(play(start, hint, hint, hint, hint).log)).toBe(3)
  })
})

describe('tab completion', () => {
  it('completes a unique command name and adds a space', () => {
    expect(complete(scenario, 'ta')).toEqual({ input: 'tail ' })
  })

  it('lists candidates when there is no common prefix to add', () => {
    expect(complete(scenario, 'c')).toEqual({ input: 'c', options: ['cat', 'clear'] })
  })

  it('completes paths from scripted commands and the scenario\'s files', () => {
    expect(complete(scenario, 'cat /e')).toEqual({ input: 'cat /etc/logrotate.d/app ' })
    expect(complete(scenario, 'tail /var/log/n')).toEqual({ input: 'tail /var/log/nginx/access.log ' })
  })

  it('extends to the common prefix first', () => {
    expect(complete(scenario, 'ls -lh /v').input).toBe('ls -lh /var/log/')
  })

  it('completes pattern commands from their example, but never typed fixes', () => {
    expect(complete(scenario, 'journ').input).toBe('journalctl ') // a pattern command's example
    expect(complete(scenario, 'trunc')).toEqual({ input: 'trunc' }) // a typed fix
    expect(complete(scenario, 'reb')).toEqual({ input: 'reb' })
  })

  it('does nothing on an empty prompt', () => {
    expect(complete(scenario, '')).toEqual({ input: '' })
  })
})

describe('terminal transcript from the log', () => {
  const truncate = run('truncate -s 0 /var/log/app/app.log')

  it('rebuilds exactly what the live terminal printed, in order', () => {
    const log = play(start, run('df -h'), truncate, hyp('disk-full'), truncate, run('df -h'), run('history')).log
    const lines = transcript(scenario, log)
    expect(lines.map((l) => l.input)).toEqual(['df -h', 'truncate -s 0 /var/log/app/app.log', 'truncate -s 0 /var/log/app/app.log', 'df -h', 'history'])
    expect(lines[0].output).toMatch(/100%/)
    expect(lines[1].output).toMatch(/^Not run/) // before the root cause was named
    expect(lines[2].output).toMatch(/Output redirection truncates/) // after: the action's feedback
    expect(lines[3].output).toMatch(/28%/) // the fixed state
    expect(lines[4].output).toMatch(/5 {2}history$/)
    // Each line matches what terminalOutput gives for the log before it.
    const runs = log.flatMap((e, i) => (e.type === 'RUN_COMMAND' ? [i] : []))
    runs.forEach((i, n) => expect(lines[n].output).toBe(terminalOutput(scenario, (log[i] as { input: string }).input, log.slice(0, i))))
  })

  it('clear empties it', () => {
    const log = play(start, run('df -h'), run('clear'), run('help')).log
    expect(transcript(scenario, log).map((l) => l.input)).toEqual(['help'])
  })
})

describe('EDITED', () => {
  it('is logged and changes nothing else', () => {
    const before = play(start, run('df -h'))
    const after = step(scenario, before, { type: 'EDITED', path: '/tmp/x', content: 'hi', at: 5 })
    expect(after.phase).toBe(before.phase)
    expect(after.feedback).toBe(before.feedback)
    expect(after.log).toEqual([...before.log, { type: 'EDITED', path: '/tmp/x', content: 'hi', at: 5 }])
    expect(evidenceSeen(scenario, after.log)).toEqual(evidenceSeen(scenario, before.log))
    expect(step(scenario, newSession(), { type: 'EDITED', path: '/tmp/x', content: 'hi', at: 5 }).log).toEqual([])
  })
})
