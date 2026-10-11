// World predicates: the checks a scenario's done_when is made of, evaluated against a snapshot.
import { equal, type Value } from './eval.ts'
import type { PlanResult } from './plan.ts'
import { hasChanges } from './render.ts'
import { realityKey, type Reality } from './refresh.ts'
import { addressCovers } from './address.ts'
import { groupHasRule, groupOnly, MIXED_SUMMARY } from './sgrules.ts'
import { listAddresses, type State } from './state.ts'

import type { Leaf, Predicate } from '../../schema/scenario.ts'
export type { Leaf, Predicate }

export interface World {
  state: State
  reality: Reality
  lock?: object
  history: string[]
  plan(): PlanResult | undefined
  readFile(path: string): Promise<string | undefined>
  // The files directly in a directory (name and text); needed by config_matches.
  // The backend `terraform init` last recorded (its literal attributes), if any; needed by `backend`.
  backend?: { type: string; attrs: Record<string, Value> }
  listFiles?(dir: string): Promise<{ name: string; text: string }[]>
}

// Remove # // and /* */ comments outside double-quoted strings, keeping newlines. One pass, linear.
export function stripHclComments(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; ) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '#' || (c === '/' && text[i + 1] === '/')) {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, '')
      i = stop
    } else {
      out += c
      i++
    }
  }
  return out
}

// The suffix on a history line whose step ran with -lock=false while the lock was held.
export const LOCK_BYPASSED = ' (lock bypassed)'

const has = <T extends object, K extends string>(o: T, k: K): o is Extract<T, Record<K, unknown>> => Object.hasOwn(o, k)

const covers = addressCovers // a key-less address names every instance of the resource; a module covers all under it

async function leaf(l: Leaf, w: World, plan: () => PlanResult | undefined): Promise<boolean> {
  if (has(l, 'plan_clean')) {
    const p = plan()
    return p !== undefined && p.diagnostics.length === 0 && !p.warnings.some((x) => x.summary === MIXED_SUMMARY) && !hasChanges(p)
  }
  if (has(l, 'plan_has')) {
    const p = plan()
    if (!p || p.diagnostics.length) return false
    const { no_destroy, no_change } = l.plan_has
    const hit = (actions: string[], list: string[] | undefined) => !!list && p.items.some((i) => actions.includes(i.action) && list.some((a) => covers(a, i.address)))
    return !hit(['destroy', 'replace'], no_destroy) && !hit(['update', 'destroy', 'replace'], no_change)
  }
  if (has(l, 'state_has')) return listAddresses(w.state).some((a) => covers(l.state_has, a))
  if (has(l, 'state_lacks')) return !listAddresses(w.state).some((a) => covers(l.state_lacks, a))
  if (has(l, 'lock_free')) return w.lock === undefined
  if (has(l, 'lock_bypassed')) return w.history.some((h) => h.endsWith(LOCK_BYPASSED))
  if (has(l, 'reality_has')) {
    const { type, id, attr, equals } = l.reality_has
    const key = realityKey(type, id)
    if (!Object.hasOwn(w.reality, key)) return false
    if (attr === undefined) return true
    const obj = w.reality[key]
    return typeof obj === 'object' && obj !== null && !Array.isArray(obj) && Object.hasOwn(obj, attr) && (equals === undefined || equal(obj[attr], equals))
  }
  if (has(l, 'sg_rule')) return groupHasRule(w.reality, l.sg_rule)
  if (has(l, 'sg_only')) return groupOnly(w.reality, l.sg_only)
  if (has(l, 'config_matches')) {
    const re = new RegExp(l.config_matches.matches, 'm')
    return (await w.listFiles?.(l.config_matches.dir) ?? []).some((f) => f.name.endsWith('.tf') && f.text.length <= 200_000 && re.test(stripHclComments(f.text)))
  }
  if (has(l, 'backend')) {
    const b = w.backend
    if (!b || b.type !== l.backend.type) return false
    const meets = (req: Record<string, Value | '*'> | undefined) => Object.entries(req ?? {}).every(([k, v]) => (v === '*' ? typeof b.attrs[k] === 'string' && b.attrs[k] !== '' : Object.hasOwn(b.attrs, k) && equal(b.attrs[k], v)))
    return meets(l.backend.require) && (l.backend.any_of === undefined || l.backend.any_of.some(meets))
  }
  if (has(l, 'reality_lacks')) return !Object.hasOwn(w.reality, realityKey(l.reality_lacks.type, l.reality_lacks.id))
  if (has(l, 'applied')) {
    const { op, address, lock_bypassed } = l.applied
    return w.history.some((h) => {
      const bypassed = h.endsWith(LOCK_BYPASSED)
      const rest = bypassed ? h.slice(0, -LOCK_BYPASSED.length) : h
      return (!lock_bypassed || bypassed) && rest.startsWith(`${op} `) && covers(address, rest.slice(op.length + 1))
    })
  }
  try {
    const text = await w.readFile(l.file_contains.path)
    return text !== undefined && new RegExp(l.file_contains.matches, 'm').test(text)
  } catch {
    return false
  }
}

export async function evalPredicate(p: Predicate, w: World): Promise<boolean> {
  let memo: { r: PlanResult | undefined } | undefined
  const plan = () => {
    if (!memo) {
      try {
        memo = { r: w.plan() }
      } catch {
        memo = { r: undefined }
      }
    }
    return memo.r
  }
  const one = async (x: Leaf | { not: Leaf }): Promise<boolean> => (has(x, 'not') ? !(await leaf(x.not, w, plan)) : leaf(x, w, plan))
  // Malformed input (not schema-checked) is simply not satisfied.
  try {
    if (has(p, 'all')) {
      for (const x of p.all) if (!(await one(x))) return false
      return true
    }
    if (has(p, 'any')) {
      for (const x of p.any) if (await one(x)) return true
      return false
    }
    return await one(p)
  } catch {
    return false
  }
}
