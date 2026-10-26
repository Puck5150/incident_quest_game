# Category Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-select category chips to the top of the Ops board that show or hide track sections and world-map stations, with the choice remembered in `localStorage`.

**Architecture:** `category` becomes a required field on every track in `content/tracks.yaml`, validated by `TrackSchema`. A pure module (`src/game/categoryFilter.ts`) owns load/save/toggle rules; a small presentational `CategoryChips` component renders the chips; `HomeScreen` holds the selection in state and filters `tracks` once, feeding both the `WorldMap` sectors and the track sections.

**Tech Stack:** TypeScript, React, Zod (schema), Vitest + React Testing Library (jsdom), Tailwind classes, oxlint.

**Spec:** `docs/superpowers/specs/2026-10-26-category-toggle-design.md`

## Global Constraints

- Four categories, in chip order: `foundations` "Foundations", `platform` "Platform", `cloud` "Cloud", `private-cloud` "Private cloud".
- Track membership: foundations = networking, linux, databases; platform = containers, iac, cicd, microservices; cloud = aws, azure, gcp, cloud-design; private-cloud = openstack.
- `TrackSchema.category` is required: `z.enum(['foundations','platform','cloud','private-cloud'])`.
- localStorage key is `incident-quest:categories` (JSON array of ids), separate from the progress key `incident-quest:v1`.
- Every category is on the first time. The last category cannot be turned off. The page works when storage is unavailable.
- Chip text is `<label> · <n> open`. Open count = queue items of the category's tracks not in `progress.completed` (locked tracks included, same `items` list the screen already receives).
- Filter scope: Ops board sections and `WorldMap` together. Clearance map (`SkillTreeScreen`), on-call shift and preview never read the selection.
- `categories.ts` and `categoryFilter.ts` must not import Zod at runtime (startup bundle rule in `src/game/progress.ts`): use `import type` only.
- Sections keep `tracks.yaml` order; they are not regrouped.
- Out of scope: Clearance map filtering, URL params, per-category colours/icons, regrouping sections, collapsible groups.
- Git: the user commits, pushes and opens PRs only when they say so. Do not commit, push or open a PR at the end of a task unless told. Show the diff for review first (user rule: evaluate before commit, no rework after a push).
- Repo shell is zsh. `rm` and `cp` are interactive: use `rm -f` / `cp -f`. macOS `sed -i ''`.

## Review Focus

Each line is pinned by a test in the task named in brackets.

1. Storage blocked or throwing (private window, `SecurityError` even on reading `localStorage`): defaults to all on and toggling still works for the session. [Task 2]
2. Stored value is garbage: not JSON, not an array, unknown ids mixed with good ones, or an empty array: unknown ids dropped; nothing valid left means all on. [Task 2]
3. Player presses the last pressed chip: it stays on, stays pressed, and a screen reader hears "At least one category must stay on". [Tasks 2 and 3]
4. Arriving with `focusTrack` for a hidden track reveals its category and focuses the section; afterwards toggling a chip must not yank focus back to that section. [Task 3]
5. A new track added without `category`, or with an unknown one, is rejected at content validation; a category with all incidents done shows `0 open` and stays selectable. [Tasks 1 and 3]

## File Structure

| File | Responsibility |
|---|---|
| `src/schema/scenario.ts` (modify) | `TrackSchema` gains required `category`. |
| `content/tracks.yaml` (modify) | `category` on all 12 tracks; header comment mentions it. |
| `src/game/categories.ts` (create) | `Category` type (from the schema) and ordered `CATEGORIES` list with labels. |
| `src/game/categoryFilter.ts` (create) | `ALL`, `loadCategories`, `saveCategories`, `toggleCategory`, `revealCategory`. Pure, no React. |
| `src/components/CategoryChips.tsx` (create) | Presentational chip group. No storage, no knowledge of tracks. |
| `src/screens/HomeScreen.tsx` (modify) | Selection state, filtered tracks, chips, focus-reveal. |
| `tests/categories.test.ts` (create) | Schema rejects bad/missing category; every track has one; every category has a track. |
| `tests/category-filter.test.ts` (create) | Unit tests for `categoryFilter.ts`. |
| `tests/home-categories-ui.test.tsx` (create) | `HomeScreen` behaviour through the DOM. |
| `tests/progress.test.ts` (modify) | `Track` literals get the new required field. |

