// `moved` blocks: the statement that an object at one address in state is
// really the object at another, so changing a name or a key is not a destroy.
import { parseAddress, type Address } from './addresses.ts'
import { instanceAddress, type State, type StateInstance, type StateResource } from './state.ts'
import { shapeErrors } from './declarations.ts'
import type { Block, Diagnostic, Pos } from './types.ts'

export interface Move {
  from: Address
  to: Address
  file: string
  pos: Pos
}

const fmt = (a: Address) => instanceAddress({ mode: 'managed', type: a.type, name: a.name }, a.key)
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
      const addr = parseAddress(a.value)
      if (!addr) diagnostics.push(diag(b.file, a.pos, `Invalid "${name}" address`, 'Moved block addresses must be resource instance addresses such as aws_instance.web or aws_instance.web[0].'))
      return addr
    }
    const from = get('from')
    const to = get('to')
    if (!from || !to) continue
    if (from.type !== to.type) {
      diagnostics.push(diag(b.file, b.pos, 'Resource type mismatch', `This statement declares a move from ${fmt(from)} to ${fmt(to)}, which is a resource of a different type.`))
      continue
    }
    if (fmt(from) === fmt(to)) {
      diagnostics.push(diag(b.file, b.pos, 'Redundant move statement', `The move statement ${fmt(from)} to ${fmt(to)} has the same source and destination, so it has no effect.`))
      continue
    }
    moves.push({ from, to, file: b.file, pos: b.pos })
  }
  return { moves, diagnostics }
}

// Where an object at `a` goes under the first matching move, if any.
function step(moves: Move[], a: Address): { next: Address; move: Move } | undefined {
  for (const m of moves) {
    if (m.from.type !== a.type || m.from.name !== a.name) continue
    if (m.from.key === undefined) {
      // Whole-resource move: instances keep their keys, unless the target is keyed and this is the lone unkeyed instance.
      if (a.key === undefined || m.to.key === undefined) return { next: { type: m.to.type, name: m.to.name, key: a.key ?? m.to.key }, move: m }
      continue
    }
    if (m.from.key === a.key) return { next: { type: m.to.type, name: m.to.name, key: m.to.key }, move: m }
  }
  return undefined
}

export function applyMoves(
  state: State,
  moves: Move[],
): { state: State; moved: Map<string, string>; blocked: { from: string; to: string }[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const cycles = new Set<string>()
  const final = (start: Address): Address => {
    const path = [fmt(start)]
    let cur = start
    for (;;) {
      const s = step(moves, cur)
      if (!s) return cur
      const k = fmt(s.next)
      const at = path.indexOf(k)
      if (at >= 0) {
        const key = path.slice(at).sort().join(',')
        if (!cycles.has(key)) {
          cycles.add(key)
          diagnostics.push(diag(s.move.file, s.move.pos, 'Cycle in move statements', `Terraform found a cycle among the move statements involving ${k}.`))
        }
        return start
      }
      path.push(k)
      cur = s.next
    }
  }

  const groups = new Map<string, StateResource>()
  const placed = new Set<string>()
  const moved = new Map<string, string>()
  const blocked: { from: string; to: string }[] = []
  const place = (r: StateResource, inst: StateInstance, dest: Address) => {
    const gk = `${r.mode}:${dest.type}.${dest.name}`
    let group = groups.get(gk)
    if (!group) {
      group = { mode: r.mode, type: dest.type, name: dest.name, provider: r.provider, instances: [] }
      groups.set(gk, group)
    }
    const copy: StateInstance = structuredClone(inst)
    if (dest.key === undefined) delete copy.index_key
    else copy.index_key = dest.key
    group.instances.push(copy)
    placed.add(instanceAddress({ mode: r.mode, type: dest.type, name: dest.name }, dest.key))
  }
  const todo: { r: StateResource; inst: StateInstance; from: Address; dest: Address; oldAddr: string; newAddr: string }[] = []
  for (const r of state.resources) {
    for (const inst of r.instances) {
      const from = { type: r.type, name: r.name, key: inst.index_key }
      const dest = r.mode === 'data' ? from : final(from)
      const oldAddr = instanceAddress(r, inst.index_key)
      const newAddr = instanceAddress({ mode: r.mode, type: dest.type, name: dest.name }, dest.key)
      todo.push({ r, inst, from, dest, oldAddr, newAddr })
    }
  }
  // Unmoved objects first, so a moved one can never displace an existing object.
  for (const t of todo) if (t.oldAddr === t.newAddr) place(t.r, t.inst, t.dest)
  const stay: typeof todo = []
  for (const t of todo) {
    if (t.oldAddr === t.newAddr) continue
    if (placed.has(t.newAddr)) {
      blocked.push({ from: t.oldAddr, to: t.newAddr })
      stay.push(t)
      continue
    }
    place(t.r, t.inst, t.dest)
    moved.set(t.newAddr, t.oldAddr)
  }
  // ponytail: a blocked source whose old address was also taken is dropped; real Terraform would error earlier.
  for (const t of stay) if (!placed.has(t.oldAddr)) place(t.r, t.inst, t.from)
  return { state: { ...structuredClone(state), resources: [...groups.values()] }, moved, blocked, diagnostics }
}
