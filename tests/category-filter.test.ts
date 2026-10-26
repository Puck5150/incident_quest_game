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
