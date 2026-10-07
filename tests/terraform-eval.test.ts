import { describe, expect, it } from 'vitest'
import { parseHcl } from '../src/game/terraform/parse.ts'
import { evalExpr, EvalError, UNKNOWN, type Scope, type Value } from '../src/game/terraform/eval.ts'

// Evaluate one expression with a scope that resolves references by walking `refs`.
export const ev = (src: string, refs: Record<string, Value> = {}): Value => {
  const r = parseHcl('main.tf', `locals {\n  v = ${src}\n}`)
  if (r.diagnostics.length) throw new Error(`parse: ${r.diagnostics[0].summary}`)
  const scope: Scope = {
    ref(path) {
      let cur: Value = refs as Value
      for (const p of path) {
        if (typeof cur !== 'object' || cur === null || Array.isArray(cur) || !(p in cur)) {
          throw new EvalError('Reference to undeclared value', `No value for ${path.join('.')}.`)
        }
        cur = (cur as Record<string, Value>)[p]
      }
      return cur
    },
  }
  return evalExpr(r.blocks[0].attrs[0].value, scope)
}

const fails = (src: string, refs: Record<string, Value> = {}) => {
  try {
    ev(src, refs)
  } catch (e) {
    if (e instanceof EvalError) return { summary: e.summary, detail: e.detail }
    throw e
  }
  throw new Error('expected an EvalError')
}

describe('eval: literals, templates, references', () => {
  it('evaluates literals', () => {
    expect([ev('1'), ev('"a"'), ev('true'), ev('null')]).toEqual([1, 'a', true, null])
    expect(ev('[1, "a"]')).toEqual([1, 'a'])
    expect(ev('{ a = 1, "b-c" = [2] }')).toEqual({ a: 1, 'b-c': [2] })
  })

  it('builds strings from templates, printing whole numbers without a decimal point', () => {
    expect(ev('"x-${var.n}-${var.ok}-${var.s}"', { var: { n: 1, ok: true, s: 'z' } })).toBe('x-1-true-z')
    expect(ev('"${var.f}"', { var: { f: 1.5 } })).toBe(1.5)
    expect(ev('"n=${var.f}"', { var: { f: 1.5 } })).toBe('n=1.5')
  })

  it('rejects null and collections inside a template', () => {
    expect(fails('"x${null}"').summary).toBe('Invalid template interpolation value')
    expect(fails('"x${[1]}"').summary).toBe('Invalid template interpolation value')
  })

  it('resolves references through the scope, then attributes and indexes', () => {
    const refs = { aws_vpc: { main: { id: 'vpc-1' } }, aws_subnet: { s: [{ id: 'a' }, { id: 'b' }] } }
    expect(ev('aws_vpc.main.id', refs)).toBe('vpc-1')
    expect(ev('aws_subnet.s[1].id', refs)).toBe('b')
    expect(ev('aws_subnet.s.0.id', refs)).toBe('a')
  })

  it('reports a missing attribute or index', () => {
    expect(fails('aws_vpc.main.nope', { aws_vpc: { main: { id: 'x' } } })).toMatchObject({ summary: 'Reference to undeclared value' })
    expect(fails('v.a', { v: { b: 1 } }).summary).toBe('Reference to undeclared value')
    expect(fails('[1][5]').summary).toBe('Invalid index')
    expect(fails('{ a = 1 }.b').summary).toBe('Unsupported attribute')
    expect(fails('"s".x').summary).toBe('Unsupported attribute')
  })

  it('treats an unknown value as unknown through attribute, index and template', () => {
    const refs = { aws_vpc: { main: { id: UNKNOWN } } }
    expect(ev('aws_vpc.main.id', refs)).toBe(UNKNOWN)
    expect(ev('"vpc-${aws_vpc.main.id}"', refs)).toBe(UNKNOWN)
    expect(ev('aws_vpc.main.id[0]', refs)).toBe(UNKNOWN)
  })
})

