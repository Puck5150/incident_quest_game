// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import App from '../src/App.tsx'

globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

beforeEach(() => {
  localStorage.clear()
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

const add = (label: string, lane: string) => {
  const button = within(screen.getByRole('region', { name: 'Palette' })).getByRole('button', { name: `Add ${label}` })
  fireEvent.change(within(button.parentElement!).getByRole('combobox'), { target: { value: lane } })
  fireEvent.click(button)
}
const inspector = () => screen.getByRole('region', { name: /^Inspector: / })
const select = (id: string) => fireEvent.click(screen.getAllByRole('button', { name: new RegExp(`^${id}(,|$)`) })[0])
const link = (from: string, to: string) => {
  select(from)
  fireEvent.change(within(inspector()).getByLabelText('Send traffic to'), { target: { value: to } })
  fireEvent.click(within(inspector()).getAllByRole('button', { name: 'Link' })[0])
}

it('pick a cloud, build on it, and the queue remembers which cloud', () => {
  const { unmount } = render(<App />)
  fireEvent.click(screen.getByRole('button', { name: /Zone-resilient checkout/ }))

  fireEvent.click(screen.getByLabelText(/Google Cloud/))
  expect(screen.getByText('Cloud SQL for PostgreSQL instance')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Start on Google Cloud' }))

  // The canvas speaks Google Cloud now.
  expect(screen.getByRole('button', { name: 'Add Compute Engine VM (web)' })).toBeTruthy()
  add('Regional external Application Load Balancer', 'r1')
  for (const z of ['r1-a', 'r1-a', 'r1-b', 'r1-b']) add('Compute Engine VM (web)', z)
  add('Cloud SQL for PostgreSQL instance', 'r1-a')
  add('Cloud SQL for PostgreSQL instance', 'r1-b')
  link('users', 'regional-alb-1')
  for (const w of ['web-1', 'web-2', 'web-3', 'web-4']) link('regional-alb-1', w)
  for (const w of ['web-1', 'web-3']) link(w, 'cloud-sql-1')
  select('cloud-sql-1')
  fireEvent.change(within(inspector()).getByLabelText('Replicate to another database'), { target: { value: 'cloud-sql-2' } })
  fireEvent.click(within(inspector()).getAllByRole('button', { name: 'Link' })[1])

  fireEvent.click(screen.getByRole('button', { name: 'Run stress tests' }))
  const results = screen.getByRole('region', { name: /Stress tests/ })
  expect(results.textContent).toMatch(/us-central1-a fails/)
  expect(results.textContent).not.toMatch(/Failed/)
  fireEvent.click(screen.getByRole('button', { name: 'Submit design' }))

  unmount()
  render(<App />)
  const card = screen.getByRole('button', { name: /Zone-resilient checkout/ })
  expect(card.textContent).toMatch(/GCP completed/)
  expect(card.textContent).not.toMatch(/AWS completed/)
})
