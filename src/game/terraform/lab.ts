// A scenario's Terraform world, turned into the engine's State and Reality.
import type { TerraformBlock } from '../../schema/scenario.ts'
import { staticKey, stepsOf } from './address.ts'
import type { Fault } from './apply.ts'
import type { Value } from './eval.ts'
import { realityKey, type Reality } from './refresh.ts'
import { schemaFor } from './resources.ts'
import { join, labDir, labFiles, normalizeRegistry, type RegistryModule } from './layout.ts'
import type { ModuleTree } from './modules.ts'
import type { RemoteState } from './plan.ts'
import type { Target } from './target.ts'
import { cacheFromLock, mountedLock, type ProviderCache, type ProviderInfo } from './providers.ts'
import { emptyState, type State, type StateResource } from './state.ts'

export interface SavedPlan {
  tree: ModuleTree // the root and installed module files the plan was made from
  vars: Record<string, Value>
  replace: string[]
  destroy: boolean
  targets?: Target[] // -target addresses the plan was made with
  serial: number
  lineage: string
  workspace: string
}

export interface Lab {
  dir: string
  version: string
  initialized: boolean
  files: { path: string; content: string }[]
  registry: RegistryModule[] // the authored offline module registry
  remoteStates: RemoteState[] // the authored upstream states data "terraform_remote_state" reads
  providers: Map<string, ProviderInfo> // authored provider versions by provider name (aws)
  providerCache?: ProviderCache // the packages `init` installed in .terraform/providers; absent outside the lab directory (not modelled there)
  hasState: boolean
  state: State
  workspace: string
  workspaces: Map<string, { state: State; hasState: boolean }>
  workspacesCreated: number // by `workspace new`: numbers their lineages, never reused after a delete
  lock?: { id: string; who: string; operation: string; created: string; path: string; info: string; message: string }
  reality: Reality
  releases: NonNullable<NonNullable<TerraformBlock['cloud']>['release']> // blockers the player's actions remove from reality
  vars: Record<string, Value>
  evidence: NonNullable<TerraformBlock['evidence']>
  faults: Fault[]
  attempts: Map<number, number>
  savedPlans: Map<string, SavedPlan>
  history: string[] // "OP ADDRESS" per apply step or state-writing command (state-rm, state-mv, taint, untaint, import, workspace-new/delete) that completed, in order, across workspaces; " (lock bypassed)" appended when -lock=false skipped a held lock
}

const depKey = (r: StateResource) => staticKey({ module: stepsOf(r.module), mode: r.mode, type: r.type, name: r.name })

// One workspace's state: expand the entries and derive each instance's dependencies.
function buildState(version: string, lineage: string, entries: NonNullable<TerraformBlock['state']>, outputs: TerraformBlock['outputs']): State {
  const state = { ...emptyState(version, lineage), serial: 12 }
  for (const s of entries) {
    const mode = s.mode ?? 'managed'
    let r = state.resources.find((x) => x.mode === mode && x.type === s.type && x.name === s.name && x.module === s.module)
    if (!r) {
      const source = schemaFor(s.type)?.provider ?? `registry.terraform.io/hashicorp/${s.type.split('_')[0]}`
      r = { ...(s.module ? { module: s.module } : {}), mode, type: s.type, name: s.name, provider: `provider["${source}"]`, instances: [] } satisfies StateResource
      state.resources.push(r)
    }
    r.instances.push({
      ...(s.key === undefined ? {} : { index_key: s.key }),
      ...(s.status ? { status: s.status } : {}),
      attributes: structuredClone(s.attrs) as Record<string, Value>,
    })
  }
  state.outputs = structuredClone(outputs ?? {}) as State['outputs']

  const ids = new Map<string, string>() // managed id -> static resource address
  for (const r of state.resources) if (r.mode === 'managed') for (const i of r.instances) ids.set(String(i.attributes.id), depKey(r))
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
      found(i.attributes, depKey(r), into)
      if (into.size) i.dependencies = [...into].sort()
    }
  }
  return state
}

export function labFromScenario(tf: TerraformBlock, startDir: string, home: string): Lab {
  const dir = labDir(tf, startDir, home)
  const version = tf.version ?? '1.9.8'
  const lineage = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`
  const all = new Map<string, { state: State; hasState: boolean }>([['default', { state: buildState(version, lineage(1), tf.state ?? [], tf.outputs), hasState: tf.state !== undefined }]])
  Object.keys(tf.workspaces ?? {})
    .sort()
    .forEach((name, i) => {
      const w = tf.workspaces![name]!
      all.set(name, { state: buildState(version, lineage(i + 2), w.state ?? [], w.outputs), hasState: w.state !== undefined })
    })
  const workspace = tf.workspace ?? 'default'
  const { state, hasState } = all.get(workspace)!
  all.delete(workspace)

  const reality: Reality = {}
  // The cloud is shared by every workspace. Colliding type:id: last wins, in order current, default, then the rest sorted.
  for (const st of [state, ...[...all.values()].map((w) => w.state)])
    for (const r of st.resources) {
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

  const initialized = tf.initialized ?? true
  const files = labFiles(tf, startDir, home)
  return {
    dir,
    version,
    initialized,
    files,
    registry: (tf.modules?.registry ?? []).map((r) => ({ source: normalizeRegistry(r.source), versions: structuredClone(r.versions) })),
    remoteStates: (tf.remote_states ?? []).map((r) => ({ backend: r.backend, config: structuredClone(r.config) as Record<string, Value>, workspace: r.workspace ?? 'default', outputs: structuredClone(r.outputs) as Record<string, Value> })),
    providers: new Map(Object.entries(structuredClone(tf.providers ?? {}))),
    providerCache: initialized ? cacheFromLock(files.find((f) => f.path === join(dir, '.terraform.lock.hcl'))?.content ?? mountedLock(tf, files)) : new Map(),
    hasState,
    state,
    workspace,
    workspaces: all,
    workspacesCreated: 0,
    ...(tf.lock ? { lock: { operation: 'OperationTypeApply', path: 'terraform.tfstate', info: '', message: 'resource temporarily unavailable', ...tf.lock } } : {}),
    reality,
    releases: structuredClone(tf.cloud?.release ?? []),
    vars: structuredClone(tf.vars ?? {}) as Record<string, Value>,
    evidence: tf.evidence ?? [],
    faults: structuredClone(tf.faults ?? []) as Fault[],
    attempts: new Map(),
    savedPlans: new Map(),
    history: [],
  }
}

// The cloud after the player's own actions: every release whose actions are all taken is gone. Idempotent.
export function applyReleases(lab: Lab, taken: Set<string>): void {
  for (const r of lab.releases) if (r.when_actions.every((a) => taken.has(a))) delete lab.reality[realityKey(r.type, r.id)]
}
