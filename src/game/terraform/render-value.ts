// Rendering values and value differences the way `terraform plan` lays them
// out: a row is `col` spaces, a symbol, a space, then text; nested entries sit
// four columns deeper than their parent; a closing bracket has no symbol.
import { equal, isUnknown, type Value } from './eval.ts'

type Obj = { [key: string]: Value }
const isObj = (v: Value | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !isUnknown(v as Value)
const isBlockList = (v: Value | undefined): v is Obj[] => Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && Object.keys(x).length > 0)
const unchangedText = (n: number, what: string) => `# (${n} unchanged ${what}${n === 1 ? '' : 's'} hidden)`
const sorted = (keys: Iterable<string>) => [...keys].sort()

export const row = (col: number, sym: string, text: string) => `${' '.repeat(col)}${sym} ${text}`

export function scalar(v: Value | undefined): string {
  if (v === undefined || v === null) return 'null'
  if (isUnknown(v)) return '(known after apply)'
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return v.length ? JSON.stringify(v) : '[]'
  if (typeof v === 'object') return Object.keys(v).length ? JSON.stringify(v) : '{}'
  return String(v)
}

function blockLines(col: number, sym: string, name: string, o: Obj): string[] {
  const keys = sorted(Object.keys(o)).filter((k) => o[k] !== null)
  const w = Math.max(0, ...keys.map((k) => k.length))
  return [row(col, sym, `${name} {`), ...keys.flatMap((k) => lines(col + 4, sym, k, w, o[k])), row(col, ' ', '}')]
}

// `name = value` (or a bare list element when name is null) with one symbol throughout.
export function lines(col: number, sym: string, name: string | null, width: number, v: Value, tail = ''): string[] {
  const head = name === null ? '' : `${name.padEnd(width)} = `
  if (name !== null && isBlockList(v)) return v.flatMap((o) => blockLines(col, sym, name, o))
  if (Array.isArray(v) && v.length) {
    return [row(col, sym, `${head}[`), ...v.flatMap((x) => lines(col + 4, sym, null, 0, x, ',')), row(col, ' ', `]${tail}`)]
  }
  if (isObj(v) && Object.keys(v).length) {
    const o: Obj = v as Obj
    const keys = sorted(Object.keys(o))
    const w = Math.max(...keys.map((k) => JSON.stringify(k).length))
    return [row(col, sym, `${head}{`), ...keys.flatMap((k) => lines(col + 4, sym, JSON.stringify(k), w, o[k])), row(col, ' ', `}${tail}`)]
  }
  return [row(col, sym, `${head}${scalar(v)}${tail}`)]
}

function mapDiff(col: number, head: string, b: Obj, a: Obj): string[] {
  const keys = sorted(new Set([...Object.keys(b), ...Object.keys(a)]))
  const same = (k: string) => Object.hasOwn(b, k) && Object.hasOwn(a, k) && equal(b[k], a[k])
  const shown = keys.filter((k) => !same(k))
  const w = Math.max(0, ...shown.map((k) => JSON.stringify(k).length))
  const body = shown.flatMap((k) => {
    const kt = JSON.stringify(k)
    if (!Object.hasOwn(b, k)) return lines(col + 4, '+', kt, w, a[k])
    if (!Object.hasOwn(a, k)) return lines(col + 4, '-', kt, w, b[k])
    return diffCore(col + 4, kt, w, b[k], a[k])
  })
  const hidden = keys.length - shown.length
  return [row(col, '~', `${head}{`), ...body, ...(hidden ? [row(col + 4, ' ', unchangedText(hidden, 'element'))] : []), row(col, ' ', '}')]
}

function listDiff(col: number, head: string, b: Value[], a: Value[]): string[] {
  const m = b.length
  const n = a.length
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = equal(b[i], a[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: string[] = []
  let kept = 0
  const flush = () => {
    if (kept) out.push(row(col + 4, ' ', unchangedText(kept, 'element')))
    kept = 0
  }
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && equal(b[i], a[j])) {
      kept++
      i++
      j++
    } else if (j >= n || (i < m && dp[i + 1][j] >= dp[i][j + 1])) {
      flush()
      out.push(...lines(col + 4, '-', null, 0, b[i], ','))
      i++
    } else {
      flush()
      out.push(...lines(col + 4, '+', null, 0, a[j], ','))
      j++
    }
  }
  flush()
  return [row(col, '~', `${head}[`), ...out, row(col, ' ', ']')]
}

function blockChange(col: number, name: string, b: Obj, a: Obj): string[] {
  const keys = sorted(new Set([...Object.keys(b), ...Object.keys(a)])).filter((k) => b[k] != null || a[k] != null)
  const same = (k: string) => equal(b[k] ?? null, a[k] ?? null)
  const shown = keys.filter((k) => !same(k))
  const w = Math.max(0, ...shown.map((k) => k.length))
  const hidden = keys.length - shown.length
  return [
    row(col, '~', `${name} {`),
    ...shown.flatMap((k) => diffCore(col + 4, k, w, b[k] ?? null, a[k] ?? null)),
    ...(hidden ? [row(col + 4, ' ', unchangedText(hidden, 'attribute'))] : []),
    row(col, ' ', '}'),
  ]
}

function blockDiff(col: number, name: string, b: Obj[], a: Obj[]): string[] {
  const out: string[] = []
  let hidden = 0
  for (let i = 0; i < Math.max(b.length, a.length); i++) {
    if (i >= b.length) out.push(...blockLines(col, '+', name, a[i]))
    else if (i >= a.length) out.push(...blockLines(col, '-', name, b[i]))
    else if (equal(b[i], a[i])) hidden++
    else out.push(...blockChange(col, name, b[i], a[i]))
  }
  if (hidden) out.push(row(col, ' ', unchangedText(hidden, 'block')))
  return out
}

function diffCore(col: number, name: string, width: number, b: Value | undefined, a: Value): string[] {
  const head = `${name.padEnd(width)} = `
  if (b === undefined || b === null) return lines(col, '+', name, width, a)
  if (a === null) {
    const out = lines(col, '-', name, width, b)
    if (!isBlockList(b)) out[out.length - 1] += ' -> null'
    return out
  }
  if (isObj(b) && isObj(a)) return mapDiff(col, head, b, a)
  if (Array.isArray(b) && Array.isArray(a)) return isBlockList(b) || isBlockList(a) ? blockDiff(col, name, b as Obj[], a as Obj[]) : listDiff(col, head, b, a)
  return [row(col, '~', `${head}${scalar(b)} -> ${scalar(a)}`)]
}

export function diffLines(col: number, name: string, width: number, before: Value | undefined, after: Value, forces = false): string[] {
  const out = diffCore(col, name, width, before, after)
  if (forces && out.length) out[out.length - 1] += ' # forces replacement'
  return out
}
