// The plan: refresh state against the cloud, walk the configuration in
// dependency order, plan each resource instance from its evaluated arguments
// and the planned values of what it depends on, then plan destroys for
// instances that are no longer configured. Any configuration error stops the
// plan: nothing is half-planned.
import { lifecycleOf, resourceArguments } from './arguments.ts'
import { importsOf, removedOf } from './declarations.ts'
import { evalExpr, EvalError, isUnknown, UNKNOWN, type Scope, type Value } from './eval.ts'
import { expandInstances, type Key } from './expand.ts'
import { buildGraph, type GNode } from './graph.ts'
import { applyMoves, movesOf } from './moves.ts'
import { realityKey, refresh as refreshState, type Drift, type Reality } from './refresh.ts'
import { diffInstance, schemaFor, unsupportedType, type Action, type AttrChange, type ResourceSchema } from './resources.ts'
import { findInstance, instanceAddress, type State } from './state.ts'
import type { Diagnostic, Pos } from './types.ts'

export interface PlanInput {
  files: { name: string; text: string }[]
  state: State
  reality: Reality
  vars: Record<string, Value>
  workspace?: string
  refresh?: boolean
  replace?: string[]
}
export interface PlanItem {
  address: string
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
  destroyReason?: 'not-in-config' | 'count-index' | 'for-each-key'
}
export interface PlanOutput {
  name: string
  value: Value
  sensitive: boolean
}
export interface PlanResult {
  diagnostics: Diagnostic[]
  warnings: Diagnostic[]
  drift: Drift[]
  items: PlanItem[]
  outputs: PlanOutput[]
  refreshed: State
  summary: { add: number; change: number; destroy: number }
  imported: number
}

