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
  relaxed: false,
  inShift: false,
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
    expect(rankFor(0).rank.name).toBe('Recruit')
    expect(rankFor(599).next?.xp).toBe(600)
    expect(rankFor(9000).rank.name).toBe('Ops Director')
    expect(rankFor(9000).next).toBeUndefined()
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

  it('requires_any unlocks after any one required track has a completion; empty tracks never satisfy it', () => {
    const anyOf: Track[] = [
      { id: 'aws', name: 'AWS', requires: [] },
      { id: 'azure', name: 'Azure', requires: [] },
      { id: 'gcp', name: 'GCP', requires: [] }, // no content
      { id: 'design', name: 'Design', requires: ['aws', 'azure', 'gcp'], requires_any: true },
    ]
    const items = [
      { id: 'a1', track: 'aws' },
      { id: 'z1', track: 'azure' },
    ]
    const c = { bestScore: 1, completedAt: '', hintsUsed: 0, clean: true }
    expect(unlockedTracks(anyOf, items, {}).has('design')).toBe(false)
    expect(unlockedTracks(anyOf, items, { z1: c }).has('design')).toBe(true)
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

  // Saved data is untrusted: anything that doesn't have the right shape is
  // backed up and replaced, never half-loaded.
  const valid = {
    version: 1,
    xp: 40,
    completed: { a: { bestScore: 40, completedAt: '2026-09-30', hintsUsed: 0, clean: true, providers: ['aws'] } },
    streak: { current: 1, best: 1 },
    settings: { theme: 'light', motion: 'reduce', relaxed: true, callsign: 'NIGHTOWL-7', sound: true },
  }
  const loads = (patch: (v: typeof valid & Record<string, unknown>) => void) => {
    const v = structuredClone(valid) as typeof valid & Record<string, unknown>
    patch(v)
    localStorage.setItem('incident-quest:v1', JSON.stringify(v))
    return JSON.stringify(loadProgress()) !== JSON.stringify(newProgress())
  }

  it('accepts a full save, and old saves without the later optional fields', () => {
    expect(loads(() => {})).toBe(true)
    expect(
      loads((v) => {
        delete (v.settings as Partial<typeof valid.settings>).motion
        delete (v.settings as Partial<typeof valid.settings>).relaxed
        delete (v.settings as Partial<typeof valid.settings>).callsign
        delete (v.settings as Partial<typeof valid.settings>).sound
        delete (v.completed.a as Partial<typeof valid.completed.a>).providers
      }),
    ).toBe(true)
  })

  it.each([
    ['wrong version', (v: Record<string, unknown>) => (v.version = 2)],
    ['negative xp', (v: Record<string, unknown>) => (v.xp = -1)],
    ['fractional xp', (v: Record<string, unknown>) => (v.xp = 1.5)],
    ['completed is a list', (v: Record<string, unknown>) => (v.completed = [])],
    ['completion missing a field', (v: Record<string, unknown>) => delete (v.completed as Record<string, Partial<typeof valid.completed.a>>).a.clean],
    ['providers not strings', (v: Record<string, unknown>) => ((v.completed as typeof valid.completed).a.providers = [1 as unknown as string])],
    ['streak missing', (v: Record<string, unknown>) => delete v.streak],
    ['unknown theme', (v: Record<string, unknown>) => ((v.settings as typeof valid.settings).theme = 'sepia')],
    ['unknown motion', (v: Record<string, unknown>) => ((v.settings as typeof valid.settings).motion = 'fast')],
    ['relaxed not a boolean', (v: Record<string, unknown>) => ((v.settings as Record<string, unknown>).relaxed = 'yes')],
    ['callsign with markup', (v: Record<string, unknown>) => ((v.settings as Record<string, unknown>).callsign = '<b>owl</b>')],
    ['sound not a boolean', (v: Record<string, unknown>) => ((v.settings as Record<string, unknown>).sound = 1)],
    ['empty callsign', (v: Record<string, unknown>) => ((v.settings as Record<string, unknown>).callsign = '')],
    ['not an object', (v: Record<string, unknown>) => Object.keys(v).forEach((k) => delete v[k])],
  ])('rejects a save with %s', (_, patch) => {
    expect(loads(patch)).toBe(false)
  })

  it('survives storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } } as unknown as Storage
    expect(loadProgress(broken)).toEqual(newProgress())
    expect(() => saveProgress(newProgress(), broken)).not.toThrow()
  })
})
