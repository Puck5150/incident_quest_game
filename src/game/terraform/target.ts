// -target: which objects a targeted plan, apply or destroy touches. Real Terraform (TargetsTransformer) keeps the
// targeted nodes and their ancestors in the graph; in destroy mode the ancestors are the dependents. A root output
// stays only when every resource it depends on is kept.
import { modulePathCovers, parseModuleAddr, parseResAddr, staticKey, stepsOf, type ModStep } from './address.ts'
import { resourceDeps, type GNode } from './graph.ts'
import type { State } from './state.ts'

export interface Target {
  steps: ModStep[] // the module path (a whole-module target has no res)
  res?: { mode: 'managed' | 'data'; type: string; name: string; key?: string | number }
}

export function parseTargetArg(text: string): Target | undefined {
  const steps = parseModuleAddr(text)
  if (steps) return { steps }
  const a = parseResAddr(text)
  return a ? { steps: a.module, res: { mode: a.mode, type: a.type, name: a.name, ...(a.key === undefined ? {} : { key: a.key }) } } : undefined
}

type Res = { module?: string; mode: 'managed' | 'data'; type: string; name: string }
const hit = (ts: Target[], r: Res, key?: string | number) =>
  ts.some((t) => {
    const steps = stepsOf(r.module)
    return t.res ? t.res.mode === r.mode && t.res.type === r.type && t.res.name === r.name && modulePathCovers(t.steps, steps, true) && (t.res.key === undefined || t.res.key === key) : modulePathCovers(t.steps, steps)
  })
const unkeyed = (ts: Target[]): Target[] => ts.map((t) => ({ steps: t.steps.map((s) => ({ name: s.name })), ...(t.res ? { res: { mode: t.res.mode, type: t.res.type, name: t.res.name } } : {}) }))
const sk = (r: Res) => staticKey({ module: stepsOf(r.module), mode: r.mode, type: r.type, name: r.name })

export interface TargetScope {
  visit: Set<string> // graph nodes the plan walks
  includes(r: Res, key?: string | number): boolean // is this state or planned instance inside the targets?
  outputs: string[] // root outputs kept (normal mode) or removed (destroy)
}

// Root outputs whose resource dependencies are all among `kept` (and that have at least one).
function outputsWithin(nodes: Map<string, GNode>, kept: Set<string>): GNode[] {
  return [...nodes.values()].filter((n) => {
    if (n.kind !== 'output' || n.module) return false
    const rd = resourceDeps(nodes, n)
    return rd.length > 0 && rd.every((a) => kept.has(a))
  })
}

// Plan and apply: the targets, everything they depend on, and the outputs only those feed.
export function targetScope(nodes: Map<string, GNode>, targets: Target[]): TargetScope {
  const loose = unkeyed(targets)
  const visit = new Set<string>()
  const deps = new Set<string>() // reached as someone's dependency: every instance is planned
  const seeds = new Set<string>() // directly targeted: Terraform filters their instances to the targets, even when also a dependency
  let late = false // adding a kept output: what is already walked keeps its instance filter
  const add = (addr: string, asDep: boolean) => {
    const n = nodes.get(addr)
    if (!n || (visit.has(addr) && (!asDep || deps.has(addr) || late))) return
    visit.add(addr)
    if (asDep) deps.add(addr)
    for (const d of n.deps) add(d, true)
    if (n.module) add(n.module, true)
  }
  for (const n of nodes.values()) {
    if ((n.kind === 'resource' || n.kind === 'data') && n.block && hit(loose, { module: n.module, mode: n.kind === 'data' ? 'data' : 'managed', type: n.block.labels[0], name: n.block.labels[1] })) {
      seeds.add(n.address)
      add(n.address, false)
    }
  }
  // Like Terraform, an output stays when every resource it reads is in the walk, even if only some of its instances are.
  const outs = outputsWithin(nodes, visit)
  late = true
  for (const o of outs) add(o.address, false)
  return {
    visit,
    includes: (r, key) => hit(targets, r, key) || (deps.has(sk(r)) && !seeds.has(sk(r))),
    outputs: outs.map((o) => o.block?.labels[0] ?? o.local.slice('output.'.length)),
  }
}

// Destroy: the targeted instances plus every resource that depends on a targeted resource, by state or configuration.
export function destroyScope(nodes: Map<string, GNode>, state: State, targets: Target[]): TargetScope {
  const managed = state.resources.filter((r) => r.mode === 'managed')
  const need = new Map<string, Set<string>>()
  for (const r of managed) {
    const set = need.get(sk(r)) ?? new Set<string>()
    for (const i of r.instances) for (const d of i.dependencies ?? []) set.add(d)
    const node = nodes.get(sk(r))
    if (node) for (const d of resourceDeps(nodes, node)) set.add(d)
    need.set(sk(r), set)
  }
  const within = new Set(managed.filter((r) => r.instances.some((i) => hit(targets, r, i.index_key))).map(sk))
  const dependents = new Set<string>()
  for (let grew = true; grew; ) {
    grew = false
    for (const [a, ds] of need) {
      if (within.has(a) || ![...ds].some((d) => within.has(d))) continue
      within.add(a)
      dependents.add(a)
      grew = true
    }
  }
  return {
    visit: within,
    includes: (r, key) => hit(targets, r, key) || dependents.has(sk(r)),
    outputs: outputsWithin(nodes, within).map((o) => o.block?.labels[0] ?? o.local.slice('output.'.length)),
  }
}
