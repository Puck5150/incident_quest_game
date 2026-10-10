// @vitest-environment jsdom
// Ship dark: `published: false` content validates but players only see it with preview on.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import App from '../src/App.tsx'
import content from 'virtual:content'
import { loadContent } from '../vite-plugin-content.ts'
import { parseItem } from '../src/content/item.ts'
import { ScenarioSchema } from '../src/schema/scenario.ts'
import { render as renderSchema, SCHEMAS } from '../scripts/schemas.ts'
import fullDisk from '../content/linux/full-disk.yaml?raw'
import path from 'node:path'

// A hidden clone of full-disk, added to the index only for these tests.
vi.mock('virtual:content', async (orig) => {
  const m = await orig<typeof import('virtual:content')>()
  const base = m.default.items.find((x) => x.id === 'full-disk')!
  return {
    ...m,
    default: { ...m.default, items: [...m.default.items, { ...base, id: 'dark-drill', title: 'Secret dark drill', published: false }] },
    loadItem: async (id: string) => {
      const item = await m.loadItem(id === 'dark-drill' ? 'full-disk' : id)
      return id === 'dark-drill' && item.kind === 'incident' ? { ...item, scenario: { ...item.scenario, id, title: 'Secret dark drill' } } : item
    },
  }
})

globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const station = content.tracks.find((t) => t.id === 'linux')!.station!.city
const done = { bestScore: 100, completedAt: '2026-10-01', hintsUsed: 0, clean: true }
const seed = (completed: Record<string, unknown> = {}) =>
  localStorage.setItem('incident-quest:v1', JSON.stringify({ version: 1, xp: 0, completed, streak: { current: 0, best: 0 }, settings: { theme: 'dark', motion: 'reduce' } }))
const at = (search: string, hash = '') => history.replaceState(null, '', location.pathname + search + hash)

beforeEach(() => {
  vi.stubEnv('DEV', false)
  localStorage.clear()
  sessionStorage.clear()
  at('')
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

// Real content currently shipping dark (TF6c, released by deleting each `published: false`).
const DARK = ['terraform-destroy-dependency-violation', 'terraform-destroy-nonempty-bucket', 'terraform-module-key-removed', 'terraform-module-refactor', 'terraform-module-upgrade', 'terraform-provider-lock-drift', 'terraform-remote-state-rename']

describe('schema and loader', () => {
  const doc = parse(fullDisk)
  it('accepts a boolean published on every kind and rejects other values', () => {
    expect(ScenarioSchema.safeParse({ ...doc, published: false }).success).toBe(true)
    expect(ScenarioSchema.safeParse({ ...doc, published: 'no' }).success).toBe(false)
    for (const name of ['incident', 'challenge', 'canvas', 'pick-cloud-canvas', 'pick-cloud-slot'] as const)
      expect(JSON.parse(renderSchema(SCHEMAS[name])).properties.published).toEqual({ type: 'boolean' })
  })
  it('marks items in the index: absent means published', () => {
    expect(content.items.find((x) => x.id === 'full-disk')?.published).toBe(true)
    expect(content.items.find((x) => x.id === 'dark-drill')?.published).toBe(false)
  })
  it('parseItem keeps a hidden scenario valid', () => {
    const { item, errors } = parseItem(fullDisk.replace(/^id:/m, 'published: false\nid:'), 'x')
    expect(errors).toEqual([])
    expect(item?.kind === 'incident' && item.scenario.published).toBe(false)
  })
  it('only the listed items ship dark (remove an id here when its published: false is deleted)', () => {
    const c = loadContent(path.resolve(import.meta.dirname, '../content'))
    const hidden = [...c.scenarios, ...c.challenges, ...c.canvases, ...c.multis].filter((x) => x.published === false).map((x) => x.id)
    expect(hidden.sort()).toEqual(DARK)
  })
})

describe('players (preview off)', () => {
  it('the board, sector counts and map badges leave hidden items out', () => {
    seed()
    render(<App />)
    expect(screen.queryByText('Secret dark drill')).toBeNull()
    const linux = content.items.filter((x) => x.track === 'linux' && x.published).length
    expect(screen.getByLabelText(`Linux Admin, ${station} station: ${linux} of ${linux} missions open`)).toBeTruthy()
  })
  it('opening a hidden id behaves like an unknown id: back on the board', async () => {
    seed()
    at('', '#/play/dark-drill')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Ops board' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Accept mission' })).toBeNull()
  })
  it('shifts never page a hidden incident', async () => {
    const all = Object.fromEntries(content.items.filter((x) => x.kind === 'incident' && x.id !== 'full-disk' && x.id !== 'dark-drill').map((x) => [x.id, done]))
    seed(all)
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Start on-call shift' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Short shift: 2 pages' }))
    const queue = within(await screen.findByRole('complementary', { name: 'On-call queue' }))
    expect(await queue.findByRole('button', { name: /Checkout returning 500s/ })).toBeTruthy()
    expect(queue.queryByText(/Secret dark drill/)).toBeNull()
  })
})

describe('authors (?preview=1)', () => {
  it('shows hidden items with an Unpublished marker, counted like the rest', () => {
    seed()
    at('?preview=1')
    render(<App />)
    const card = screen.getByRole('button', { name: /Secret dark drill/ })
    expect(card.textContent).toMatch(/Unpublished/)
    const linux = content.items.filter((x) => x.track === 'linux').length
    expect(screen.getByLabelText(`Linux Admin, ${station} station: ${linux} of ${linux} missions open`)).toBeTruthy()
  })
  it('opens a hidden id and marks the mission', async () => {
    seed()
    at('?preview=1', '#/play/dark-drill')
    render(<App />)
    expect(await screen.findByRole('button', { name: 'Accept mission' })).toBeTruthy()
    expect(screen.getByText('Unpublished')).toBeTruthy()
  })
  it('shifts can page hidden incidents', async () => {
    const all = Object.fromEntries(content.items.filter((x) => x.kind === 'incident' && x.id !== 'dark-drill').map((x) => [x.id, done]))
    seed(all)
    at('?preview=1')
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Start on-call shift' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Short shift: 2 pages' }))
    const queue = within(await screen.findByRole('complementary', { name: 'On-call queue' }))
    expect(await queue.findByRole('button', { name: /Secret dark drill/ })).toBeTruthy()
  })
})
