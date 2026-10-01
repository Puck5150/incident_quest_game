// @vitest-environment jsdom
// URL hash routing: deep links, the back button, and links that can't be honored.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import App from '../src/App.tsx'

globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

// Cloud Platforms done, so Cloud System Design (and its pick-your-cloud challenge) is unlocked.
const seed = () =>
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

beforeEach(() => {
  localStorage.clear()
  location.hash = ''
})
afterEach(cleanup)

it('opens an incident from a deep link, and Back returns to the queue', async () => {
  history.pushState(null, '', '#/')
  history.pushState(null, '', '#/play/full-disk')
  render(<App />)
  expect(await screen.findByRole('button', { name: 'Take incident' })).toBeTruthy()

  history.back()
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Take incident' })).toBeNull())
  expect(location.hash).toBe('#/')
  expect(screen.getByRole('button', { name: /Checkout returning 500s/ })).toBeTruthy()
})

it('playing from the queue updates the URL', async () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: /Checkout returning 500s/ }))
  await screen.findByRole('button', { name: 'Take incident' })
  expect(location.hash).toBe('#/play/full-disk')
})

it('a provider in the URL skips the cloud picker', async () => {
  seed()
  location.hash = '#/play/zone-resilient-checkout/gcp'
  render(<App />)
  expect(await screen.findByRole('button', { name: 'Add Compute Engine VM (web)' })).toBeTruthy()
})

it('a locked item opens its track instead', async () => {
  location.hash = '#/play/crashloopbackoff' // Containers needs Linux first
  render(<App />)
  await waitFor(() => expect(document.activeElement?.id).toBe('track-containers'))
  expect(screen.queryByRole('button', { name: 'Take incident' })).toBeNull()
})

it('an unknown item falls back to the queue', async () => {
  location.hash = '#/play/no-such-incident'
  render(<App />)
  expect(await screen.findByRole('button', { name: /Checkout returning 500s/ })).toBeTruthy()
})
