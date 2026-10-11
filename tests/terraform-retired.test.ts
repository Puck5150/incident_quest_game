// @vitest-environment jsdom
// terraform-state-lock was retired (superseded by terraform-cancelled-ci-lock).
// Saved games that completed it must keep loading and scoring.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { isProgress, loadProgress, recordResult, unlockedTracks, type Progress } from '../src/game/progress.ts'

const RETIRED = 'terraform-state-lock'
const content = loadContent(path.resolve(import.meta.dirname, '../content'))
const items = [...content.scenarios, ...content.challenges, ...content.canvases, ...content.multis]
const saved: Progress = {
  version: 1,
  xp: 120,
  completed: { [RETIRED]: { bestScore: 100, completedAt: '2026-10-01T00:00:00.000Z', hintsUsed: 0, clean: true } },
  streak: { current: 1, best: 1 },
  settings: { theme: 'dark' },
}

describe('retired incident terraform-state-lock', () => {
  it('is gone from content; the replacement is published', () => {
    expect(items.some((i) => i.id === RETIRED)).toBe(false)
    const r = content.scenarios.find((s) => s.id === 'terraform-cancelled-ci-lock')
    expect(r).toBeDefined()
    expect(r!.published).not.toBe(false)
  })

  it('a save containing it still loads untouched, with no backup written', () => {
    expect(isProgress(saved)).toBe(true)
    localStorage.clear()
    localStorage.setItem('incident-quest:v1', JSON.stringify(saved))
    expect(loadProgress()).toEqual(saved)
    expect(Object.keys(localStorage).filter((k) => k.includes('backup'))).toEqual([])
  })

  it('still scores other incidents and keeps the entry', () => {
    const s = { total: 80, clean: true, hintsUsed: 0 }
    const { progress, gained } = recordResult(saved, 'terraform-cancelled-ci-lock', s, new Date('2026-10-10T00:00:00Z'))
    expect(gained).toBe(80)
    expect(progress.xp).toBe(200)
    expect(progress.completed[RETIRED]).toEqual(saved.completed[RETIRED])
  })

  it('does not change which tracks are unlocked', () => {
    expect(unlockedTracks(content.tracks, items, saved.completed)).toEqual(unlockedTracks(content.tracks, items, {}))
  })
})
