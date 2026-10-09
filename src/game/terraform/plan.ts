// The plan: refresh state against the cloud, walk the configuration in
// dependency order, plan each resource instance from its evaluated arguments
// and the planned values of what it depends on, then plan destroys for
// instances that are no longer configured. Any configuration error stops the
// plan: nothing is half-planned. prevent_destroy is the exception: it fails
// after planning, and the result keeps the partial plan (`partial`).
import { compareAddresses, parseResAddr, staticKey, stepsOf } from './address.ts'
import { lifecycleOf, resourceArguments } from './arguments.ts'
import { importsOf, removedOf } from './declarations.ts'
import { equal, evalExpr, EvalError, isUnknown, UNKNOWN, type Scope, type Value } from './eval.ts'
import { expandInstances, type Key } from './expand.ts'
import { buildGraph, type GNode } from './graph.ts'
import { applyMoves, movesOf } from './moves.ts'
import type { ModuleTree } from './modules.ts'
import { realityKey, refresh as refreshState, type Drift, type Reality } from './refresh.ts'
import { diffInstance, schemaFor, unsupportedType, type Action, type AttrChange, type ResourceSchema } from './resources.ts'
import { findInstance, instanceAddress, type State } from './state.ts'
import { NO_IMPORT_CONFIG, NO_REMOTE_OBJECT, noImportConfigDetail, noRemoteObjectDetail } from './state-ops.ts'
import type { Diagnostic, Pos } from './types.ts'

export interface PlanInput {
  files: { name: string; text: string }[] // the root module's files
  tree?: ModuleTree // the root and its loaded child modules; takes precedence over files
  state: State
  reality: Reality
  vars: Record<string, Value>
  workspace?: string
  refresh?: boolean
  replace?: string[]
  skipImports?: Set<string> // instance addresses whose import blocks are already spent (apply imported or deleted them)
  destroy?: boolean // plan -destroy: every managed instance in state is destroyed; arguments are not evaluated
}
export interface PlanItem {
  address: string // the full qualified instance address: module.net.aws_vpc.main[0]
  module?: string // module instance path as in state (absent or '' root; equals the static path while module calls are single-instance)
  resource?: string // unqualified type.name (always set by planConfig)
  type: string
  name: string
  key?: string | number
  action: Action | 'destroy' | 'forget'
  changes: AttrChange[]
  movedFrom?: string
  importing?: string
  reason?: 'tainted' | 'requested' | 'triggered'
  triggeredBy?: string[]
  createBeforeDestroy?: boolean
  unchanged?: Record<string, Value>
  dependsOn: string[] // module-qualified resource addresses (no instance keys) this item's resource depends on
  block?: { file: string; line: number; col: number } // where the resource is declared
  destroyReason?: 'not-in-config' | 'module-gone' | 'count-index' | 'for-each-key' | 'wrong-repetition'
}
// A still-declared resource whose instance key no longer fits its repetition mode.
function wrongRepetition(key: string | number | undefined, shape: 'count' | 'for_each' | undefined): NonNullable<PlanItem['destroyReason']> {
  if (typeof key === 'number') return shape === 'count' ? 'count-index' : 'wrong-repetition'
  if (typeof key === 'string') return shape === 'for_each' ? 'for-each-key' : 'wrong-repetition'
  return shape ? 'wrong-repetition' : 'not-in-config'
}
export interface PlanOutput {
  name: string
  value: Value
  sensitive: boolean
}
export interface PlanResult {
  diagnostics: Diagnostic[]
  warnings: Diagnostic[]
  drift: Drift[] // every difference refresh found
  driftShown: Drift[] // the part of it that plan output reports: only what a changing object refers to
  items: PlanItem[]
  outputs: PlanOutput[]
  refreshed: State
  baseState: State // what planning worked from: refreshed, with moves applied
  summary: { add: number; change: number; destroy: number }
  imported: number
  partial?: boolean // diagnostics came from prevent_destroy after planning: items and outputs hold what was planned
}

