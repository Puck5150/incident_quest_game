// Apply: execute a plan against the simulated cloud one object at a time, in
// dependency order, re-planning after each step so real ids flow into what
// depends on them. Provider errors (scripted faults first, then the generic
// "already exists" and "has dependencies" cases) stop the failed resource and
// everything that depends on it; independent work carries on, leaving a
// half-applied world exactly as real Terraform does.
import { equal, hasUnknown, type Value } from './eval.ts'
import { planConfig, resKey, type PlanInput, type PlanItem, type PlanResult } from './plan.ts'
import { alreadyExists, dependencyViolation, fillOnCreate, fillOnUpdate, hex, referencedBy, seconds } from './provider.ts'
import { realityKey, type Reality } from './refresh.ts'
import { schemaFor } from './resources.ts'
import { findInstance, instanceAddress, type State } from './state.ts'
import type { Diagnostic } from './types.ts'

export interface Fault {
  at: string // an instance address (aws_subnet.a, aws_s3_bucket.b["x"]) or a resource address (aws_subnet.a)
  on: 'create' | 'update' | 'delete'
  error: string // the provider's complete error text, shown as the Error summary
  times?: number // fail this many times, then succeed (default: always)
  // only when the new object's attribute has this value, or is a string matching this regex (create/update)
  if?: { attr: string; equals: Value } | { attr: string; matches: string }
  until_actions?: string[] // inactive once all of these actions are taken
}
export interface ApplyContext {
  faults: Fault[]
  taken: Set<string> // actions the player has taken
  attempts: Map<number, number> // fault index -> times it has fired (persisted by the caller across runs)
  seed: string // salt for generated ids; the caller passes lineage and serial, e.g. `${state.lineage}:${state.serial}`
}
export interface ApplyStep {
  address: string
  op: 'create' | 'update' | 'delete' | 'forget' | 'import'
  id?: string
  deposed?: string // the delete of a deposed object (key); address is its instance's
  seconds: number
  ok: boolean
}
export interface ApplyResult {
  plan: PlanResult // the first plan (refresh included)
  steps: ApplyStep[] // in execution order, failed attempts included (ok: false)
  errors: Diagnostic[] // provider errors with address, file, line, context
  state: State
  reality: Reality
  counts: { imported: number; added: number; changed: number; destroyed: number }
}

type Attrs = Record<string, Value>
const res = resKey
const destroyPhase = (i: PlanItem) => i.action === 'destroy' || i.action === 'replace'
const pending = (i: PlanItem) => destroyPhase(i) || i.action === 'create' || i.action === 'update' || i.action === 'forget' || i.importing !== undefined

// A create_before_destroy replacement: created first, its old object deleted (as a deposed one) after its dependents moved over.
const cbd = (i: PlanItem) => i.action === 'replace' && i.createBeforeDestroy === true

const opOf = (i: PlanItem): ApplyStep['op'] =>
  i.importing !== undefined ? 'import' : i.action === 'forget' ? 'forget' : destroyPhase(i) ? 'delete' : i.action === 'create' ? 'create' : 'update'

// done holds `${address}:${op}` for every successful step: an op never runs twice
// on one address, and a created or updated instance is settled for this run, so
// a plan that never converges (e.g. a value that stays unknown) cannot loop.
// A deposed delete fails on its own: it must not hold up the live instance's updates or dependents.
const fkey = (i: PlanItem) => (i.deposed ? `${i.address}#${i.deposed}` : i.address)
const doneKey = (i: PlanItem) => `${i.address}${i.deposed ? `#${i.deposed}` : ''}:${opOf(i)}`
function todoOf(items: PlanItem[], done: Set<string>): PlanItem[] {
  const settled = (a: string) => done.has(`${a}:create`) || done.has(`${a}:update`)
  return items.filter((i) => pending(i) && (i.deposed !== undefined || !settled(i.address)) && !done.has(doneKey(i)))
}

