// The resource graph: which configuration objects exist, what each refers to,
// the order they can be applied in, and whether that order is possible.
import { parseAddress } from './addresses.ts'
import { parseHcl } from './parse.ts'
import type { Block, Diagnostic, Expr, Pos } from './types.ts'

export type NodeKind = 'resource' | 'data' | 'variable' | 'local' | 'output' | 'module'
export interface Ref {
  path: string[]
  pos: Pos
}
export interface GNode {
  address: string
  kind: NodeKind
  file: string
  pos: Pos
  block?: Block // not set for locals
  value?: Expr // set for locals
  refs: Ref[]
  deps: string[]
}
export interface Graph {
  nodes: Map<string, GNode>
  blocks: Block[] // every parsed top-level block, in file order
  order: string[] // dependencies before dependents; empty when a cycle makes ordering impossible
  diagnostics: Diagnostic[]
}

function exprRefs(e: Expr, out: Ref[]): void {
  switch (e.kind) {
    case 'lit':
      return
    case 'tmpl':
      for (const p of e.parts) if (typeof p !== 'string') exprRefs(p, out)
      return
    case 'ref':
      out.push({ path: e.path, pos: e.pos })
      return
    case 'attr':
      exprRefs(e.base, out)
      return
    case 'idx':
      exprRefs(e.base, out)
      exprRefs(e.index, out)
      return
    case 'call':
      for (const a of e.args) exprRefs(a, out)
      return
    case 'list':
      for (const a of e.items) exprRefs(a, out)
      return
    case 'obj':
      for (const en of e.entries) {
        exprRefs(en.key, out)
        exprRefs(en.value, out)
      }
      return
    case 'cond':
      exprRefs(e.test, out)
      exprRefs(e.yes, out)
      exprRefs(e.no, out)
      return
    case 'bin':
      exprRefs(e.left, out)
      exprRefs(e.right, out)
      return
    case 'un':
      exprRefs(e.expr, out)
  }
}

// provider/providers name a provider configuration; ignore_changes names
// attributes. Neither is a reference to another object.
function blockRefs(b: Block, out: Ref[], top: boolean): void {
  if (b.type === 'dynamic') {
    // The iterator (default: the block label) is local to the dynamic block, not an object.
    const it = b.attrs.find((a) => a.name === 'iterator')?.value
    const name = it?.kind === 'ref' ? it.path[0] : b.labels[0]
    const inner: Ref[] = []
    for (const a of b.attrs) if (a.name !== 'iterator') exprRefs(a.value, inner)
    for (const n of b.blocks) blockRefs(n, inner, false)
    out.push(...inner.filter((r) => r.path[0] !== name))
    return
  }
  for (const a of b.attrs) {
    if (top && (a.name === 'provider' || a.name === 'providers')) continue
    if (b.type === 'lifecycle' && a.name === 'ignore_changes') continue
    if (top && b.type === 'variable' && a.name === 'type') continue // a type expression, not references
    exprRefs(a.value, out)
  }
  for (const n of b.blocks) blockRefs(n, out, false)
}

const DECL: Record<string, [NodeKind, number]> = {
  resource: ['resource', 2],
  data: ['data', 2],
  variable: ['variable', 1],
  output: ['output', 1],
  module: ['module', 1],
}
const PREFIX: Record<NodeKind, string> = { resource: '', data: 'data.', variable: 'var.', local: 'local.', output: 'output.', module: 'module.' }
const SPECIAL = new Set(['each', 'count', 'self', 'path', 'terraform'])

type Resolved = { want: string } | { summary: string; detail: string } | undefined

function resolve(path: string[]): Resolved {
  const [a, b, c] = path
  if (SPECIAL.has(a)) return undefined
  if (a === 'var' || a === 'local' || a === 'module') {
    if (!b) return { summary: 'Invalid reference', detail: `The "${a}" object must be followed by a name.` }
    return { want: `${a}.${b}` }
  }
  if (a === 'data') {
    if (!c) return { summary: 'Invalid reference', detail: 'A reference to a data source must be followed by the data source type and name.' }
    return { want: `data.${b}.${c}` }
  }
  if (!b) return { summary: 'Invalid reference', detail: 'A reference to a resource type must be followed by at least one attribute access, specifying the resource name.' }
  return { want: `${a}.${b}` }
}