const cmp = <T extends string | number>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0)
// Terraform's order: type, then name, then key (none first, numbers numerically, strings lexically).
const keyRank = (k: Key) => (k === undefined ? 0 : typeof k === 'number' ? 1 : 2)
const modOf = (i: PlanItem) => (i.module ? `${i.module}.x.x` : 'x.x')
const staticModule = (module: string) => stepsOf(module).map((x) => `module.${x.name}`).join('.')
// The qualified resource address (no instance key) of an item: how dependencies and lifecycle checks name it.
export const resKey = (i: Pick<PlanItem, 'module' | 'resource' | 'type' | 'name'>) => `${i.module ? `${staticModule(i.module)}.` : ''}${i.resource ?? `${i.type}.${i.name}`}`
const byInstance = (a: PlanItem, b: PlanItem) =>
  compareAddresses(modOf(a), modOf(b)) || cmp(a.type, b.type) || cmp(a.name, b.name) || cmp(keyRank(a.key), keyRank(b.key)) || (a.key === undefined || b.key === undefined ? 0 : cmp(a.key, b.key))
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

// Follow attribute names into a value, as `a.b.c` does.
function walk(v: Value, names: string[]): Value {
  let cur = v
  for (const n of names) {
    if (isUnknown(cur)) return UNKNOWN
    if (typeof cur === 'object' && cur !== null && !Array.isArray(cur) && Object.hasOwn(cur, n)) cur = cur[n]
    else throw new EvalError('Unsupported attribute', `This object has no argument, nested block, or exported attribute named "${n}".`)
  }
  return cur
}

// Every attribute the schema knows is present on a planned object (null if
// nothing sets it), so references to it resolve instead of failing.
const complete = (planned: Record<string, Value>, schema: ResourceSchema): Record<string, Value> =>
  Object.fromEntries([...Object.keys(schema.attrs).map((n): [string, Value] => [n, null]), ...Object.entries(planned)])

