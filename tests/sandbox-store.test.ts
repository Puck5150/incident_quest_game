// Saved sandbox designs: what is remembered, what is refused, what is never lost.
// Storage and imported files are untrusted.

import { describe, expect, it } from 'vitest'
import {
  KEY, createDesign, deleteDesign, emptySandbox, exportDesign, loadSandbox, newId, readExport, renameDesign, saveSandbox, updateDesign,
} from '../src/game/sandboxStore.ts'
import type { Design } from '../src/schema/canvas.ts'

const fake = (initial?: string) => {
  const data = new Map<string, string>(initial === undefined ? [] : [[KEY, initial]])
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
}
const design: Design = { nodes: [{ id: 'alb-1', type: 'alb', lane: 'use1' }], edges: [{ from: 'users', to: 'alb-1', kind: 'traffic' }] }
const now = new Date('2026-10-27T10:00:00Z')

describe('the pure operations', () => {
  it('create, rename, update and delete without mutating the input', () => {
    const empty = emptySandbox()
    const one = createDesign(empty, { id: 'a1', name: '  My shop  ', provider: 'aws', now })
    expect(empty.designs).toHaveLength(0)
    expect(one.designs[0]).toEqual({ id: 'a1', name: 'My shop', provider: 'aws', design: { nodes: [], edges: [] }, updatedAt: now.toISOString() })
    expect(renameDesign(one, 'a1', 'Renamed').designs[0].name).toBe('Renamed')
    expect(updateDesign(one, 'a1', design, new Date('2026-10-28T00:00:00Z')).designs[0]).toMatchObject({ design, updatedAt: '2026-10-28T00:00:00.000Z' })
    expect(deleteDesign(one, 'a1').designs).toEqual([])
    expect(deleteDesign(one, 'nope')).toEqual(one)
  })

  it('createDesign never reuses an id; rename and update of an unknown id change nothing', () => {
    const one = createDesign(emptySandbox(), { id: 'a1', name: 'One', provider: 'aws', now })
    const two = createDesign(one, { id: 'a1', name: 'Two', provider: 'aws', now })
    expect(new Set(two.designs.map((d) => d.id)).size).toBe(2)
    expect(renameDesign(one, 'nope', 'X')).toEqual(one)
    expect(updateDesign(one, 'nope', design, now)).toEqual(one)
  })

  it('names are trimmed, never empty and at most 60 characters', () => {
    expect(createDesign(emptySandbox(), { id: 'a', name: '   ', provider: 'gcp', now }).designs[0].name).toBe('Untitled design')
    expect(createDesign(emptySandbox(), { id: 'a', name: 'x'.repeat(100), provider: 'gcp', now }).designs[0].name).toHaveLength(60)
  })

  it('newId is URL-safe and differs between calls', () => {
    const a = newId()
    expect(a).toMatch(/^[a-z0-9]+$/)
    expect(newId()).not.toBe(a)
  })
})

