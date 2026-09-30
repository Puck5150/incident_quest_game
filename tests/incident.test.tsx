// @vitest-environment jsdom
// Click-through of the incident loop, through the real UI.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import App from '../src/App.tsx'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

const openIncident = () => {
  fireEvent.click(screen.getByRole('button', { name: /Checkout returning 500s/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Take incident' }))
}

const type = (cmd: string) => {
  const input = screen.getByLabelText('Terminal command')
  fireEvent.change(input, { target: { value: cmd } })
  fireEvent.keyDown(input, { key: 'Enter' })
}
const output = () => screen.getByRole('log', { name: 'Terminal output' }).textContent

it('queue -> investigate -> hypothesis -> fix -> verify -> close -> debrief, and progress survives a reload', () => {
  const { unmount } = render(<App />)
  openIncident()

  type('df -h')
  expect(output()).toMatch(/100%/)
  type('nope')
  expect(output()).toMatch(/nope: command not found/)

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
  expect(screen.getByText('+115 XP')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Root cause' })).toBeTruthy()
  expect(screen.getByText(/Promoted to Support Engineer/)).toBeTruthy()

  // "Reload": a fresh App reads progress back from localStorage.
  unmount()
  render(<App />)
  expect(screen.getByText(/best 115 XP/)).toBeTruthy()
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

it('hints reveal one tier at a time, analogy with the second', () => {
  render(<App />)
  openIncident()
  fireEvent.click(screen.getByRole('button', { name: /Show nudge hint/ }))
  expect(screen.getByText(/Errno 28 mean/)).toBeTruthy()
  expect(screen.queryByText(/filing cabinet/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Show direction hint/ }))
  expect(screen.getByText(/filing cabinet/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Show answer hint/ }))
  expect(screen.getByText('No hints left.')).toBeTruthy()
})
