// Refresh: compare what state says with what is actually in the simulated
// cloud ("reality"), the first step of a plan. Differences are drift: someone
// changed or deleted something outside Terraform.
import { equal, type Value } from './eval.ts'
import { instanceAddress, type State, type StateInstance, type StateResource } from './state.ts'

// What exists in the cloud, keyed by realityKey(type, id).
export type Reality = Record<string, Record<string, Value>>
export const realityKey = (type: string, id: string) => `${type}:${id}`

export interface Drift {
  address: string
  kind: 'deleted' | 'changed'
  changes: { name: string; before: Value; after: Value }[]
  before?: Record<string, Value>
  relevant?: string[] | 'all' // driftShown only: for a deleted object, the attributes the plan uses
}

export function refresh(state: State, reality: Reality): { state: State; drift: Drift[] } {
  // State never holds unknown values (stateJson refuses them); structuredClone would lose the sentinel's identity.
  const drift: Drift[] = []
  const resources: StateResource[] = []
  for (const r of state.resources) {
    if (r.mode === 'data') {
      resources.push(structuredClone(r))
      continue
    }
    const instances: StateInstance[] = []
    for (const inst of r.instances) {
      const address = instanceAddress(r, inst.index_key)
      const id = inst.attributes.id
      const now = typeof id === 'string' && Object.hasOwn(reality, realityKey(r.type, id)) ? reality[realityKey(r.type, id)] : undefined
      if (typeof id !== 'string') {
        instances.push(structuredClone(inst))
        continue
      }
      if (!now) {
        drift.push({ address, kind: 'deleted', changes: [], before: structuredClone(inst.attributes) })
        continue
      }
      const changes: Drift['changes'] = []
      const attributes = new Map(Object.entries(structuredClone(inst.attributes)))
      for (const [name, after] of Object.entries(now)) {
        const before = Object.hasOwn(inst.attributes, name) ? inst.attributes[name] : null
        if (!equal(before, after)) changes.push({ name, before, after })
        attributes.set(name, structuredClone(after))
      }
      if (changes.length) drift.push({ address, kind: 'changed', changes })
      instances.push({ ...structuredClone(inst), attributes: Object.fromEntries(attributes) })
    }
    if (instances.length) resources.push({ ...structuredClone(r), instances })
  }
  return { state: { ...structuredClone(state), resources }, drift }
}
