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
  if (isObj(v)) {
    const o: Obj = v
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]))
  }
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
  return fmt.replace(/%[\s\S]?/g, (spec) => {
    if (spec === '%%') return '%'
    if (!/^%[sdv]$/.test(spec)) throw new EvalError('Invalid function argument', 'Invalid value for "format" parameter: unsupported format verb.')
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
    if (Object.hasOwn(o, key)) return o[key]
    if (d === undefined) return bad('lookup', `key "${key}" does not exist in the map.`)
    return d
  }],
  merge: [0, Infinity, (a) => Object.fromEntries(a.flatMap((m) => Object.entries(map('merge', m)))) as Obj],
  format: [1, Infinity, ([f, ...rest]) => format(str('format', f), rest)],
  join: [2, 2, ([s, l]) => list('join', l).map(show).join(str('join', s))],
  concat: [0, Infinity, (a) => a.flatMap((l) => list('concat', l))],
  keys: [1, 1, ([m]) => Object.keys(map('keys', m)).sort()],
  values: [1, 1, ([m]) => { const o = map('values', m); return Object.keys(o).sort().map((k) => o[k]) }],
  element: [2, 2, ([l, i]) => { const xs = list('element', l); return xs.length ? xs[((int('element', i) % xs.length) + xs.length) % xs.length] : (bad('element', 'cannot use element function with an empty list.') as never) }],
  toset: [1, 1, ([l]) => sorted(unique(list('toset', l)))],
  tolist: [1, 1, ([l]) => list('tolist', l)],
  tostring: [1, 1, ([v]) => (v === null ? null : show(v))],
  tonumber: [1, 1, ([v]) => (v === null ? null : typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : (bad('tonumber', 'cannot convert to number.') as never))],
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
  // These inspect element values, so an unknown at any depth makes the result unknown.
  if (['join', 'contains', 'toset', 'format'].includes(name) ? args.some(hasUnknown) : name !== 'jsonencode' && args.some(isUnknown)) return UNKNOWN
  return fn(args)
}