export function planConfig(input: PlanInput): PlanResult {
  const g = buildGraph(input.tree ?? input.files)
  const { state: refreshed, drift } = input.refresh === false ? { state: structuredClone(input.state), drift: [] as Drift[] } : refreshState(input.state, input.reality)
  const result: PlanResult = { diagnostics: [...g.diagnostics], warnings: [], drift, driftShown: [], items: [], outputs: [], refreshed, baseState: refreshed, summary: { add: 0, change: 0, destroy: 0 }, imported: 0 }
  if (g.diagnostics.length) return result

  const errors = result.diagnostics
  const values = new Map<string, Value>()
  const shapes = new Map<string, 'count' | 'for_each'>()
  const val = (k: string): Value => (values.has(k) ? values.get(k)! : UNKNOWN)
  const fail = (file: string, pos: Pos, summary: string, detail: string, context?: string) =>
    errors.push({ severity: 'error', summary, detail, file, line: pos.line, col: pos.col, context })
  const evalAt = (node: GNode, pos: Pos, fn: () => Value, context?: string, file = node.file): Value => {
    try {
      return fn()
    } catch (e) {
      if (!(e instanceof EvalError)) throw e
      fail(file, pos, e.summary, e.detail, context)
      return UNKNOWN
    }
  }

  // moved / removed / import: statements about state.
  const rootFiles = new Set((input.tree?.root.files ?? input.files).map((f) => f.name))
  const rootBlocks = g.blocks.filter((b) => rootFiles.has(b.file)) // moved/removed/import inside child modules are not supported yet
  const mv = movesOf(rootBlocks)
  const rm = removedOf(rootBlocks)
  const im = importsOf(rootBlocks)
  errors.push(...mv.diagnostics, ...rm.diagnostics, ...im.diagnostics)
  const declared = (a: { type: string; name: string }) => g.nodes.has(`${a.type}.${a.name}`)
  const show = (a: { type: string; name: string; key?: string | number }) => instanceAddress({ mode: 'managed', type: a.type, name: a.name }, a.key)
  const imports = im.imports.filter((i) => !input.skipImports?.has(show(i.to)))
  for (const r of input.destroy ? [] : rm.removals) {
    if (declared(r.from)) fail(r.file, r.pos, 'Removed resource still exists', `This statement declares that ${show(r.from)} was removed, so it should no longer be declared in the configuration, but the resource is still declared.`)
  }
  for (const i of input.destroy ? [] : imports) {
    if (!declared(i.to)) fail(i.file, i.pos, NO_IMPORT_CONFIG, noImportConfigDetail(show(i.to)))
  }
  const applied = applyMoves(refreshed, mv.moves)
  errors.push(...applied.diagnostics)
  for (const x of applied.blocked) {
    result.warnings.push({
      severity: 'warning',
      summary: 'Unresolved resource instance address changes',
      detail: `Terraform was not able to move ${x.from} to ${x.to}: ${x.claimed ? `another object was moved there first, so ${x.from} is left where it is.` : `an object already exists at ${x.to}, so the existing object takes priority and ${x.from} is left where it is.`}`,
      file: '',
      line: 0,
      col: 0,
    })
  }
  if (errors.length) return result
  const base = applied.state // the state planning works from: refreshed, with moves applied
  result.baseState = base
  if (input.destroy) return planDestroy(g.nodes, result, fail)

  // mod is the module prefix the expression is written in: '' (root) or 'module.net.'.
  const scopeFor = (ctx: { each?: { key: Value; value: Value }; count?: number }, mod = ''): Scope => ({
    ref(path) {
      const [root, a, b] = path
      switch (root) {
        case 'each':
          if (!ctx.each) throw new EvalError('Reference to "each" in context without for_each', 'The "each" object can be used only in "resource" blocks, and only when the "for_each" argument is set.')
          return walk({ key: ctx.each.key, value: ctx.each.value }, path.slice(1))
        case 'count':
          if (ctx.count === undefined) throw new EvalError('Reference to "count" in non-counted context', 'The "count" object can only be used in "resource" blocks when the "count" argument is set.')
          return walk({ index: ctx.count }, path.slice(1))
        case 'self':
          throw new EvalError('Invalid "self" reference', 'The "self" object is not available in this context.')
        case 'path':
          return walk({ module: mod ? (input.tree?.children.get(mod.slice(7, -1))?.files.dir ?? '.') : '.', root: '.', cwd: '.' }, path.slice(1))
        case 'terraform':
          return walk({ workspace: input.workspace ?? 'default' }, path.slice(1))
        case 'var':
        case 'local':
          return walk(val(`${mod}${root}.${a}`), path.slice(2))
        case 'data':
          return walk(val(`${mod}data.${a}.${b}`), path.slice(3))
        case 'module': {
          // The call's outputs as one object; unknown until each output has been evaluated.
          const call = g.nodes.get(`${mod}module.${a}`)
          if (!call?.child) return UNKNOWN
          const outs = [...g.nodes.values()].filter((n) => n.kind === 'output' && n.module === call.address)
          return walk(Object.fromEntries(outs.map((n): [string, Value] => [n.local.slice('output.'.length), val(n.address)])), path.slice(2))
        }
        default: {
          const addr = `${mod}${root}.${a}`
          const shape = shapes.get(addr)
          if (shape && path.length > 2) {
            throw new EvalError(
              'Missing resource instance key',
              `Because ${root}.${a} has "${shape}" set, its attributes must be accessed on specific instances.\n\nFor example, to correlate with indices of a referring resource, use:\n    ${root}.${a}[${shape === 'count' ? 'count.index' : 'each.key'}]`,
            )
          }
          return walk(val(addr), path.slice(2))
        }
      }
    },
  })

  const consumed = new Set<string>()
  // Which actions each resource's instances ended up with, for replace_triggered_by.
  const touched = new Map<string, Set<string>>()
  // Resources that set prevent_destroy, by type.name, with where to point an error.
  const protectedBy = new Map<string, { file: string; pos: Pos; context: string }>()
  const planResource = (node: GNode) => {
    const b = node.block!
    const [type, name] = b.labels
    const context = `resource "${type}" "${name}"`
    values.set(node.address, UNKNOWN)
    const schema = schemaFor(type)
    if (!schema) {
      const u = unsupportedType(type)
      fail(node.file, b.pos, u.summary, u.detail, context)
      return
    }
    const mod = node.module ? `${node.module}.` : ''
    const ex = expandInstances(b, scopeFor({}, mod))
    if (!ex.ok) {
      fail(node.file, ex.pos, ex.summary, ex.detail, context)
      return
    }
    const lc = lifecycleOf(b)
    if (!lc.ok) {
      fail(node.file, lc.pos, lc.summary, lc.detail, context)
      return
    }
    if (ex.kind !== 'single') shapes.set(node.address, ex.kind)
    if (lc.lifecycle.preventDestroy) protectedBy.set(node.address, { file: node.file, pos: b.pos, context })
    const planned = new Map<Key, Value>()
    let failed = false
    for (const key of ex.keys) {
      const ctx = ex.kind === 'count' ? { count: key as number } : ex.kind === 'for_each' ? { each: ex.each(key as string) } : {}
      const ar = resourceArguments(b, scopeFor(ctx, mod))
      if (!ar.ok) {
        fail(node.file, ar.pos, ar.summary, ar.detail, context)
        failed = true
        continue
      }
      const at = { mode: 'managed' as const, type, name, module: node.module || undefined }
      const address = instanceAddress(at, key)
      let priorInst = findInstance(base, address)?.instance
      let movedFrom: string | undefined = applied.moved.get(address)
      // Adding or removing `count = 1` moves the lone instance between `x` and `x[0]` (Terraform 1.1+).
      if (!priorInst && ex.kind !== 'for_each' && (key === 0 || key === undefined)) {
        const old = instanceAddress(at, key === 0 ? undefined : 0)
        const found = findInstance(base, old)
        if (found) {
          priorInst = found.instance
          movedFrom = applied.moved.get(old) ?? old
          consumed.add(old)
        }
      }
      let importing: string | undefined
      const decl = node.module ? undefined : imports.find((d) => d.to.type === type && d.to.name === name && d.to.key === key)
      if (!priorInst && decl) {
        const before = errors.length
        let id = evalAt(node, decl.idPos, () => evalExpr(decl.id, scopeFor({})), 'import')
        if (errors.length === before && typeof id === 'number') id = String(id)
        if (errors.length === before && typeof id !== 'string') {
          fail(decl.file, decl.idPos, 'Invalid import id argument', `The given import id for ${address} must be a known string value.`, 'import')
          failed = true
          continue
        }
        const object = errors.length === before && typeof id === 'string' && Object.hasOwn(input.reality, realityKey(type, id)) ? input.reality[realityKey(type, id)] : undefined
        if (!object) {
          if (errors.length === before) {
            fail(
              decl.file,
              decl.pos,
              NO_REMOTE_OBJECT,
              noRemoteObjectDetail(address),
              'import',
            )
          }
          failed = true
          continue
        }
        priorInst = { attributes: structuredClone(object) }
        importing = id as string
      }
      const prior = priorInst?.attributes
      // Why an existing instance might be replaced even though its arguments did not force it.
      const triggers = prior ? lc.lifecycle.replaceTriggeredBy.filter((a) => touched.get(mod + a)?.has('update') || touched.get(mod + a)?.has('replace')) : []
      const tainted = priorInst?.status === 'tainted'
      const requested = !!prior && !!input.replace?.includes(address)
      const forced = tainted || requested || triggers.length > 0
      // A tainted object's prior value counts as null, so the replacement comes from the configuration.
      const ignore = tainted ? [] : lc.lifecycle.ignoreChanges
      let p = diffInstance(schema, ar.args, prior, ignore)
      if (forced && p.action !== 'replace') p = diffInstance(schema, ar.args, prior, ignore, true)
      const reason: PlanItem['reason'] = p.action === 'replace' ? (triggers.length ? 'triggered' : tainted ? 'tainted' : requested ? 'requested' : undefined) : undefined
      const changed = new Set(p.changes.map((c) => c.name))
      const unchanged = prior ? Object.fromEntries(Object.entries(prior).filter(([n, v]) => v !== null && !changed.has(n))) : undefined
      result.items.push({
        address,
        module: node.module,
        resource: `${type}.${name}`,
        type,
        name,
        key,
        action: p.action,
        changes: p.changes,
        dependsOn: resourceDeps(g.nodes, node),
        block: { file: node.file, line: b.pos.line, col: b.pos.col },
        ...(movedFrom ? { movedFrom } : {}),
        ...(importing ? { importing } : {}),
        ...(reason ? { reason } : {}),
        ...(unchanged ? { unchanged } : {}),
        ...(reason === 'triggered' ? { triggeredBy: [triggers[0]] } : {}),
        ...(p.action === 'replace' && lc.lifecycle.createBeforeDestroy ? { createBeforeDestroy: true } : {}),
      })
      const seen = touched.get(node.address) ?? new Set<string>()
      touched.set(node.address, seen.add(p.action))
      planned.set(key, complete(p.planned, schema))
    }
    if (failed) return
    values.set(
      node.address,
      ex.kind === 'count' ? ex.keys.map((k) => planned.get(k)!) : ex.kind === 'for_each' ? Object.fromEntries(ex.keys.map((k): [string, Value] => [k as string, planned.get(k)!])) : planned.get(undefined)!,
    )
  }

  const broken = new Set<string>()
  for (const addr of g.order) {
    const node = g.nodes.get(addr)!
    const b = node.block
    // A failed node's dependents are not visited; their errors would only mislead.
    if (node.deps.some((d) => broken.has(d))) {
      broken.add(addr)
      values.set(addr, UNKNOWN)
      continue
    }
    const errorsBefore = errors.length
    switch (node.kind) {
      case 'variable': {
        const name = b!.labels[0]
        const context = `variable "${name}"`
        const def = b!.attrs.find((a) => a.name === 'default')
        const mod = node.module ? `${node.module}.` : ''
        if (node.module && node.arg) {
          // A module input is the call's argument, evaluated where the call is written.
          const call = g.nodes.get(node.module)!
          const { value, pos, file } = node.arg
          values.set(addr, evalAt(node, pos, () => evalExpr(value, scopeFor({}, call.module ? `${call.module}.` : '')), `module "${call.local.slice('module.'.length)}"`, file))
        } else if (!node.module && Object.hasOwn(input.vars, name)) values.set(addr, input.vars[name])
        else if (def) values.set(addr, evalAt(node, def.pos, () => evalExpr(def.value, scopeFor({}, mod)), context))
        else {
          fail(node.file, node.pos, 'No value for required variable', `The root module input variable "${name}" is not set, and has no default value. Use a -var or -var-file command line argument to provide a value for this variable.`, context)
          values.set(addr, UNKNOWN)
        }
        break
      }
      case 'local':
        values.set(addr, evalAt(node, node.pos, () => evalExpr(node.value!, scopeFor({}, node.module ? `${node.module}.` : '')), 'locals'))
        break
      case 'data': {
        const [type, name] = b!.labels
        values.set(addr, base.resources.find((r) => r.mode === 'data' && (r.module ?? '') === node.module && r.type === type && r.name === name)?.instances[0]?.attributes ?? UNKNOWN)
        break
      }
      case 'module': {
        const context = `module "${b!.labels[0]}"`
        if (node.module) fail(node.file, node.pos, 'Unsupported', 'Nested modules are not supported by this lab yet.', context)
        else if (!node.child) fail(node.file, node.pos, 'Unsupported module', 'Module calls are not supported by this lab yet.', context)
        else for (const a of b!.attrs) if (a.name === 'count' || a.name === 'for_each') fail(node.file, a.pos, 'Unsupported', 'Module count and for_each are not supported by this lab yet.', context)
        values.set(addr, UNKNOWN)
        break
      }
      case 'output': {
        const value = b!.attrs.find((a) => a.name === 'value')
        const sensitive = b!.attrs.find((a) => a.name === 'sensitive')
        const octx = `output "${b!.labels[0]}"`
        if (!value) fail(node.file, node.pos, 'Missing required argument', 'The argument "value" is required, but no definition was found.', octx)
        const v = value ? evalAt(node, value.pos, () => evalExpr(value.value, scopeFor({}, node.module ? `${node.module}.` : '')), octx) : null
        values.set(addr, v)
        if (!node.module) result.outputs.push({ name: b!.labels[0], value: v, sensitive: sensitive?.value.kind === 'lit' && sensitive.value.value === true })
        break
      }
      case 'resource':
        planResource(node)
        break
    }
    if (errors.length > errorsBefore) broken.add(addr)
  }

  if (errors.length) {
    result.items = []
    result.outputs = []
    return result
  }

  // In state but no longer configured (or a count/for_each instance that went away).
  const planned = new Set(result.items.map((i) => i.address))
  // Instance-level checks need the expansion, so they run after the walk.
  for (const m of mv.moves) {
    const still = m.from.key === undefined && m.to.key === undefined ? declared(m.from) : planned.has(show(m.from))
    if (still) fail(m.file, m.pos, 'Moved object still exists', `This statement declares that ${show(m.from)} was moved to ${show(m.to)}, but ${show(m.from)} is still declared in the configuration.`)
  }
  for (const i of imports) {
    if (declared(i.to) && !planned.has(show(i.to))) fail(i.file, i.pos, NO_IMPORT_CONFIG, noImportConfigDetail(show(i.to)))
  }
  for (const r of base.resources) {
    if (r.mode !== 'managed') continue
    const schema = schemaFor(r.type)
    for (const inst of r.instances) {
      const address = instanceAddress(r, inst.index_key)
      if (planned.has(address) || consumed.has(address)) continue
      if (!r.module && rm.removals.some((x) => x.from.type === r.type && x.from.name === r.name && !x.destroy)) {
        result.items.push({ address, module: r.module ?? '', resource: `${r.type}.${r.name}`, type: r.type, name: r.name, key: inst.index_key, action: 'forget', changes: [], dependsOn: inst.dependencies ?? [], unchanged: Object.fromEntries(Object.entries(inst.attributes).filter(([, v]) => v !== null)) })
        continue
      }
      const rk = resKey({ module: r.module, type: r.type, name: r.name })
      // The module instance itself is gone: no such call, or a keyed instance of a call that is not repeated.
      const steps = stepsOf(r.module)
      const moduleGone = steps.length > 0 && (steps.some((x) => x.key !== undefined) || !g.nodes.get(staticModule(r.module!))?.child)
      result.items.push({
        address,
        module: r.module ?? '',
        resource: `${r.type}.${r.name}`,
        type: r.type,
        name: r.name,
        key: inst.index_key,
        action: 'destroy',
        dependsOn: inst.dependencies ?? [],
        destroyReason: moduleGone ? 'module-gone' : !g.nodes.has(rk) ? 'not-in-config' : wrongRepetition(inst.index_key, shapes.get(rk)),
        changes: destroyChanges(schema, inst.attributes),
      })
    }
  }
  // Real Terraform only warns when a keyless address names a count/for_each resource.
  for (const a of new Set(input.replace ?? [])) {
    if (a.includes('[') || !shapes.has(a)) continue
    const addrs = result.items.filter((i) => i.action !== 'destroy' && resKey(i) === a).map((i) => i.address)
    const P = `Your force-replace request for ${a} doesn't match any resource instances`
    const detail = !addrs.length
      ? `${P} because this resource doesn't have any instances.`
      : addrs.length === 1
        ? `${P} because it lacks an instance key.\n\nTo force replacement of the single declared instance, use the following option instead:\n  -replace="${addrs[0]}"`
        : `${P} because it lacks an instance key.\n\nTo force replacement of particular instances, use one or more of the following options instead:${addrs.map((x) => `\n  -replace="${x}"`).join('')}`
    result.warnings.push({
      severity: 'warning',
      summary: 'Incompletely-matched force-replace resource instance',
      detail,
      file: '',
      line: 0,
      col: 0,
    })
  }
  // prevent_destroy fails a resource after its changes are planned. Terraform
  // skips everything downstream of a failed resource (no changes, no errors)
  // and shows the rest as a partial plan ahead of the errors.
  // ponytail: moved/import check errors above keep the old errors-only output; real Terraform would show a partial plan there too.
  const checked = errors.length > 0
  const res = resKey
  const guarded = (i: PlanItem) => protectedBy.has(res(i)) && (i.action === 'destroy' || i.action === 'replace')
  const failing = new Set(result.items.filter(guarded).map(res))
  const skipped = new Set<string>()
  if (!checked) for (const a of g.order) if (g.nodes.get(a)!.deps.some((d) => failing.has(d) || skipped.has(d))) skipped.add(a)
  for (const i of result.items) {
    const guard = protectedBy.get(res(i))
    if (guard && guarded(i) && !skipped.has(res(i))) fail(guard.file, guard.pos, ...preventDestroyError(i.address), guard.context)
  }
  if (checked) {
    result.items = []
    result.outputs = []
    return result
  }
  if (errors.length) {
    result.partial = true
    result.items = result.items.filter((i) => !skipped.has(res(i)))
    result.outputs = result.outputs.filter((o) => !skipped.has(`output.${o.name}`))
  }
  result.items.sort(byInstance)
  result.outputs.sort(byName)
  result.imported = result.items.filter((i) => i.importing !== undefined).length
  for (const i of result.items) {
    if (i.action === 'create' || i.action === 'replace') result.summary.add++
    if (i.action === 'update') result.summary.change++
    if (i.action === 'destroy' || i.action === 'replace') result.summary.destroy++
  }
  result.driftShown = relevantDrift(g.nodes, result, drift)
  return result
}

