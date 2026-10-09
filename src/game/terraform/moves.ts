// `moved` blocks: the statement that an object at one address in state is
// really the object at another, so changing a name or a key is not a destroy.
import { formatAddress, isModuleAddress, parseAddress, type Address } from './addresses.ts'
import { formatModule, formatResAddr, stepsOf, type ModStep, type ResAddr } from './address.ts'
import { type State, type StateInstance, type StateResource } from './state.ts'
import { shapeErrors } from './declarations.ts'
import type { Block, Diagnostic, Pos } from './types.ts'

export interface Move {
  from: Address
  to: Address
  file: string
  pos: Pos
}

const fmt = formatAddress
const sameStep = (x: ModStep, y: ModStep) => x.name === y.name && x.key === y.key
const startsWith = (path: ModStep[], prefix: ModStep[]) => prefix.length <= path.length && prefix.every((p, i) => sameStep(p, path[i]))
const diag = (file: string, pos: Pos, summary: string, detail: string): Diagnostic => ({ severity: 'error', summary, detail, file, line: pos.line, col: pos.col })

export function movesOf(blocks: Block[]): { moves: Move[]; diagnostics: Diagnostic[] } {
  const moves: Move[] = []
  const diagnostics: Diagnostic[] = []
  for (const b of blocks) {
    if (b.type !== 'moved') continue
    diagnostics.push(...shapeErrors(b, ['from', 'to']))
    const get = (name: 'from' | 'to'): Address | undefined => {
      const a = b.attrs.find((x) => x.name === name)
      if (!a) {
        diagnostics.push(diag(b.file, b.pos, 'Missing required argument', `The argument "${name}" is required, but no definition was found.`))
        return undefined
      }
      const addr = parseAddress(a.value, true)
      if (!addr) diagnostics.push(diag(b.file, a.pos, `Invalid "${name}" address`, 'Moved block addresses must be resource instance addresses such as aws_instance.web or aws_instance.web[0], or module addresses such as module.net.'))
      return addr
    }
    const from = get('from')
    const to = get('to')
    if (!from || !to) continue
    if (isModuleAddress(from) !== isModuleAddress(to)) {
      diagnostics.push(diag(b.file, b.pos, 'Invalid "moved" addresses', 'The "from" and "to" addresses must either both refer to resources or both refer to modules.'))
      continue
    }
    if (isModuleAddress(to) && startsWith(to.module ?? [], from.module ?? [])) {
      diagnostics.push(diag(b.file, b.pos, 'Invalid "moved" addresses', `Cannot move ${fmt(from)} to ${fmt(to)}: a module cannot be moved into itself.`))
      continue
    }
    if (from.type !== to.type) {
      diagnostics.push(diag(b.file, b.pos, 'Resource type mismatch', `This statement declares a move from ${fmt(from)} to ${fmt(to)}, which is a resource of a different type.`))
      continue
    }
    if (fmt(from) === fmt(to)) {
      diagnostics.push(diag(b.file, b.pos, 'Redundant move statement', `The move statement ${fmt(from)} to ${fmt(to)} has the same source and destination, so it has no effect.`))
      continue
    }
    if (moves.some((m) => fmt(m.to) === fmt(to))) {
      diagnostics.push(diag(b.file, b.pos, 'Ambiguous move statements', `Each move statement must have a distinct destination: ${fmt(to)} is the destination of more than one move statement.`))
      continue
    }
    moves.push({ from, to, file: b.file, pos: b.pos })
  }
  return { moves, diagnostics }
}

// Where an object at `a` goes under the first matching move, if any.
// A module move rewrites the module path prefix of everything under it; a resource move needs the exact module.
function step(moves: Move[], a: ResAddr): { next: ResAddr; move: Move } | undefined {
  for (const m of moves) {
    const fm = m.from.module ?? []
    const tm = m.to.module ?? []
    if (isModuleAddress(m.from)) {
      const n = fm.length
      if (!startsWith(a.module.slice(0, n - 1), fm.slice(0, n - 1)) || a.module.length < n || a.module[n - 1].name !== fm[n - 1].name) continue
      const last = fm[n - 1]
      const have = a.module[n - 1]
      if (last.key !== undefined && last.key !== have.key) continue
      const key = last.key === undefined ? (tm[tm.length - 1].key ?? have.key) : tm[tm.length - 1].key
      const step = { name: tm[tm.length - 1].name, ...(key === undefined ? {} : { key }) }
      return { next: { ...a, module: [...tm.slice(0, -1), step, ...a.module.slice(n)] }, move: m }
    }
    if (a.mode === 'data' || m.from.type !== a.type || m.from.name !== a.name || a.module.length !== fm.length || !startsWith(a.module, fm)) continue
    const to = { module: tm, mode: 'managed' as const, type: m.to.type, name: m.to.name }
    if (m.from.key === undefined) {
      // Whole-resource move: instances keep their keys, unless the target is keyed and this is the lone unkeyed instance.
      if (a.key === undefined || m.to.key === undefined) return { next: { ...to, key: a.key ?? m.to.key }, move: m }
      continue
    }
    if (m.from.key === a.key) return { next: { ...to, key: m.to.key }, move: m }
  }
  return undefined
}