describe('eval: operators and conditionals', () => {
  it('does arithmetic with precedence, and coerces numeric strings', () => {
    expect(ev('1 + 2 * 3')).toBe(7)
    expect(ev('10 - 2 - 3')).toBe(5)
    expect(ev('7 % 4')).toBe(3)
    expect(ev('"2" + 1')).toBe(3)
    expect(ev('-3 + 1')).toBe(-2)
  })

  it('rejects a non-number operand', () => {
    expect(fails('"a" + 1')).toMatchObject({ summary: 'Invalid operand', detail: 'Unsuitable value for left operand: a number is required.' })
    expect(fails('1 + true').detail).toBe('Unsuitable value for right operand: a number is required.')
  })

  it('compares and tests equality deeply', () => {
    expect([ev('1 < 2'), ev('2 <= 2'), ev('3 > 4'), ev('"a" == "a"'), ev('1 != 2')]).toEqual([true, true, false, true, true])
    expect(ev('[1, { a = 2 }] == [1, { a = 2 }]')).toBe(true)
    expect(ev('[1] == [2]')).toBe(false)
    expect(ev('1 == "1"')).toBe(false)
  })

  it('does logic, and negation', () => {
    expect([ev('true && false'), ev('false || true'), ev('!false')]).toEqual([false, true, true])
    expect(fails('1 && true').summary).toBe('Invalid operand')
    expect(fails('!1').summary).toBe('Invalid operand')
  })

  it('propagates unknown, except where the answer is already decided', () => {
    const refs = { u: UNKNOWN }
    expect(ev('u + 1', refs)).toBe(UNKNOWN)
    expect(ev('u == 1', refs)).toBe(UNKNOWN)
    expect(ev('!u', refs)).toBe(UNKNOWN)
    expect(ev('false && u', refs)).toBe(false)
    expect(ev('u && false', refs)).toBe(false)
    expect(ev('true || u', refs)).toBe(true)
    expect(ev('true && u', refs)).toBe(UNKNOWN)
  })

  it('evaluates conditionals, lazily in the branch not taken', () => {
    expect(ev('true ? 1 : 2')).toBe(1)
    expect(ev('false ? nope.x : 2')).toBe(2)
    expect(ev('u ? 1 : 2', { u: UNKNOWN })).toBe(UNKNOWN)
    expect(fails('1 ? 1 : 2').summary).toBe('Incorrect condition type')
  })
})

describe('eval: own keys only', () => {
  it('does not resolve inherited keys', () => {
    expect(fails('{ a = 1 }.constructor').summary).toBe('Unsupported attribute')
    expect(fails('{ a = 1 }.toString').summary).toBe('Unsupported attribute')
    expect(fails('{ a = 1 }["constructor"]').summary).toBe('Invalid index')
  })

  it('keeps __proto__ as an ordinary key', () => {
    expect(Object.keys(ev('{ "__proto__" = 1 }') as object)).toContain('__proto__')
    expect(ev('{} == { "__proto__" = 1 }')).toBe(false)
  })

  it('propagates unknown through unary minus', () => {
    expect(ev('-u', { u: UNKNOWN })).toBe(UNKNOWN)
  })
})

