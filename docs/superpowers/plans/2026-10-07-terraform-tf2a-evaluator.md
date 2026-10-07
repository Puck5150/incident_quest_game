# Terraform TF2a: expression evaluator and functions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate a parsed HCL `Expr` to a value (strings, numbers, booleans, null, lists, objects, and an "unknown" for `(known after apply)`), with the allowlisted Terraform functions.

**Architecture:** `eval.ts` evaluates expression nodes against a caller-supplied `Scope` (the engine resolves `var.*`, `local.*`, resource and `each`/`count` references through `scope.ref(path)`). `functions.ts` holds the function table. Unknown values propagate the way Terraform's do. Errors are `EvalError` (summary + detail), which the engine will turn into located diagnostics in TF2b.

**Tech Stack:** TypeScript (strict), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("Architecture": expressions and the function allowlist; "Errors and honesty"). This is the first of three TF2 plans (TF2a evaluator; TF2b resource schemas, state/reality model and plan diff; TF2c plan rendering, the `terraform` CLI and shell wiring). TF1 (`src/game/terraform/{types,lex,parse,diag,graph}.ts`) is complete.

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, `import type` for types, `.ts` import extensions.
- No new npm dependencies.
- Tests live in `tests/*.test.ts` (vitest); `src/` is type-checked by `npx tsc -b`, `tests/` `.ts` is not.
- Anything outside the supported subset gives a real-looking `Error` (an unknown function says so by name); the evaluator never invents values.
- Error wording follows real Terraform where known; wording not verified against the docs is logged in `CONTENT_TODO.md` (Task 2).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Unknown propagation: `false && <unknown>` is `false`, `true || <unknown>` is `true`, any other operator with an unknown operand is unknown, and a template or function argument that is unknown makes the whole result unknown (Task 1 and 2 tests).
2. `null` or a collection inside a string template is an error, not the text `null` (Task 1 test).
3. Whole numbers print without a decimal point in templates and `format` (`1`, not `1.0`) (Task 1 and 2 tests).
4. `lookup` with a missing key and no default is an error, with a default it returns the default; `element` wraps around the list length (Task 2 tests).
5. `cidrsubnet` rejects a prefix that is not IPv4 CIDR, a result longer than 32 bits, and a `netnum` that does not fit in `newbits` (Task 2 tests).

---

### Task 1: Values and the core evaluator

**Files:**
- Create: `src/game/terraform/eval.ts`
- Test: `tests/terraform-eval.test.ts`

**Interfaces:**
- Consumes: `Expr` from `./types.ts`; `callFunction` from `./functions.ts` (Task 2; Task 1 ships it as a stub that throws the unknown-function error, replaced in Task 2).
- Produces:
  - `UNKNOWN`, `type Unknown`, `type Value`, `isUnknown(v: Value): v is Unknown`
  - `class EvalError extends Error { summary: string; detail: string }`
  - `interface Scope { ref(path: string[]): Value }` (the engine throws `EvalError` for references it cannot resolve)
  - `evalExpr(e: Expr, scope: Scope): Value`
  - `show(v: Value): string` (a value as it appears inside a string template; throws `EvalError` for null/collections)

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-eval.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-eval.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/eval.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/functions.ts` as a stub (Task 2 replaces it):

```ts
import { EvalError, type Value } from './eval.ts'

export function callFunction(name: string, _args: Value[]): Value {
  throw new EvalError('Call to unknown function', `There is no function named "${name}".`)
}
```

Create `src/game/terraform/eval.ts`:

```ts
// Evaluate a parsed expression to a value. References are resolved by the
// caller's Scope, so the plan engine decides what var/local/resource/each/count
// mean; this file only knows how values combine.
import { callFunction } from './functions.ts'
import type { Expr } from './types.ts'

export const UNKNOWN = Object.freeze({ unknown: true as const })
export type Unknown = typeof UNKNOWN
export type Value = string | number | boolean | null | Unknown | Value[] | { [key: string]: Value }
export const isUnknown = (v: Value): v is Unknown => v === UNKNOWN

