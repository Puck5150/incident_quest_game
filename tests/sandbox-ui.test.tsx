// @vitest-environment jsdom
// The design sandbox through the real UI: create a design, build it without
// dragging, run a check, reload and find it again, import and export.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import App from '../src/App.tsx'
import { KEY } from '../src/game/sandboxStore.ts'

globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
File.prototype.text ??= function (this: Blob) {
  return new Promise<string>((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.readAsText(this)
  })
}

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', location.pathname)
  localStorage.setItem(
    'incident-quest:v1',
    JSON.stringify({ version: 1, xp: 0, completed: {}, streak: { current: 0, best: 0 }, settings: { theme: 'dark', motion: 'reduce' } }),
  )
})
afterEach(cleanup)

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Design sandbox' }))
const palette = () => screen.getByRole('region', { name: 'Palette' })
const add = (label: string, lane: string) => {
  const button = within(palette()).getByRole('button', { name: `Add ${label}` })
  fireEvent.change(within(button.parentElement!).getByRole('combobox'), { target: { value: lane } })
  fireEvent.click(button)
}
const inspector = () => screen.getByRole('region', { name: /^Inspector: / })
const selectNode = (id: string) => fireEvent.click(screen.getAllByRole('button', { name: new RegExp(`^${id}(,|$)`) })[0])
const link = (from: string, to: string) => {
  selectNode(from)
  fireEvent.change(within(inspector()).getByLabelText('Send traffic to'), { target: { value: to } })
  fireEvent.click(within(inspector()).getAllByRole('button', { name: 'Link' })[0])
}
const create = async (name: string, cloud: string) => {
  fireEvent.change(screen.getByLabelText('Design name'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Cloud'), { target: { value: cloud } })
  fireEvent.click(screen.getByRole('button', { name: 'Create design' }))
  await screen.findByRole('region', { name: 'Palette' })
}

it('create, build, run a check, and find the design again after a reload', async () => {
  render(<App />)
  open()
  expect(await screen.findByRole('heading', { name: 'Design sandbox' })).toBeTruthy()
  await create('My shop', 'aws')

  add('Application Load Balancer', 'use1')
  add('EC2 web server', 'use1-az1')
  add('RDS for PostgreSQL DB instance', 'use1-az1')
  link('users', 'alb-1')
  link('alb-1', 'web-1')
  link('web-1', 'rds-1')

  // Pick the zone check and run it: everything is in one zone, so it fails.
  fireEvent.change(screen.getByLabelText('Check'), { target: { value: 'zone-use1-az1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Run check' }))
  const result = screen.getByRole('region', { name: 'Check result' })
  expect(result.textContent).toMatch(/Failed: Lose us-east-1a/)
  expect(screen.getByRole('button', { name: /^web-1, .*down in this check/ })).toBeTruthy()
  expect(result.textContent).not.toMatch(/Budget|XP/)

  // Edits were saved without pressing anything.
  const saved = JSON.parse(localStorage.getItem(KEY)!)
  expect(saved.designs[0].design.nodes).toHaveLength(3)

  // A fresh page load lists it and reopens it with the components in place.
  cleanup()
  render(<App />)
  open()
  fireEvent.click(await screen.findByRole('button', { name: /^My shop/ }))
  await screen.findByRole('region', { name: 'Palette' })
  expect(screen.getAllByRole('button', { name: /^web-1(,|$)/ }).length).toBeGreaterThan(0)
})

it('offers no checks until the design has something to judge, and says neutral parts are not judged', async () => {
  render(<App />)
  open()
  await screen.findByRole('heading', { name: 'Design sandbox' })
  await create('Empty', 'aws')
  expect((screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/Add a web server or a database to run checks/)).toBeTruthy()
  add('Amazon SQS queue', 'use1')
  expect((screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/aren't judged by these checks/)).toBeTruthy()
  expect(screen.getByText(/A link through one is treated as a direct link to what's behind it/)).toBeTruthy()
  expect(screen.queryByText(/ignore them/)).toBeNull()
})

it('an unknown design id falls back to the list', async () => {
  history.replaceState(null, '', `${location.pathname}#/sandbox/nope`)
  render(<App />)
  expect(await screen.findByRole('heading', { name: 'Design sandbox' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Create design' })).toBeTruthy()
})

it('a saved design that uses a part no longer in the palette explains itself instead of crashing', async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({ version: 1, designs: [{ id: 'old1', name: 'Old', provider: 'aws', updatedAt: 'x', design: { nodes: [{ id: 'x-1', type: 'mainframe', lane: 'use1' }], edges: [] } }] }),
  )
  history.replaceState(null, '', `${location.pathname}#/sandbox/old1`)
  render(<App />)
  expect(await screen.findByText(/isn't in this cloud's palette/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy()
})

it('imports a design file, and rejects a bad one with a message', async () => {
  render(<App />)
  open()
  await screen.findByRole('heading', { name: 'Design sandbox' })
  const input = screen.getByLabelText('Import a design') as HTMLInputElement
  const good = { version: 1, name: 'Imported', provider: 'aws', design: { nodes: [{ id: 'alb-1', type: 'alb', lane: 'use1' }], edges: [] } }
  fireEvent.change(input, { target: { files: [new File([JSON.stringify(good)], 'd.json', { type: 'application/json' })] } })
  await screen.findByRole('button', { name: /^Imported/ })

  const bad = { ...good, name: 'Bad', design: { nodes: [{ id: 'web-1', type: 'ec2-web', lane: 'use1' }], edges: [] } }
  fireEvent.change(input, { target: { files: [new File([JSON.stringify(bad)], 'b.json', { type: 'application/json' })] } })
  expect((await screen.findByRole('alert')).textContent).toMatch(/can't go in/)
  expect(screen.queryByRole('button', { name: /Bad/ })).toBeNull()
})

it('rename and delete (with a confirmation) from the list', async () => {
  localStorage.setItem(KEY, JSON.stringify({ version: 1, designs: [{ id: 'a1', name: 'First', provider: 'gcp', updatedAt: '2026-10-27T00:00:00.000Z', design: { nodes: [], edges: [] } }] }))
  render(<App />)
  open()
  await screen.findByRole('button', { name: /^First/ })
  fireEvent.click(screen.getByRole('button', { name: 'Rename First' }))
  fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Second' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
  await screen.findByRole('button', { name: /^Second/ })
  fireEvent.click(screen.getByRole('button', { name: 'Delete Second' }))
  fireEvent.click(screen.getByRole('button', { name: 'Yes, delete Second' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: /Second/ })).toBeNull())
  expect(JSON.parse(localStorage.getItem(KEY)!).designs).toEqual([])
})

it('focus lands on the design heading after creating or opening one', async () => {
  render(<App />)
  open()
  await screen.findByRole('heading', { name: 'Design sandbox' })
  await create('Focus me', 'aws')
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Focus me' })))
  fireEvent.click(screen.getByRole('button', { name: '← All designs' }))
  fireEvent.click(await screen.findByRole('button', { name: /^Focus me/ }))
  await screen.findByRole('region', { name: 'Palette' })
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Focus me' })))
})

it('a stale design link goes back to the list without adding a history entry', async () => {
  history.replaceState(null, '', `${location.pathname}#/sandbox/gone`)
  const before = history.length
  render(<App />)
  await screen.findByRole('button', { name: 'Create design' })
  await waitFor(() => expect(location.hash).toBe('#/sandbox'))
  expect(history.length).toBe(before)
})

const one = () =>
  localStorage.setItem(KEY, JSON.stringify({ version: 1, designs: [{ id: 'a1', name: 'First', provider: 'aws', updatedAt: '2026-10-27T00:00:00.000Z', design: { nodes: [], edges: [] } }] }))

it('rename and delete give focus back, Escape cancels them, and Delete alone deletes nothing', async () => {
  one()
  render(<App />)
  open()
  await screen.findByRole('button', { name: /^First/ })
  fireEvent.click(screen.getByRole('button', { name: 'Rename First' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename First' }))
  fireEvent.click(screen.getByRole('button', { name: 'Rename First' }))
  fireEvent.keyDown(screen.getByLabelText('New name'), { key: 'Escape' })
  expect(screen.queryByLabelText('New name')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename First' }))
  fireEvent.click(screen.getByRole('button', { name: 'Rename First' }))
  fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Renamed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename Renamed' }))

  fireEvent.click(screen.getByRole('button', { name: 'Delete Renamed' }))
  expect(JSON.parse(localStorage.getItem(KEY)!).designs).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete Renamed' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete Renamed' }))
  fireEvent.keyDown(screen.getByRole('button', { name: 'Keep' }), { key: 'Escape' })
  expect(screen.queryByRole('button', { name: 'Yes, delete Renamed' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete Renamed' }))
  expect(JSON.parse(localStorage.getItem(KEY)!).designs).toHaveLength(1)
})

const importText = async (text: string | File) => {
  const input = screen.getByLabelText('Import a design') as HTMLInputElement
  const file = typeof text === 'string' ? new File([text], 'f.json', { type: 'application/json' }) : text
  fireEvent.change(input, { target: { files: [file] } })
}

it('announces an import, and shows each import error verbatim', async () => {
  render(<App />)
  open()
  await screen.findByRole('heading', { name: 'Design sandbox' })
  const good = { version: 1, name: 'Shop', provider: 'aws', design: { nodes: [{ id: 'alb-1', type: 'alb', lane: 'use1' }], edges: [] } }
  await importText(JSON.stringify(good))
  await screen.findByRole('button', { name: /^Shop/ })
  expect(screen.getAllByRole('status').some((s) => s.textContent === 'Imported Shop.')).toBe(true)

  await importText('not json')
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("That file isn't valid JSON."))
  await importText(JSON.stringify({ ...good, provider: 'oracle' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The design file names a cloud this game does not have.'))
  await importText(JSON.stringify({ ...good, design: { nodes: good.design.nodes, edges: [{ from: 'users', to: 'zzz', kind: 'traffic' }] } }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('A link ends at "zzz", which isn\'t in the design.'))

  await importText(new File(['x'.repeat(1_000_001)], 'big.json'))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/too big/))
  const unreadable = new File(['{}'], 'u.json')
  Object.defineProperty(unreadable, 'text', { value: () => Promise.reject(new Error('nope')) })
  await importText(unreadable)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Couldn't read that file."))
})
