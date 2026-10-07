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

  it('renders a list of objects as a list: bare attribute names aligned per element, nulls shown, the element closed with a comma', () => {
    expect(lines(6, '+', 'ingress', 0, [{ from_port: 22, to_port: 22, note: null }, { from_port: 80, to_port: 80 }])).toEqual([
      '      + ingress = [',
      '          + {',
      '              + from_port = 22',
      '              + note      = null',
      '              + to_port   = 22',
      '            },',
      '          + {',
      '              + from_port = 80',
      '              + to_port   = 80',
      '            },',
      '        ]',
    ])
  })

  it('quotes the keys of a map inside an element', () => {
    expect(lines(6, '+', 'rule', 0, [{ tags: { a: '1' } }])).toEqual(['      + rule = [', '          + {', '              + tags = {', '                  + "a" = "1"', '                }', '            },', '        ]'])
  })

  it('nests lists of objects inside an element, aligned over all of its attributes', () => {
    expect(lines(6, '+', 'rule', 0, [{ port: 22, inner: [{ x: 1 }], zz: 'a' }])).toEqual([
      '      + rule = [',
      '          + {',
      '              + inner = [',
      '                  + {',
      '                      + x = 1',
      '                    },',
      '                ]',
      '              + port  = 22',
      '              + zz    = "a"',
      '            },',
      '        ]',
    ])
  })

  it('does not overflow the stack on a 200k-key map', () => {
    const big: Record<string, string> = {}
    for (let i = 0; i < 200000; i++) big[`k${i}`] = 'v'
    expect(lines(6, '+', 'm', 0, big)).toHaveLength(200002)
    expect(diffLines(6, 'm', 0, {}, big)).toHaveLength(200002)
  })
})

describe('diffLines: scalars and additions/removals', () => {
  it('shows a changed scalar, and an unknown replacement value', () => {
    expect(diffLines(6, 'ami', 0, 'ami-1', 'ami-2')).toEqual(['      ~ ami = "ami-1" -> "ami-2"'])
    expect(diffLines(6, 'vpc_id', 0, 'vpc-1', UNKNOWN)).toEqual(['      ~ vpc_id = "vpc-1" -> (known after apply)'])
  })

  it('marks forced replacement on the opening line', () => {
    expect(diffLines(6, 'ami', 0, 'a', 'b', true)).toEqual(['      ~ ami = "a" -> "b" # forces replacement'])
    // on the opening line for a map, a list and a list of objects
    expect(diffLines(6, 'tags', 0, undefined, { A: '1' }, true)[0]).toBe('      + tags = { # forces replacement')
    expect(diffLines(6, 'xs', 0, ['a'], ['b'], true)[0]).toBe('      ~ xs = [ # forces replacement')
    expect(diffLines(6, 'ingress', 0, [{ p: 1 }], [{ p: 2 }], true)[0]).toBe('      ~ ingress = [ # forces replacement')
  })

  it('puts the marker after the closing bracket when a collection becomes unknown', () => {
    expect(diffLines(6, 'xs', 0, ['a'], UNKNOWN, true)).toEqual(['      ~ xs = [', '          - "a",', '        ] -> (known after apply) # forces replacement'])
    expect(diffLines(6, 'tags', 0, { A: '1' }, UNKNOWN, true)).toEqual(['      ~ tags = {', '          - "A" = "1"', '        } -> (known after apply) # forces replacement'])
    expect(diffLines(6, 'id', 0, 'a', UNKNOWN, true)).toEqual(['      ~ id = "a" -> (known after apply) # forces replacement'])
  })

  it('shows null to value as an addition and value to null as a removal', () => {
    expect(diffLines(6, 'tags', 0, undefined, { Name: 'x' })).toEqual(['      + tags = {', '          + "Name" = "x"', '        }'])
    expect(diffLines(6, 'tags', 0, null, 'x')).toEqual(['      + tags = "x"'])
    expect(diffLines(6, 'ami', 0, 'ami-1', null)).toEqual(['      - ami = "ami-1" -> null'])
    expect(diffLines(6, 'tags', 0, { Name: 'x' }, null)).toEqual(['      - tags = {', '          - "Name" = "x"', '        } -> null'])
  })

  it('shows a collection that becomes unknown as removals closed by -> (known after apply)', () => {
    expect(diffLines(6, 'tags_all', 0, { Name: 'web' }, UNKNOWN)).toEqual(['      ~ tags_all = {', '          - "Name" = "web"', '        } -> (known after apply)'])
    expect(diffLines(6, 'xs', 0, ['a'], UNKNOWN)).toEqual(['      ~ xs = [', '          - "a",', '        ] -> (known after apply)'])
  })

  it('renders a change of type without JSON', () => {
    expect(diffLines(6, 't', 0, 'x', { A: '1' })).toEqual(['      ~ t = "x" -> {', '          + "A" = "1"', '        }'])
    expect(diffLines(6, 't', 0, { A: '1' }, 'x')).toEqual(['      ~ t = {', '          - "A" = "1"', '        } -> "x"'])
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
      '          - "B" = "2" -> null',
      '          ~ "C" = "3" -> "x"',
      '            # (1 unchanged element hidden)',
      '        }',
    ])
  })

  it('closes a removed key holding a collection with -> null after the bracket', () => {
    expect(diffLines(6, 'm', 0, { A: { x: '1' }, B: '2' }, { B: '2' })).toEqual([
      '      ~ m = {',
      '          - "A" = {',
      '              - "x" = "1"',
      '            } -> null',
      '            # (1 unchanged element hidden)',
      '        }',
    ])
  })

  it('pluralises the hidden count', () => {
    const out = diffLines(6, 'tags', 0, { A: '1', B: '2', C: '3' }, { A: '1', B: '2', C: '3', Long: 'x' })
    expect(out[1]).toBe('          + "Long" = "x"')
    expect(out[2]).toBe('            # (3 unchanged elements hidden)')
  })

  it('aligns over every key, including the unchanged ones that are hidden', () => {
    expect(diffLines(6, 'tags', 0, { A: '1', Longer: 'x' }, { A: '1', Longer: 'x', B: '2' })).toEqual([
      '      ~ tags = {',
      '          + "B"      = "2"',
      '            # (2 unchanged elements hidden)',
      '        }',
    ])
  })

  it('shows every key, unchanged ones as context and no hidden line, for id/name/tags', () => {
    expect(diffLines(6, 'tags', 0, { Name: 'web', Env: 'p' }, { Name: 'web', Env: 'q' }, false, true)).toEqual([
      '      ~ tags = {',
      '          ~ "Env"  = "p" -> "q"',
      '            "Name" = "web"',
      '        }',
    ])
  })
})