export class EvalError extends Error {
  summary: string
  detail: string
  constructor(summary: string, detail: string) {
    super(summary)
    this.summary = summary
    this.detail = detail
  }
}

export interface Scope {
  ref(path: string[]): Value
}

const isObject = (v: Value): v is { [key: string]: Value } => typeof v === 'object' && v !== null && !Array.isArray(v) && v !== UNKNOWN

// A value as it reads inside "...${v}...".
export function show(v: Value): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null) throw new EvalError('Invalid template interpolation value', 'The expression result is null. Cannot include a null value in a string template.')
  throw new EvalError('Invalid template interpolation value', 'Cannot include the given value in a string template: string required.')
}

function attribute(base: Value, name: string): Value {
  if (isUnknown(base)) return UNKNOWN
  if (isObject(base)) {
    if (name in base) return base[name]
    throw new EvalError('Unsupported attribute', `This object does not have an attribute named "${name}".`)
  }
  if (Array.isArray(base)) throw new EvalError('Unsupported attribute', 'This value does not have any attributes.')
  throw new EvalError('Unsupported attribute', `Can't access attributes on a primitive-typed value (${base === null ? 'null' : typeof base}).`)
}

function index(base: Value, key: Value): Value {
  if (isUnknown(base) || isUnknown(key)) return UNKNOWN
  if (Array.isArray(base)) {
    const n = typeof key === 'string' && key.trim() !== '' ? Number(key) : key
    if (typeof n !== 'number' || !Number.isInteger(n)) throw new EvalError('Invalid index', 'The given key does not identify an element in this collection value: a number is required.')
    if (n < 0 || n >= base.length) throw new EvalError('Invalid index', 'The given key does not identify an element in this collection value.')
    return base[n]
  }
  if (isObject(base)) {
    const k = show(key)
    if (k in base) return base[k]
    throw new EvalError('Invalid index', 'The given key does not identify an element in this collection value.')
  }
  throw new EvalError('Invalid index', 'This value does not have any indices.')
}

function number(v: Value, side: string): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  throw new EvalError('Invalid operand', `Unsuitable value for ${side} operand: a number is required.`)
}

function bool(v: Value, side: string): boolean {
  if (typeof v === 'boolean') return v
  throw new EvalError('Invalid operand', `Unsuitable value for ${side} operand: a bool is required.`)
}

export function equal(a: Value, b: Value): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]))
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && equal(a[k], b[k]))
  }
  return a === b
}

function binary(op: string, l: Value, r: Value): Value {
  if (op === '&&' || op === '||') {
    // Decided by one side even if the other is unknown.
    const decided = op === '&&' ? false : true
    if (l === decided || r === decided) return decided
    if (isUnknown(l) || isUnknown(r)) return UNKNOWN
    return op === '&&' ? bool(l, 'left') && bool(r, 'right') : bool(l, 'left') || bool(r, 'right')
  }
  if (isUnknown(l) || isUnknown(r)) return UNKNOWN
  if (op === '==') return equal(l, r)
  if (op === '!=') return !equal(l, r)
  const a = number(l, 'left')
  const b = number(r, 'right')
  switch (op) {
    case '+': return a + b
    case '-': return a - b
    case '*': return a * b
    case '/': return a / b
    case '%': return a % b
    case '<': return a < b
    case '>': return a > b
    case '<=': return a <= b
    default: return a >= b
  }
}