// Resources a node depends on, followed through locals, outputs, variables and data sources.
function resourceDeps(nodes: Map<string, GNode>, node: GNode): string[] {
  const found = new Set<string>()
  const seen = new Set<string>()
  for (const todo = [...node.deps]; todo.length; ) {
    const a = todo.pop()!
    if (seen.has(a)) continue
    seen.add(a)
    const n = nodes.get(a)
    if (!n) continue
    if (n.kind === 'resource') found.add(a)
    else todo.push(...n.deps)
  }
  found.delete(node.address)
  return [...found].sort()
}
const destroyChanges = (schema: ResourceSchema | undefined, attrs: Record<string, Value>): AttrChange[] =>
  Object.entries(attrs)
    .map(([name, before]) => ({ name, before, after: null, forcesReplacement: false, sensitive: !!(schema && Object.hasOwn(schema.attrs, name) && schema.attrs[name].sensitive) }))
    .sort(byName)
const preventDestroyError = (address: string): [string, string] => [
  'Instance cannot be destroyed',
  `Resource ${address} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.`,
]

// plan -destroy: every managed instance in the (refreshed, moved) state goes,
// data sources are dropped from state, and every output is removed. The
// configuration is consulted only for dependencies, block positions and
// prevent_destroy; no argument is evaluated, so unset variables don't matter.
function planDestroy(nodes: Map<string, GNode>, result: PlanResult, fail: (file: string, pos: Pos, summary: string, detail: string, context?: string) => void): PlanResult {
  const base = { ...result.baseState, resources: result.baseState.resources.filter((r) => r.mode === 'managed') }
  result.baseState = base
  // Destroying a resource waits for the destroys of what state says depends on
  // it, so when a protected resource fails, Terraform never plans the
  // resources it depends on (directly or not): no changes, no errors.
  const res = (r: { type: string; name: string; module?: string }) => staticKey({ module: stepsOf(r.module), mode: 'managed', type: r.type, name: r.name })
  const deps = new Map(base.resources.map((r) => [res(r), r.instances.flatMap((i) => i.dependencies ?? [])]))
  const lifecycle = (r: { type: string; name: string; module?: string }) => {
    const node = nodes.get(res(r))
    return node?.kind === 'resource' && node.block ? lifecycleOf(node.block) : undefined
  }
  const configError = base.resources.some((r) => lifecycle(r)?.ok === false)
  const skipped = new Set<string>()
  const protects = (r: { type: string; name: string; module?: string }) => {
    const lc = lifecycle(r)
    return lc?.ok === true && lc.lifecycle.preventDestroy
  }
  const failing = configError ? [] : base.resources.filter((r) => r.instances.length > 0 && protects(r))
  for (const todo = failing.flatMap((r) => deps.get(res(r))!); todo.length; ) {
    const a = todo.pop()!
    if (!skipped.has(a)) todo.push(...(deps.get(a) ?? []))
    skipped.add(a)
  }
  for (const r of base.resources) {
    const node = nodes.get(res(r))
    const b = node?.kind === 'resource' ? node.block : undefined
    const lc = b && lifecycleOf(b)
    const context = `resource "${r.type}" "${r.name}"`
    if (lc && !lc.ok) fail(node!.file, lc.pos, lc.summary, lc.detail, context)
    if (skipped.has(res(r))) continue
    for (const inst of r.instances) {
      const address = instanceAddress(r, inst.index_key)
      if (lc?.ok && lc.lifecycle.preventDestroy) fail(node!.file, b!.pos, ...preventDestroyError(address), context)
      result.items.push({
        address,
        module: r.module ?? '',
        resource: `${r.type}.${r.name}`,
        type: r.type,
        name: r.name,
        key: inst.index_key,
        action: 'destroy',
        dependsOn: b ? resourceDeps(nodes, node!) : (inst.dependencies ?? []),
        ...(b ? { block: { file: node!.file, line: b.pos.line, col: b.pos.col } } : {}),
        changes: destroyChanges(schemaFor(r.type), inst.attributes),
      })
    }
  }
  if (configError) {
    result.items = []
    return result
  }
  if (result.diagnostics.length) result.partial = true
  result.items.sort(byInstance)
  result.summary.destroy = result.items.length
  result.driftShown = relevantDrift(nodes, result, result.drift)
  return result
}

