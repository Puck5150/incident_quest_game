import { describe, expect, it } from 'vitest'
import { parseHcl } from '../src/game/terraform/parse.ts'

const parse = (text: string) => parseHcl('main.tf', text)

// Parse one expression by putting it in a locals block.
export const ex = (src: string) => {
  const r = parse(`locals {\n  v = ${src}\n}`)
  if (r.diagnostics.length) throw new Error(r.diagnostics[0].summary)
  return r.blocks[0].attrs[0].value
}

describe('parse: structure', () => {
  it('parses labelled blocks, arguments and nested blocks', () => {
    const r = parse(`resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = var.tags
  lifecycle {
    prevent_destroy = true
  }
}
`)
    expect(r.diagnostics).toEqual([])
    const b = r.blocks[0]
    expect(b).toMatchObject({ type: 'resource', labels: ['aws_vpc', 'main'], file: 'main.tf', pos: { line: 1, col: 1 } })
    expect(b.attrs.map((a) => a.name)).toEqual(['cidr_block', 'tags'])
    expect(b.attrs[0].value).toEqual({ kind: 'lit', value: '10.0.0.0/16' })
    expect(b.attrs[1].value).toMatchObject({ kind: 'ref', path: ['var', 'tags'] })
    expect(b.blocks[0]).toMatchObject({ type: 'lifecycle', attrs: [{ name: 'prevent_destroy', value: { kind: 'lit', value: true } }] })
  })

  it('accepts one-line blocks and bare-word labels', () => {
    const r = parse('terraform { required_version = ">= 1.9" }\nvariable region {}\n')
    expect(r.diagnostics).toEqual([])
    expect(r.blocks[0].attrs[0].name).toBe('required_version')
    expect(r.blocks[1]).toMatchObject({ type: 'variable', labels: ['region'] })
  })

  it('treats empty and comment-only files as no blocks', () => {
    expect(parse('')).toEqual({ blocks: [], diagnostics: [] })
    expect(parse('# nothing here\n/* or here */\n')).toEqual({ blocks: [], diagnostics: [] })
  })

  it('parses files with CRLF line endings', () => {
    const r = parse('locals {\r\n  a = 1\r\n}\r\n')
    expect(r.diagnostics).toEqual([])
    expect(r.blocks[0].attrs[0].name).toBe('a')
  })
})

describe('parse: strings and references', () => {
  it('keeps plain strings as literals and templates as parts', () => {
    expect(ex('"plain"')).toEqual({ kind: 'lit', value: 'plain' })
    expect(ex('"x-${var.y}"')).toMatchObject({ kind: 'tmpl', parts: ['x-', { kind: 'ref', path: ['var', 'y'] }] })
  })

  it('unwraps a string that is only one interpolation', () => {
    expect(ex('"${var.y}"')).toMatchObject({ kind: 'ref', path: ['var', 'y'] })
  })

  it('reads dotted references, indexes and later attributes', () => {
    expect(ex('aws_subnet.s[0].id')).toMatchObject({
      kind: 'attr',
      name: 'id',
      base: { kind: 'idx', index: { kind: 'lit', value: 0 }, base: { kind: 'ref', path: ['aws_subnet', 's'] } },
    })
  })

  it('reads true, false and null as literals', () => {
    expect([ex('true'), ex('false'), ex('null')]).toEqual([
      { kind: 'lit', value: true },
      { kind: 'lit', value: false },
      { kind: 'lit', value: null },
    ])
  })
})

describe('parse: errors', () => {
  it('reports a bare name with no = as a missing argument, with context', () => {
    const d = parse('resource "a" "b" {\n  cidr_block\n}\n').diagnostics[0]
    expect(d).toMatchObject({ summary: 'Argument or block definition required', file: 'main.tf', line: 2, context: 'resource "a" "b"' })
    expect(d.detail).toContain('use the equals sign "="')
  })

  it('reports an unclosed block at the opening brace', () => {
    expect(parse('resource "a" "b" {\n  x = 1\n').diagnostics[0]).toMatchObject({ summary: 'Unclosed configuration block', line: 1 })
  })

  it('reports a redefined argument', () => {
    const d = parse('locals {\n  a = 1\n  a = 2\n}\n').diagnostics[0]
    expect(d).toMatchObject({ summary: 'Attribute redefined', line: 3 })
    expect(d.detail).toContain('main.tf:2,3')
  })

  it('reports a top-level argument', () => {
    expect(parse('region = "x"\n').diagnostics[0]).toMatchObject({ summary: 'Unsupported argument', detail: 'An argument named "region" is not expected here.' })
  })

  it('reports two arguments on one line', () => {
    expect(parse('locals {\n  a = 1 b = 2\n}\n').diagnostics[0]).toMatchObject({ summary: 'Missing newline after argument', line: 2 })
  })

  it('returns lexer errors as diagnostics too', () => {
    expect(parse('a = "oops\n').diagnostics[0].summary).toBe('Unterminated template string')
  })
})