---

### Task 1: Category on tracks (schema, data, category list)

**Files:**
- Create: `src/game/categories.ts`
- Create: `tests/categories.test.ts`
- Modify: `src/schema/scenario.ts` (the `TrackSchema` block, around line 62)
- Modify: `content/tracks.yaml`
- Modify: `tests/progress.test.ts` (the eight `Track` literals, lines ~64-67 and ~83-86)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type Category = 'foundations' | 'platform' | 'cloud' | 'private-cloud'` (exported from `src/game/categories.ts`, derived as `Track['category']`).
  - `CATEGORIES: { id: Category; label: string }[]` in chip order.
  - `Track` (from `src/schema/scenario.ts`) now has required `category: Category`.

- [ ] **Step 1: Write the failing test**

Create `tests/categories.test.ts`:

```ts
// Every track must belong to a category, and every category must be used.
// Checked against the real content, so a new track can't land without one.

import path from 'node:path'
import { expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { TrackSchema } from '../src/schema/scenario.ts'
import { CATEGORIES } from '../src/game/categories.ts'

const { tracks } = loadContent(path.resolve(import.meta.dirname, '../content'))

it('the category list is in chip order', () => {
  expect(CATEGORIES).toEqual([
    { id: 'foundations', label: 'Foundations' },
    { id: 'platform', label: 'Platform' },
    { id: 'cloud', label: 'Cloud' },
    { id: 'private-cloud', label: 'Private cloud' },
  ])
})

it('a track without a category, or with an unknown one, is rejected', () => {
  const base = { id: 'x', name: 'X', requires: [] }
  expect(TrackSchema.safeParse(base).success).toBe(false)
  expect(TrackSchema.safeParse({ ...base, category: 'nope' }).success).toBe(false)
  expect(TrackSchema.safeParse({ ...base, category: 'cloud' }).success).toBe(true)
})

it('every category has at least one track', () => {
  for (const c of CATEGORIES) expect(tracks.some((t) => t.category === c.id), c.id).toBe(true)
})

it('tracks are grouped as the spec says', () => {
  const by = (cat: string) => tracks.filter((t) => t.category === cat).map((t) => t.id)
  expect(by('foundations')).toEqual(['networking', 'linux', 'databases'])
  expect(by('platform')).toEqual(['containers', 'iac', 'cicd', 'microservices'])
  expect(by('cloud')).toEqual(['aws', 'azure', 'gcp', 'cloud-design'])
  expect(by('private-cloud')).toEqual(['openstack'])
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/categories.test.ts`
Expected: FAIL, cannot resolve `../src/game/categories.ts`.

- [ ] **Step 3: Add the schema field**

In `src/schema/scenario.ts`, inside `TrackSchema`, after `name: z.string().min(1),` add:

```ts
  // Which Ops-board filter chip the track belongs to (see src/game/categories.ts).
  category: z.enum(['foundations', 'platform', 'cloud', 'private-cloud']),
```

- [ ] **Step 4: Create the category list**

Create `src/game/categories.ts`:

```ts
// The Ops-board filter chips. The ids come from the track schema, so a
// category can't exist here without being valid in tracks.yaml (and the
// Record below fails to compile if one is missing a label).

import type { Track } from '../schema/scenario.ts'

export type Category = Track['category']

const LABELS: Record<Category, string> = {
  foundations: 'Foundations',
  platform: 'Platform',
  cloud: 'Cloud',
  'private-cloud': 'Private cloud',
}

// Chip order is the key order above.
export const CATEGORIES = (Object.keys(LABELS) as Category[]).map((id) => ({ id, label: LABELS[id] }))
```

- [ ] **Step 5: Add `category` to all 12 tracks**

Run (zsh):

```bash
cd /Users/keithbarnett/workspace/incident_quest_game
for p in networking:foundations linux:foundations databases:foundations containers:platform iac:platform cicd:platform microservices:platform aws:cloud azure:cloud gcp:cloud cloud-design:cloud openstack:private-cloud; do
  sed -i '' -E "/^- \{ id: ${p%%:*},/s/, station:/, category: ${p##*:}, station:/" content/tracks.yaml
done
grep -c "category:" content/tracks.yaml
```

Expected: `12`. Also add one line to the header comment of `content/tracks.yaml`, after the `station` line:

```yaml
# `category` is the Ops-board filter chip the track sits under (foundations, platform, cloud, private-cloud).
```

- [ ] **Step 6: Fix the `Track` literals in `tests/progress.test.ts`**

Run:

```bash
sed -i '' -E "/^ +\{ id: '[a-z]+', name: /s/ \},\$/, category: 'foundations' },/" tests/progress.test.ts
git diff --stat tests/progress.test.ts
```

Expected: 8 lines changed (4 in `tracks`, 4 in `anyOf`). Open the diff and confirm each line now reads like `{ id: 'linux', name: 'Linux', requires: [], category: 'foundations' },` and the `requires_any: true` line reads `..., requires_any: true, category: 'foundations' },`. No `{ id: 'a1', track: ... }` item line may be touched.

- [ ] **Step 7: Run tests, types and lint**

Run: `npx vitest run tests/categories.test.ts tests/progress.test.ts tests/skill-tree-layout.test.ts tests/content.test.ts && npx tsc -b && npx oxlint`
Expected: all PASS, no type errors, lint clean. If `tsc` reports another `Track` literal missing `category`, add `category: 'foundations'` to it and rerun.

- [ ] **Step 8: Checkpoint**

Run `npm test` (full suite). Expected: PASS. Show `git diff` to the user. Do not commit unless told.

---

### Task 2: Selection rules (`categoryFilter.ts`)

**Files:**
- Create: `src/game/categoryFilter.ts`
- Create: `tests/category-filter.test.ts`

**Interfaces:**
- Consumes: `CATEGORIES`, `Category` from `src/game/categories.ts` (Task 1).
- Produces (all exported from `src/game/categoryFilter.ts`):
  - `ALL: ReadonlySet<Category>`
  - `loadCategories(storage?: Pick<Storage, 'getItem' | 'setItem'>): Set<Category>` (returns a fresh set each call)
  - `saveCategories(selected: ReadonlySet<Category>, storage?: Pick<Storage, 'getItem' | 'setItem'>): void`
  - `toggleCategory(selected: ReadonlySet<Category>, id: Category): Set<Category>`
  - `revealCategory(selected: ReadonlySet<Category>, id: Category): Set<Category>`
  - storage key constant `KEY = 'incident-quest:categories'` (exported so UI tests can seed it).

- [ ] **Step 1: Write the failing tests**

Create `tests/category-filter.test.ts`:

```ts
// The category selection: what's remembered, and the rules for changing it.
// Storage is untrusted (editable, blocked, or absent), so every bad shape
// falls back to "everything on".

import { describe, expect, it } from 'vitest'
import { ALL, KEY, loadCategories, revealCategory, saveCategories, toggleCategory } from '../src/game/categoryFilter.ts'
import type { Category } from '../src/game/categories.ts'

// A minimal in-memory Storage.
const fake = (initial?: string) => {
  const data = new Map<string, string>(initial === undefined ? [] : [[KEY, initial]])
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
}
const set = (...ids: Category[]) => new Set(ids)

describe('loadCategories', () => {
  it('is everything on the first time', () => {
    expect(loadCategories(fake())).toEqual(new Set(ALL))
  })

  it('reads back what saveCategories wrote', () => {
    const s = fake()
    saveCategories(set('cloud', 'platform'), s)
    expect(s.data.get(KEY)).toBe('["cloud","platform"]')
    expect(loadCategories(s)).toEqual(set('cloud', 'platform'))
  })

  it('drops unknown ids and keeps the good ones', () => {
    expect(loadCategories(fake('["cloud","mainframe",7]'))).toEqual(set('cloud'))
  })

  it.each([['[]'], ['["mainframe"]'], ['not json'], ['{"cloud":true}'], ['"cloud"'], ['null']])('%s falls back to everything on', (raw) => {
    expect(loadCategories(fake(raw))).toEqual(new Set(ALL))
  })

  it('works when reading storage throws', () => {
    const boom = { getItem: () => { throw new Error('blocked') }, setItem: () => {} }
    expect(loadCategories(boom)).toEqual(new Set(ALL))
  })

  it('returns a copy: changing it does not change ALL', () => {
    loadCategories(fake()).delete('cloud')
    expect(ALL.has('cloud')).toBe(true)
  })
})

describe('saveCategories', () => {
  it('swallows a storage that throws on write', () => {
    const boom = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    expect(() => saveCategories(set('cloud'), boom)).not.toThrow()
  })
})

describe('toggleCategory', () => {
  it('flips one category on or off without changing the input', () => {
    const before = set('cloud', 'platform')
    expect(toggleCategory(before, 'cloud')).toEqual(set('platform'))
    expect(toggleCategory(before, 'foundations')).toEqual(set('cloud', 'platform', 'foundations'))
    expect(before).toEqual(set('cloud', 'platform'))
  })

  it('refuses to turn off the last category', () => {
    const next = toggleCategory(set('cloud'), 'cloud')
    expect(next).toEqual(set('cloud'))
  })
})

describe('revealCategory', () => {
  it('adds a missing category, leaves a present one, never mutates', () => {
    const before = set('cloud')
    expect(revealCategory(before, 'platform')).toEqual(set('cloud', 'platform'))
    expect(revealCategory(before, 'cloud')).toEqual(set('cloud'))
    expect(before).toEqual(set('cloud'))
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/category-filter.test.ts`
Expected: FAIL, cannot resolve `../src/game/categoryFilter.ts`.

- [ ] **Step 3: Implement**

Create `src/game/categoryFilter.ts`:

```ts
// Which categories the Ops board shows. Kept apart from the progress save so a
// bad value here can never touch progress. Saved data is untrusted: anything
// unreadable or empty means "show everything". `localStorage` is looked up
// inside the try because merely touching it can throw when storage is blocked.

import { CATEGORIES, type Category } from './categories.ts'

export const KEY = 'incident-quest:categories'

type Store = Pick<Storage, 'getItem' | 'setItem'>

export const ALL: ReadonlySet<Category> = new Set(CATEGORIES.map((c) => c.id))

export function loadCategories(storage?: Store): Set<Category> {
  try {
    const raw: unknown = JSON.parse((storage ?? localStorage).getItem(KEY) ?? 'null')
    const ids = Array.isArray(raw) ? raw.filter((x): x is Category => ALL.has(x)) : []
    if (ids.length) return new Set(ids)
  } catch {
    // unreadable: fall through to everything on
  }
  return new Set(ALL)
}

export function saveCategories(selected: ReadonlySet<Category>, storage?: Store): void {
  try {
    ;(storage ?? localStorage).setItem(KEY, JSON.stringify([...selected]))
  } catch {
    // storage blocked or full: the choice lasts for this visit only
  }
}

// Flip one category. The last one stays on, so the board is never empty.
export function toggleCategory(selected: ReadonlySet<Category>, id: Category): Set<Category> {
  const next = new Set(selected)
  if (!next.delete(id)) next.add(id)
  return next.size ? next : new Set(selected)
}

export const revealCategory = (selected: ReadonlySet<Category>, id: Category): Set<Category> => new Set(selected).add(id)
```

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run tests/category-filter.test.ts && npx tsc -b && npx oxlint`
Expected: PASS, types clean, lint clean. If oxlint flags the leading `;` or the empty-looking `catch`, restructure (e.g. `const s = storage ?? localStorage` as the first line inside the `try`) rather than adding a lint-disable.

- [ ] **Step 5: Checkpoint**

Show `git diff` / new files to the user. Do not commit unless told.

---

### Task 3: Chips and Ops board wiring

**Files:**
- Create: `src/components/CategoryChips.tsx`
- Modify: `src/screens/HomeScreen.tsx`
- Create: `tests/home-categories-ui.test.tsx`

**Interfaces:**
- Consumes: `CATEGORIES`, `Category` (Task 1); `loadCategories`, `saveCategories`, `toggleCategory`, `revealCategory`, `KEY` (Task 2); `Track.category` (Task 1).
- Produces:
  - `CategoryChips` default export, props `{ selected: ReadonlySet<Category>; open: Record<Category, number>; onToggle: (id: Category) => void }`.
  - `HomeScreen` props unchanged.

Behaviour contract for `CategoryChips`: a `role="group"` named "Show categories"; one `<button>` per entry of `CATEGORIES`, name `"<label> · <n> open"`, `aria-pressed` true/false. When exactly one chip is pressed, that chip also has `aria-disabled="true"` and clicking it does not call `onToggle`; instead a `role="status"` element (class `sr-only`) reads "At least one category must stay on". The message clears on the next successful toggle.

- [ ] **Step 1: Write the failing UI tests**

Create `tests/home-categories-ui.test.tsx`. It renders `HomeScreen` directly with a small hand-built fixture so it does not depend on real content:

```tsx
// @vitest-environment jsdom
// The Ops board category chips through the DOM: counts, hiding sections and
// map stations, the last chip, restoring the saved choice, and the jump from
// the Clearance map to a hidden track.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import HomeScreen, { type QueueItem } from '../src/screens/HomeScreen.tsx'
import { KEY } from '../src/game/categoryFilter.ts'
import { newProgress } from '../src/game/progress.ts'
import type { Track } from '../src/schema/scenario.ts'

const tracks: Track[] = [
  { id: 'linux', name: 'Linux Admin', requires: [], category: 'foundations', station: { city: 'Helsinki', lat: 60.2, lon: 24.9 } },
  { id: 'aws', name: 'AWS', requires: [], category: 'cloud', station: { city: 'Ashburn', lat: 39.0, lon: -77.5 } },
  { id: 'azure', name: 'Azure', requires: [], category: 'cloud', station: { city: 'Amsterdam', lat: 52.4, lon: 4.9 } },
]
const item = (id: string, track: string): QueueItem => ({ id, track, title: `Title ${id}`, difficulty: 1, published: true, kind: 'incident', tag: 'SEV3' })
const items = [item('l1', 'linux'), item('a1', 'aws'), item('a2', 'aws'), item('z1', 'azure')]
const unlocked = new Set(['linux', 'aws', 'azure'])

const done = { bestScore: 100, completedAt: '2026-10-01', hintsUsed: 0, clean: true }
const board = (props: { completed?: string[]; focusTrack?: string } = {}) => {
  const progress = { ...newProgress(), completed: Object.fromEntries((props.completed ?? []).map((id) => [id, done])) }
  return render(<HomeScreen tracks={tracks} items={items} progress={progress} unlocked={unlocked} focusTrack={props.focusTrack} onPlay={() => {}} shiftNeeds={0} onShift={() => {}} />)
}
const chip = (label: RegExp) => screen.getByRole('button', { name: label })
const section = (id: string) => document.getElementById(`track-${id}`)
const station = (name: RegExp) => screen.queryByRole('button', { name: name })

beforeEach(() => localStorage.clear())
afterEach(cleanup)

it('shows every category on the first visit, with open counts', () => {
  board({ completed: ['a1'] })
  expect(screen.getByRole('group', { name: 'Show categories' })).toBeTruthy()
  expect(chip(/^Foundations · 1 open$/).getAttribute('aria-pressed')).toBe('true')
  expect(chip(/^Platform · 0 open$/).getAttribute('aria-pressed')).toBe('true')
  expect(chip(/^Cloud · 2 open$/).getAttribute('aria-pressed')).toBe('true') // a2 and z1; a1 is done
  expect(chip(/^Private cloud · 0 open$/)).toBeTruthy()
  expect(section('linux') && section('aws') && section('azure')).toBeTruthy()
})

it('turning a category off hides its sections and its map stations, and the choice is saved', () => {
  board()
  fireEvent.click(chip(/^Cloud/))
  expect(chip(/^Cloud/).getAttribute('aria-pressed')).toBe('false')
  expect(section('aws')).toBeNull()
  expect(section('azure')).toBeNull()
  expect(station(/^AWS, Ashburn/)).toBeNull()
  expect(station(/^Linux Admin, Helsinki/)).toBeTruthy()
  expect(section('linux')).toBeTruthy()
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['foundations', 'platform', 'private-cloud'])
  fireEvent.click(chip(/^Cloud/))
  expect(section('aws')).toBeTruthy()
  expect(station(/^AWS, Ashburn/)).toBeTruthy()
})

it('the last category cannot be turned off, and says why', () => {
  board()
  for (const label of [/^Platform/, /^Cloud/, /^Private cloud/]) fireEvent.click(chip(label))
  const last = chip(/^Foundations/)
  expect(last.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(last)
  expect(last.getAttribute('aria-pressed')).toBe('true')
  expect(section('linux')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('At least one category must stay on')
  fireEvent.click(chip(/^Cloud/)) // a successful toggle clears the message
  expect(screen.getByRole('status').textContent).toBe('')
})

it('restores the saved choice on load', () => {
  localStorage.setItem(KEY, '["cloud"]')
  board()
  expect(chip(/^Cloud/).getAttribute('aria-pressed')).toBe('true')
  expect(chip(/^Foundations/).getAttribute('aria-pressed')).toBe('false')
  expect(section('linux')).toBeNull()
  expect(section('aws')).toBeTruthy()
})

it('works when storage is blocked', () => {
  const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('blocked') } })
  try {
    board()
    fireEvent.click(chip(/^Cloud/))
    expect(section('aws')).toBeNull()
  } finally {
    Object.defineProperty(window, 'localStorage', real)
  }
})

it('arriving from the Clearance map at a hidden track reveals its category and focuses the section', () => {
  localStorage.setItem(KEY, '["foundations"]')
  board({ focusTrack: 'aws' })
  expect(chip(/^Cloud/).getAttribute('aria-pressed')).toBe('true')
  expect(document.activeElement).toBe(section('aws'))
})

it('toggling a chip afterwards does not pull focus back to that section', () => {
  board({ focusTrack: 'linux' })
  expect(document.activeElement).toBe(section('linux'))
  document.getElementById('screen-title')!.focus()
  fireEvent.click(chip(/^Cloud/))
  expect(document.activeElement).toBe(document.getElementById('screen-title'))
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/home-categories-ui.test.tsx`
Expected: FAIL, no `Show categories` group (and `newProgress` import should resolve; if the export name differs, check `src/game/progress.ts` and use the real one).

- [ ] **Step 3: Create `CategoryChips`**

Create `src/components/CategoryChips.tsx`. Match the existing chip styling in `HomeScreen.tsx` (pressed: accent border and text; unpressed: `border-line text-muted`):

```tsx
import { useState } from 'react'
import { CATEGORIES, type Category } from '../game/categories.ts'

// Multi-select filter for the Ops board. The last pressed chip refuses to
// turn off and says so to screen readers.
export default function CategoryChips({
  selected,
  open,
  onToggle,
}: {
  selected: ReadonlySet<Category>
  open: Record<Category, number>
  onToggle: (id: Category) => void
}) {
  const [notice, setNotice] = useState('')
  return (
    <div role="group" aria-label="Show categories" className="flex flex-wrap items-center gap-2">
      {CATEGORIES.map(({ id, label }) => {
        const on = selected.has(id)
        const last = on && selected.size === 1
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            aria-disabled={last || undefined}
            onClick={() => {
              if (last) return setNotice('At least one category must stay on')
              setNotice('')
              onToggle(id)
            }}
            className={`rounded-md border px-3 py-1.5 font-mono text-sm tracking-wider focus-visible:outline-2 focus-visible:outline-accent ${on ? 'border-accent text-accent' : 'border-line text-muted hover:border-accent'} ${last ? 'cursor-not-allowed' : ''}`}
          >
            {label} · <span className="tabular-nums">{open[id]}</span> open
          </button>
        )
      })}
      <span role="status" className="sr-only">
        {notice}
      </span>
    </div>
  )
}
```

- [ ] **Step 4: Wire `HomeScreen`**

In `src/screens/HomeScreen.tsx`:

1. Imports: change `import { useEffect } from 'react'` to `import { useEffect, useRef, useState } from 'react'`; add
   ```tsx
   import CategoryChips from '../components/CategoryChips.tsx'
   import { CATEGORIES, type Category } from '../game/categories.ts'
   import { loadCategories, revealCategory, saveCategories, toggleCategory } from '../game/categoryFilter.ts'
   ```
2. Rename the prop destructure `tracks,` to `tracks: allTracks,` and, as the first lines of the function body (before `const name = ...`), add:
   ```tsx
   const [selected, setSelected] = useState(loadCategories)
   const choose = (next: Set<Category>) => {
     setSelected(next)
     saveCategories(next)
   }
   const tracks = allTracks.filter((t) => selected.has(t.category))
   ```
   Change `name` to look in `allTracks` (a locked-track message may name a hidden track): `allTracks.find(...)`.
3. Compute the chip counts after `name`:
   ```tsx
   const categoryOf = new Map(allTracks.map((t) => [t.id, t.category]))
   const open = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0])) as Record<Category, number>
   for (const s of allItems) {
     const c = categoryOf.get(s.track)
     if (c && !progress.completed[s.id]) open[c]++
   }
   ```
4. Replace the focus effect with one that reveals a hidden category first and focuses once per arrival:
   ```tsx
   // Arriving from the skill tree: jump to (and focus) that track's section,
   // revealing its category first if the player had it switched off. Once per
   // arrival, so later chip clicks don't pull focus back here.
   const focused = useRef<string>()
   useEffect(() => {
     if (!focusTrack || focused.current === focusTrack) return
     const category = allTracks.find((t) => t.id === focusTrack)?.category
     if (category && !selected.has(category)) return choose(revealCategory(selected, category)) // re-runs once the section exists
     focused.current = focusTrack
     // focus() also scrolls the heading into view (scroll-mt keeps a gap above it)
     document.getElementById(`track-${focusTrack}`)?.focus()
   }, [focusTrack, selected]) // eslint-disable-line react-hooks/exhaustive-deps -- allTracks and choose are stable per render of the same data
   ```
   If the repo's oxlint config has no `react-hooks` rule, drop the disable comment and keep only `[focusTrack, selected]`; do not add a lint-disable that the linter doesn't know.
5. Render the chips between the `<h1>` and the shift button row:
   ```tsx
   <CategoryChips selected={selected} open={open} onToggle={(id) => choose(toggleCategory(selected, id))} />
   ```
   `WorldMap` sectors and the `tracks.map` sections already read `tracks`, which is now the filtered list: leave them as they are.

- [ ] **Step 5: Run the new tests**

Run: `npx vitest run tests/home-categories-ui.test.tsx`
Expected: PASS (7 tests). If the "does not pull focus back" test fails, the `focused` ref is not being set before the effect re-runs: check step 4.4.

- [ ] **Step 6: Full verification**

Run, in order:

```bash
npx tsc -b && npx oxlint && npm test && npm run check-links
node -e "import('./vite-plugin-content.ts').then(m=>{try{m.loadContent('content');console.log('OK')}catch(e){console.log(e.message)}})"
```

Expected: no type errors, lint clean, full suite PASS (previous baseline 3360 plus the new tests), links OK, content prints `OK`.

- [ ] **Step 7: Check it in the real app**

Run `npm run dev` and, in the browser: confirm the chips sit under "Ops board", turning off Cloud removes the AWS/Azure/GCP/Cloud System Design sections and their map stations, a reload keeps the choice, the last chip cannot be turned off, and clicking a locked-sector hint or a Clearance map node for a track in a hidden category lands on that section. Report anything that does not match.

- [ ] **Step 8: Checkpoint**

Show the full `git diff` and the browser result to the user. Do not commit, push or open a PR until told.

---

## Self-Review

- **Spec coverage:** categories and chip order (T1), required schema field and all 12 tracks (T1), `categoryFilter` API and key (T2), chip UI incl. count, `aria-pressed`, `aria-disabled`, live message (T3), `HomeScreen` state/filter/chips placement (T3), focus reveal with effect re-run (T3), storage-failure and bad-value fallbacks (T2, T3), existing `Track` literals updated (T1), Clearance map untouched (no task touches it). Tests named in the spec all exist; the content check lives in `tests/categories.test.ts`.
- **Placeholders:** none; every code step has code, every run step has a command and expected result.
- **Type consistency:** `Category`, `CATEGORIES`, `ALL`, `KEY`, `loadCategories`, `saveCategories`, `toggleCategory`, `revealCategory`, `CategoryChips` props match across tasks. `HomeScreen` renames the prop locally only (`tracks: allTracks`); its external props are unchanged, so `App.tsx` needs no edit.
- **Known judgement call:** a category revealed by `focusTrack` is saved (persisted), same as a manual toggle. If you would rather it be session-only, say so before execution.
