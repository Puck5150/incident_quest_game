// Which instances a resource has: one, `count` of them, or one per
// `for_each` key. Both meta-arguments must be known at plan time.
import { evalExpr, EvalError, isUnknown, type Scope, type Value } from './eval.ts'
import type { Block, Pos } from './types.ts'

export type Key = string | number | undefined
export type Expansion =
  | { ok: true; kind: 'single' | 'count' | 'for_each'; keys: Key[]; each(key: string): { key: Value; value: Value } }
  | { ok: false; summary: string; detail: string; pos: Pos }

const bad = (pos: Pos, summary: string, detail: string): Expansion => ({ ok: false, summary, detail, pos })
const typeName = (v: Value) => (v === null ? 'null' : Array.isArray(v) ? 'tuple' : typeof v === 'object' ? 'object' : typeof v)

const COUNT_UNKNOWN =
  'The "count" value depends on resource attributes that cannot be determined until apply, so Terraform cannot predict how many instances will be created. To work around this, use the -target argument to first apply only the resources that the count depends on.'
const FOR_EACH_UNKNOWN =
  'The "for_each" map includes keys derived from resource attributes that cannot be determined until apply, and so Terraform cannot determine the full set of keys that will identify the instances of this resource.\n\nWhen working with unknown values in for_each, it\'s better to define the map keys statically in your configuration and place apply-time results only in the map values.\n\nAlternatively, you could use the -target argument to first apply only the resources that the for_each value depends on.'

const MAX_INSTANCES = 1000
const TOO_MANY = `this lab supports at most ${MAX_INSTANCES} instances of one resource`

export function expandInstances(block: Block, scope: Scope): Expansion {
  const count = block.attrs.find((a) => a.name === 'count')
  const forEach = block.attrs.find((a) => a.name === 'for_each')
  const noEach = (key: string) => ({ key, value: key })
  if (count && forEach) {
    return bad(forEach.pos, 'Invalid combination of "count" and "for_each"', 'The "count" and "for_each" meta-arguments are mutually exclusive, only one should be used to be explicit about the number of resources to be created.')
  }
  if (!count && !forEach) return { ok: true, kind: 'single', keys: [undefined], each: noEach }

  const attr = (count ?? forEach)!
  let v: Value
  try {
    v = evalExpr(attr.value, scope)
  } catch (e) {
    if (e instanceof EvalError) return bad(attr.pos, e.summary, e.detail)
    throw e
  }

  if (count) {
    const unsuitable = (why: string) => bad(count.pos, 'Invalid count argument', `The given "count" argument value is unsuitable: ${why}.`)
    if (isUnknown(v)) return bad(count.pos, 'Invalid count argument', COUNT_UNKNOWN)
    if (typeof v !== 'number') return unsuitable(v === null ? 'the given value is null' : 'number required')
    if (!Number.isInteger(v)) return unsuitable('must be a whole number')
    if (v < 0) return unsuitable('must be greater than or equal to zero')
    if (v > MAX_INSTANCES) return unsuitable(TOO_MANY)
    return { ok: true, kind: 'count', keys: Array.from({ length: v }, (_, i) => i), each: noEach }
  }

  const unsuitable = (why: string) => bad(forEach!.pos, 'Invalid for_each argument', `The given "for_each" argument value is unsuitable: ${why}.`)
  if (isUnknown(v)) return bad(forEach!.pos, 'Invalid for_each argument', FOR_EACH_UNKNOWN)
  if (Array.isArray(v)) {
    if (v.some(isUnknown)) return bad(forEach!.pos, 'Invalid for_each argument', FOR_EACH_UNKNOWN)
    const wrong = v.find((x) => typeof x !== 'string')
    if (wrong !== undefined) return unsuitable(`"for_each" supports maps and sets of strings, but you have provided a set containing type ${typeName(wrong)}`)
    const keys = [...new Set(v as string[])].sort()
    if (keys.length > MAX_INSTANCES) return unsuitable(TOO_MANY)
    return { ok: true, kind: 'for_each', keys, each: noEach }
  }
  if (typeof v === 'object' && v !== null) {
    const map = v as { [key: string]: Value }
    if (Object.keys(map).length > MAX_INSTANCES) return unsuitable(TOO_MANY)
    return { ok: true, kind: 'for_each', keys: Object.keys(map).sort(), each: (key) => ({ key, value: Object.hasOwn(map, key) ? map[key] : null }) }
  }
  return unsuitable(`the "for_each" argument must be a map, or set of strings, and you have provided a value of type ${typeName(v)}`)
}
