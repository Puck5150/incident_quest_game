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