describe('loadSandbox and saveSandbox', () => {
  it('starts empty and round-trips', () => {
    expect(loadSandbox(fake())).toEqual(emptySandbox())
    const s = fake()
    const data = createDesign(emptySandbox(), { id: 'a1', name: 'One', provider: 'azure', now })
    expect(saveSandbox(data, s)).toBe(true)
    expect(loadSandbox(s)).toEqual(data)
  })

  it.each([
    ['not json', 'not json'],
    ['wrong version', JSON.stringify({ version: 2, designs: [] })],
    ['designs not an array', JSON.stringify({ version: 1, designs: {} })],
    ['unknown provider', JSON.stringify({ version: 1, designs: [{ id: 'a', name: 'n', provider: 'ibm', design, updatedAt: 'x' }] })],
    ['a node missing its lane', JSON.stringify({ version: 1, designs: [{ id: 'a', name: 'n', provider: 'aws', design: { nodes: [{ id: 'a', type: 'alb' }], edges: [] }, updatedAt: 'x' }] })],
    ['an unknown link kind', JSON.stringify({ version: 1, designs: [{ id: 'a', name: 'n', provider: 'aws', design: { nodes: [], edges: [{ from: 'a', to: 'b', kind: 'magic' }] }, updatedAt: 'x' }] })],
    ['null', 'null'],
  ])('%s: backed up, then starts empty', (_name, raw) => {
    const s = fake(raw)
    expect(loadSandbox(s)).toEqual(emptySandbox())
    const backups = [...s.data.entries()].filter(([k]) => k.startsWith(`${KEY}:backup-`))
    expect(backups).toHaveLength(1)
    expect(backups[0][1]).toBe(raw)
  })

  it('loading garbage twice leaves one backup and a valid empty store', () => {
    const s = fake('garbage')
    loadSandbox(s)
    expect(JSON.parse(s.data.get(KEY)!)).toEqual(emptySandbox())
    loadSandbox(s)
    expect([...s.data.keys()].filter((k) => k.startsWith(`${KEY}:backup-`))).toHaveLength(1)
  })

  it('when the backup fails, saving refuses and the original stays until a clean load', () => {
    const s = fake('garbage')
    const picky = { getItem: s.getItem, setItem: (k: string, v: string) => { if (k.includes('backup')) throw new Error('quota'); s.setItem(k, v) } }
    expect(loadSandbox(picky)).toEqual(emptySandbox())
    expect(saveSandbox(createDesign(emptySandbox(), { id: 'a', name: 'n', provider: 'aws', now }), picky)).toBe(false)
    expect(s.data.get(KEY)).toBe('garbage')
    s.data.delete(KEY)
    loadSandbox(s)
    expect(saveSandbox(emptySandbox(), s)).toBe(true)
  })

  it('duplicate design ids are invalid and backed up', () => {
    const d = { id: 'a', name: 'n', provider: 'aws', design: { nodes: [], edges: [] }, updatedAt: 'x' }
    const s = fake(JSON.stringify({ version: 1, designs: [d, d] }))
    expect(loadSandbox(s)).toEqual(emptySandbox())
    expect([...s.data.keys()].filter((k) => k.startsWith(`${KEY}:backup-`))).toHaveLength(1)
  })

  it('works when storage throws on read, and reports a failed write', () => {
    const boom = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') } }
    expect(loadSandbox(boom)).toEqual(emptySandbox())
    expect(saveSandbox(emptySandbox(), boom)).toBe(false)
  })
})

describe('export and import', () => {
  const saved = createDesign(emptySandbox(), { id: 'a1', name: 'Shop', provider: 'aws', now }).designs[0]

  it('exports one design as a versioned file and reads it back', () => {
    const text = exportDesign({ ...saved, design })
    expect(JSON.parse(text)).toEqual({ version: 1, name: 'Shop', provider: 'aws', design })
    expect(readExport(text)).toEqual({ name: 'Shop', provider: 'aws', design })
  })

  it.each([
    ['not json', 'nope', /JSON/],
    ['an array', '[]', /design file/],
    ['wrong version', JSON.stringify({ version: 9, name: 'x', provider: 'aws', design }), /version/],
    ['an unknown cloud', JSON.stringify({ version: 1, name: 'x', provider: 'ibm', design }), /cloud/],
    ['no name', JSON.stringify({ version: 1, provider: 'aws', design }), /name/],
    ['a bad design', JSON.stringify({ version: 1, name: 'x', provider: 'aws', design: { nodes: 'no', edges: [] } }), /design/],
  ])('rejects %s with a plain message', (_name, text, message) => {
    const r = readExport(text)
    expect('error' in r && r.error).toMatch(message)
  })

  it('a __proto__ key in the file does not pollute anything and the result carries no extra keys', () => {
    const text = '{"version":1,"name":"x","provider":"aws","__proto__":{"polluted":true},"design":{"nodes":[],"edges":[],"__proto__":{"polluted":true}}}'
    const r = readExport(text)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect('error' in r).toBe(false)
    expect(Object.keys(r)).toEqual(['name', 'provider', 'design'])
    expect(Object.keys((r as { design: Design }).design)).toEqual(['nodes', 'edges'])
  })

  it('rebuilds nodes and edges field by field, dropping unknown fields', () => {
    const text = JSON.stringify({ version: 1, name: 'x', provider: 'aws', design: { nodes: [{ id: 'a', type: 'alb', lane: 'use1', extra: 1 }], edges: [{ from: 'users', to: 'a', kind: 'traffic', extra: 1 }] } })
    const r = readExport(text) as { design: Design }
    expect(r.design.nodes[0]).toEqual({ id: 'a', type: 'alb', lane: 'use1' })
    expect(r.design.edges[0]).toEqual({ from: 'users', to: 'a', kind: 'traffic' })
  })
})
