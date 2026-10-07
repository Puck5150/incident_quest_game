import { describe, expect, it } from 'vitest'
import { UNKNOWN } from '../src/game/terraform/eval.ts'
import { diffLines, lines, row, scalar } from '../src/game/terraform/render-value.ts'

describe('scalar and row', () => {
  it('formats scalars and empty collections', () => {
    expect([scalar('a"b'), scalar(5), scalar(true), scalar(null), scalar(undefined), scalar(UNKNOWN), scalar([]), scalar({})]).toEqual(['"a\\"b"', '5', 'true', 'null', 'null', '(known after apply)', '[]', '{}'])
  })
  it('puts the symbol at the column and the text two columns after it', () => {
    expect(row(6, '+', 'a = 1')).toBe('      + a = 1')
    expect(row(6, ' ', '}')).toBe('        }')
  })
})

describe('lines', () => {
  it('renders scalars on one row', () => {
    expect(lines(6, '+', 'ami', 0, 'ami-1')).toEqual(['      + ami = "ami-1"'])
    expect(lines(6, '+', 'arn', 0, UNKNOWN)).toEqual(['      + arn = (known after apply)'])
    expect(lines(6, '+', 'x', 0, [])).toEqual(['      + x = []'])
  })

  it('pads the name to the width given', () => {
    expect(lines(6, '+', 'ami', 5, 'a')).toEqual(['      + ami   = "a"'])
  })

  it('renders a map with sorted, quoted, aligned keys', () => {
    expect(lines(6, '+', 'tags', 0, { Name: 'x', Env: 'prod' })).toEqual([
      '      + tags = {',
      '          + "Env"  = "prod"',
      '          + "Name" = "x"',
      '        }',
    ])
  })

  it('renders a list with one element per row', () => {
    expect(lines(6, '+', 'cidr_blocks', 0, ['10.0.0.0/8', '10.1.0.0/16'])).toEqual([
      '      + cidr_blocks = [',
      '          + "10.0.0.0/8",',
      '          + "10.1.0.0/16",',
      '        ]',
    ])
  })

  it('renders a list of objects as repeated nested blocks with unquoted aligned attributes, omitting nulls', () => {
    expect(lines(6, '+', 'ingress', 0, [{ from_port: 22, to_port: 22, note: null }, { from_port: 80, to_port: 80 }])).toEqual([
      '      + ingress {',
      '          + from_port = 22',
      '          + to_port   = 22',
      '        }',
      '      + ingress {',
      '          + from_port = 80',
      '          + to_port   = 80',
      '        }',
    ])
  })

  it('nests maps inside blocks', () => {
    expect(lines(6, '-', 'rule', 0, [{ tags: { a: '1' } }])).toEqual(['      - rule {', '          - tags = {', '              - "a" = "1"', '            }', '        }'])
  })
})

describe('diffLines: scalars and additions/removals', () => {
  it('shows a changed scalar, and an unknown replacement value', () => {
    expect(diffLines(6, 'ami', 0, 'ami-1', 'ami-2')).toEqual(['      ~ ami = "ami-1" -> "ami-2"'])
    expect(diffLines(6, 'vpc_id', 0, 'vpc-1', UNKNOWN)).toEqual(['      ~ vpc_id = "vpc-1" -> (known after apply)'])
  })

  it('marks forced replacement on the last row', () => {
    expect(diffLines(6, 'ami', 0, 'a', 'b', true)).toEqual(['      ~ ami = "a" -> "b" # forces replacement'])
    expect(diffLines(6, 'tags', 0, undefined, { A: '1' }, true).at(-1)).toBe('        } # forces replacement')
  })

  it('shows null to value as an addition and value to null as a removal', () => {
    expect(diffLines(6, 'tags', 0, undefined, { Name: 'x' })).toEqual(['      + tags = {', '          + "Name" = "x"', '        }'])
    expect(diffLines(6, 'tags', 0, null, 'x')).toEqual(['      + tags = "x"'])
    expect(diffLines(6, 'ami', 0, 'ami-1', null)).toEqual(['      - ami = "ami-1" -> null'])
    expect(diffLines(6, 'tags', 0, { Name: 'x' }, null)).toEqual(['      - tags = {', '          - "Name" = "x"', '        } -> null'])
  })
})

describe('diffLines: maps', () => {
  it('shows only added, removed and changed keys, with a hidden count', () => {
    expect(diffLines(6, 'tags', 0, { Name: 'main' }, { Name: 'main', Owner: 'ops' })).toEqual([
      '      ~ tags = {',
      '          + "Owner" = "ops"',
      '            # (1 unchanged element hidden)',
      '        }',
    ])
    expect(diffLines(6, 'tags', 0, { A: '1', B: '2', C: '3' }, { A: '1', C: 'x' })).toEqual([
      '      ~ tags = {',
      '          - "B" = "2"',
      '          ~ "C" = "3" -> "x"',
      '            # (1 unchanged element hidden)',
      '        }',
    ])
  })

  it('pluralises the hidden count and aligns shown keys', () => {
    const out = diffLines(6, 'tags', 0, { A: '1', B: '2', C: '3' }, { A: '1', B: '2', C: '3', Long: 'x' })
    expect(out[1]).toBe('          + "Long" = "x"')
    expect(out[2]).toBe('            # (3 unchanged elements hidden)')
  })
})

describe('diffLines: lists', () => {
  it('diffs lists element-wise, collapsing the unchanged run', () => {
    expect(diffLines(6, 'xs', 0, ['a', 'b'], ['a', 'c'])).toEqual([
      '      ~ xs = [',
      '            # (1 unchanged element hidden)',
      '          - "b",',
      '          + "c",',
      '        ]',
    ])
  })
})

describe('diffLines: nested blocks', () => {
  const a = [{ from_port: 22, to_port: 22 }, { from_port: 80, to_port: 80 }]
  it('shows only the changed attribute of a changed block and counts unchanged blocks', () => {
    const b = [{ from_port: 22, to_port: 22 }, { from_port: 80, to_port: 8080 }]
    expect(diffLines(6, 'ingress', 0, a, b)).toEqual([
      '      ~ ingress {',
      '          ~ to_port = 80 -> 8080',
      '            # (1 unchanged attribute hidden)',
      '        }',
      '        # (1 unchanged block hidden)',
    ])
  })

  it('adds and removes whole blocks by position', () => {
    expect(diffLines(6, 'ingress', 0, [a[0]], a)).toEqual(['      + ingress {', '          + from_port = 80', '          + to_port   = 80', '        }', '        # (1 unchanged block hidden)'])
    expect(diffLines(6, 'ingress', 0, a, [a[0]])).toEqual(['      - ingress {', '          - from_port = 80', '          - to_port   = 80', '        }', '        # (1 unchanged block hidden)'])
  })
})
