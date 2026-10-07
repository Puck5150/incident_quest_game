// The plan: refresh state against the cloud, walk the configuration in
// dependency order, plan each resource instance from its evaluated arguments
// and the planned values of what it depends on, then plan destroys for
// instances that are no longer configured. Any configuration error stops the
// plan: nothing is half-planned.
import { lifecycleOf, resourceArguments } from './arguments.ts'
import { evalExpr, EvalError, isUnknown, UNKNOWN, type Scope, type Value } from './eval.ts'
import { expandInstances, type Key } from './expand.ts'
import { buildGraph, type GNode } from './graph.ts'
import { refresh as refreshState, type Drift, type Reality } from './refresh.ts'
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
}
export interface PlanItem {
  address: string
  type: string
  name: string
  key?: string | number
  action: Action | 'destroy'
  changes: AttrChange[]
}
export interface PlanOutput {
  name: string
  value: Value
  sensitive: boolean
}
export interface PlanResult {
  diagnostics: Diagnostic[]
  drift: Drift[]
  items: PlanItem[]
  outputs: PlanOutput[]
  refreshed: State
  summary: { add: number; change: number; destroy: number }
}

const byAddress = (a: PlanItem, b: PlanItem) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)
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
  const { state: refreshed, drift } = input.refresh === false ? { state: input.state, drift: [] as Drift[] } : refreshState(input.state, input.reality)
  const result: PlanResult = { diagnostics: [...g.diagnostics], drift, items: [], outputs: [], refreshed, summary: { add: 0, change: 0, destroy: 0 } }
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
      const prior = findInstance(refreshed, address)?.instance.attributes
      const p = diffInstance(schema, ar.args, prior, lc.lifecycle.ignoreChanges)
      result.items.push({ address, type, name, key, action: p.action, changes: p.changes })
      planned.set(key, complete(p.planned, schema))
    }
    if (failed) return
    values.set(
      node.address,
      ex.kind === 'count' ? ex.keys.map((k) => planned.get(k)!) : ex.kind === 'for_each' ? Object.fromEntries(ex.keys.map((k): [string, Value] => [k as string, planned.get(k)!])) : planned.get(undefined)!,
    )
  }

  for (const addr of g.order) {
    const node = g.nodes.get(addr)!
    const b = node.block
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
        values.set(addr, evalAt(node, node.pos, () => evalExpr(node.value!, scopeFor({}))))
        break
      case 'data': {
        const [type, name] = b!.labels
        values.set(addr, refreshed.resources.find((r) => r.mode === 'data' && r.type === type && r.name === name)?.instances[0]?.attributes ?? UNKNOWN)
        break
      }
      case 'module':
        fail(node.file, node.pos, 'Unsupported module', 'Module calls are not supported by this lab yet.', `module "${b!.labels[0]}"`)
        values.set(addr, UNKNOWN)
        break
      case 'output': {
        const value = b!.attrs.find((a) => a.name === 'value')
        const sensitive = b!.attrs.find((a) => a.name === 'sensitive')
        const v = value ? evalAt(node, value.pos, () => evalExpr(value.value, scopeFor({})), `output "${b!.labels[0]}"`) : null
        result.outputs.push({ name: b!.labels[0], value: v, sensitive: sensitive?.value.kind === 'lit' && sensitive.value.value === true })
        break
      }
      case 'resource':
        planResource(node)
        break
    }
  }

  if (errors.length) {
    result.items = []
    result.outputs = []
    return result
  }

  // In state but no longer configured (or a count/for_each instance that went away).
  const planned = new Set(result.items.map((i) => i.address))
  for (const r of refreshed.resources) {
    if (r.mode !== 'managed') continue
    const schema = schemaFor(r.type)
    for (const inst of r.instances) {
      const address = instanceAddress(r, inst.index_key)
      if (planned.has(address)) continue
      result.items.push({
        address,
        type: r.type,
        name: r.name,
        key: inst.index_key,
        action: 'destroy',
        changes: Object.entries(inst.attributes)
          .map(([name, before]) => ({ name, before, after: null, forcesReplacement: false, sensitive: !!(schema && Object.hasOwn(schema.attrs, name) && schema.attrs[name].sensitive) }))
          .sort(byName),
      })
    }
  }
  result.items.sort(byAddress)
  result.outputs.sort(byName)
  for (const i of result.items) {
    if (i.action === 'create' || i.action === 'replace') result.summary.add++
    if (i.action === 'update') result.summary.change++
    if (i.action === 'destroy' || i.action === 'replace') result.summary.destroy++
  }
  return result
}
