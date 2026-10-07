// Rendering values and value differences the way `terraform plan` lays them
// out: a row is `col` spaces, a symbol, a space, then text; nested entries sit
// four columns deeper than their parent; a closing bracket has no symbol.
import { equal, isUnknown, type Value } from './eval.ts'

type Obj = { [key: string]: Value }
const isObj = (v: Value | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !isUnknown(v as Value)
// A non-empty list or map: rendered over several rows rather than inline.
const coll = (v: Value | undefined) => (Array.isArray(v) ? v.length > 0 : isObj(v) && Object.keys(v).length > 0)
const unchangedText = (n: number, what: string) => `# (${n} unchanged ${what}${n === 1 ? '' : 's'} hidden)`
const sorted = (keys: Iterable<string>) => [...keys].sort()
// reduce, not Math.max(...xs): a spread of 200k keys overflows the stack
const maxLen = (xs: string[]) => xs.reduce((m, s) => Math.max(m, s.length), 0)
const has = (o: Obj, k: string) => Object.hasOwn(o, k)
// Terraform always shows these attributes, with their unchanged children.
const IMPORTANT = new Set(['id', 'name', 'tags'])

export const SENSITIVE = '(sensitive value)'
export const row = (col: number, sym: string, text: string) => `${' '.repeat(col)}${sym} ${text}`
export const masked = (col: number, sym: string, name: string, width: number, suffix = '') => row(col, sym, `${name.padEnd(width)} = ${SENSITIVE}${suffix}`)

export function scalar(v: Value | undefined): string {
  if (v === undefined || v === null) return 'null'
  if (isUnknown(v)) return '(known after apply)'
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return v.length ? '(list)' : '[]'
  if (typeof v === 'object') return Object.keys(v).length ? '(map)' : '{}'
  return String(v)
}

// One attribute of an object: how it changed, and whether to mask it.
export interface Field {
  name: string
  op: '+' | '-' | '~' | ' '
  before?: Value
  after?: Value
  sensitive?: boolean
  forces?: boolean
  show?: boolean // print an unchanged (' ') field in full instead of counting it as hidden
  set?: boolean // a set: elements match by value, unchanged ones are only counted
}

// An object body: attributes aligned over every one (hidden or not), then a
// hidden count.
export function body(col: number, fields: Field[]): string[] {
  const fs = [...fields].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
  const w = maxLen(fs.map((f) => f.name))
  let hidden = 0
  const out = fs.flatMap((f) => {
    if (f.op === ' ' && !f.show && !IMPORTANT.has(f.name)) {
      hidden++
      return []
    }
    if (f.sensitive) return [masked(col, f.op, f.name, w, f.op === '-' ? ' -> null' : '') + (f.forces ? ' # forces replacement' : '')]
    if (f.op === '+') return emit(col, '+', f.name, w, f.after as Value)
    if (f.op === '-') return emit(col, '-', f.name, w, f.before as Value, '', true)
    if (f.op === ' ') return emit(col, ' ', f.name, w, f.after as Value)
    return diffLines(col, f.name, w, f.before as Value, f.after as Value, f.forces, IMPORTANT.has(f.name), f.set)
  })
  if (hidden) out.push(row(col, ' ', unchangedText(hidden, 'attribute')))
  return out
}

// A list element: `gone` and `child` never apply, and an object's attribute names are unquoted.
const elem = (col: number, sym: string, v: Value) => emit(col, sym, null, 0, v, ',', false, undefined, true)

// `name = value` (or a bare list element when name is null). `gone` puts
// `-> null` after the value (or its closing bracket); `child` is the symbol for
// nested rows when it differs from the opening row's.
function emit(col: number, sym: string, name: string | null, width: number, v: Value, tail = '', gone = false, child?: string, bare = false): string[] {
  const head = name === null ? '' : `${name.padEnd(width)} = `
  const nt = gone && name !== null ? ' -> null' : ''
  const kid = child ?? sym
  if (Array.isArray(v) && v.length) {
    return [row(col, sym, `${head}[`), ...v.flatMap((x) => elem(col + 4, kid, x)), row(col, ' ', `]${tail}${nt}`)]
  }
  if (isObj(v) && Object.keys(v).length) {
    // `bare`: a list element, an object whose attribute names are unquoted. Anywhere else it is a map: keys are quoted.
    const keys = sorted(Object.keys(v))
    const label = (k: string) => (bare ? k : JSON.stringify(k))
    const w = maxLen(keys.map(label))
    return [row(col, sym, `${head}{`), ...keys.flatMap((k) => emit(col + 4, kid, label(k), w, (v as Obj)[k])), row(col, ' ', `}${tail}${nt}`)]
  }
  return [row(col, sym, `${head}${scalar(v)}${tail}${nt}`)]
}

export const lines = (col: number, sym: string, name: string | null, width: number, v: Value, tail = '', gone = false): string[] => emit(col, sym, name, width, v, tail, gone)

// `bare`: an object (a list element), whose attribute names are unquoted; otherwise a map.
function mapDiff(col: number, head: string, b: Obj, a: Obj, ctx: boolean, tail: string, bare: boolean): string[] {
  const keys = sorted(new Set([...Object.keys(b), ...Object.keys(a)]))
  const label = (k: string) => (bare ? k : JSON.stringify(k))
  const w = maxLen(keys.map(label))
  let hidden = 0
  const out = keys.flatMap((k) => {
    const kt = label(k)
    if (!has(b, k)) return emit(col + 4, '+', kt, w, a[k])
    if (!has(a, k)) return emit(col + 4, '-', kt, w, b[k], '', true)
    if (equal(b[k], a[k])) {
      if (ctx) return emit(col + 4, ' ', kt, w, b[k])
      hidden++
      return []
    }
    return diffCore(col + 4, kt, w, b[k], a[k], ctx)
  })
  return [row(col, '~', `${head}{`), ...out, ...(hidden ? [row(col + 4, ' ', unchangedText(hidden, bare ? 'attribute' : 'element'))] : []), row(col, ' ', `}${tail}`)]
}

type Op = { k: 'same' | 'chg' | 'del' | 'add'; b?: Value; a?: Value }

function listOps(b: Value[], a: Value[]): Op[] {
  // Same length and not just a reordering (some element of `b` is missing from `a`): compare position by position.
  if (b.length === a.length && !b.every((x) => a.some((y) => equal(x, y)))) return b.map((x, i) => ({ k: equal(x, a[i]) ? 'same' : 'chg', b: x, a: a[i] }))
  const m = b.length
  const n = a.length
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = equal(b[i], a[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && equal(b[i], a[j])) ops.push({ k: 'same', b: b[i++], a: a[j++] })
    else if (j >= n || (i < m && dp[i + 1][j] >= dp[i][j + 1])) ops.push({ k: 'del', b: b[i++] })
    else ops.push({ k: 'add', a: a[j++] })
  }
  // An object deleted and another created in the same place read as one updated object.
  const out: Op[] = []
  for (let x = 0; x < ops.length; x++) {
    const o = ops[x]
    const next = ops[x + 1]
    if (o.k === 'del' && next?.k === 'add' && isObj(o.b) && isObj(next.a)) {
      out.push({ k: 'chg', b: o.b, a: next.a })
      x++
    } else out.push(o)
  }
  return out
}

function elemChange(col: number, b: Value, a: Value, ctx: boolean): string[] {
  if ((isObj(b) && isObj(a)) || (Array.isArray(b) && Array.isArray(a))) return diffCore(col, null, 0, b, a, ctx, ',')
  if (coll(b) || coll(a)) return [...elem(col, '-', b), ...elem(col, '+', a)]
  return [row(col, '~', `${scalar(b)} -> ${scalar(a)},`)]
}

// One unchanged element before and after each change is shown in full; the
// rest of a run collapses to a count.
function listDiff(col: number, head: string, b: Value[], a: Value[], ctx: boolean, tail: string): string[] {
  const ops = listOps(b, a)
  const show = ops.map((o, i) => ctx || o.k !== 'same' || (i > 0 && ops[i - 1].k !== 'same') || (i < ops.length - 1 && ops[i + 1].k !== 'same'))
  const out: string[] = []
  let hidden = 0
  const flush = () => {
    if (hidden) out.push(row(col + 4, ' ', unchangedText(hidden, 'element')))
    hidden = 0
  }
  ops.forEach((o, i) => {
    if (!show[i]) {
      hidden++
      return
    }
    flush()
    if (o.k === 'same') out.push(...elem(col + 4, ' ', o.b as Value))
    else if (o.k === 'del') out.push(...elem(col + 4, '-', o.b as Value))
    else if (o.k === 'add') out.push(...elem(col + 4, '+', o.a as Value))
    else out.push(...elemChange(col + 4, o.b as Value, o.a as Value, ctx))
  })
  flush()
  return [row(col, '~', `${head}[`), ...out, row(col, ' ', `]${tail}`)]
}

// A set: elements match by value. What differs is a removal plus an addition;
// what matches is only counted.
function setDiff(col: number, head: string, b: Value[], a: Value[]): string[] {
  const has2 = (xs: Value[], v: Value) => xs.some((x) => equal(x, v))
  const out = [...b.filter((x) => !has2(a, x)).flatMap((x) => elem(col + 4, '-', x)), ...a.filter((x) => !has2(b, x)).flatMap((x) => elem(col + 4, '+', x))]
  const same = a.filter((x) => has2(b, x)).length
  return [row(col, '~', `${head}[`), ...out, ...(same ? [row(col + 4, ' ', unchangedText(same, 'element'))] : []), row(col, ' ', ']')]
}

function diffCore(col: number, name: string | null, width: number, b: Value | undefined, a: Value, ctx: boolean, tail = ''): string[] {
  const head = name === null ? '' : `${name.padEnd(width)} = `
  if (b === undefined || b === null) return emit(col, '+', name, width, a, tail)
  if (a === null) return emit(col, '-', name, width, b, tail, true)
  if (isObj(b) && isObj(a)) return mapDiff(col, head, b, a, ctx, tail, name === null)
  if (Array.isArray(b) && Array.isArray(a)) return listDiff(col, head, b, a, ctx, tail)
  // A scalar change, a collection becoming unknown, or a change of type: the
  // old value as removals, then ` -> ` and the new value as additions.
  const old = coll(b) ? emit(col, '~', name, width, b, '', false, '-') : [row(col, '~', `${head}${scalar(b)}`)]
  const next = coll(a) ? emit(col, '+', null, 0, a, tail, false, '+') : [row(col, '+', `${scalar(a)}${tail}`)]
  old[old.length - 1] += ` -> ${next[0].slice(col + 2)}`
  return [...old, ...next.slice(1)]
}

export function diffLines(col: number, name: string, width: number, before: Value | undefined, after: Value, forces = false, ctx = false, set = false): string[] {
  const out = Array.isArray(before) && Array.isArray(after) && set ? setDiff(col, `${name.padEnd(width)} = `, before, after) : diffCore(col, name, width, before, after, ctx)
  // A collection that becomes unknown is closed by `-> (known after apply)`; the marker goes after that.
  const atEnd = isUnknown(after) && coll(before)
  if (forces && out.length) out[atEnd ? out.length - 1 : 0] += ' # forces replacement'
  return out
}
