import { describe, expect, it, vi } from 'vitest'
import { detectAction } from '../src/components/terminal/detect.ts'

const file = { path: '/etc/x', matches: 'ok', after: 'ok' }
const pred = { lock_free: true } as const
const check = (fileOk: boolean, doneOk: boolean, taken: string[] = []) => ({
  taken: new Set(taken),
  fileMatches: vi.fn(async () => fileOk),
  doneWhen: vi.fn(async () => doneOk),
})

describe('detectAction', () => {
  it('file-only: the file decides', async () => {
    expect(await detectAction({ id: 'a', file }, check(true, false))).toBe(true)
    expect(await detectAction({ id: 'a', file }, check(false, true))).toBe(false)
  })
  it('done_when-only: the predicate decides', async () => {
    expect(await detectAction({ id: 'a', done_when: pred }, check(false, true))).toBe(true)
    expect(await detectAction({ id: 'a', done_when: pred }, check(true, false))).toBe(false)
  })
  it('both: both are required', async () => {
    expect(await detectAction({ id: 'a', file, done_when: pred }, check(true, true))).toBe(true)
    expect(await detectAction({ id: 'a', file, done_when: pred }, check(true, false))).toBe(false)
    expect(await detectAction({ id: 'a', file, done_when: pred }, check(false, true))).toBe(false)
  })
  it('neither: never detected, nothing checked', async () => {
    const c = check(true, true)
    expect(await detectAction({ id: 'a' }, c)).toBe(false)
    expect(c.fileMatches).not.toHaveBeenCalled()
    expect(c.doneWhen).not.toHaveBeenCalled()
  })
  it('taken actions are skipped without checking', async () => {
    const c = check(true, true, ['a'])
    expect(await detectAction({ id: 'a', file, done_when: pred }, c)).toBe(false)
    expect(c.fileMatches).not.toHaveBeenCalled()
    expect(c.doneWhen).not.toHaveBeenCalled()
  })
  it('done_when is not evaluated when the file test fails', async () => {
    const c = check(false, true)
    await detectAction({ id: 'a', file, done_when: pred }, c)
    expect(c.fileMatches).toHaveBeenCalledWith(file)
    expect(c.doneWhen).not.toHaveBeenCalled()
  })
})
