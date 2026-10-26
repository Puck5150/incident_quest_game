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
    const store = storage ?? localStorage
    store.setItem(KEY, JSON.stringify([...selected]))
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
