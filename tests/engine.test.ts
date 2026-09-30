import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import {
  evidenceSeen,
  hintsUsed,
  newSession,
  runCommand,
  step,
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

  it('help lists exact-match commands once each', () => {
    const out = runCommand(scenario, 'help', none).output
    expect(out.match(/df -h/g)).toHaveLength(1)
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