// Terraform reports drift only for objects that something changing in this plan
// refers to (directly or through other values), and only the attributes it
// refers to. What a changing resource's own configuration points at counts; the
// resource itself does not.
function relevantDrift(nodes: Map<string, GNode>, result: PlanResult, drift: Drift[]): Drift[] {
  const before = result.refreshed.outputs
  const start = [
    ...result.items.filter((i) => i.action !== 'noop').map(resKey),
    ...result.outputs.filter((o) => !(Object.hasOwn(before, o.name) && equal(before[o.name].value, o.value))).map((o) => `output.${o.name}`),
  ]
  const seen = new Set<string>()
  const refd = new Map<string, Set<string> | 'all'>()
  for (const todo = [...start]; todo.length; ) {
    const node = nodes.get(todo.pop()!)
    if (!node || seen.has(node.address)) continue
    seen.add(node.address)
    todo.push(...node.deps)
    for (const { path, scope } of node.refs) {
      const key = `${scope ?? (node.module ? `${node.module}.` : '')}${path[0]}.${path[1]}`
      if (nodes.get(key)?.kind !== 'resource') continue
      const have = refd.get(key)
      if (path.length < 3) refd.set(key, 'all')
      else if (have !== 'all') refd.set(key, (have ?? new Set<string>()).add(path[2]))
    }
  }
  return drift.flatMap((d): Drift[] => {
    const a = parseResAddr(d.address)
    const want = a && refd.get(staticKey(a))
    if (d.kind === 'deleted') return want === undefined ? [] : [{ ...d, relevant: want === 'all' ? 'all' : [...want] }]
    if (want === undefined) return []
    const changes = want === 'all' ? d.changes : d.changes.filter((c) => want.has(c.name))
    return changes.length ? [{ ...d, changes }] : []
  })
}