describe('eval: functions', () => {
  it('rejects an unknown function and the wrong number of arguments', () => {
    expect(fails('nope(1)')).toMatchObject({ summary: 'Call to unknown function', detail: 'There is no function named "nope".' })
    expect(fails('lookup({ a = 1 })').summary).toBe('Not enough function arguments')
    expect(fails('upper("a", "b")').summary).toBe('Too many function arguments')
  })

  it('makes the result unknown when an argument is unknown', () => {
    expect(ev('upper(u)', { u: UNKNOWN })).toBe(UNKNOWN)
    expect(ev('merge({ a = 1 }, u)', { u: UNKNOWN })).toBe(UNKNOWN)
  })

  it('does collections: length, keys, values, concat, contains, element', () => {
    expect([ev('length([1, 2])'), ev('length("héllo")'), ev('length({ a = 1 })')]).toEqual([2, 5, 1])
    expect(ev('keys({ b = 1, a = 2 })')).toEqual(['a', 'b'])
    expect(ev('values({ b = 1, a = 2 })')).toEqual([2, 1])
    expect(ev('concat([1], [2, 3])')).toEqual([1, 2, 3])
    expect([ev('contains(["a"], "a")'), ev('contains(["a"], "b")')]).toEqual([true, false])
    expect([ev('element(["a", "b", "c"], 1)'), ev('element(["a", "b", "c"], 4)')]).toEqual(['b', 'b'])
  })

  it('merges maps with later keys winning, and looks keys up with an optional default', () => {
    expect(ev('merge({ a = 1, b = 2 }, { b = 3 })')).toEqual({ a: 1, b: 3 })
    expect(ev('lookup({ a = 1 }, "a")')).toBe(1)
    expect(ev('lookup({ a = 1 }, "z", 9)')).toBe(9)
    expect(fails('lookup({ a = 1 }, "z")').summary).toBe('Invalid function argument')
    expect(fails('lookup({ a = 1 }, "constructor")').summary).toBe('Invalid function argument')
    expect(Object.keys(ev('merge({ "__proto__" = 1 }, { b = 2 })') as object)).toEqual(['__proto__', 'b'])
  })

  it('builds sets as sorted unique lists', () => {
    expect(ev('toset(["b", "a", "b"])')).toEqual(['a', 'b'])
    expect(ev('tolist(toset([3, 1, 3]))')).toEqual([1, 3])
  })

  it('does strings: format, join, upper, lower, replace, trimspace', () => {
    expect(ev('format("%s-%d-%v-%%", "a", 3, true)')).toBe('a-3-true-%')
    expect(ev('format("%d", 1.0)')).toBe('1')
    expect(ev('join(",", ["a", "b"])')).toBe('a,b')
    expect([ev('upper("a")'), ev('lower("A")'), ev('replace("a-b-c", "-", "_")'), ev('trimspace("  x ")')]).toEqual(['A', 'a', 'a_b_c', 'x'])
  })

  it('converts types and picks values', () => {
    expect([ev('tostring(1)'), ev('tonumber("2")'), ev('max(1, 3, 2)'), ev('min(4, 2)')]).toEqual(['1', 2, 3, 2])
    expect(fails('tonumber("x")').summary).toBe('Invalid function argument')
    expect(ev('coalesce("", null, "b", "c")')).toBe('b')
    expect(fails('coalesce("", null)').summary).toBe('Invalid function argument')
  })

  it('encodes JSON with sorted keys', () => {
    expect(ev('jsonencode({ b = [1, "x"], a = true, c = null })')).toBe('{"a":true,"b":[1,"x"],"c":null}')
    expect(ev('jsonencode({ a = u })', { u: UNKNOWN })).toBe(UNKNOWN)
  })

  it('computes cidrsubnet', () => {
    expect(ev('cidrsubnet("10.0.0.0/16", 8, 2)')).toBe('10.0.2.0/24')
    expect(ev('cidrsubnet("10.0.0.0/16", 4, 15)')).toBe('10.0.240.0/20')
    expect(ev('cidrsubnet("192.168.1.0/24", 1, 1)')).toBe('192.168.1.128/25')
  })

  it('rejects bad cidrsubnet arguments', () => {
    expect(fails('cidrsubnet("nope", 8, 0)').summary).toBe('Invalid function argument')
    expect(fails('cidrsubnet("10.0.0.0/30", 8, 0)').detail).toContain('not enough remaining address space')
    expect(fails('cidrsubnet("10.0.0.0/16", 2, 4)').detail).toContain('does not accommodate a subnet numbered 4')
  })
})

describe('eval: functions, nested unknowns and edge cases', () => {
  const u = { u: UNKNOWN }
  it('makes value-inspecting functions unknown when an element is unknown', () => {
    expect(ev('join(",", [u, "x"])', u)).toBe(UNKNOWN)
    expect(ev('toset([u, "a"])', u)).toBe(UNKNOWN)
    expect(ev('contains([u], "x")', u)).toBe(UNKNOWN)
    expect(ev('format("%s-%s", "a", u)', u)).toBe(UNKNOWN)
  })

  it('lets partial unknowns pass through functions that only move values', () => {
    expect(ev('element([u, "b"], 1)', u)).toBe('b')
    expect(ev('element([u, "b"], 0)', u)).toBe(UNKNOWN)
    expect(ev('lookup({ a = u }, "b", 1)', u)).toBe(1)
  })

  it('rejects unsupported format verbs and converts null', () => {
    expect(fails('format("%03d", 5)').summary).toBe('Invalid function argument')
    expect(fails('format("100%")').summary).toBe('Invalid function argument')
    expect([ev('tostring(null)'), ev('tonumber(null)')]).toEqual([null, null])
  })
})
