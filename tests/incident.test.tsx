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

// Types a line and presses Enter, once the previous command has finished
// (Enter waits while one runs).
const press = (cmd: string) => {
  const input = screen.getByLabelText('Terminal command')
  fireEvent.change(input, { target: { value: cmd } })
  fireEvent.keyDown(input, { key: 'Enter' })
}
const type = async (cmd: string) => {
  await waitFor(() => expect(screen.getByRole('log', { name: 'Terminal output' }).getAttribute('aria-busy')).toBe('false'))
  press(cmd)
}
const output = () => screen.getByRole('log', { name: 'Terminal output' }).textContent

it('queue -> investigate -> hypothesis -> fix -> verify -> close -> debrief, and progress survives a reload', async () => {
  const { unmount } = render(<App />)
  await openIncident()

  await type('df -h')
  expect(output()).toMatch(/100%/)
  await type('nope')
  await waitFor(() => expect(output()).toMatch(/bash: nope: command not found/))
  await type('df -h | grep -c dev')
  await waitFor(() => expect(output()).toMatch(/df -h \| grep -c dev\s*\d/))

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
  await type('df -h')
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
  await type('sudo reboot')
  expect(output()).toMatch(/Declare a root cause first/)
  fireEvent.click(screen.getByLabelText(/filesystem is full/))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  await type(': > /var/log/app/app.log')
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
  await type('df -h')
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

it('editing a config file is the fix: sed -i before naming the cause counts once it is named; nano edits files', async () => {
  const { default: IncidentScreen } = await import('../src/screens/IncidentScreen.tsx')
  const item = await (await import('virtual:content')).loadItem('full-disk')
  if (item.kind !== 'incident') throw new Error('expected an incident')
  render(<IncidentScreen scenario={item.scenario} onResolved={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Accept mission' }))

  await type(`sed -i 's#/var/log/ap/#/var/log/app/#' /etc/logrotate.d/app`)
  await waitFor(() => expect(output()).toMatch(/counts this as a fix once you've named the root cause/))

  fireEvent.click(screen.getByLabelText(/filesystem is full/))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/logrotate will now find and rotate app\.log/))

  await type('nano /tmp/notes')
  const editor = await screen.findByRole('dialog', { name: 'Editing /tmp/notes' })
  fireEvent.change(within(editor).getByLabelText('Contents of /tmp/notes'), { target: { value: 'checked logrotate\n' } })
  fireEvent.click(within(editor).getByRole('button', { name: 'Save and exit' }))
  await type('cat /tmp/notes /etc/logrotate.d/app')
  await waitFor(() => expect(output()).toMatch(/checked logrotate\s*\/var\/log\/app\/\*\.log/))
})

it('a file saved in the editor is still there after the terminal remounts', async () => {
  const { default: IncidentScreen } = await import('../src/screens/IncidentScreen.tsx')
  const item = await (await import('virtual:content')).loadItem('full-disk')
  if (item.kind !== 'incident') throw new Error('expected an incident')
  let saved: import('../src/game/engine.ts').Session | undefined
  const props = { scenario: item.scenario, onResolved: () => {}, onChange: (s: typeof saved) => (saved = s) }
  const first = render(<IncidentScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Accept mission' }))

  await type('nano /tmp/notes')
  const editor = await screen.findByRole('dialog', { name: 'Editing /tmp/notes' })
  fireEvent.change(within(editor).getByLabelText('Contents of /tmp/notes'), { target: { value: 'checked logrotate\n' } })
  fireEvent.click(within(editor).getByRole('button', { name: 'Save and exit' }))
  await waitFor(() => expect(saved?.log.some((e) => e.type === 'EDITED' && e.path === '/tmp/notes')).toBe(true))
  await type('nano /tmp/other') // quit without saving: nothing is logged
  const quit = await screen.findByRole('dialog', { name: 'Editing /tmp/other' })
  fireEvent.click(within(quit).getByRole('button', { name: 'Exit without saving' }))
  await type('cat /tmp/notes')
  await waitFor(() => expect(output()).toMatch(/checked logrotate/))
  expect(saved!.log.filter((e) => e.type === 'EDITED')).toHaveLength(1)
  await type('nano /tmp/notes; nano /tmp/notes') // two saves inside one command replay in order
  for (const text of ['pass one\n', 'pass two\n']) {
    const d = await screen.findByRole('dialog', { name: 'Editing /tmp/notes' })
    fireEvent.change(within(d).getByLabelText('Contents of /tmp/notes'), { target: { value: text } })
    fireEvent.click(within(d).getByRole('button', { name: 'Save and exit' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editing /tmp/notes' })).toBeNull())
  }
  await waitFor(() => expect(saved!.log.filter((e) => e.type === 'EDITED')).toHaveLength(3))
  first.unmount()

  render(<IncidentScreen {...props} initial={saved} />)
  await waitFor(() => expect(output()).toMatch(/cat \/tmp\/notes[\s\S]*checked logrotate/))
  await type('cat /tmp/notes')
  await waitFor(() => expect(output()).toMatch(/cat \/tmp\/notes\s*pass two/))
})

it('terraform apply asks in a dialog, and the answer replays after a remount', async () => {
  const { default: IncidentScreen } = await import('../src/screens/IncidentScreen.tsx')
  const item = await (await import('virtual:content')).loadItem('terraform-forces-replacement')
  if (item.kind !== 'incident') throw new Error('expected an incident')
  let saved: import('../src/game/engine.ts').Session | undefined
  const props = { scenario: item.scenario, onResolved: () => {}, onChange: (s: typeof saved) => (saved = s) }
  const first = render(<IncidentScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Accept mission' }))

  await type('terraform init')
  await type(`sed -i '/prevent_destroy/d' db.tf`)
  await type('terraform apply')
  const dialog = await screen.findByRole('dialog', { name: 'Confirm terraform action' })
  press('ls') // type-ahead while apply waits: not run, the line stays in the input
  expect(saved!.log.filter((e) => e.type === 'RUN_COMMAND').at(-1)).toMatchObject({ input: 'terraform apply' })
  expect(screen.getByLabelText<HTMLInputElement>('Terminal command').value).toBe('ls')
  expect(dialog.textContent).toMatch(/must be replaced[\s\S]*Enter a value:/)
  const answer = within(dialog).getByLabelText('Enter a value')
  fireEvent.change(answer, { target: { value: 'yes' } })
  fireEvent.keyDown(answer, { key: 'Enter' })
  await waitFor(() => expect(output()).toMatch(/Apply complete!/))
  await waitFor(() => expect(saved!.log.filter((e) => e.type === 'ANSWERED')).toEqual([expect.objectContaining({ value: 'yes' })]))
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Terminal command'))) // focus back at the prompt
  await type('ls')
  await waitFor(() => expect(saved!.log.at(-1)).toMatchObject({ type: 'RUN_COMMAND', input: 'ls' }))
  await waitFor(() => expect(output()).toMatch(/\$ ls\s*db\.tf/))
  const before = output()
  first.unmount()

  render(<IncidentScreen {...props} initial={saved} />)
  await waitFor(() => expect(output()).toMatch(/Apply complete!/))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(output()).toBe(before)
})

it('applying the replacement takes the destructive action from the world, once, gated on the root cause', async () => {
  const { default: IncidentScreen } = await import('../src/screens/IncidentScreen.tsx')
  const { score } = await import('../src/game/scoring.ts')
  const item = await (await import('virtual:content')).loadItem('terraform-forces-replacement')
  if (item.kind !== 'incident') throw new Error('expected an incident')
  let saved: import('../src/game/engine.ts').Session | undefined
  const props = { scenario: item.scenario, onResolved: () => {}, onChange: (s: typeof saved) => (saved = s) }
  const taken = () => saved!.log.filter((e) => e.type === 'TAKE_ACTION')
  const first = render(<IncidentScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Accept mission' }))

  // Applied before naming the root cause: saved, nothing taken yet.
  await type('terraform init')
  await type(`sed -i '/prevent_destroy/d' db.tf`)
  await type('terraform apply')
  const answer = within(await screen.findByRole('dialog', { name: 'Confirm terraform action' })).getByLabelText('Enter a value')
  fireEvent.change(answer, { target: { value: 'yes' } })
  fireEvent.keyDown(answer, { key: 'Enter' })
  await waitFor(() => expect(output()).toMatch(/Apply complete![\s\S]*counts this as a fix once you've named the root cause/))
  expect(taken()).toEqual([])

  // Naming it re-checks the world: the delete in the history takes remove-guard, exactly once.
  fireEvent.click(screen.getByLabelText(/storage_encrypted can't be changed/))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  await waitFor(() => expect(taken()).toEqual([expect.objectContaining({ id: 'remove-guard' })]))
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/destroy the production orders database/))
  await type('terraform plan') // more checks after more commands take nothing more
  await waitFor(() => expect(saved!.log.at(-1)).toMatchObject({ type: 'RUN_COMMAND', input: 'terraform plan' }))
  await waitFor(() => expect(screen.getByRole('log', { name: 'Terminal output' }).getAttribute('aria-busy')).toBe('false'))
  expect(taken()).toHaveLength(1)
  first.unmount()

  // A remount replays the apply without taking it again.
  render(<IncidentScreen {...props} initial={saved} />)
  await waitFor(() => expect(output()).toMatch(/terraform plan/))
  await waitFor(() => expect(screen.getByRole('log', { name: 'Terminal output' }).getAttribute('aria-busy')).toBe('false'))
  expect(taken()).toHaveLength(1)
  expect(score(item.scenario, saved!.log).mistakes.destructive).toBe(1)
})
