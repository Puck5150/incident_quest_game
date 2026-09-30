// @vitest-environment jsdom
// Click-through of the whole Milestone 2 loop, through the real UI.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import App from '../src/App.tsx'

afterEach(cleanup)

it('ticket -> hypothesis -> actions -> resolved', () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Take incident' }))

  fireEvent.click(screen.getByLabelText(/database is unreachable/))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  expect(screen.getByRole('status').textContent).toMatch(/Not quite/)

  fireEvent.click(screen.getByLabelText(/filesystem is full/))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  fireEvent.click(screen.getByRole('button', { name: /Reboot/ }))
  expect(screen.getByRole('status').textContent).toMatch(/Harmful/)

  fireEvent.click(screen.getByRole('button', { name: /Truncate/ }))
  fireEvent.click(screen.getByRole('button', { name: /logrotate/ }))
  expect(screen.getByRole('heading', { name: /Incident resolved/ })).toBeTruthy()
})
