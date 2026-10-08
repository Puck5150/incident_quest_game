import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { evidenceSeen, newSession, step, transcript, type GameEvent, type Session } from '../src/game/engine.ts'
import { score } from '../src/game/scoring.ts'
import { takeAnswer } from '../src/components/terminal/session.ts'

const scenario = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.id === 'full-disk')!

const play = (...events: GameEvent[]): Session => events.reduce((s, e) => step(scenario, s, e), newSession())
const start: GameEvent = { type: 'START', at: 0 }
const run = (input: string): GameEvent => ({ type: 'RUN_COMMAND', input, at: 0 })
const answered: GameEvent = { type: 'ANSWERED', value: 'yes', at: 0 }

describe('ANSWERED', () => {
  it('is logged and changes nothing else', () => {
    const before = play(start, run('df -h'))
    const after = step(scenario, before, answered)
    expect(after.phase).toBe(before.phase)
    expect(after.feedback).toBe(before.feedback)
    expect(after.log).toEqual([...before.log, answered])
    expect(evidenceSeen(scenario, after.log)).toEqual(evidenceSeen(scenario, before.log))
    expect(transcript(scenario, after.log)).toEqual(transcript(scenario, before.log))
    expect(score(scenario, after.log)).toEqual(score(scenario, before.log))
    expect(step(scenario, newSession(), answered).log).toEqual([])
  })
})

describe('takeAnswer', () => {
  it('hands out recorded answers in order, then undefined', () => {
    const q: Extract<GameEvent, { type: 'ANSWERED' }>[] = [
      { type: 'ANSWERED', value: 'yes', at: 1 },
      { type: 'ANSWERED', value: 'no', at: 2 },
    ]
    expect(takeAnswer(q)).toBe('yes')
    expect(takeAnswer(q)).toBe('no')
    expect(takeAnswer(q)).toBeUndefined()
  })
})
