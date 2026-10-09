// The resource graph: which configuration objects exist, what each refers to,
// the order they can be applied in, and whether that order is possible.
import { parseAddress } from './addresses.ts'
import { parseHcl } from './parse.ts'
import type { ModuleTree } from './modules.ts'
import type { Block, Diagnostic, Expr, Pos } from './types.ts'

export type NodeKind = 'resource' | 'data' | 'variable' | 'local' | 'output' | 'module'
export interface Ref {
  path: string[]
  pos: Pos
  file?: string // set when the reference lives in another block's file (import ids)
  scope?: string // module prefix ('module.net.') the path resolves in, when not the declaring module (call arguments)
}
export interface GNode {
  address: string // module-qualified: 'module.net.aws_vpc.main', 'module.net.var.cidr'
  module: string // static path of the declaring module ('' for the root, 'module.net'; a call node is declared by its parent)
  local: string // the address inside the declaring module ('aws_vpc.main', 'var.cidr', 'module.net')
  child?: string // call nodes only: the static path of the loaded module (equal to address); unset when no module files were supplied
  arg?: { value: Expr; pos: Pos; file: string } // module variables only: the call's argument, to be evaluated in the parent scope
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
      // module.net["a"].out: the attribute names the output, the index is its own expression
      if (e.base.kind === 'idx' && e.base.base.kind === 'ref' && e.base.base.path.length === 2 && e.base.base.path[0] === 'module') {
        out.push({ path: [...e.base.base.path, e.name], pos: e.base.base.pos })
        exprRefs(e.base.index, out)
        return
      }
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
// Arguments of a module call that are not inputs to the child's variables.
const CALL_META = new Set(['source', 'version', 'count', 'for_each', 'depends_on', 'providers'])

type Fail = { summary: string; detail: string }
type Resolved = { want: string } | Fail | undefined

// P is the module prefix of the scope the reference is written in: '' or 'module.net.'.
function resolve(path: string[], P: string): Resolved {
  const [a, b, c] = path
  if (SPECIAL.has(a)) return undefined
  if (a === 'var' || a === 'local' || a === 'module') {
    if (!b) return { summary: 'Invalid reference', detail: `The "${a}" object must be followed by a name.` }
    return { want: `${P}${a}.${b}` }
  }
  if (a === 'data') {
    if (!c) return { summary: 'Invalid reference', detail: 'A reference to a data source must be followed by the data source type and name.' }
    return { want: `${P}data.${b}.${c}` }
  }
  if (!b) return { summary: 'Invalid reference', detail: 'A reference to a resource type must be followed by at least one attribute access, specifying the resource name.' }
  return { want: `${P}${a}.${b}` }
}

// Real Terraform (evaluate_valid.go moduleConfigDisplayAddr): "the root module", or the module address.
function missing(path: string[], P: string): Fail {
  const [a, b, c] = path
  const where = P ? P.slice(0, -1) : 'the root module'
  if (a === 'var') return { summary: 'Reference to undeclared input variable', detail: `An input variable with the name "${b}" has not been declared. This variable can be declared with a variable "${b}" {} block.` }
  if (a === 'local') return { summary: 'Reference to undeclared local value', detail: `A local value with the name "${b}" has not been declared.` }
  if (a === 'module') return { summary: 'Reference to undeclared module', detail: `No module call named "${b}" is declared in ${where}.` }
  if (a === 'data') return { summary: 'Reference to undeclared resource', detail: `A data resource "${b}" "${c}" has not been declared in ${where}.` }
  return { summary: 'Reference to undeclared resource', detail: `A managed resource "${a}" "${b}" has not been declared in ${where}.` }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

function duplicate(prev: GNode, local: string, kind: NodeKind, file: string, pos: Pos): Diagnostic {
  const at = `${prev.file}:${prev.pos.line},${prev.pos.col}`
  const [type, name] = local.replace(/^data\./, '').split('.')
  const mk = (summary: string, detail: string): Diagnostic => ({ severity: 'error', summary, detail, file, line: pos.line, col: pos.col })
  if (kind === 'resource') return mk(`Duplicate resource "${type}" configuration`, `A ${type} resource named "${name}" was already declared at ${at}. Resource names must be unique per type in each module.`)
  if (kind === 'data') return mk(`Duplicate data "${type}" configuration`, `A ${type} data resource named "${name}" was already declared at ${at}. Resource names must be unique per type in each module.`)
  const word = kind === 'variable' ? 'variable' : kind === 'local' ? 'local value' : kind
  return mk(`Duplicate ${word} ${kind === 'local' ? 'definition' : 'declaration'}`, `A ${word} named "${name}" was already declared at ${at}. ${cap(word)} names must be unique within a module.`)
}

type File = { name: string; text: string }
interface Mod {
  path: string // static: '' or 'module.net'
  key: string // the manifest/tree key: '' or 'net' (nested: 'net.sub')
  files: File[]
  call?: Block // the declaring call block, in the parent
  blocks: Block[]
}

// A directory called from two places is walked twice: report each identical diagnostic once.
// Per-call diagnostics (missing/unsupported argument) sit at different call sites, so they stay per call.
function dedupe(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>()
  return list.filter((d) => {
    const k = JSON.stringify([d.file, d.line, d.col, d.summary, d.detail])
    return !seen.has(k) && (seen.add(k), true)
  })
}

// Accepts the root module's files alone (no module files are known, so a call stays one node), or a module tree.
export function buildGraph(input: File[] | ModuleTree): Graph {
  const tree: ModuleTree = Array.isArray(input) ? { root: { dir: '', files: input }, children: new Map() } : input
  const diagnostics: Diagnostic[] = []
  const blocks: Block[] = []

  // Parse the root, then the child modules its calls (transitively) name, in call order.
  const mods: Mod[] = []
  const parsed = new Set<string>()
  const queue: Mod[] = [{ path: '', key: '', files: tree.root.files, blocks: [] }]
  for (let i = 0; i < queue.length; i++) {
    const m = queue[i]
    for (const f of m.files) {
      const r = parseHcl(f.name, f.text)
      m.blocks.push(...r.blocks)
      // The same directory called twice parses twice: report each syntax error once.
      for (const d of r.diagnostics) {
        const k = `${d.file}:${d.line}:${d.col}:${d.summary}`
        if (!parsed.has(k)) diagnostics.push(d)
        parsed.add(k)
      }
    }
    blocks.push(...m.blocks)
    mods.push(m)
    const seen = new Set<string>()
    for (const b of m.blocks) {
      const name = b.type === 'module' && b.labels.length === 1 ? b.labels[0] : undefined
      if (name === undefined || seen.has(name)) continue
      seen.add(name)
      const key = m.key ? `${m.key}.${name}` : name
      const child = tree.children.get(key)
      if (child) queue.push({ path: m.path ? `${m.path}.module.${name}` : `module.${name}`, key, files: child.files.files, call: b, blocks: [] })
    }
  }
  // A syntax error in a module's files stops Terraform loading the configuration: nothing else is checked (its blocks are missing, which would only cascade).
  const rootNames = new Set(tree.root.files.map((f) => f.name))
  if (diagnostics.some((d) => !rootNames.has(d.file))) return { nodes: new Map(), order: [], blocks, diagnostics: dedupe(diagnostics) }
  const loaded = new Map(mods.filter((m) => m.call).map((m) => [m.path, m]))

  const nodes = new Map<string, GNode>()
  const put = (m: Mod, local: string, kind: NodeKind, file: string, pos: Pos, refs: Ref[], block?: Block, value?: Expr, extra?: Partial<GNode>) => {
    const address = m.path ? `${m.path}.${local}` : local
    const prev = nodes.get(address)
    if (prev) diagnostics.push(duplicate(prev, local, kind, file, pos))
    else nodes.set(address, { address, module: m.path, local, ...(kind === 'module' && loaded.has(address) ? { child: address } : {}), kind, file, pos, block, value, refs, deps: [], ...extra })
  }

  for (const m of mods) {
    const vars = new Set(m.blocks.filter((b) => b.type === 'variable' && b.labels.length === 1).map((b) => b.labels[0]))
    if (m.call) {
      const ctx = `module "${m.call.labels[0]}"`
      for (const a of m.call.attrs) {
        if (!CALL_META.has(a.name) && !vars.has(a.name)) diagnostics.push({ severity: 'error', summary: 'Unsupported argument', detail: `An argument named "${a.name}" is not expected here.`, file: m.call.file, line: a.pos.line, col: a.pos.col, context: ctx })
      }
    }
    const parentP = m.path.includes('.module.') ? m.path.slice(0, m.path.lastIndexOf('.module.')) + '.' : ''
    const askedFor = new Set<string>()
    for (const b of m.blocks) {
      if (b.type === 'locals') {
        for (const a of b.attrs) {
          const refs: Ref[] = []
          exprRefs(a.value, refs)
          put(m, `local.${a.name}`, 'local', b.file, a.pos, refs, undefined, a.value)
        }
        continue
      }
      const d = Object.hasOwn(DECL, b.type) ? DECL[b.type] : undefined
      if (!d) continue // provider, terraform, moved, import, removed: not graph nodes
      const [kind, n] = d
      if (b.labels.length !== n) {
        diagnostics.push({ severity: 'error', summary: `Invalid ${b.type} block`, detail: `A ${b.type} block requires exactly ${n} label${n > 1 ? 's' : ''}.`, file: b.file, line: b.pos.line, col: b.pos.col })
        continue
      }
      const refs: Ref[] = []
      let extra: Partial<GNode> | undefined
      if (kind === 'module' && loaded.has(m.path ? `${m.path}.module.${b.labels[0]}` : `module.${b.labels[0]}`)) {
        // The arguments are bindings of the child's variables (see below); the call itself waits on its meta-arguments.
        for (const a of b.attrs) if (CALL_META.has(a.name) && a.name !== 'providers') exprRefs(a.value, refs)
      } else blockRefs(b, refs, true)
      if (kind === 'variable' && m.call) {
        const arg = m.call.attrs.find((a) => a.name === b.labels[0] && !CALL_META.has(a.name))
        if (arg) {
          const found: Ref[] = []
          exprRefs(arg.value, found)
          refs.push(...found.map((r) => ({ ...r, file: m.call!.file, scope: parentP })))
          extra = { arg: { value: arg.value, pos: arg.pos, file: m.call.file } }
        } else if (!b.attrs.some((a) => a.name === 'default') && !askedFor.has(b.labels[0])) {
          diagnostics.push({ severity: 'error', summary: 'Missing required argument', detail: `The argument "${b.labels[0]}" is required, but no definition was found.`, file: m.call.file, line: m.call.pos.line, col: m.call.pos.col, context: `module "${m.call.labels[0]}"` })
        }
        askedFor.add(b.labels[0])
      }
      put(m, PREFIX[kind] + b.labels.join('.'), kind, b.file, b.pos, refs, b, undefined, extra)
    }
  }

  // An import block's id may use variables and locals, so its target resource depends on them (root module only).
  for (const b of blocks) {
    if (b.type !== 'import' || !tree.root.files.some((f) => f.name === b.file)) continue
    const to = b.attrs.find((a) => a.name === 'to')
    const id = b.attrs.find((a) => a.name === 'id')
    const addr = to && parseAddress(to.value)
    const node = addr && nodes.get(`${addr.type}.${addr.name}`)
    if (node && id) {
      const found: Ref[] = []
      exprRefs(id.value, found)
      node.refs.push(...found.map((r) => ({ ...r, file: b.file })))
    }
  }

  // The outputs of each loaded module, for references that name one.
  const outputs = new Map<string, string[]>([...loaded.keys()].map((p) => [p, []]))
  for (const n of nodes.values()) if (n.kind === 'output' && n.module) outputs.get(n.module)?.push(n.address)

  // Resolve references into dependencies.
  for (const node of [...nodes.values()].sort((x, y) => x.address.localeCompare(y.address))) {
    const deps = new Set<string>()
    if (node.module) deps.add(node.module) // everything in a module waits for its call to expand
    for (const ref of node.refs) {
      const P = ref.scope ?? (node.module ? `${node.module}.` : '')
      const r = resolve(ref.path, P)
      if (!r) continue
      let bad: Fail | undefined = 'want' in r ? undefined : r
      let wants: string[] = []
      if ('want' in r) {
        const outs = ref.path[0] === 'module' && nodes.has(r.want) ? outputs.get(r.want) : undefined
        if (!nodes.has(r.want)) bad = missing(ref.path, P)
        else if (outs) {
          // module.net.out resolves to that output; the whole object (module.net, module.net[0]) to all of them
          const c = ref.path[2]
          const one = c === undefined ? undefined : `${r.want}.output.${c}`
          if (one === undefined) wants = outs.length ? outs : [r.want]
          else if (nodes.has(one)) wants = [one]
          else bad = { summary: 'Unsupported attribute', detail: `This object does not have an attribute named "${c}".` }
        } else wants = [r.want]
      }
      if (bad) diagnostics.push({ severity: 'error', ...bad, file: ref.file ?? node.file, line: ref.pos.line, col: ref.pos.col })
      else for (const w of wants) if (!(node.kind === 'variable' && w === node.address)) deps.add(w) // validation may read its own variable
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
    return { nodes, order: [], blocks, diagnostics: dedupe(diagnostics) }
  }
  return { nodes, order, blocks, diagnostics: dedupe(diagnostics) }
}
