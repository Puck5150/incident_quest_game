import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { newSession, step, type GameEvent, type Session } from '../src/game/engine.ts'

const scenario = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find(
  (s) => s.id === 'full-disk',
)!

const play = (...events: GameEvent[]): Session => events.reduce((s, e) => step(scenario, s, e), newSession())
const start: GameEvent = { type: 'START', at: 0 }
const hyp = (id: string): GameEvent => ({ type: 'DECLARE_HYPOTHESIS', id, at: 0 })
const act = (id: string): GameEvent => ({ type: 'TAKE_ACTION', id, at: 0 })

describe('engine', () => {
  it('happy path resolves', () => {
    const s = play(start, hyp('disk-full'), act('truncate-log'), act('fix-logrotate'))
    expect(s.phase).toBe('resolved')
    expect(s.log).toHaveLength(4)
  })

  it('wrong hypothesis keeps the player investigating, with feedback', () => {
    const s = play(start, hyp('db-down'))
    expect(s.phase).toBe('investigating')
    expect(s.feedback?.tone).toBe('bad')
  })

  it('actions are locked until the hypothesis is confirmed', () => {
    const s = play(start, act('truncate-log'))
    expect(s.phase).toBe('investigating')
    expect(s.log).toHaveLength(1)
  })

  it('wrong and destructive actions do not resolve', () => {
    const s = play(start, hyp('disk-full'), act('rm-log'), act('reboot'), act('fix-logrotate'))
    expect(s.phase).toBe('acting')
    expect(s.feedback?.tone).toBe('good')
  })
})
