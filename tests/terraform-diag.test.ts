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
