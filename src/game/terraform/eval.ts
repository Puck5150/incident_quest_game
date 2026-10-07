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
    const [oa, ob] = [a as { [key: string]: Value }, b as { [key: string]: Value }]
    const ka = Object.keys(oa)
    return ka.length === Object.keys(ob).length && ka.every((k) => k in ob && equal(oa[k], ob[k]))
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
