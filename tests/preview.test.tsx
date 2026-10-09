// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previewOn, visible } from '../src/game/preview.ts'

const at = (search: string) => history.replaceState(null, '', location.pathname + search)

beforeEach(() => {
  vi.stubEnv('DEV', false)
  sessionStorage.clear()
  at('')
})
afterEach(() => vi.unstubAllEnvs())

describe('previewOn', () => {
  it('is off in production without the flag', () => expect(previewOn()).toBe(false))
  it('is on in dev', () => {
    vi.stubEnv('DEV', true)
    expect(previewOn()).toBe(true)
  })
  it('is on with ?preview=1, and stays on for the session after the URL loses it', () => {
    at('?preview=1')
    expect(previewOn()).toBe(true)
    at('')
    expect(previewOn()).toBe(true)
  })
  it('ignores other values', () => {
    at('?preview=0')
    expect(previewOn()).toBe(false)
  })
  it('still honours the flag when storage is unavailable, and does not throw without it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(previewOn()).toBe(false)
    at('?preview=1')
    expect(previewOn()).toBe(true)
    vi.restoreAllMocks()
  })
})

it('visible drops unpublished items unless preview is on', () => {
  const xs = [{ id: 'a', published: true }, { id: 'b', published: false }]
  expect(visible(xs, false).map((x) => x.id)).toEqual(['a'])
  expect(visible(xs, true).map((x) => x.id)).toEqual(['a', 'b'])
})
