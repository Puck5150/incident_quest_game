import { describe, expect, it } from 'vitest'
import { formatDiagnostic, wrap } from '../src/game/terraform/diag.ts'
import { parseHcl } from '../src/game/terraform/parse.ts'

describe('formatDiagnostic', () => {
  it('prints the boxed error with location, source line and detail', () => {
    const out = formatDiagnostic(
      { severity: 'error', summary: 'Bad thing', detail: 'short detail', file: 'main.tf', line: 2, col: 3, context: 'resource "a" "b"' },
      'x\n  cidr_block\n',
    )
    expect(out).toBe(
      [
        '╷',
        '│ Error: Bad thing',
        '│ ',
        '│   on main.tf line 2, in resource "a" "b":',
        '│    2:   cidr_block',
        '│ ',
        '│ short detail',
        '╵',
      ].join('\n'),
    )
  })

  it('omits the location for diagnostics without a file, such as a cycle', () => {
    expect(formatDiagnostic({ severity: 'error', summary: 'Cycle: a, b', detail: '', file: '', line: 0, col: 0 })).toBe('╷\n│ Error: Cycle: a, b\n╵')
  })

  it('omits ", in ..." when there is no context', () => {
    const out = formatDiagnostic({ severity: 'error', summary: 'S', detail: '', file: 'f.tf', line: 1, col: 1 }, 'a = 1')
    expect(out).toContain('│   on f.tf line 1:')
  })

  it('formats a real parse error end to end', () => {
    const text = 'resource "a" "b" {\n  cidr_block\n}\n'
    const out = formatDiagnostic(parseHcl('main.tf', text).diagnostics[0], text)
    expect(out.startsWith('╷\n│ Error: Argument or block definition required\n')).toBe(true)
    expect(out).toContain('│    2:   cidr_block')
    expect(out.endsWith('╵')).toBe(true)
  })
})

describe('wrap', () => {
  it('wraps on word boundaries without losing words', () => {
    const text = Array.from({ length: 30 }, () => 'aaaa').join(' ')
    const lines = wrap(text, 76)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every((l) => l.length <= 76)).toBe(true)
    expect(lines.join(' ')).toBe(text)
  })
})

describe('formatDiagnostic: warnings', () => {
  it('labels a warning as Warning', () => {
    const out = formatDiagnostic({ severity: 'warning', summary: 'Careful', detail: 'short detail', file: '', line: 0, col: 0 })
    expect(out).toBe(['╷', '│ Warning: Careful', '│ ', '│ short detail', '╵'].join('\n'))
  })
})

describe('wrap and formatDiagnostic: preserveLines', () => {
  it('keeps indented lines and blank lines as written and wraps the rest', () => {
    const text = 'Intro line.\n  - provider a/b: required\n\nTo fix this, run:\n  terraform init'
    expect(wrap(text, 76, true)).toEqual(['Intro line.', '  - provider a/b: required', '', 'To fix this, run:', '  terraform init'])
    const long = `${'word '.repeat(30)}end`
    expect(wrap(long, 76, true).length).toBeGreaterThan(1)
    const out = formatDiagnostic({ severity: 'error', summary: 'S', detail: text, file: '', line: 0, col: 0 }, '', { preserveLines: true })
    expect(out).toBe(['╷', '│ Error: S', '│ ', '│ Intro line.', '│   - provider a/b: required', '│ ', '│ To fix this, run:', '│   terraform init', '╵'].join('\n'))
  })
})

describe('formatDiagnostic: address', () => {
  it('prints the with-line before the location', () => {
    const out = formatDiagnostic({ severity: 'error', summary: 'creating X', detail: '', file: 'main.tf', line: 2, col: 1, context: 'resource "a" "b"', address: 'a.b' }, 'x\nresource "a" "b" {\n')
    expect(out).toBe(['╷', '│ Error: creating X', '│ ', '│   with a.b,', '│   on main.tf line 2, in resource "a" "b":', '│    2: resource "a" "b" {', '╵'].join('\n'))
  })
  it('prints only the with-line when there is no source', () => {
    expect(formatDiagnostic({ severity: 'error', summary: 'destroying X', detail: '', file: '', line: 0, col: 0, address: 'a.old' })).toBe(['╷', '│ Error: destroying X', '│ ', '│   with a.old,', '╵'].join('\n'))
  })
})
