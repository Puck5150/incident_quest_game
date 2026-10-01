// @vitest-environment jsdom
// Build an architecture on the canvas without dragging (palette Add buttons and
// the inspector), which is also the WCAG 2.5.7 alternative to drag and drop.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import App from '../src/App.tsx'

// jsdom has no ResizeObserver; the board only uses it to redraw link lines.
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

beforeEach(() => {
  localStorage.clear()
  location.hash = ''
  localStorage.setItem(
    'incident-quest:v1',
    JSON.stringify({
      version: 1,
      xp: 0,
      completed: { 'aws-single-az-database': { bestScore: 1, completedAt: '', hintsUsed: 0, clean: true } },
      streak: { current: 0, best: 0 },
      settings: { theme: 'dark', motion: 'reduce' },
    }),
  )
})
afterEach(cleanup)

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
const results = () => screen.getByRole('region', { name: /Stress tests/ })

it('build, fail, fix, pass and submit a canvas design without dragging', async () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: /Build a checkout that survives losing a zone/ }))
  await screen.findByRole('region', { name: /Stress tests/ }) // screen loads lazily

  add('Application Load Balancer', 'use1')
  add('EC2 web server', 'use1-az1')
  add('EC2 web server', 'use1-az2')
  add('RDS for PostgreSQL DB instance', 'use1-az1')
  add('RDS for PostgreSQL DB instance', 'use1-az2')

  link('users', 'alb-1')
  link('alb-1', 'web-1')
  link('alb-1', 'web-2')
  link('web-1', 'rds-1')
  link('web-2', 'rds-1')

  // Replicate rds-1 -> rds-2 asynchronously first: a classic mistake.
  selectNode('rds-1')
  fireEvent.click(within(inspector()).getByLabelText('async'))
  fireEvent.change(within(inspector()).getByLabelText('Replicate to another database'), { target: { value: 'rds-2' } })
  fireEvent.click(within(inspector()).getAllByRole('button', { name: 'Link' })[1])

  fireEvent.click(screen.getByRole('button', { name: 'Run stress tests' }))
  expect(results().textContent).toMatch(/Failed: us-east-1a fails during the sale/)
  expect(results().textContent).toMatch(/rds-1 was lost, and rds-2 is an async replica/)
  expect(results().textContent).toMatch(/only 2× of the 3× traffic needed/)
  // By default the latest failure is shown on the design (one web server failing)...
  expect(screen.getByRole('button', { name: /^web-1, .*down in this test/ })).toBeTruthy()
  // ...and any failed test can be picked to see what it knocked out.
  const az1 = within(results()).getByText(/us-east-1a fails during the sale/).closest('li')!
  fireEvent.click(within(az1).getByRole('button', { name: 'Show on the design' }))
  expect(screen.getByRole('button', { name: /^rds-1, .*down in this test/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /^web-1, .*down in this test/ })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^web-2, .*down in this test/ })).toBeNull()

  // Fix: a sync standby, and a second web server per zone.
  selectNode('rds-1')
  fireEvent.click(within(inspector()).getByRole('button', { name: 'Unlink: rds-1 replicates (async) to rds-2' }))
  fireEvent.click(within(inspector()).getByLabelText('sync'))
  fireEvent.change(within(inspector()).getByLabelText('Replicate to another database'), { target: { value: 'rds-2' } })
  fireEvent.click(within(inspector()).getAllByRole('button', { name: 'Link' })[1])
  add('EC2 web server', 'use1-az1')
  add('EC2 web server', 'use1-az2')
  link('alb-1', 'web-3')
  link('alb-1', 'web-4')

  fireEvent.click(screen.getByRole('button', { name: 'Run stress tests again' }))
  expect(results().textContent).not.toMatch(/Failed/)
  fireEvent.click(screen.getByRole('button', { name: 'Submit design' }))

  // 300 base + 20% lean - 10% for the extra run = 330
  expect(await screen.findByText('330', { selector: '.sr-only' })).toBeTruthy()
  expect(screen.getByText(/Design accepted on run 2/)).toBeTruthy()
})
