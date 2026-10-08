// A scenario's Terraform world, turned into the engine's State and Reality.
import type { TerraformBlock } from '../../schema/scenario.ts'
import type { Fault } from './apply.ts'
import type { Value } from './eval.ts'
import { realityKey, type Reality } from './refresh.ts'
import { schemaFor } from './resources.ts'
import { labDir, labFiles } from './layout.ts'
import { emptyState, type State, type StateResource } from './state.ts'

export interface SavedPlan {
  files: { name: string; text: string }[]
  vars: Record<string, Value>
  replace: string[]
  destroy: boolean
  serial: number
  lineage: string
}

export interface Lab {
  dir: string
  version: string
  initialized: boolean
  files: { path: string; content: string }[]
  hasState: boolean
  state: State
  reality: Reality
  vars: Record<string, Value>
  evidence: NonNullable<TerraformBlock['evidence']>
  faults: Fault[]
  attempts: Map<number, number>
  savedPlans: Map<string, SavedPlan>
}

export function labFromScenario(tf: TerraformBlock, startDir: string, home: string): Lab {
  const dir = labDir(tf, startDir, home)
  const version = tf.version ?? '1.9.8'
  const state = { ...emptyState(version, '00000000-0000-4000-8000-000000000001'), serial: 12 }
  for (const s of tf.state ?? []) {
    const mode = s.mode ?? 'managed'
    let r = state.resources.find((x) => x.mode === mode && x.type === s.type && x.name === s.name)
    if (!r) {
      const source = schemaFor(s.type)?.provider ?? `registry.terraform.io/hashicorp/${s.type.split('_')[0]}`
      r = { mode, type: s.type, name: s.name, provider: `provider["${source}"]`, instances: [] } satisfies StateResource
      state.resources.push(r)
    }
    r.instances.push({
      ...(s.key === undefined ? {} : { index_key: s.key }),
      ...(s.status ? { status: s.status } : {}),
      attributes: structuredClone(s.attrs) as Record<string, Value>,
    })
  }
  state.outputs = structuredClone(tf.outputs ?? {}) as State['outputs']

  const ids = new Map<string, string>() // managed id -> type.name
  for (const r of state.resources) if (r.mode === 'managed') for (const i of r.instances) ids.set(String(i.attributes.id), `${r.type}.${r.name}`)
  const found = (v: unknown, own: string, into: Set<string>) => {
    if (typeof v === 'string') {
      const a = ids.get(v)
      if (a && a !== own) into.add(a)
    } else if (Array.isArray(v)) v.forEach((x) => found(x, own, into))
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach((x) => found(x, own, into))
  }
  for (const r of state.resources) {
    if (r.mode !== 'managed') continue
    for (const i of r.instances) {
      const into = new Set<string>()
      found(i.attributes, `${r.type}.${r.name}`, into)
      if (into.size) i.dependencies = [...into].sort()
    }
  }

  const reality: Reality = {}
  for (const r of state.resources) {
    if (r.mode !== 'managed') continue
    for (const i of r.instances) reality[realityKey(r.type, i.attributes.id as string)] = structuredClone(i.attributes)
  }
  // add, then patch (a patch may aim at an added object), then delete.
  for (const a of tf.cloud?.add ?? []) reality[realityKey(a.type, a.attrs.id as string)] = structuredClone(a.attrs) as Record<string, Value>
  for (const p of tf.cloud?.patch ?? []) {
    const key = realityKey(p.type, p.id)
    if (Object.hasOwn(reality, key)) reality[key] = { ...reality[key], ...(structuredClone(p.set) as Record<string, Value>) }
  }
  for (const d of tf.cloud?.delete ?? []) delete reality[realityKey(d.type, d.id)]

  return {
    dir,
    version,
    initialized: tf.initialized ?? true,
    files: labFiles(tf, startDir, home),
    hasState: tf.state !== undefined,
    state,
    reality,
    vars: structuredClone(tf.vars ?? {}) as Record<string, Value>,
    evidence: tf.evidence ?? [],
    faults: structuredClone(tf.faults ?? []) as Fault[],
    attempts: new Map(),
    savedPlans: new Map(),
  }
}
