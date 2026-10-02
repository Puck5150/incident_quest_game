// @vitest-environment jsdom
// Click-through of the incident loop, through the real UI.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../src/App.tsx'
import content from 'virtual:content'

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', location.pathname) // reset the URL without a stray hashchange event
})
afterEach(cleanup)

// Play and debrief screens load lazily, so the first query after a screen change awaits.
const openIncident = async () => {
  fireEvent.click(screen.getByRole('button', { name: /Checkout returning 500s/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Accept mission' }))
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

  fireEvent.click(screen.getByRole('button', { name: 'Close out' }))

  // Debrief: 100 base + 20 time + 20 methodical + 10 verified - 10 wrong hyp - 25 destructive = 115
  // The XP counts up visually; screen readers (and this test) get the final value.
  expect(await screen.findByText('115', { selector: '.sr-only' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Root cause' })).toBeTruthy()
  expect(screen.getByText('The root filesystem is at 100%')).toBeTruthy() // evidence label, not the tag id
  // The command breakdown: commands that found evidence or verify the fix, plus what you ran.
  const breakdown = within(screen.getByRole('heading', { name: 'Command breakdown' }).closest('section')!)
  const dfEntry = breakdown.getByText('$ df -h').closest('details')!
  expect(dfEntry.textContent).toMatch(/you ran it/)
  expect(dfEntry.textContent).toMatch(/Human-readable sizes/) // the -h flag, explained
  expect(breakdown.getByText('$ journalctl -u checkout')).toBeTruthy() // found key evidence, though not typed here
  expect(location.hash).toBe('#/done/full-disk') // a reload opens the queue, not a fresh run
  expect(screen.getByText(/Clearance raised: Operator/)).toBeTruthy()
  expect(screen.queryByText(/Sector cleared/)).toBeNull() // other Linux incidents are still open
  // Linux was Containers' only prerequisite.
  expect(screen.getByRole('button', { name: /Track unlocked: Containers & Kubernetes/ })).toBeTruthy()

  // "Reload": a fresh App reads progress back from localStorage.
  unmount()
  render(<App />)
  expect(screen.getByRole('button', { name: /best 115 XP/ })).toBeTruthy()
  expect(screen.getByText('Operator')).toBeTruthy()
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
  // The ticket stays open after accepting; folding it by hand sticks across re-renders.
  const ticket = () => screen.getByText(/^Ticket from/).closest('details')!
  expect(ticket().open).toBe(true)
  // Its body is height-capped and scrolls once work starts; keyboard users can focus it to scroll.
  expect(screen.getByRole('region', { name: 'Ticket details' }).tabIndex).toBe(0)
  ticket().open = false
  fireEvent.click(screen.getByRole('button', { name: /Show nudge hint/ }))
  expect(screen.getByText(/Errno 28 mean/)).toBeTruthy()
  expect(screen.queryByText(/filing cabinet/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Show direction hint/ }))
  expect(screen.getByText(/filing cabinet/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Show answer hint/ }))
  expect(screen.getByText('No hints left.')).toBeTruthy()
  expect(ticket().open).toBe(false)
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

it('Tab completes in the terminal, but moves focus on an empty prompt', async () => {
  render(<App />)
  await openIncident()
  const input = screen.getByLabelText('Terminal command') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'cat /e' } })
  expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(false) // handled (default prevented)
  expect(input.value).toBe('cat /etc/logrotate.d/app ')
  fireEvent.change(input, { target: { value: 'c' } })
  fireEvent.keyDown(input, { key: 'Tab' })
  expect(output()).toMatch(/cat {2}clear/)
  fireEvent.change(input, { target: { value: '' } })
  expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true) // left alone: focus moves as usual
})

it('shuffles hypotheses so the right answer is not always first', async () => {
  // The order is seeded by when the incident is accepted; try a few fixed times.
  const firsts: string[] = []
  for (const now of [1, 2, 3, 4, 5]) {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now)
    const { unmount } = render(<App />)
    await openIncident()
    firsts.push(screen.getAllByRole('radio')[0].closest('label')!.textContent!)
    unmount()
    spy.mockRestore()
    history.replaceState(null, '', location.pathname)
  }
  expect(firsts.some((f) => !/filesystem is full/.test(f))).toBe(true) // listed first in the YAML
  expect(new Set(firsts).size).toBeGreaterThan(1)
})

