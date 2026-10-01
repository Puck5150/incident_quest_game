// @vitest-environment jsdom
// URL hash routing: deep links, the back button, and links that can't be honored.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../src/App.tsx'
import fullDisk from '../content/linux/full-disk.yaml?raw'

globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

// An AWS incident done, so Cloud System Design (and its pick-your-cloud challenge) is unlocked.
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
  history.replaceState(null, '', location.pathname) // reset the URL without a stray hashchange event
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

describe('preview page', () => {
  const paste = async (yaml: string) => {
    location.hash = '#/preview'
    render(<App />)
    fireEvent.change(await screen.findByLabelText('or paste it here'), { target: { value: yaml } })
    fireEvent.click(screen.getByRole('button', { name: 'Check and play' }))
  }

  it('plays a pasted file, with a banner saying nothing is saved', async () => {
    await paste(fullDisk.replace('title: "Checkout returning 500s"', 'title: "My draft incident"'))
    expect(await screen.findByRole('heading', { name: 'My draft incident' })).toBeTruthy()
    expect(screen.getByText(/nothing is saved to your progress/)).toBeTruthy()

    // Play it through: the debrief appears, but no progress is saved and the URL stays put.
    fireEvent.click(screen.getByRole('button', { name: 'Take incident' }))
    fireEvent.click(screen.getByLabelText(/filesystem is full/))
    fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
    fireEvent.click(screen.getByRole('button', { name: /Truncate app\.log/ }))
    fireEvent.click(screen.getByRole('button', { name: /Fix the path typo/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Close incident' }))
    expect(await screen.findByRole('heading', { name: 'Root cause' })).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('incident-quest:v1') ?? '{"completed":{}}').completed).toEqual({})
    expect(location.hash).toBe('#/preview')

    fireEvent.click(screen.getByRole('button', { name: 'Back to the preview page' }))
    expect(await screen.findByRole('heading', { name: 'Preview a content file' })).toBeTruthy()
    expect((screen.getByLabelText('or paste it here') as HTMLTextAreaElement).value).toMatch(/My draft incident/) // kept
  })

  it('shows the same errors the build would', async () => {
    await paste(fullDisk.replace('[truncate-log, fix-logrotate]', '[truncate-log, typo]'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/"typo" is not an action with kind: fix/)
    expect(screen.queryByRole('button', { name: 'Take incident' })).toBeNull()
  })

  it('checks the track exists', async () => {
    await paste(fullDisk.replace('track: linux', 'track: underwater-basketry'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/track "underwater-basketry" is not defined/)
  })
})
