// `moved` blocks: the statement that an object at one address in state is
// really the object at another, so changing a name or a key is not a destroy.
import { parseAddress, type Address } from './addresses.ts'
import { instanceAddress, type State, type StateInstance, type StateResource } from './state.ts'
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
    moves.push({ from, to, file: b.file, pos: b.pos })
  }
  return { moves, diagnostics }
}

// Where an object at `a` goes under the first matching move, if any.
function step(moves: Move[], a: Address): Address | undefined {
  for (const m of moves) {
    if (m.from.type !== a.type || m.from.name !== a.name) continue
    if (m.from.key === undefined) {
      // Whole-resource move: instances keep their keys, unless the target is keyed and this is the lone unkeyed instance.
      if (a.key === undefined || m.to.key === undefined) return { type: m.to.type, name: m.to.name, key: a.key ?? m.to.key }
      continue
    }
    if (m.from.key === a.key) return { type: m.to.type, name: m.to.name, key: m.to.key }
  }
  return undefined
}

export function applyMoves(state: State, moves: Move[]): { state: State; moved: Map<string, string>; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const none = { file: '', pos: { line: 0, col: 0 } }
  const final = (start: Address): Address => {
    const seen = new Set<string>([fmt(start)])
    let cur = start
    for (;;) {
      const next = step(moves, cur)
      if (!next) return cur
      const k = fmt(next)
      if (seen.has(k)) {
        diagnostics.push(diag(none.file, none.pos, 'Cycle in move statements', `Terraform found a cycle among the move statements involving ${fmt(start)}.`))
        return start
      }
      seen.add(k)
      cur = next
    }
  }

  const groups = new Map<string, StateResource>()
  const placed = new Map<string, string>()
  const moved = new Map<string, string>()
  for (const r of state.resources) {
    for (const inst of r.instances) {
      const oldAddr = instanceAddress(r, inst.index_key)
      const dest = r.mode === 'data' ? { type: r.type, name: r.name, key: inst.index_key } : final({ type: r.type, name: r.name, key: inst.index_key })
      const newAddr = instanceAddress({ mode: r.mode, type: dest.type, name: dest.name }, dest.key)
      if (placed.has(newAddr)) {
        // Name the object that is moving, whichever of the two was seen first.
        const mover = newAddr !== oldAddr ? oldAddr : placed.get(newAddr)
        diagnostics.push(diag(none.file, none.pos, 'Cannot move to existing object', `Cannot move ${mover} to ${newAddr}: an object already exists at that address in the state.`))
        continue
      }
      placed.set(newAddr, oldAddr)
      if (newAddr !== oldAddr) moved.set(newAddr, oldAddr)
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
    }
  }
  return { state: { ...structuredClone(state), resources: [...groups.values()] }, moved, diagnostics }
}
