import { describe, expect, it } from 'vitest'
import { lex } from '../src/game/terraform/lex.ts'
import { HclError } from '../src/game/terraform/types.ts'

const kinds = (t: string) =>
  lex('main.tf', t).map((x) => (x.k === 'p' ? x.v : x.k === 'id' ? `id:${x.v}` : x.k))

const lexError = (t: string) => {
  try {
    lex('main.tf', t)
  } catch (e) {
    if (e instanceof HclError) return e.diag
    throw e
  }
  throw new Error('expected a lex error')
}

describe('lex', () => {
  it('tokenises identifiers, punctuation, numbers and newlines', () => {
    expect(kinds('a = 1\nb-c = foo.bar')).toEqual(['id:a', '=', 'num', 'nl', 'id:b-c', '=', 'id:foo', '.', 'id:bar', 'eof'])
  })

  it('reads two-character operators as one token', () => {
    expect(kinds('a == b && c != d || e >= f')).toEqual(['id:a', '==', 'id:b', '&&', 'id:c', '!=', 'id:d', '||', 'id:e', '>=', 'id:f', 'eof'])
  })

  it('skips all three comment styles', () => {
    expect(kinds('# x\n// y\n/* z */ a')).toEqual(['nl', 'nl', 'id:a', 'eof'])
  })

  it('ignores a BOM and carriage returns', () => {
    expect(kinds('﻿a = 1\r\n')).toEqual(['id:a', '=', 'num', 'nl', 'eof'])
  })

  it('tracks line and column', () => {
    const toks = lex('main.tf', 'a = 1\n  b')
    expect(toks[4]).toMatchObject({ k: 'id', v: 'b', pos: { line: 2, col: 3 } })
  })

  it('decodes escapes and splits interpolations out of strings', () => {
    const [, , s] = lex('main.tf', 'a = "x\\n${var.y}z"')
    expect(s).toMatchObject({ k: 'str', parts: ['x\n', { src: 'var.y' }, 'z'] })
  })

  it('treats $${ as a literal ${', () => {
    const [, , s] = lex('main.tf', 'a = "$${x}"')
    expect(s).toMatchObject({ k: 'str', parts: ['${x}'] })
  })

  it('finds the end of an interpolation that contains quotes and braces', () => {
    const [, , s] = lex('main.tf', 'a = "${lookup({ k = "v" }, "k")}"')
    expect(s).toMatchObject({ k: 'str', parts: [{ src: 'lookup({ k = "v" }, "k")' }] })
  })

  it('reads a <<- heredoc, strips the common indent, and keeps interpolations', () => {
    const toks = lex('main.tf', 'a = <<-EOT\n    hi ${x}\n      there\n  EOT\n')
    expect(toks[2]).toMatchObject({ k: 'str', parts: ['hi ', { src: 'x' }, '\n  there\n'] })
    expect(toks[3]).toMatchObject({ k: 'nl' })
  })

  it('rejects an unterminated string', () => {
    expect(lexError('a = "oops\n')).toMatchObject({ summary: 'Unterminated template string', line: 1 })
  })

  it('rejects an unterminated comment, heredoc and interpolation', () => {
    expect(lexError('/* never closed').summary).toBe('Unterminated comment')
    expect(lexError('a = <<EOT\nbody\n').summary).toBe('Unterminated heredoc')
    expect(lexError('a = "${x').summary).toBe('Unterminated template interpolation')
  })

  it('rejects template directives and stray characters', () => {
    expect(lexError('a = "%{ if x }y%{ endif }"').summary).toBe('Unsupported template directive')
    expect(lexError('a = @').summary).toBe('Invalid character')
  })
})
