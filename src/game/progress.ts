// Player progress: what's saved to localStorage, and everything computed
// from it (rank, unlocked tracks). Rank and unlocks are never stored, so they
// can't drift out of sync with the XP and completions they come from.

import type { Track } from '../schema/scenario.ts'

const KEY = 'incident-quest:v1'

export type Progress = {
  version: 1
  xp: number
  completed: Record<
    string,
    {
      bestScore: number
      completedAt: string
      hintsUsed: number
      clean: boolean
      // "Pick your cloud" challenges: which clouds it's been completed on. Optional so old saves stay valid.
      providers?: string[]
    }
  >
  // Consecutive incidents resolved "clean": no hints, no destructive actions.
  streak: { current: number; best: number }
  // `motion` and `relaxed` were added after v1 shipped, so they're optional: old saves stay valid.
  settings: { theme: 'dark' | 'light'; motion?: 'system' | 'reduce'; relaxed?: boolean }
}

// Saved data is untrusted: a player can edit it, and an old app version may
// have written a different shape. Anything that fails this is backed up, not
// silently thrown away. Hand-written rather than Zod so no Zod code is in the
// startup bundle (content is validated at build time; only the preview page
// loads Zod). tests/progress.test.ts pins down every rule.
type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const optional = (x: unknown, ok: (v: unknown) => boolean) => x === undefined || ok(x)
const oneOf = (...xs: unknown[]) => (v: unknown) => xs.includes(v)

const isCompletion = (c: unknown) =>
  isObj(c) &&
  isNum(c.bestScore) &&
  typeof c.completedAt === 'string' &&
  isNum(c.hintsUsed) &&
  typeof c.clean === 'boolean' &&
  optional(c.providers, (p) => Array.isArray(p) && p.every((x) => typeof x === 'string'))

export const isProgress = (p: unknown): p is Progress =>
  isObj(p) &&
  p.version === 1 &&
  Number.isInteger(p.xp) &&
  (p.xp as number) >= 0 &&
  isObj(p.completed) &&
  Object.values(p.completed).every(isCompletion) &&
  isObj(p.streak) &&
  isNum(p.streak.current) &&
  isNum(p.streak.best) &&
  isObj(p.settings) &&
  oneOf('dark', 'light')(p.settings.theme) &&
  optional(p.settings.motion, oneOf('system', 'reduce')) &&
  optional(p.settings.relaxed, (r) => typeof r === 'boolean')

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
    const parsed: unknown = JSON.parse(raw)
    if (isProgress(parsed)) return parsed
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
  s: { total: number; clean: boolean; hintsUsed: number }, // incident or challenge score
  now: Date,
  provider?: string, // for "pick your cloud" challenges
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
          ...(provider || prev?.providers
            ? { providers: [...new Set([...(prev?.providers ?? []), ...(provider ? [provider] : [])])] }
            : {}),
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
// incident (or, with requires_any, once any one of them does). A required
// track with no content yet can't block anything, and can't satisfy an
// any-of requirement either.
// `items` is every playable thing (incidents and challenges); only id and track matter.
export function unlockedTracks(
  tracks: Track[],
  items: { id: string; track: string }[],
  completed: Progress['completed'],
): Set<string> {
  const hasContent = (trackId: string) => items.some((s) => s.track === trackId)
  const finished = (trackId: string) => items.some((s) => s.track === trackId && completed[s.id])
  const open = (t: Track) => {
    const real = t.requires.filter(hasContent)
    return t.requires_any ? real.length === 0 || real.some(finished) : real.every(finished)
  }
  return new Set(tracks.filter(open).map((t) => t.id))
}