export function evalExpr(e: Expr, scope: Scope): Value {
  switch (e.kind) {
    case 'lit':
      return e.value
    case 'tmpl': {
      let out = ''
      for (const p of e.parts) {
        if (typeof p === 'string') {
          out += p
          continue
        }
        const v = evalExpr(p, scope)
        if (isUnknown(v)) return UNKNOWN
        out += show(v)
      }
      return out
    }
    case 'ref':
      return scope.ref(e.path)
    case 'attr':
      return attribute(evalExpr(e.base, scope), e.name)
    case 'idx':
      return index(evalExpr(e.base, scope), evalExpr(e.index, scope))
    case 'call':
      return callFunction(e.name, e.args.map((a) => evalExpr(a, scope)))
    case 'list':
      return e.items.map((i) => evalExpr(i, scope))
    case 'obj': {
      const out: { [key: string]: Value } = {}
      for (const { key, value } of e.entries) {
        const k = evalExpr(key, scope)
        if (isUnknown(k)) return UNKNOWN
        out[show(k)] = evalExpr(value, scope)
      }
      return out
    }
    case 'cond': {
      const test = evalExpr(e.test, scope)
      if (isUnknown(test)) return UNKNOWN
      if (typeof test !== 'boolean') throw new EvalError('Incorrect condition type', 'The condition expression must be of type bool.')
      return evalExpr(test ? e.yes : e.no, scope)
    }
    case 'bin':
      return binary(e.op, evalExpr(e.left, scope), evalExpr(e.right, scope))
    case 'un': {
      const v = evalExpr(e.expr, scope)
      if (isUnknown(v)) return UNKNOWN
      return e.op === '!' ? !bool(v, 'unary') : -number(v, 'unary')
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-eval.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent. (`npx tsc -b` may report the unused `_args`; if so rename nothing: a leading underscore is exempt from `noUnusedParameters`.)

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/eval.ts src/game/terraform/functions.ts tests/terraform-eval.test.ts
git commit -m "feat: Terraform expression evaluator with unknown values (TF2a)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Built-in functions

**Files:**
- Replace: `src/game/terraform/functions.ts` (the Task 1 stub)
- Modify: `tests/terraform-eval.test.ts` (append)
- Modify: `CONTENT_TODO.md` (append a section)

**Interfaces:**
- Consumes: `EvalError`, `UNKNOWN`, `isUnknown`, `show`, `equal`, `Value` from `./eval.ts`.
- Produces: `callFunction(name: string, args: Value[]): Value`. Allowlist: `length`, `lookup`, `merge`, `format`, `join`, `concat`, `keys`, `values`, `element`, `toset`, `tolist`, `tostring`, `tonumber`, `jsonencode`, `upper`, `lower`, `coalesce`, `contains`, `replace`, `trimspace`, `max`, `min`, `cidrsubnet`. A set is represented as a sorted, de-duplicated list.

- [ ] **Step 1: Write the failing test**

Append to `tests/terraform-eval.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-eval.test.ts`
Expected: FAIL on the new tests (the stub throws "Call to unknown function" for everything).

- [ ] **Step 3: Write the implementation**

Replace `src/game/terraform/functions.ts` with:

```ts
// The Terraform functions this lab supports. Anything else is "Call to unknown
// function", the same error real Terraform gives for a name it doesn't have.
import { equal, EvalError, isUnknown, show, UNKNOWN, type Value } from './eval.ts'

type Obj = { [key: string]: Value }
const isObj = (v: Value): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && v !== UNKNOWN
const bad = (name: string, why: string): never => {
  throw new EvalError('Invalid function argument', `Invalid value for "${name}" parameter: ${why}`)
}
const arg = (name: string, v: Value, kind: 'string' | 'number' | 'list' | 'map'): never | Value => {
  const ok = kind === 'string' ? typeof v === 'string' : kind === 'number' ? typeof v === 'number' : kind === 'list' ? Array.isArray(v) : isObj(v)
  return ok ? v : bad(name, `${kind} required.`)
}
const str = (name: string, v: Value) => arg(name, v, 'string') as string
const int = (name: string, v: Value) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) ? n : (bad(name, 'whole number required.') as never)
}
const list = (name: string, v: Value) => arg(name, v, 'list') as Value[]
const map = (name: string, v: Value) => arg(name, v, 'map') as Obj
const sorted = (xs: Value[]) => [...xs].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : show(a) < show(b) ? -1 : show(a) > show(b) ? 1 : 0))
const unique = (xs: Value[]) => xs.filter((x, i) => xs.findIndex((y) => equal(x, y)) === i)

function hasUnknown(v: Value): boolean {
  return v === UNKNOWN || (Array.isArray(v) && v.some(hasUnknown)) || (isObj(v) && Object.values(v).some(hasUnknown))
}
function sortKeys(v: Value): Value {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  return v
}

function cidrsubnet(prefix: string, newbits: number, netnum: number): string {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(prefix)
  const parts = m?.slice(1, 5).map(Number)
  if (!m || parts!.some((p) => p > 255) || Number(m[5]) > 32) throw new EvalError('Invalid function argument', `Invalid value for "prefix" parameter: invalid CIDR address: ${prefix}.`)
  const len = Number(m[5]) + newbits
  if (newbits < 0 || len > 32) throw new EvalError('Invalid function argument', `Invalid value for "newbits" parameter: not enough remaining address space for a subnet with a prefix of ${len} bits after ${prefix}.`)
  if (netnum < 0 || netnum >= 2 ** newbits) throw new EvalError('Invalid function argument', `Invalid value for "netnum" parameter: prefix extension of ${newbits} does not accommodate a subnet numbered ${netnum}.`)
  const base = parts!.reduce((a, b) => a * 256 + b, 0)
  const block = 2 ** (32 - Number(m[5]))
  const net = Math.floor(base / block) * block + netnum * 2 ** (32 - len)
  const octets = [Math.floor(net / 2 ** 24) % 256, Math.floor(net / 2 ** 16) % 256, Math.floor(net / 256) % 256, net % 256]
  return `${octets.join('.')}/${len}`
}

function format(fmt: string, args: Value[]): string {
  let i = 0
  return fmt.replace(/%[sdv%]/g, (spec) => {
    if (spec === '%%') return '%'
    if (i >= args.length) throw new EvalError('Invalid function argument', 'Invalid value for "format" parameter: not enough arguments for the format string.')
    const v = args[i++]
    if (spec === '%d') {
      if (typeof v !== 'number') throw new EvalError('Invalid function argument', 'Invalid value for "format" parameter: %d requires a number.')
      return String(Math.trunc(v))
    }
    return show(v)
  })
}

// [min args, max args (Infinity = any), implementation]
const FNS: Record<string, [number, number, (a: Value[]) => Value]> = {
  length: [1, 1, ([v]) => (typeof v === 'string' ? [...v].length : Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : (bad('length', 'collection or string required.') as never))],
  lookup: [2, 3, ([m, k, d]) => {
    const o = map('lookup', m)
    const key = str('lookup', k)
    if (key in o) return o[key]
    if (d === undefined) return bad('lookup', `key "${key}" does not exist in the map.`)
    return d
  }],
  merge: [0, Infinity, (a) => Object.assign({}, ...a.map((m) => map('merge', m))) as Obj],
  format: [1, Infinity, ([f, ...rest]) => format(str('format', f), rest)],
  join: [2, 2, ([s, l]) => list('join', l).map(show).join(str('join', s))],
  concat: [0, Infinity, (a) => a.flatMap((l) => list('concat', l))],
  keys: [1, 1, ([m]) => Object.keys(map('keys', m)).sort()],
  values: [1, 1, ([m]) => { const o = map('values', m); return Object.keys(o).sort().map((k) => o[k]) }],
  element: [2, 2, ([l, i]) => { const xs = list('element', l); return xs.length ? xs[((int('element', i) % xs.length) + xs.length) % xs.length] : (bad('element', 'cannot use element function with an empty list.') as never) }],
  toset: [1, 1, ([l]) => sorted(unique(list('toset', l)))],
  tolist: [1, 1, ([l]) => list('tolist', l)],
  tostring: [1, 1, ([v]) => show(v)],
  tonumber: [1, 1, ([v]) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : (bad('tonumber', 'cannot convert to number.') as never))],
  jsonencode: [1, 1, ([v]) => (hasUnknown(v) ? UNKNOWN : JSON.stringify(sortKeys(v)))],
  upper: [1, 1, ([s]) => str('upper', s).toUpperCase()],
  lower: [1, 1, ([s]) => str('lower', s).toLowerCase()],
  coalesce: [1, Infinity, (a) => a.find((v) => v !== null && v !== '') ?? (bad('coalesce', 'no non-null, non-empty-string arguments.') as never)],
  contains: [2, 2, ([l, v]) => list('contains', l).some((x) => equal(x, v))],
  replace: [3, 3, ([s, a, b]) => str('replace', s).split(str('replace', a)).join(str('replace', b))],
  trimspace: [1, 1, ([s]) => str('trimspace', s).trim()],
  max: [1, Infinity, (a) => Math.max(...a.map((n) => arg('max', n, 'number') as number))],
  min: [1, Infinity, (a) => Math.min(...a.map((n) => arg('min', n, 'number') as number))],
  cidrsubnet: [3, 3, ([p, b, n]) => cidrsubnet(str('cidrsubnet', p), int('cidrsubnet', b), int('cidrsubnet', n))],
}

export function callFunction(name: string, args: Value[]): Value {
  const f = Object.hasOwn(FNS, name) ? FNS[name] : undefined
  if (!f) throw new EvalError('Call to unknown function', `There is no function named "${name}".`)
  const [min, max, fn] = f
  if (args.length < min) throw new EvalError('Not enough function arguments', `Function "${name}" expects at least ${min} argument(s). Pass only ${args.length}.`)
  if (args.length > max) throw new EvalError('Too many function arguments', `Function "${name}" expects at most ${max} argument(s). Pass ${args.length}.`)
  if (name !== 'jsonencode' && args.some(isUnknown)) return UNKNOWN
  return fn(args)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-eval.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent. If `tsc` flags the `never`-casting idioms, replace each `(bad(...) as never)` with a small helper that returns `never` by throwing and is called in expression position, keeping behavior identical.

- [ ] **Step 5: Append to `CONTENT_TODO.md`**

```markdown

## terraform simulator (expression evaluator, TF2a)
- [ ] Evaluator error wording: `Invalid operand`, `Incorrect condition type`, `Unsupported attribute`, `Invalid index`, `Invalid template interpolation value`, `Not enough function arguments` / `Too many function arguments`, `Call to unknown function`: summaries follow the Terraform language docs and CLI; the detail strings are paraphrased.
- [ ] `Invalid function argument` details for lookup, element, coalesce, tonumber and cidrsubnet: paraphrased from the function docs.
- [ ] Unsupported on purpose (reported as `Call to unknown function`): `file`, `templatefile`, `try`, `can`, `for` expressions, anything not in the allowlist.
- [ ] Sets are modeled as sorted, de-duplicated lists, so `toset` output order is by value; real Terraform sets have no defined order.
```

- [ ] **Step 6: Run the full check, then commit**

Run: `npm test 2>&1 | tail -8 && npm run lint 2>&1 | tail -3 && npx tsc -b`
Expected: all test files pass, lint clean, `tsc` silent.

```bash
git add src/game/terraform/functions.ts tests/terraform-eval.test.ts CONTENT_TODO.md
git commit -m "feat: Terraform built-in functions for the evaluator (TF2a)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done)

- **Spec coverage:** the spec's expression list (literals, references, `count`/`each`/`var`/`local` via `Scope.ref`, interpolation, function allowlist including `lookup`, `merge`, `format`, `toset`, `cidrsubnet`) is covered; unknown values and `(known after apply)` are modeled as `UNKNOWN`. Not in this plan by design: schemas, state, plan, CLI (TF2b/TF2c).
- **Placeholders:** none. **Type consistency:** `Value`, `Scope`, `EvalError`, `UNKNOWN`, `isUnknown`, `show`, `equal` are defined in Task 1 and imported by Task 2 with the same names; `callFunction(name, args)` matches its call site in `eval.ts`.
- **Review Focus:** all five lines have tests (unknown propagation and `&&`/`||`: Task 1; null/collection in a template: Task 1; whole-number printing: Task 1 and 2; `lookup`/`element`: Task 2; `cidrsubnet` rejections: Task 2).
- **Known circular import:** `eval.ts` imports `functions.ts` and `functions.ts` imports values from `eval.ts`. Both only use each other inside function bodies, so ES module evaluation order is safe; if a bundler complains, move `UNKNOWN`/`Value`/`EvalError`/`equal`/`show` into a third `values.ts` and re-export from `eval.ts`.
