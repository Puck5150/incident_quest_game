// @vitest-environment jsdom
// The design sandbox when things go wrong: storage refuses writes, saved data
// is corrupt and can't be backed up, or a cloud's sandbox fails to load.
// Its own file because the module-level "unsaved" copy and the content mock
// must not leak into other tests.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../src/App.tsx'
import { KEY } from '../src/game/sandboxStore.ts'

globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

let cloudFails = false
vi.mock('virtual:content', async (orig) => {
  const m = await orig<typeof import('virtual:content')>()
  return { ...m, loadSandbox: (p: 'aws' | 'azure' | 'gcp') => (cloudFails ? Promise.reject(new Error('chunk')) : m.loadSandbox(p)) }
})

const realSet = Storage.prototype.setItem
const block = (match: (key: string) => boolean) =>
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
    if (match(k)) throw new Error('QuotaExceededError')
    return realSet.call(this, k, v)
  })

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', location.pathname)
  cloudFails = false
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('a cloud that fails to load says the design cannot be opened, and offers Export', async () => {
  cloudFails = true
  localStorage.setItem(KEY, JSON.stringify({ version: 1, designs: [{ id: 'd1', name: 'D', provider: 'aws', updatedAt: 'x', design: { nodes: [], edges: [] } }] }))
  history.replaceState(null, '', `${location.pathname}#/sandbox/d1`)
  render(<App />)
  expect((await screen.findByRole('alert')).textContent).toMatch(/can't be opened/)
  expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy()
})

it('corrupt saved data that cannot be backed up warns from the start', async () => {
  localStorage.setItem(KEY, 'garbage')
  block((k) => k.startsWith(`${KEY}:backup`))
  history.replaceState(null, '', `${location.pathname}#/sandbox`)
  render(<App />)
  await screen.findByRole('heading', { name: 'Design sandbox' })
  expect(screen.getByText(/designs last only until you reload or close this tab/)).toBeTruthy()
  expect(localStorage.getItem(KEY)).toBe('garbage')
})

it('with storage blocked, a new design survives going back to the list, with a warning', async () => {
  block((k) => k === KEY)
  history.replaceState(null, '', `${location.pathname}#/sandbox`)
  render(<App />)
  await screen.findByRole('heading', { name: 'Design sandbox' })
  fireEvent.change(screen.getByLabelText('Design name'), { target: { value: 'Kept' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create design' }))
  await screen.findByRole('region', { name: 'Palette' })
  expect(screen.getByText(/won't be saved/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '← All designs' }))
  expect(await screen.findByRole('button', { name: /^Kept/ })).toBeTruthy()
  expect(screen.getByText(/designs last only until you reload or close this tab/)).toBeTruthy()
})
