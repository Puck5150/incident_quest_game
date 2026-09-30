// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadProgress,
  newProgress,
  rankFor,
  recordResult,
  saveProgress,
  unlockedTracks,
} from '../src/game/progress.ts'
import type { Score } from '../src/game/scoring.ts'
import type { Scenario, Track } from '../src/schema/scenario.ts'

const result = (total: number, clean = true): Score => ({
  lines: [],
  total,
  elapsedMs: 0,
  hintsUsed: clean ? 0 : 1,
  mistakes: { wrongHypotheses: 0, wrongActions: 0, destructive: 0 },
  methodical: true,
  verified: true,
  clean,
})
const now = new Date('2026-09-30T12:00:00Z')

describe('recordResult', () => {
  it('first clear awards full score and starts the streak', () => {
    const { progress, gained } = recordResult(newProgress(), 'a', result(150), now)
    expect(gained).toBe(150)
    expect(progress.xp).toBe(150)
    expect(progress.streak).toEqual({ current: 1, best: 1 })
  })

  it('replays only award improvement over the best score', () => {
    let p = recordResult(newProgress(), 'a', result(100), now).progress
    const worse = recordResult(p, 'a', result(80), now)
    expect(worse.gained).toBe(0)
    expect(worse.progress.completed.a.bestScore).toBe(100)
    p = recordResult(p, 'a', result(130), now).progress
    expect(p.xp).toBe(130)
  })

  it('a non-clean resolution resets the current streak but keeps the best', () => {
    let p = recordResult(newProgress(), 'a', result(100), now).progress
    p = recordResult(p, 'b', result(100), now).progress
    p = recordResult(p, 'c', result(100, false), now).progress
    expect(p.streak).toEqual({ current: 0, best: 2 })
  })
})

describe('ranks', () => {
  it('maps XP to rank and next rank', () => {
    expect(rankFor(0).rank.name).toBe('Help Desk')
    expect(rankFor(299).next?.xp).toBe(300)
    expect(rankFor(5000).rank.name).toBe('Principal Engineer')
    expect(rankFor(5000).next).toBeUndefined()
  })
})

describe('unlocks', () => {
  const tracks: Track[] = [
    { id: 'linux', name: 'Linux', requires: [] },
    { id: 'containers', name: 'Containers', requires: ['linux'] },
    { id: 'micro', name: 'Micro', requires: ['containers', 'empty'] },
    { id: 'empty', name: 'Empty', requires: [] },
  ]
  const scenarios = [
    { id: 'l1', track: 'linux' },
    { id: 'c1', track: 'containers' },
  ] as Scenario[]

  it('a track unlocks when each required track has a completion; empty tracks never block', () => {
    expect(unlockedTracks(tracks, scenarios, {})).toEqual(new Set(['linux', 'empty']))
    const done = { l1: { bestScore: 1, completedAt: '', hintsUsed: 0, clean: true } }
    expect(unlockedTracks(tracks, scenarios, done)).toEqual(new Set(['linux', 'containers', 'empty']))
    expect(unlockedTracks(tracks, scenarios, { ...done, c1: done.l1 }).has('micro')).toBe(true)
  })
})

describe('storage', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips through localStorage', () => {
    const p = recordResult(newProgress(), 'a', result(150), now).progress
    saveProgress(p)
    expect(loadProgress()).toEqual(p)
  })

  it('backs up corrupt data instead of silently discarding it', () => {
    localStorage.setItem('incident-quest:v1', '{"version":1,"xp":"lots"}')
    expect(loadProgress()).toEqual(newProgress())
    const backup = Object.keys(localStorage).find((k) => k.startsWith('incident-quest:v1:backup-'))
    expect(localStorage.getItem(backup!)).toBe('{"version":1,"xp":"lots"}')
  })

  it('survives storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } } as unknown as Storage
    expect(loadProgress(broken)).toEqual(newProgress())
    expect(() => saveProgress(newProgress(), broken)).not.toThrow()
  })
})