export function applyMoves(
  state: State,
  moves: Move[],
): { state: State; moved: Map<string, string>; blocked: { from: string; to: string; claimed?: true }[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const cycles = new Set<string>()
  // The destination and the number of steps taken to reach it.
  const final = (start: ResAddr): { dest: ResAddr; len: number } => {
    const path = [formatResAddr(start)]
    const taken: Move[] = []
    let cur = start
    for (;;) {
      const s = step(moves, cur)
      if (!s) return { dest: cur, len: taken.length }
      const k = formatResAddr(s.next)
      const at = path.indexOf(k)
      if (at >= 0) {
        const key = [...new Set([...taken.slice(at), s.move].map((m) => `${m.file}:${m.pos.line}:${m.pos.col}`))].sort().join(',')
        if (!cycles.has(key)) {
          cycles.add(key)
          diagnostics.push(diag(s.move.file, s.move.pos, 'Cycle in move statements', `Terraform found a cycle among the move statements involving ${k}.`))
        }
        return { dest: start, len: 0 }
      }
      taken.push(s.move)
      path.push(k)
      cur = s.next
    }
  }

  const groups = new Map<string, StateResource>()
  const placed = new Set<string>()
  const moved = new Map<string, string>()
  const blocked: { from: string; to: string; claimed?: true }[] = []
  const place = (r: StateResource, inst: StateInstance, dest: ResAddr) => {
    const module = dest.module.length ? formatModule(dest.module) : undefined
    const gk = `${module ?? ''}|${r.mode}:${dest.type}.${dest.name}`
    let group = groups.get(gk)
    if (!group) {
      group = { ...(module ? { module } : {}), mode: r.mode, type: dest.type, name: dest.name, provider: r.provider, instances: [] }
      groups.set(gk, group)
    }
    const copy: StateInstance = structuredClone(inst)
    if (dest.key === undefined) delete copy.index_key
    else copy.index_key = dest.key
    group.instances.push(copy)
    placed.add(formatResAddr(dest))
  }
  const todo: { r: StateResource; inst: StateInstance; from: ResAddr; dest: ResAddr; len: number; oldAddr: string; newAddr: string }[] = []
  for (const r of state.resources) {
    for (const inst of r.instances) {
      const from: ResAddr = { module: stepsOf(r.module), mode: r.mode, type: r.type, name: r.name, ...(inst.index_key === undefined ? {} : { key: inst.index_key }) }
      const { dest, len } = final(from)
      const oldAddr = formatResAddr(from)
      const newAddr = formatResAddr(dest)
      todo.push({ r, inst, from, dest, len, oldAddr, newAddr })
    }
  }
  // Unmoved objects first, so a moved one can never displace an existing object.
  for (const t of todo) if (t.oldAddr === t.newAddr) place(t.r, t.inst, t.dest)
  const unmoved = new Set(placed)
  const stay: typeof todo = []
  // The mover nearest its destination wins a contested address; state order only breaks ties.
  const movers = todo.filter((t) => t.oldAddr !== t.newAddr).sort((x, y) => x.len - y.len)
  for (const t of movers) {
    if (placed.has(t.newAddr)) {
      blocked.push({ from: t.oldAddr, to: t.newAddr, ...(unmoved.has(t.newAddr) ? {} : { claimed: true as const }) })
      stay.push(t)
      continue
    }
    place(t.r, t.inst, t.dest)
    moved.set(t.newAddr, t.oldAddr)
  }
  // ponytail: a blocked source whose old address is taken by another moved object is dropped. Unreachable unless state holds duplicate addresses, which applyMoves does not diagnose.
  for (const t of stay) if (!placed.has(t.oldAddr)) place(t.r, t.inst, t.from)
  return { state: { ...structuredClone(state), resources: [...groups.values()] }, moved, blocked, diagnostics }
}