it('skill tree shows only tracks with content, with lock state and requirements', async () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Clearance map' }))
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

it('relaxed mode setting persists', async () => {
  const { unmount } = render(<App />)
  const toggle = screen.getByRole('button', { name: 'Relaxed mode' })
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
  unmount()
  render(<App />)
  expect(screen.getByRole('button', { name: 'Relaxed mode' }).getAttribute('aria-pressed')).toBe('true')
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

it('the field guide is there from the start, free, and its coaching follows the phase', async () => {
  render(<App />)
  await openIncident()
  const guide = () => screen.getByRole('region', { name: /Field manual/ })
  expect(guide().textContent).toMatch(/Collect evidence/)
  expect(within(guide()).getByText('How to approach it')).toBeTruthy()

  fireEvent.click(screen.getByLabelText(/filesystem is full/))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  expect(guide().textContent).toMatch(/smallest safe change/)
})

it('choose a callsign: cleaned up, saved, and shown after a reload', async () => {
  const { unmount } = render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose callsign' }))
  fireEvent.change(screen.getByLabelText('Callsign'), { target: { value: 'night owl!7' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(screen.getByRole('button', { name: 'NIGHTOWL7' })).toBeTruthy()
  unmount()
  render(<App />)
  expect(screen.getByRole('button', { name: 'NIGHTOWL7' })).toBeTruthy()
})

it('finishing the last mission in a sector says so', async () => {
  const done = { bestScore: 100, completedAt: '2026-10-01', hintsUsed: 0, clean: true }
  localStorage.setItem(
    'incident-quest:v1',
    JSON.stringify({
      version: 1,
      xp: 100,
      // every other Linux mission already done
      completed: Object.fromEntries(content.items.filter((x) => x.track === 'linux' && x.id !== 'full-disk').map((x) => [x.id, done])),
      streak: { current: 1, best: 1 },
      settings: { theme: 'dark' },
    }),
  )
  render(<App />)
  await openIncident()
  fireEvent.click(screen.getByLabelText(/filesystem is full/))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  fireEvent.click(screen.getByRole('button', { name: /Truncate/ }))
  fireEvent.click(screen.getByRole('button', { name: /logrotate/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Close out' }))
  expect(await screen.findByText(/Sector cleared: Linux/)).toBeTruthy()
})

it('the ops wall shows each sector station and jumps to its sector', () => {
  render(<App />)
  const n = content.items.filter((x) => x.track === 'linux').length
  const linux = screen.getByRole('button', { name: `Linux Admin, Helsinki station: ${n} of ${n} missions open` })
  expect(screen.getByRole('button', { name: /^Containers & Kubernetes, Seattle station: locked/ })).toBeTruthy()
  fireEvent.keyDown(linux, { key: 'Enter' })
  expect(document.activeElement?.id).toBe('track-linux')
})

it('an incident resumes where it left off: transcript, order, phase', async () => {
  const { default: IncidentScreen } = await import('../src/screens/IncidentScreen.tsx')
  const scenario = (await import('virtual:content')).loadItem
  const item = await scenario('full-disk')
  if (item.kind !== 'incident') throw new Error('expected an incident')
  let saved: import('../src/game/engine.ts').Session | undefined
  const props = { scenario: item.scenario, onResolved: () => {}, onChange: (s: typeof saved) => (saved = s) }

  const first = render(<IncidentScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Accept mission' }))
  type('df -h')
  const order = () => screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)
  const before = order()
  first.unmount()

  const second = render(<IncidentScreen {...props} initial={saved} />)
  expect(output()).toMatch(/df -h[\s\S]*100%/) // transcript rebuilt
  expect(order()).toEqual(before) // same hypothesis order
  fireEvent.click(screen.getByLabelText(/filesystem is full/))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  second.unmount()

  render(<IncidentScreen {...props} initial={saved} />)
  expect(screen.getByRole('heading', { name: 'Take action' })).toBeTruthy() // still past the hypothesis
})