describe('diffLines: lists', () => {
  it('compares equal-length lists position by position, with the neighbours of a change as context', () => {
    expect(diffLines(6, 'xs', 0, ['a', 'b'], ['a', 'c'])).toEqual(['      ~ xs = [', '            "a",', '          ~ "b" -> "c",', '        ]'])
    expect(diffLines(6, 'xs', 0, ['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual(['      ~ xs = [', '            "a",', '          ~ "b" -> "x",', '            "c",', '        ]'])
  })

  it('hides the rest of an unchanged run: its length minus the printed context', () => {
    expect(diffLines(6, 'xs', 0, ['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c', 'X', 'e', 'f'])).toEqual([
      '      ~ xs = [',
      '            # (2 unchanged elements hidden)',
      '            "c",',
      '          ~ "d" -> "X",',
      '            "e",',
      '            # (1 unchanged element hidden)',
      '        ]',
    ])
  })

  it('uses a longest-common-subsequence diff when the length changes or the list is only reordered', () => {
    expect(diffLines(6, 'xs', 0, ['a', 'b'], ['a', 'b', 'c'])).toEqual(['      ~ xs = [', '            # (1 unchanged element hidden)', '            "b",', '          + "c",', '        ]'])
    expect(diffLines(6, 'xs', 0, ['a', 'b'], ['b', 'a'])).toEqual(['      ~ xs = [', '          - "a",', '            "b",', '          + "a",', '        ]'])
  })
})

describe('diffLines: lists of objects and sets', () => {
  it('compares same-length lists of objects position by position, an updated element showing only what changed', () => {
    expect(diffLines(6, 'rules', 0, [{ a: 1, b: 2 }, { a: 3, b: 4 }], [{ a: 1, b: 2 }, { a: 3, b: 5 }])).toEqual([
      '      ~ rules = [',
      '            {',
      '                a = 1',
      '                b = 2',
      '            },',
      '          ~ {',
      '              ~ b = 4 -> 5',
      '                # (1 unchanged attribute hidden)',
      '            },',
      '        ]',
    ])
  })

  it('on the LCS path shows an object deleted and another created in its place as one updated element', () => {
    expect(diffLines(6, 'xs', 0, [{ n: 1 }, { n: 2 }], [{ n: 1 }, { n: 3 }, { n: 4 }])).toEqual([
      '      ~ xs = [',
      '            {',
      '                n = 1',
      '            },',
      '          ~ {',
      '              ~ n = 2 -> 3',
      '            },',
      '          + {',
      '              + n = 4',
      '            },',
      '        ]',
    ])
  })

  it('treats a list as a reordering, and uses the LCS, whenever every old element is still present', () => {
    expect(diffLines(6, 'xs', 0, ['a', 'a', 'b'], ['a', 'b', 'b'])).toEqual(['      ~ xs = [', '            "a",', '          - "a",', '            "b",', '          + "b",', '        ]'])
  })

  it('shows a set as removals and additions by value, counting the unchanged elements at the end', () => {
    const r1 = { from_port: 80 }
    expect(diffLines(6, 'ingress', 0, [r1, { from_port: 22 }], [r1, { from_port: 2222 }], false, false, true)).toEqual([
      '      ~ ingress = [',
      '          - {',
      '              - from_port = 22',
      '            },',
      '          + {',
      '              + from_port = 2222',
      '            },',
      '            # (1 unchanged element hidden)',
      '        ]',
    ])
  })

  it('removes a whole list of objects with -> null after the bracket and none inside', () => {
    expect(diffLines(6, 'rule', 0, [{ tags: { a: '1' } }], null)).toEqual(['      - rule = [', '          - {', '              - tags = {', '                  - "a" = "1"', '                }', '            },', '        ] -> null'])
  })
})