// failed holds instance addresses (an instance is never retried in this run) and
// resource addresses (nothing that depends on a failed resource is attempted).
// strict: a plain destroy also waits for updates that move off it (from their
// state dependencies); a replace does not (its dependents wait for it instead).
function pickNext(todo: PlanItem[], state: State, failed: Set<string>, strict: boolean): PlanItem | undefined {
  // The live instance at a deposed object's address is itself being replaced or created: its dependents wait for it, so the deposed delete must not wait for them.
  const live = (d: PlanItem) => todo.some((x) => x.deposed === undefined && x.address === d.address)
  const priorDeps = (o: PlanItem) => findInstance(state, o.address)?.instance.dependencies ?? []
  const tier1 = todo.find(
    (i) =>
      destroyPhase(i) &&
      !cbd(i) &&
      i.importing === undefined &&
      !failed.has(fkey(i)) &&
      // a deposed object goes first; its own delete also waits for every create/update that still moves dependents off it
      !todo.some((o) => o !== i && !i.deposed && o.deposed !== undefined && o.address === i.address) &&
      !todo.some((o) => o !== i && ((destroyPhase(o) && !cbd(o) && o.dependsOn.includes(res(i))) || (i.deposed !== undefined && !live(i) && o.action !== 'destroy' && o.dependsOn.includes(res(i))) || (strict && i.action === 'destroy' && o.action === 'update' && priorDeps(o).includes(res(i))))),
  )
  if (tier1) return tier1
  const tier2 = todo.find((i) => i.action === 'forget' || i.importing !== undefined)
  if (tier2) return tier2
  // Plain destroys never hold up a create/update: the updates they matter to already go first.
  return todo.find(
    (i) =>
      (i.action === 'create' || i.action === 'update' || cbd(i)) &&
      !failed.has(i.address) &&
      !(cbd(i) && todo.some((o) => o.deposed !== undefined && o.address === i.address)) &&
      i.dependsOn.every((d) => !failed.has(d) && !todo.some((o) => o !== i && o.action !== 'destroy' && res(o) === d)),
  )
}

function removeInstance(state: State, address: string): void {
  state.resources = state.resources
    .map((r) => ({ ...r, instances: r.instances.filter((x) => instanceAddress(r, x.index_key) !== address) }))
    .filter((r) => r.instances.length > 0)
}

function addInstance(state: State, item: PlanItem, attributes: Attrs): void {
  const module = item.module ?? ''
  let r = state.resources.find((x) => x.mode === 'managed' && x.type === item.type && x.name === item.name && (x.module ?? '') === module)
  if (!r) {
    const prefix = item.type.split('_')[0]
    r = { ...(module ? { module } : {}), mode: 'managed', type: item.type, name: item.name, provider: `provider["${schemaFor(item.type)?.provider ?? `registry.terraform.io/hashicorp/${prefix}`}"]`, instances: [] }
    state.resources.push(r)
  }
  r.instances.push({
    ...(item.key === undefined ? {} : { index_key: item.key }),
    attributes,
    ...(item.dependsOn.length ? { dependencies: [...item.dependsOn] } : {}),
  })
}

// A missing attribute, a non-string for `matches`, or an invalid regex: no match (never throws).
function ifHolds(cond: NonNullable<Fault['if']>, attrs: Attrs): boolean {
  if (!Object.hasOwn(attrs, cond.attr)) return false
  const v = attrs[cond.attr]
  if ('equals' in cond) return equal(v, cond.equals)
  if (typeof v !== 'string') return false
  try {
    return new RegExp(cond.matches).test(v)
  } catch {
    return false
  }
}