const cmp = <T extends string | number>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0)
// Terraform's order: type, then name, then key (none first, numbers numerically, strings lexically).
const keyRank = (k: Key) => (k === undefined ? 0 : typeof k === 'number' ? 1 : 2)
const byInstance = (a: PlanItem, b: PlanItem) =>
  cmp(a.type, b.type) || cmp(a.name, b.name) || cmp(keyRank(a.key), keyRank(b.key)) || (a.key === undefined || b.key === undefined ? 0 : cmp(a.key, b.key))
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
  const g = buildGraph(input.files)
  const { state: refreshed, drift } = input.refresh === false ? { state: structuredClone(input.state), drift: [] as Drift[] } : refreshState(input.state, input.reality)
  const result: PlanResult = { diagnostics: [...g.diagnostics], warnings: [], drift, items: [], outputs: [], refreshed, summary: { add: 0, change: 0, destroy: 0 }, imported: 0 }
  if (g.diagnostics.length) return result

  const errors = result.diagnostics
  const values = new Map<string, Value>()
  const shapes = new Map<string, 'count' | 'for_each'>()
  const val = (k: string): Value => (values.has(k) ? values.get(k)! : UNKNOWN)
  const fail = (file: string, pos: Pos, summary: string, detail: string, context?: string) =>
    errors.push({ severity: 'error', summary, detail, file, line: pos.line, col: pos.col, context })
  const evalAt = (node: GNode, pos: Pos, fn: () => Value, context?: string): Value => {
    try {
      return fn()
    } catch (e) {
      if (!(e instanceof EvalError)) throw e
      fail(node.file, pos, e.summary, e.detail, context)
      return UNKNOWN
    }
  }

  // moved / removed / import: statements about state.
  const mv = movesOf(g.blocks)
  const rm = removedOf(g.blocks)
  const im = importsOf(g.blocks)
  errors.push(...mv.diagnostics, ...rm.diagnostics, ...im.diagnostics)
  const declared = (a: { type: string; name: string }) => g.nodes.has(`${a.type}.${a.name}`)
  const show = (a: { type: string; name: string; key?: string | number }) => instanceAddress({ mode: 'managed', type: a.type, name: a.name }, a.key)
  for (const r of rm.removals) {
    if (declared(r.from)) fail(r.file, r.pos, 'Removed resource still exists', `This statement declares that ${show(r.from)} was removed, so it should no longer be declared in the configuration, but the resource is still declared.`)
  }
  for (const i of im.imports) {
    if (!declared(i.to)) fail(i.file, i.pos, 'Configuration for import target does not exist', `The configuration for the given import target ${show(i.to)} does not exist. All target instances must have an associated configuration to be imported.`)
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

  const scopeFor = (ctx: { each?: { key: Value; value: Value }; count?: number }): Scope => ({
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
          return walk({ module: '.', root: '.', cwd: '.' }, path.slice(1))
        case 'terraform':
          return walk({ workspace: input.workspace ?? 'default' }, path.slice(1))
        case 'var':
        case 'local':
          return walk(val(`${root}.${a}`), path.slice(2))
        case 'data':
          return walk(val(`data.${a}.${b}`), path.slice(3))
        case 'module':
          return UNKNOWN
        default: {
          const addr = `${root}.${a}`
          const shape = shapes.get(addr)
          if (shape && path.length > 2) {
            throw new EvalError(
              'Missing resource instance key',
              `Because ${addr} has "${shape}" set, its attributes must be accessed on specific instances.\n\nFor example, to correlate with indices of a referring resource, use:\n    ${addr}[${shape === 'count' ? 'count.index' : 'each.key'}]`,
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
    const ex = expandInstances(b, scopeFor({}))
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
    if (lc.lifecycle.preventDestroy) protectedBy.set(`${type}.${name}`, { file: node.file, pos: b.pos, context })
    const planned = new Map<Key, Value>()
    let failed = false
    for (const key of ex.keys) {
      const ctx = ex.kind === 'count' ? { count: key as number } : ex.kind === 'for_each' ? { each: ex.each(key as string) } : {}
      const ar = resourceArguments(b, scopeFor(ctx))
      if (!ar.ok) {
        fail(node.file, ar.pos, ar.summary, ar.detail, context)
        failed = true
        continue
      }
      const address = instanceAddress({ mode: 'managed', type, name }, key)
      let priorInst = findInstance(base, address)?.instance
      let movedFrom: string | undefined = applied.moved.get(address)
      // Adding or removing `count = 1` moves the lone instance between `x` and `x[0]` (Terraform 1.1+).
      if (!priorInst && ex.kind !== 'for_each' && (key === 0 || key === undefined)) {
        const old = instanceAddress({ mode: 'managed', type, name }, key === 0 ? undefined : 0)
        const found = findInstance(base, old)
        if (found) {
          priorInst = found.instance
          movedFrom = applied.moved.get(old) ?? old
          consumed.add(old)
        }
      }
      let importing: string | undefined
      const decl = im.imports.find((d) => d.to.type === type && d.to.name === name && d.to.key === key)
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
              'Cannot import non-existent remote object',
              `While attempting to import an existing object to "${address}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.`,
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
      const triggers = prior ? lc.lifecycle.replaceTriggeredBy.filter((a) => touched.get(a)?.has('update') || touched.get(a)?.has('replace')) : []
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
        type,
        name,
        key,
        action: p.action,
        changes: p.changes,
        ...(movedFrom ? { movedFrom } : {}),
        ...(importing ? { importing } : {}),
        ...(reason ? { reason } : {}),
        ...(unchanged ? { unchanged } : {}),
        ...(reason === 'triggered' ? { triggeredBy: [triggers[0]] } : {}),
        ...(p.action === 'replace' && lc.lifecycle.createBeforeDestroy ? { createBeforeDestroy: true } : {}),
      })
      const seen = touched.get(`${type}.${name}`) ?? new Set<string>()
      touched.set(`${type}.${name}`, seen.add(p.action))
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
        if (Object.hasOwn(input.vars, name)) values.set(addr, input.vars[name])
        else if (def) values.set(addr, evalAt(node, def.pos, () => evalExpr(def.value, scopeFor({})), context))
        else {
          fail(node.file, node.pos, 'No value for required variable', `The root module input variable "${name}" is not set, and has no default value. Use a -var or -var-file command line argument to provide a value for this variable.`, context)
          values.set(addr, UNKNOWN)
        }
        break
      }
      case 'local':
        values.set(addr, evalAt(node, node.pos, () => evalExpr(node.value!, scopeFor({})), 'locals'))
        break
      case 'data': {
        const [type, name] = b!.labels
        values.set(addr, base.resources.find((r) => r.mode === 'data' && r.type === type && r.name === name)?.instances[0]?.attributes ?? UNKNOWN)
        break
      }
      case 'module':
        fail(node.file, node.pos, 'Unsupported module', 'Module calls are not supported by this lab yet.', `module "${b!.labels[0]}"`)
        values.set(addr, UNKNOWN)
        break
      case 'output': {
        const value = b!.attrs.find((a) => a.name === 'value')
        const sensitive = b!.attrs.find((a) => a.name === 'sensitive')
        const octx = `output "${b!.labels[0]}"`
        if (!value) fail(node.file, node.pos, 'Missing required argument', 'The argument "value" is required, but no definition was found.', octx)
        const v = value ? evalAt(node, value.pos, () => evalExpr(value.value, scopeFor({})), octx) : null
        result.outputs.push({ name: b!.labels[0], value: v, sensitive: sensitive?.value.kind === 'lit' && sensitive.value.value === true })
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
  for (const i of im.imports) {
    if (declared(i.to) && !planned.has(show(i.to))) fail(i.file, i.pos, 'Configuration for import target does not exist', `The configuration for the given import target ${show(i.to)} does not exist. All target instances must have an associated configuration to be imported.`)
  }
  for (const r of base.resources) {
    if (r.mode !== 'managed') continue
    const schema = schemaFor(r.type)
    for (const inst of r.instances) {
      const address = instanceAddress(r, inst.index_key)
      if (planned.has(address) || consumed.has(address)) continue
      if (rm.removals.some((x) => x.from.type === r.type && x.from.name === r.name && !x.destroy)) {
        result.items.push({ address, type: r.type, name: r.name, key: inst.index_key, action: 'forget', changes: [] })
        continue
      }
      result.items.push({
        address,
        type: r.type,
        name: r.name,
        key: inst.index_key,
        action: 'destroy',
        destroyReason: !g.nodes.has(`${r.type}.${r.name}`) ? 'not-in-config' : typeof inst.index_key === 'number' ? 'count-index' : typeof inst.index_key === 'string' ? 'for-each-key' : 'not-in-config',
        changes: Object.entries(inst.attributes)
          .map(([name, before]) => ({ name, before, after: null, forcesReplacement: false, sensitive: !!(schema && Object.hasOwn(schema.attrs, name) && schema.attrs[name].sensitive) }))
          .sort(byName),
      })
    }
  }
  // Real Terraform only warns when a keyless address names a count/for_each resource.
  for (const a of new Set(input.replace ?? [])) {
    if (a.includes('[') || !shapes.has(a)) continue
    const addrs = result.items.filter((i) => i.action !== 'destroy' && `${i.type}.${i.name}` === a).map((i) => i.address)
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
  for (const i of result.items) {
    const guard = protectedBy.get(`${i.type}.${i.name}`)
    if (guard && (i.action === 'destroy' || i.action === 'replace')) {
      fail(
        guard.file,
        guard.pos,
        'Instance cannot be destroyed',
        `Resource ${i.address} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.`,
        guard.context,
      )
    }
  }
  if (errors.length) {
    result.items = []
    result.outputs = []
    return result
  }
  result.items.sort(byInstance)
  result.outputs.sort(byName)
  result.imported = result.items.filter((i) => i.importing !== undefined).length
  for (const i of result.items) {
    if (i.action === 'create' || i.action === 'replace') result.summary.add++
    if (i.action === 'update') result.summary.change++
    if (i.action === 'destroy' || i.action === 'replace') result.summary.destroy++
  }
  return result
}
