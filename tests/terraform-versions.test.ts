import { describe, expect, it } from 'vitest'
import { compareVersions, newestSatisfying, parseVersion, satisfies } from '../src/game/terraform/versions.ts'

const ok = (v: string, c: string) => satisfies(parseVersion(v)!, c)

describe('parseVersion', () => {
  it('parses 1 to 3 segments, v prefix, prerelease and metadata', () => {
    expect(parseVersion('5.40.1')).toEqual({ major: 5, minor: 40, patch: 1 })
    expect(parseVersion('v2.1')).toEqual({ major: 2, minor: 1, patch: 0 })
    expect(parseVersion('3')).toEqual({ major: 3, minor: 0, patch: 0 })
    expect(parseVersion('1.2.3-beta.1+build5')).toEqual({ major: 1, minor: 2, patch: 3, pre: 'beta.1' })
  })
  it('rejects junk', () => {
    for (const s of ['', 'x', '1.2.3.4', '1..2', '1.2.', '>=1.0', '__proto__', '1.2.3-']) expect(parseVersion(s), s).toBeUndefined()
  })
})

describe('compareVersions', () => {
  const c = (a: string, b: string) => compareVersions(parseVersion(a)!, parseVersion(b)!)
  it('orders numerically, prereleases below the release', () => {
    expect(c('1.2.3', '1.2.3')).toBe(0)
    expect(c('1.10.0', '1.9.9')).toBe(1)
    expect(c('2.0.0', '10.0.0')).toBe(-1)
    expect(c('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(c('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(c('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1)
    expect(c('1.0.0-beta', '1.0.0-beta.1')).toBe(-1)
  })
})

describe('satisfies', () => {
  const table: [string, string, boolean][] = [
    ['1.2.3', '1.2.3', true],
    ['1.2.3', '= 1.2.3', true],
    ['1.2.4', '= 1.2.3', false],
    ['1.2.3', '=1.2.3', true],
    ['1.2.4', '!= 1.2.3', true],
    ['1.2.3', '!= 1.2.3', false],
    ['1.2.4', '> 1.2.3', true],
    ['1.2.3', '> 1.2.3', false],
    ['1.2.3', '>= 1.2.3', true],
    ['1.2.2', '>= 1.2.3', false],
    ['1.2.2', '< 1.2.3', true],
    ['1.2.3', '< 1.2.3', false],
    ['1.2.3', '<= 1.2.3', true],
    ['1.2.4', '<= 1.2.3', false],
    ['1.2.0', '1.2', true], // missing segments are zero
    ['5.40.0', '~> 5.40', true],
    ['5.99.9', '~> 5.40', true],
    ['5.39.9', '~> 5.40', false],
    ['6.0.0', '~> 5.40', false],
    ['5.40.1', '~> 5.40.1', true],
    ['5.40.9', '~> 5.40.1', true],
    ['5.40.0', '~> 5.40.1', false],
    ['5.41.0', '~> 5.40.1', false],
    ['2.0.1', '~> 2.0', true],
    ['2.1.0', '~> 2.0', true],
    ['3.0.0', '~> 2.0', false],
    ['1.9.0', '~> 2.0', false],
    ['2.9.9', '~> 2.0.0', false],
    ['5.0.0', '~> 5', true], // go-version: a one-segment ~> has no upper bound
    ['9.0.0', '~> 5', true],
    ['4.9.9', '~> 5', false],
    ['1.5.0', '>= 1.2, < 2.0', true],
    ['2.0.0', '>= 1.2, < 2.0', false],
    ['1.1.0', '>= 1.2, < 2.0', false],
    ['1.5.0', '>= 1.2, < 2.0, != 1.5.0', false],
    ['1.5.1', '>= 1.2,<2.0,!=1.5.0', true],
    ['1.2.3-beta', '>= 1.0', false], // prereleases need a constraint that names one
    ['1.2.3-beta', '= 1.2.3-beta', true],
    ['1.2.3-beta', '!= 1.0.0', false],
    ['1.2.3-beta', '>= 1.2.3-alpha', true],
    ['1.2.4-beta', '>= 1.2.3-alpha', false],
    ['1.2.3', '>= 1.2.3-alpha', true],
    ['1.2.3-rc.1', '~> 1.2.3-rc.0', true],
    ['1.2.3', '~> 1.2.3-rc.0', false], // go-version: ~> with a prerelease only matches prereleases
  ]
  it.each(table)('%s against "%s" is %s', (v, c, want) => {
    expect(ok(v, c)).toEqual({ ok: want })
  })
  it('reports invalid constraints with the Terraform detail', () => {
    for (const c of ['', 'latest', '>>1.0', '~>', '>= 1.0,', '1.2.3.4', '~= 1.0', '== 1.0', '> = 1', '>= 1.0 < 2.0'])
      expect(ok('1.0.0', c), c).toEqual({ ok: false, error: 'This string does not use correct version constraint syntax.' })
  })
})

describe('newestSatisfying', () => {
  const vs = ['2.0.1', '2.1.0', '1.9.0', '3.0.0-beta', '3.0.0', '2.10.0', 'junk']
  it('picks the highest match, numerically', () => {
    expect(newestSatisfying(vs, '~> 2.0')).toBe('2.10.0')
    expect(newestSatisfying(vs, '~> 2.0.0')).toBe('2.0.1')
    expect(newestSatisfying(vs, '< 2.1')).toBe('2.0.1')
    expect(newestSatisfying(vs, '>= 1.0')).toBe('3.0.0')
    expect(newestSatisfying(vs, '= 3.0.0-beta')).toBe('3.0.0-beta')
    expect(newestSatisfying(vs, '> 3.0.0')).toBeUndefined()
    expect(newestSatisfying(vs, 'nonsense')).toBeUndefined()
    expect(newestSatisfying([], '>= 1')).toBeUndefined()
  })
})