export function executeApply(input: PlanInput, ctx: ApplyContext): ApplyResult {
  let state = structuredClone(input.state)
  const reality = new Map(Object.entries(structuredClone(input.reality)))
  const steps: ApplyStep[] = []
  const errors: Diagnostic[] = []
  const counts = { imported: 0, added: 0, changed: 0, destroyed: 0 }
  const failed = new Set<string>()
  const done = new Set<string>()
  const skipImports = new Set<string>() // imported or deleted in this run: its import block is spent
  let first: PlanResult | undefined

  const faultFor = (i: PlanItem, on: Fault['on'], attrs: Attrs): string | undefined => {
    for (const [n, f] of ctx.faults.entries()) {
      // module.net.aws_x.y (every module instance), module.net["a"].aws_x.y (that instance, every key) or the instance address
      if (f.on !== on || (f.at !== i.address && f.at !== res(i) && f.at !== instanceAddress({ mode: 'managed', type: i.type, name: i.name, module: i.module || undefined }))) continue
      // until_actions: [] (or absent) never deactivates the fault.
      if (f.until_actions?.length && f.until_actions.every((a) => ctx.taken.has(a))) continue
      if (f.if && !ifHolds(f.if, attrs)) continue
      const fired = ctx.attempts.get(n) ?? 0
      if (fired >= (f.times ?? Infinity)) continue
      ctx.attempts.set(n, fired + 1)
      return f.error
    }
    return undefined
  }
  const fail = (i: PlanItem, op: ApplyStep['op'], secs: number, summary: string, id?: string) => {
    steps.push({ address: i.address, op, ...(id === undefined ? {} : { id }), ...(i.deposed ? { deposed: i.deposed } : {}), seconds: secs, ok: false })
    errors.push({ severity: 'error', summary, detail: '', file: i.block?.file ?? '', line: i.block?.line ?? 0, col: i.block?.col ?? 0, context: `resource "${i.type}" "${i.name}"`, address: i.address })
    failed.add(fkey(i))
    if (!i.deposed) failed.add(res(i))
  }

  for (let guard = 0; guard < 2000; guard++) {
    const plan = planConfig({ ...input, state, reality: Object.fromEntries(reality), refresh: first ? false : input.refresh, skipImports })
    first ??= plan
    if (plan.diagnostics.length) {
      errors.push(...plan.diagnostics)
      break
    }
    state = structuredClone(plan.baseState)
    const todo = todoOf(plan.items, done)
    // If the ordering rules leave nothing ready, drop the soft wait so the cloud's own error shows.
    const i = pickNext(todo, state, failed, true) ?? pickNext(todo, state, failed, false)
    if (!i) {
      // Never end silently with work left over that no failure explains.
      if (!errors.length && todo.length) errors.push({ severity: 'error', summary: `Cycle: ${todo.map((t) => t.address).join(', ')}`, detail: '', file: '', line: 0, col: 0 })
      break
    }
    const seed = `${ctx.seed}:${steps.length}`
    const inst = findInstance(state, i.address)?.instance
    const prior = inst?.attributes

    if (i.importing !== undefined) {
      addInstance(state, i, structuredClone(reality.get(realityKey(i.type, i.importing)) ?? {}))
      skipImports.add(i.address)
      steps.push({ address: i.address, op: 'import', id: i.importing, seconds: 0, ok: true })
      done.add(`${i.address}:import`)
      counts.imported++
    } else if (i.action === 'forget') {
      removeInstance(state, i.address)
      steps.push({ address: i.address, op: 'forget', seconds: 0, ok: true })
      done.add(`${i.address}:forget`)
    } else if (destroyPhase(i) && !cbd(i)) {
      const gone = i.deposed === undefined ? undefined : inst?.deposed?.find((d) => d.key === i.deposed)
      const attrs = gone ? gone.attributes : (prior ?? {})
      const id = typeof attrs.id === 'string' ? attrs.id : ''
      const secs = seconds(i.type, 'delete')
      const ref = referencedBy(Object.fromEntries(reality), i.type, id)
      const error = faultFor(i, 'delete', attrs) ?? (ref ? dependencyViolation(i.type, id, seed) : undefined)
      if (error) fail(i, 'delete', secs, error, id)
      else {
        if (gone) {
          inst!.deposed = inst!.deposed!.filter((d) => d !== gone)
          if (!inst!.deposed.length) delete inst!.deposed
        } else {
          removeInstance(state, i.address)
          skipImports.add(i.address)
        }
        reality.delete(realityKey(i.type, id))
        steps.push({ address: i.address, op: 'delete', id, ...(gone ? { deposed: gone.key } : {}), seconds: secs, ok: true })
        done.add(doneKey(i))
        counts.destroyed++
      }
    } else if (i.action === 'create' || cbd(i)) {
      // A replacement's changes hold only what differs from the old object (and what is recomputed): the rest carries over.
      const attrs = fillOnCreate(i.type, i.address, { ...(cbd(i) ? i.unchanged : {}), ...Object.fromEntries(i.changes.map((c) => [c.name, c.after])) }, seed)
      const secs = seconds(i.type, 'create')
      const error = faultFor(i, 'create', attrs) ?? alreadyExists(i.type, attrs, Object.fromEntries(reality), seed)
      if (error) fail(i, 'create', secs, error)
      else {
        const id = attrs.id as string
        if (cbd(i) && inst) {
          // The old object moves aside; the instance now holds the new one.
          inst.deposed = [{ key: hex(`${i.address}:${seed}:deposed`, 8), attributes: inst.attributes }]
          inst.attributes = attrs
          delete inst.status
          if (i.dependsOn.length) inst.dependencies = [...i.dependsOn]
          else delete inst.dependencies
        } else addInstance(state, i, attrs)
        reality.set(realityKey(i.type, id), structuredClone(attrs))
        steps.push({ address: i.address, op: 'create', id, seconds: secs, ok: true })
        done.add(`${i.address}:create`)
        counts.added++
      }
    } else {
      const before = prior ?? {}
      const next = new Map(Object.entries(before))
      for (const c of i.changes) next.set(c.name, c.after)
      const attrs = fillOnUpdate(before, Object.fromEntries(next))
      const secs = seconds(i.type, 'update')
      const error = faultFor(i, 'update', attrs)
      if (error) fail(i, 'update', secs, error, typeof attrs.id === 'string' ? attrs.id : undefined)
      else {
        const id = attrs.id as string
        if (inst) {
          inst.attributes = attrs
          if (i.dependsOn.length) inst.dependencies = [...i.dependsOn]
          else delete inst.dependencies
        }
        reality.set(realityKey(i.type, id), structuredClone(attrs))
        steps.push({ address: i.address, op: 'update', id, seconds: secs, ok: true })
        done.add(`${i.address}:update`)
        counts.changed++
      }
    }
  }

  if (!errors.length) {
    const final = planConfig({ ...input, state, reality: Object.fromEntries(reality), refresh: false, skipImports })
    const computed = final.outputs.filter((o) => !hasUnknown(o.value)).map((o): [string, State['outputs'][string]] => [o.name, o.sensitive ? { value: o.value, sensitive: true } : { value: o.value }])
    // A targeted run only updates (or, destroying, removes) the outputs inside the targets.
    const scoped = first?.targetOutputs // from the first plan: a destroy has removed the objects the later plans would look at
    // Destroying removes them; otherwise an output that stayed unknown keeps its recorded value.
    const dropped = scoped && (input.destroy ? scoped : scoped.filter((n) => computed.some(([c]) => c === n)))
    const old = dropped ? Object.entries(state.outputs).filter(([n]) => !dropped.includes(n)) : []
    state.outputs = Object.fromEntries([...old, ...computed])
  }
  const content = (x: State) => JSON.stringify({ ...x, serial: 0 })
  // Terraform bumps the serial only when the state changed (statemgr/filesystem.go), not for a failed-only run.
  if (content(state) !== content(input.state)) state.serial++
  return { plan: first!, steps, errors, state, reality: Object.fromEntries(reality), counts }
}