function missing(path: string[]): { summary: string; detail: string } {
  const [a, b, c] = path
  if (a === 'var') return { summary: 'Reference to undeclared input variable', detail: `An input variable with the name "${b}" has not been declared. This variable can be declared with a variable "${b}" {} block.` }
  if (a === 'local') return { summary: 'Reference to undeclared local value', detail: `A local value with the name "${b}" has not been declared.` }
  if (a === 'module') return { summary: 'Reference to undeclared module', detail: `No module call named "${b}" is declared in the root module.` }
  if (a === 'data') return { summary: 'Reference to undeclared resource', detail: `A data resource "${b}" "${c}" has not been declared in the root module.` }
  return { summary: 'Reference to undeclared resource', detail: `A managed resource "${a}" "${b}" has not been declared in the root module.` }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

function duplicate(prev: GNode, address: string, kind: NodeKind, file: string, pos: Pos): Diagnostic {
  const at = `${prev.file}:${prev.pos.line},${prev.pos.col}`
  const [type, name] = address.replace(/^data\./, '').split('.')
  const mk = (summary: string, detail: string): Diagnostic => ({ severity: 'error', summary, detail, file, line: pos.line, col: pos.col })
  if (kind === 'resource') return mk(`Duplicate resource "${type}" configuration`, `A ${type} resource named "${name}" was already declared at ${at}. Resource names must be unique per type in each module.`)
  if (kind === 'data') return mk(`Duplicate data "${type}" configuration`, `A ${type} data resource named "${name}" was already declared at ${at}. Resource names must be unique per type in each module.`)
  const word = kind === 'variable' ? 'variable' : kind === 'local' ? 'local value' : kind
  return mk(`Duplicate ${word} ${kind === 'local' ? 'definition' : 'declaration'}`, `A ${word} named "${name}" was already declared at ${at}. ${cap(word)} names must be unique within a module.`)
}

export function buildGraph(files: { name: string; text: string }[]): Graph {
  const diagnostics: Diagnostic[] = []
  const blocks: Block[] = []
  for (const f of files) {
    const r = parseHcl(f.name, f.text)
    blocks.push(...r.blocks)
    diagnostics.push(...r.diagnostics)
  }

  const nodes = new Map<string, GNode>()
  const put = (address: string, kind: NodeKind, file: string, pos: Pos, refs: Ref[], block?: Block, value?: Expr) => {
    const prev = nodes.get(address)
    if (prev) diagnostics.push(duplicate(prev, address, kind, file, pos))
    else nodes.set(address, { address, kind, file, pos, block, value, refs, deps: [] })
  }

  for (const b of blocks) {
    if (b.type === 'locals') {
      for (const a of b.attrs) {
        const refs: Ref[] = []
        exprRefs(a.value, refs)
        put(`local.${a.name}`, 'local', b.file, a.pos, refs, undefined, a.value)
      }
      continue
    }
    const d = DECL[b.type]
    if (!d) continue // provider, terraform, moved, import, removed: not graph nodes
    const [kind, n] = d
    if (b.labels.length !== n) {
      diagnostics.push({ severity: 'error', summary: `Invalid ${b.type} block`, detail: `A ${b.type} block requires exactly ${n} label${n > 1 ? 's' : ''}.`, file: b.file, line: b.pos.line, col: b.pos.col })
      continue
    }
    const refs: Ref[] = []
    blockRefs(b, refs, true)
    put(PREFIX[kind] + b.labels.join('.'), kind, b.file, b.pos, refs, b)
  }

  // An import block's id may use variables and locals, so its target resource depends on them.
  for (const b of blocks) {
    if (b.type !== 'import') continue
    const to = b.attrs.find((a) => a.name === 'to')
    const id = b.attrs.find((a) => a.name === 'id')
    const addr = to && parseAddress(to.value)
    const node = addr && nodes.get(`${addr.type}.${addr.name}`)
    if (node && id) exprRefs(id.value, node.refs)
  }

  // Resolve references into dependencies.
  for (const node of [...nodes.values()].sort((x, y) => x.address.localeCompare(y.address))) {
    const deps = new Set<string>()
    for (const ref of node.refs) {
      const r = resolve(ref.path)
      if (!r) continue
      const bad = 'want' in r ? (nodes.has(r.want) ? undefined : missing(ref.path)) : r
      if (bad) diagnostics.push({ severity: 'error', ...bad, file: node.file, line: ref.pos.line, col: ref.pos.col })
      else if ('want' in r && !(node.kind === 'variable' && r.want === node.address)) deps.add(r.want) // validation may read its own variable
    }
    node.deps = [...deps].sort()
  }

  // Order dependencies first; what can't be ordered is in, or after, a cycle.
  const left = new Map<string, number>()
  const users = new Map<string, string[]>()
  for (const node of nodes.values()) {
    left.set(node.address, node.deps.length)
    for (const d of node.deps) users.set(d, [...(users.get(d) ?? []), node.address])
  }
  const ready = [...nodes.keys()].filter((a) => left.get(a) === 0)
  const order: string[] = []
  while (ready.length) {
    ready.sort()
    const a = ready.shift()!
    order.push(a)
    for (const u of users.get(a) ?? []) {
      const k = left.get(u)! - 1
      left.set(u, k)
      if (k === 0) ready.push(u)
    }
  }
  if (order.length < nodes.size) {
    const stuck = new Set([...nodes.keys()].filter((a) => !order.includes(a)))
    // Drop what merely waits on the cycle (nothing in the set depends on it).
    for (let changed = true; changed; ) {
      changed = false
      for (const a of stuck) {
        if (!(users.get(a) ?? []).some((u) => stuck.has(u))) {
          stuck.delete(a)
          changed = true
        }
      }
    }
    diagnostics.push({ severity: 'error', summary: `Cycle: ${[...stuck].sort().join(', ')}`, detail: '', file: '', line: 0, col: 0 })
    return { nodes, order: [], blocks, diagnostics }
  }
  return { nodes, order, blocks, diagnostics }
}
