// Player progress: what's saved to localStorage, and everything computed
// from it (rank, unlocked tracks). Rank and unlocks are never stored, so they
// can't drift out of sync with the XP and completions they come from.

// zod/mini: same validation, a fraction of the bundle size. This is the only
// Zod code that ships to the browser (content is validated at build time).
import * as z from 'zod/mini'
import type { Scenario, Track } from '../schema/scenario.ts'
import type { Score } from './scoring.ts'

const KEY = 'incident-quest:v1'

// Saved data is untrusted: a player can edit it, and an old app version may
// have written a different shape. Anything that fails this is backed up, not
// silently thrown away.
const ProgressSchema = z.object({
  version: z.literal(1),
  xp: z.int().check(z.minimum(0)),
  completed: z.record(
    z.string(),
    z.object({ bestScore: z.number(), completedAt: z.string(), hintsUsed: z.number(), clean: z.boolean() }),
  ),
  // Consecutive incidents resolved "clean": no hints, no destructive actions.
  streak: z.object({ current: z.number(), best: z.number() }),
  settings: z.object({ theme: z.enum(['dark', 'light']) }),
})

export type Progress = z.infer<typeof ProgressSchema>

export const newProgress = (): Progress => ({
  version: 1,
  xp: 0,
  completed: {},
  streak: { current: 0, best: 0 },
  settings: { theme: 'dark' },
})

// Storage access can throw (private browsing, blocked site data). The game
// still works, it just won't remember anything.
export function loadProgress(storage: Storage = localStorage): Progress {
  try {
    const raw = storage.getItem(KEY)
    if (raw === null) return newProgress()
    const parsed = ProgressSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
    storage.setItem(`${KEY}:backup-${Date.now()}`, raw)
  } catch {
    // fall through to a fresh save
  }
  return newProgress()
}

export function saveProgress(p: Progress, storage: Storage = localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify(p))
  } catch {
    // see loadProgress
  }
}

// Replays only earn the improvement over your best score, so grinding an
// easy incident can't inflate XP.
export function recordResult(
  p: Progress,
  scenarioId: string,
  s: Score,
  now: Date,
): { progress: Progress; gained: number } {
  const prev = p.completed[scenarioId]
  const gained = Math.max(0, s.total - (prev?.bestScore ?? 0))
  const current = s.clean ? p.streak.current + 1 : 0
  return {
    gained,
    progress: {
      ...p,
      xp: p.xp + gained,
      completed: {
        ...p.completed,
        [scenarioId]: {
          bestScore: Math.max(s.total, prev?.bestScore ?? 0),
          completedAt: now.toISOString(),
          hintsUsed: s.hintsUsed,
          clean: s.clean || !!prev?.clean,
        },
      },
      streak: { current, best: Math.max(current, p.streak.best) },
    },
  }
}

// ponytail: thresholds sized for the six MVP incidents (~1,100 base XP total).
// Retune when more content lands.
export const RANKS = [
  { name: 'Help Desk', xp: 0 },
  { name: 'Support Engineer', xp: 100 },
  { name: 'Systems Engineer', xp: 300 },
  { name: 'Senior Engineer', xp: 600 },
  { name: 'Staff Engineer', xp: 1000 },
  { name: 'Principal Engineer', xp: 1500 },
] as const

export function rankFor(xp: number) {
  const i = RANKS.findLastIndex((r) => xp >= r.xp)
  return { rank: RANKS[i], next: RANKS[i + 1] as (typeof RANKS)[number] | undefined }
}

// A track unlocks once every track it requires has at least one completed
// incident. A required track with no content yet can't block anything.
export function unlockedTracks(tracks: Track[], scenarios: Scenario[], completed: Progress['completed']): Set<string> {
  const done = (trackId: string) => {
    const inTrack = scenarios.filter((s) => s.track === trackId)
    return inTrack.length === 0 || inTrack.some((s) => completed[s.id])
  }
  return new Set(tracks.filter((t) => t.requires.every(done)).map((t) => t.id))
}
