// @vitest-environment jsdom
// Design challenge, through the real UI: design -> run -> revise -> pass -> debrief.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import App from '../src/App.tsx'

// Cloud System Design unlocks once any Cloud Platforms item is done.
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(
    'incident-quest:v1',
    JSON.stringify({
      version: 1,
      xp: 0,
      completed: { 'aws-single-az-database': { bestScore: 1, completedAt: '', hintsUsed: 0, clean: true } },
      streak: { current: 0, best: 0 },
      settings: { theme: 'dark' },
    }),
  )
})
afterEach(cleanup)

const pick = (tier: string, option: RegExp) =>
  fireEvent.click(within(screen.getByRole('group', { name: tier })).getByLabelText(option))
const results = () => screen.getByRole('region', { name: /Stress tests/ })

it('design, fail, revise, pass, submit', () => {
  const { unmount } = render(<App />)
  fireEvent.click(screen.getByRole('button', { name: /survives losing a data center/ }))

  const run = screen.getByRole('button', { name: 'Run stress tests' })
  expect(run).toHaveProperty('disabled', true) // every tier needs a pick

  pick('Web / app tier', /One EC2 instance/)
  pick('Orders database', /Single-AZ/)
  fireEvent.click(run)
  expect(results().textContent).toMatch(/Failed: us-east-1a becomes unreachable/)
  expect(results().textContent).toMatch(/The only copy of the database was in the failed zone/)
  expect(screen.queryByRole('button', { name: 'Submit design' })).toBeNull()

  pick('Web / app tier', /across two AZs/)
  expect(results().textContent).toMatch(/changed the design since this run/)
  pick('Orders database', /^RDS for PostgreSQL, Multi-AZ/)
  fireEvent.click(run)
  expect(results().textContent).not.toMatch(/Failed/)

  fireEvent.click(screen.getByRole('button', { name: 'Submit design' }))
  // 200 base + 20% lean - 10% for the extra run = 220
  expect(screen.getByText('220', { selector: '.sr-only' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: /Recommended/ })).toBeTruthy()

  unmount()
  render(<App />)
  expect(screen.getByRole('button', { name: /survives losing a data center.*Completed/ })).toBeTruthy()
})
