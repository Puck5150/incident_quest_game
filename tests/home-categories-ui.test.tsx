// @vitest-environment jsdom
// The Ops board category chips through the DOM: counts, hiding sections and
// map stations, the last chip, restoring the saved choice, and the jump from
// the Clearance map to a hidden track.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import HomeScreen, { type QueueItem } from '../src/screens/HomeScreen.tsx'
import { KEY } from '../src/game/categoryFilter.ts'
import { newProgress } from '../src/game/progress.ts'
import type { Track } from '../src/schema/scenario.ts'

const tracks: Track[] = [
  { id: 'linux', name: 'Linux Admin', requires: [], category: 'foundations', station: { city: 'Helsinki', lat: 60.2, lon: 24.9 } },
  { id: 'aws', name: 'AWS', requires: [], category: 'cloud', station: { city: 'Ashburn', lat: 39.0, lon: -77.5 } },
  { id: 'azure', name: 'Azure', requires: [], category: 'cloud', station: { city: 'Amsterdam', lat: 52.4, lon: 4.9 } },
]
const item = (id: string, track: string): QueueItem => ({ id, track, title: `Title ${id}`, difficulty: 1, published: true, kind: 'incident', tag: 'SEV3' })
const items = [item('l1', 'linux'), item('a1', 'aws'), item('a2', 'aws'), item('z1', 'azure')]
const unlocked = new Set(['linux', 'aws', 'azure'])

const done = { bestScore: 100, completedAt: '2026-10-01', hintsUsed: 0, clean: true }
const board = (props: { completed?: string[]; focusTrack?: string } = {}) => {
  const progress = { ...newProgress(), completed: Object.fromEntries((props.completed ?? []).map((id) => [id, done])) }
  return render(<HomeScreen tracks={tracks} items={items} progress={progress} unlocked={unlocked} focusTrack={props.focusTrack} onPlay={() => {}} shiftNeeds={0} onShift={() => {}} />)
}
const chip = (label: RegExp) => screen.getByRole('button', { name: label })
const section = (id: string) => document.getElementById(`track-${id}`)
const station = (name: RegExp) => screen.queryByRole('button', { name: name })

beforeEach(() => localStorage.clear())
afterEach(cleanup)

it('shows every category on the first visit, with open counts', () => {
  board({ completed: ['a1'] })
  expect(screen.getByRole('group', { name: 'Show categories' })).toBeTruthy()
  expect(chip(/^Foundations · 1 open$/).getAttribute('aria-pressed')).toBe('true')
  expect(chip(/^Platform · 0 open$/).getAttribute('aria-pressed')).toBe('true')
  expect(chip(/^Cloud · 2 open$/).getAttribute('aria-pressed')).toBe('true') // a2 and z1; a1 is done
  expect(chip(/^Private cloud · 0 open$/)).toBeTruthy()
  expect(section('linux') && section('aws') && section('azure')).toBeTruthy()
})

it('turning a category off hides its sections and its map stations, and the choice is saved', () => {
  board()
  fireEvent.click(chip(/^Cloud/))
  expect(chip(/^Cloud/).getAttribute('aria-pressed')).toBe('false')
  expect(section('aws')).toBeNull()
  expect(section('azure')).toBeNull()
  expect(station(/^AWS, Ashburn/)).toBeNull()
  expect(station(/^Linux Admin, Helsinki/)).toBeTruthy()
  expect(section('linux')).toBeTruthy()
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['foundations', 'platform', 'private-cloud'])
  fireEvent.click(chip(/^Cloud/))
  expect(section('aws')).toBeTruthy()
  expect(station(/^AWS, Ashburn/)).toBeTruthy()
})

it('the last category cannot be turned off, and says why', () => {
  board()
  for (const label of [/^Platform/, /^Cloud/, /^Private cloud/]) fireEvent.click(chip(label))
  const last = chip(/^Foundations/)
  expect(last.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(last)
  expect(last.getAttribute('aria-pressed')).toBe('true')
  expect(section('linux')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('At least one category must stay on')
  fireEvent.click(chip(/^Cloud/)) // a successful toggle clears the message
  expect(screen.getByRole('status').textContent).toBe('')
})

it('restores the saved choice on load', () => {
  localStorage.setItem(KEY, '["cloud"]')
  board()
  expect(chip(/^Cloud/).getAttribute('aria-pressed')).toBe('true')
  expect(chip(/^Foundations/).getAttribute('aria-pressed')).toBe('false')
  expect(section('linux')).toBeNull()
  expect(section('aws')).toBeTruthy()
})

it('works when storage is blocked', () => {
  const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('blocked') } })
  try {
    board()
    fireEvent.click(chip(/^Cloud/))
    expect(section('aws')).toBeNull()
  } finally {
    Object.defineProperty(window, 'localStorage', real)
  }
})

it('arriving from the Clearance map at a hidden track reveals its category and focuses the section', () => {
  localStorage.setItem(KEY, '["foundations"]')
  board({ focusTrack: 'aws' })
  expect(chip(/^Cloud/).getAttribute('aria-pressed')).toBe('true')
  expect(document.activeElement).toBe(section('aws'))
})

it('toggling a chip afterwards does not pull focus back to that section', () => {
  board({ focusTrack: 'linux' })
  expect(document.activeElement).toBe(section('linux'))
  document.getElementById('screen-title')!.focus()
  fireEvent.click(chip(/^Cloud/))
  expect(document.activeElement).toBe(document.getElementById('screen-title'))
})

it('reveals the category when the same board is told to focus a hidden track (back/forward, deep link)', () => {
  localStorage.setItem(KEY, '["foundations"]')
  const props = { tracks, items, progress: newProgress(), unlocked, onPlay: () => {}, shiftNeeds: 0, onShift: () => {} }
  const { rerender } = render(<HomeScreen {...props} />)
  expect(section('aws')).toBeNull()
  rerender(<HomeScreen {...props} focusTrack="aws" />)
  expect(chip(/^Cloud/).getAttribute('aria-pressed')).toBe('true')
  expect(document.activeElement).toBe(section('aws'))
})
