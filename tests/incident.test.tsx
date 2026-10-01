// @vitest-environment jsdom
// Click-through of the incident loop, through the real UI.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../src/App.tsx'
import content from 'virtual:content'

beforeEach(() => {
  localStorage.clear()
  location.hash = ''
})
afterEach(cleanup)

// Play and debrief screens load lazily, so the first query after a screen change awaits.
const openIncident = async () => {
  fireEvent.click(screen.getByRole('button', { name: /Checkout returning 500s/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Take incident' }))
}

const type = (cmd: string) => {
  const input = screen.getByLabelText('Terminal command')
  fireEvent.change(input, { target: { value: cmd } })
  fireEvent.keyDown(input, { key: 'Enter' })
}
const output = () => screen.getByRole('log', { name: 'Terminal output' }).textContent

it('queue -> investigate -> hypothesis -> fix -> verify -> close -> debrief, and progress survives a reload', async () => {
  const { unmount } = render(<App />)
  await openIncident()

  type('df -h')
  expect(output()).toMatch(/100%/)
  type('nope')
  expect(output()).toMatch(/nope: no simulated output/)

  fireEvent.click(screen.getByRole('tab', { name: 'Logs' }))
  fireEvent.click(screen.getByRole('button', { name: /journalctl/ }))
  expect(screen.getByText(/Errno 28/)).toBeTruthy()

  fireEvent.click(screen.getByLabelText(/database is unreachable/))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  expect(screen.getByRole('status').textContent).toMatch(/Not quite/)

  fireEvent.click(screen.getByLabelText(/filesystem is full/))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  fireEvent.click(screen.getByRole('button', { name: /Reboot/ }))
  expect(screen.getByRole('status').textContent).toMatch(/Harmful/)

  fireEvent.click(screen.getByRole('button', { name: /Truncate/ }))
  fireEvent.click(screen.getByRole('button', { name: /logrotate/ }))

  // Terminal kept its transcript across tab switches, and now shows the fixed state.
  fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }))
  type('df -h')
  expect(output()).toMatch(/28%/)

  fireEvent.click(screen.getByRole('button', { name: 'Close incident' }))

  // Debrief: 100 base + 20 time + 20 methodical + 10 verified - 10 wrong hyp - 25 destructive = 115
  // The XP counts up visually; screen readers (and this test) get the final value.
  expect(await screen.findByText('115', { selector: '.sr-only' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Root cause' })).toBeTruthy()
  expect(screen.getByText('The root filesystem is at 100%')).toBeTruthy() // evidence label, not the tag id
  expect(location.hash).toBe('#/done/full-disk') // a reload opens the queue, not a fresh run
  expect(screen.getByText(/Promoted to Support Engineer/)).toBeTruthy()
  // Linux was Containers' only prerequisite.
  expect(screen.getByRole('button', { name: /Track unlocked: Containers & Kubernetes/ })).toBeTruthy()

  // "Reload": a fresh App reads progress back from localStorage.
  unmount()
  render(<App />)
  expect(screen.getByRole('button', { name: /best 115 XP/ })).toBeTruthy()
  expect(screen.getByText('Support Engineer')).toBeTruthy()
})

it('theme toggle switches and persists', () => {
  render(<App />)
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Light mode' }))
  expect(document.documentElement.classList.contains('dark')).toBe(false)
  cleanup()
  render(<App />)
  expect(screen.getByRole('button', { name: 'Dark mode' })).toBeTruthy()
})

it('hints reveal one tier at a time, analogy with the second', async () => {
  render(<App />)
  await openIncident()
  // The ticket folds to one line once work starts, so the tools sit higher.
  expect(screen.getByText(/^Ticket from/).closest('details')!.open).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: /Show nudge hint/ }))
  expect(screen.getByText(/Errno 28 mean/)).toBeTruthy()
  expect(screen.queryByText(/filing cabinet/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Show direction hint/ }))
  expect(screen.getByText(/filing cabinet/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Show answer hint/ }))
  expect(screen.getByText('No hints left.')).toBeTruthy()
})

it('typed fix commands wait for the hypothesis, then take the action', async () => {
  render(<App />)
  await openIncident()
  type('sudo reboot')
  expect(output()).toMatch(/Declare a root cause first/)
  fireEvent.click(screen.getByLabelText(/filesystem is full/))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  type(': > /var/log/app/app.log')
  expect(output()).toMatch(/space comes back immediately/) // the action's feedback, inline
  expect(screen.getByRole('button', { name: /Truncate app\.log/ })).toHaveProperty('disabled', true) // done, like a click
})

it('shuffles hypotheses so the right answer is not always first', async () => {
  const spy = vi.spyOn(Math, 'random').mockReturnValue(0)
  render(<App />)
  await openIncident()
  const first = screen.getAllByRole('radio')[0].closest('label')!.textContent
  expect(first).not.toMatch(/filesystem is full/) // listed first in the YAML
  spy.mockRestore()
})

it('skill tree shows only tracks with content, with lock state and requirements', async () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Skill tree' }))
  // (The phone layout renders the same nodes; jsdom doesn't apply the CSS that hides it.)
  const tracks = within(await screen.findByRole('list', { name: 'Tracks' })) // navigation goes through the URL
  expect(document.activeElement?.id).toBe('screen-title') // focus follows the screen change
  const withContent = content.tracks.filter((t) => content.items.some((s) => s.track === t.id))
  expect(tracks.getAllByRole('listitem')).toHaveLength(withContent.length)
  const micro = tracks.getByRole('button', { name: /Microservices/ })
  expect(micro.textContent).toMatch(/Needs Networking \+ Containers & Kubernetes/)
  expect(micro.textContent).toMatch(/Locked/)
  // Selecting a track opens the queue at that track.
  fireEvent.click(tracks.getByRole('button', { name: /^Linux Admin/ }))
  await waitFor(() => expect(document.activeElement?.id).toBe('track-linux'))
})

it('reduce motion setting persists and marks the document', () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Reduce motion' }))
  expect(document.documentElement.classList.contains('reduce-motion')).toBe(true)
  cleanup()
  render(<App />)
  expect(screen.getByRole('button', { name: 'Reduce motion' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Reduce motion' }))
})
