import { describe, expect, it } from 'vitest'
import { EvalError, UNKNOWN, type Scope, type Value } from '../src/game/terraform/eval.ts'
import { expandInstances } from '../src/game/terraform/expand.ts'
import { parseHcl } from '../src/game/terraform/parse.ts'

// Expand the first resource in `body`, with `var.*` resolved from `vars`.
const expand = (body: string, vars: Record<string, Value> = {}) => {
  const r = parseHcl('main.tf', `resource "aws_s3_bucket" "b" {\n${body}\n}`)
  if (r.diagnostics.length) throw new Error(r.diagnostics[0].summary)
  const scope: Scope = {
    ref(path) {
      if (path[0] === 'var' && Object.hasOwn(vars, path[1])) return vars[path[1]]
      throw new EvalError('Reference to undeclared value', path.join('.'))
    },
  }
  return expandInstances(r.blocks[0], scope)
}
const bad = (body: string, vars: Record<string, Value> = {}) => {
  const e = expand(body, vars)
  if (e.ok) throw new Error('expected an error')
  return e
}

describe('expandInstances', () => {
  it('gives a single instance when neither count nor for_each is set', () => {
    expect(expand('  bucket = "x"')).toMatchObject({ ok: true, kind: 'single', keys: [undefined] })
  })

  it('expands count into indexes, including zero', () => {
    expect(expand('  count = 3')).toMatchObject({ ok: true, kind: 'count', keys: [0, 1, 2] })
    expect(expand('  count = var.n', { n: 0 })).toMatchObject({ kind: 'count', keys: [] })
  })

  it('converts a numeric string count (from -var), but not other strings', () => {
    expect(expand('  count = var.n', { n: '2' })).toMatchObject({ kind: 'count', keys: [0, 1] })
    expect(bad('  count = var.n', { n: 'x' }).detail).toContain('number required')
    expect(bad('  count = var.n', { n: ' 2 ' }).detail).toContain('number required')
  })

  it('rejects an unknown, null, negative, fractional or non-number count', () => {
    expect(bad('  count = var.n', { n: UNKNOWN })).toMatchObject({ summary: 'Invalid count argument', detail: expect.stringContaining('cannot be determined until apply') })
    expect(bad('  count = null').summary).toBe('Invalid count argument')
    expect(bad('  count = -1').detail).toContain('greater than or equal to zero')
    expect(bad('  count = 1.5').detail).toContain('whole number')
    expect(bad('  count = "many"').detail).toContain('number required')
  })

  it('expands a for_each map into sorted keys with key and value', () => {
    const e = expand('  for_each = { b = "2", a = "1" }')
    expect(e).toMatchObject({ ok: true, kind: 'for_each', keys: ['a', 'b'] })
    if (e.ok) expect(e.each('b')).toEqual({ key: 'b', value: '2' })
  })

  it('expands a for_each set of strings into sorted unique keys, value equal to key', () => {
    const e = expand('  for_each = toset(["b", "a", "b"])')
    expect(e).toMatchObject({ ok: true, kind: 'for_each', keys: ['a', 'b'] })
    if (e.ok) expect(e.each('a')).toEqual({ key: 'a', value: 'a' })
  })

  it('rejects an unknown for_each, or a set holding an unknown', () => {
    const first = bad('  for_each = var.m', { m: UNKNOWN })
    expect(first.summary).toBe('Invalid for_each argument')
    expect(first.detail).toContain('cannot be determined until apply')
    expect(bad('  for_each = var.m', { m: ['a', UNKNOWN] }).summary).toBe('Invalid for_each argument')
  })

  it('rejects for_each over numbers, strings, null, or a set of non-strings', () => {
    expect(bad('  for_each = 3').detail).toContain('must be a map, or set of strings')
    expect(bad('  for_each = "abc"').detail).toContain('must be a map, or set of strings')
    expect(bad('  for_each = null').summary).toBe('Invalid for_each argument')
    expect(bad('  for_each = [1, 2]').detail).toContain('set containing type number')
  })

  it('rejects count together with for_each, and reports evaluation errors at the argument', () => {
    expect(bad('  count = 1\n  for_each = ["a"]').summary).toBe('Invalid combination of "count" and "for_each"')
    const e = bad('  count = var.missing')
    expect(e).toMatchObject({ summary: 'Reference to undeclared value', pos: { line: 2 } })
  })

  it('caps instances at 1000 for count and for_each', () => {
    const d = 'The given "count" argument value is unsuitable: this lab supports at most 1000 instances of one resource.'
    expect(bad('  count = 1001')).toMatchObject({ summary: 'Invalid count argument', detail: d })
    expect(bad('  count = 1000000000')).toMatchObject({ detail: d })
    expect(bad('  count = 1e308')).toMatchObject({ detail: d })
    const ok = expand('  count = 1000')
    expect(ok.ok && ok.keys.length).toBe(1000)
    const vars = { s: Array.from({ length: 1001 }, (_, i) => String(i)) }
    expect(bad('  for_each = var.s', vars)).toMatchObject({
      summary: 'Invalid for_each argument',
      detail: 'The given "for_each" argument value is unsuitable: this lab supports at most 1000 instances of one resource.',
    })
  })
})
