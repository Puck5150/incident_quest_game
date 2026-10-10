// World predicates: the checks a scenario's done_when is made of, evaluated against a snapshot.
import { equal } from './eval.ts'
import type { PlanResult } from './plan.ts'
import { hasChanges } from './render.ts'
import { realityKey, type Reality } from './refresh.ts'
import { addressCovers } from './address.ts'
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
}

// The suffix on a history line whose step ran with -lock=false while the lock was held.
export const LOCK_BYPASSED = ' (lock bypassed)'

const has = <T extends object, K extends string>(o: T, k: K): o is Extract<T, Record<K, unknown>> => Object.hasOwn(o, k)

const covers = addressCovers // a key-less address names every instance of the resource; a module covers all under it

async function leaf(l: Leaf, w: World, plan: () => PlanResult | undefined): Promise<boolean> {
  if (has(l, 'plan_clean')) {
    const p = plan()
    return p !== undefined && p.diagnostics.length === 0 && !hasChanges(p)
  }
  if (has(l, 'plan_has')) {
    const p = plan()
    if (!p || p.diagnostics.length) return false
    return !p.items.some((i) => (i.action === 'destroy' || i.action === 'replace') && l.plan_has.no_destroy.some((a) => covers(a, i.address)))
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
