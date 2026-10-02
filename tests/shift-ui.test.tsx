// @vitest-environment jsdom
// An on-call shift through the real UI: start, open a page, switch away and
// back, resolve it, end early, read the report.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import App from '../src/App.tsx'
import content from 'virtual:content'

const done = { bestScore: 100, completedAt: '2026-10-01', hintsUsed: 0, clean: true }

// Every incident resolved except full-disk, so it's the shift's first page.
const seed = (settings: Record<string, unknown> = {}) => {
  const completed = Object.fromEntries(content.items.filter((x) => x.kind === 'incident' && x.id !== 'full-disk').map((x) => [x.id, done]))
  localStorage.setItem('incident-quest:v1', JSON.stringify({ version: 1, xp: 0, completed, streak: { current: 0, best: 0 }, settings: { theme: 'dark', ...settings } }))
}
beforeEach(() => {
  history.replaceState(null, '', location.pathname)
  seed()
})
afterEach(() => {
  cleanup()
  localStorage.clear()
})

const type = (cmd: string) => {
  const input = screen.getByLabelText('Terminal command')
  fireEvent.change(input, { target: { value: cmd } })
  fireEvent.keyDown(input, { key: 'Enter' })
}
const queue = () => within(screen.getByRole('complementary', { name: 'On-call queue' }))

it('locked until three incidents are resolved', () => {
  localStorage.setItem('incident-quest:v1', JSON.stringify({ version: 1, xp: 0, completed: {}, streak: { current: 0, best: 0 }, settings: { theme: 'dark' } }))
  render(<App />)
  expect((screen.getByRole('button', { name: 'Start on-call shift' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('Opens after 3 more resolved incidents.')).toBeTruthy()
})

it('start a shift, work a page, switch away and back, resolve it, end early, read the report', async () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Start on-call shift' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Short shift: 2 pages' }))

  // One page so far; it's full-disk.
  const page = await queue().findByRole('button', { name: /Checkout returning 500s/ })
  expect(page.textContent).toMatch(/New/)
  fireEvent.click(page)
  fireEvent.click(await screen.findByRole('button', { name: 'Accept mission' }))
  type('df -h')

  // Away to the queue and back: the transcript is still there.
  fireEvent.click(screen.getByRole('button', { name: '← Back to the queue' }))
  expect(queue().getByRole('button', { name: /Checkout returning 500s/ }).textContent).toMatch(/Investigating/)
  fireEvent.click(queue().getByRole('button', { name: /Checkout returning 500s/ }))
  expect(screen.getByRole('log', { name: 'Terminal output' }).textContent).toMatch(/100%/)

  fireEvent.click(screen.getByLabelText(/filesystem is full/))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  fireEvent.click(screen.getByRole('button', { name: /Truncate/ }))
  fireEvent.click(screen.getByRole('button', { name: /logrotate/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Close out' }))

  // Back on the shift with a result card; the incident is saved to progress.
  expect(await screen.findByRole('heading', { name: /^Resolved INC-/ })).toBeTruthy()
  expect(JSON.parse(localStorage.getItem('incident-quest:v1')!).completed['full-disk']).toBeTruthy()
  expect(location.hash).toBe('#/shift') // the shift keeps its URL

  fireEvent.click(screen.getByRole('button', { name: 'End shift' }))
  fireEvent.click(screen.getByRole('button', { name: 'End shift now' }))
  expect(await screen.findByRole('heading', { name: 'Shift report' })).toBeTruthy()
  expect(screen.getByText('Handed over')).toBeTruthy() // the second page never arrived
  // The shift wall: Linux is clear unless the unanswered second page was Linux too (it's picked at random).
  expect(screen.getByRole('img', { name: /^Linux Admin, Helsinki station: (all clear|1 of 2 missions open)$/ })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: /^After-action report for Checkout returning 500s/ }))
  expect(await screen.findByRole('heading', { name: 'Root cause' })).toBeTruthy()
  expect(screen.getByText('Time bonus: see shift response targets')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Replay incident' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Back to shift report' }))
  expect(await screen.findByRole('heading', { name: 'Shift report' })).toBeTruthy()
})

it('relaxed shift: no clock or targets, the next page arrives once the queue is clear, with a pager banner', async () => {
  seed({ relaxed: true })
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Start on-call shift' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Short shift: 2 pages' }))
  fireEvent.click(await queue().findByRole('button', { name: /Checkout returning 500s/ }))
  expect(queue().queryByText('Shift')).toBeNull() // no clock
  expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull() // the first page isn't an interruption

  fireEvent.click(await screen.findByRole('button', { name: 'Accept mission' }))
  fireEvent.click(screen.getByLabelText(/filesystem is full/))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  fireEvent.click(screen.getByRole('button', { name: /Truncate/ }))
  fireEvent.click(screen.getByRole('button', { name: /logrotate/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Close out' }))

  // The second page arrives straight away and pages you.
  fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }))
  expect(await screen.findByRole('button', { name: 'Accept mission' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'End shift' }))
  fireEvent.click(screen.getByRole('button', { name: 'End shift now' }))
  expect(await screen.findByRole('heading', { name: 'Shift report' })).toBeTruthy()
  expect(screen.queryByRole('columnheader', { name: 'Targets' })).toBeNull()
  expect(screen.queryByText(/Triage:/)).toBeNull()
  expect(document.body.textContent).toMatch(/from incidents, 0 shift bonus/)
})
