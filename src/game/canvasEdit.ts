// Editing a canvas design, as pure functions. The UI (drag, menus, keyboard)
// only calls these, so every way of building a design follows the same rules.

import { MAX_NODES, USERS } from '../schema/constants.ts'
import type { CanvasChallenge, Design } from '../schema/canvas.ts'

export type Lane = { id: string; label: string; scope: 'zonal' | 'regional' | 'global'; region?: string }
type Kind = Design['edges'][number]['kind']

export const emptyDesign = (): Design => ({ nodes: [], edges: [] })

export function lanes(c: CanvasChallenge): Lane[] {
  return [
    ...(c.layout.global ? [{ id: 'global', label: 'Global', scope: 'global' as const }] : []),
    ...c.layout.regions.flatMap((r) => [
      { id: r.id, label: `${r.label} (regional)`, scope: 'regional' as const, region: r.id },
      ...r.zones.map((z) => ({ id: z.id, label: z.label, scope: 'zonal' as const, region: r.id })),
    ]),
  ]
}

export const lanesFor = (c: CanvasChallenge, type: string) => {
  const scope = c.palette.find((p) => p.id === type)?.scope
  return lanes(c).filter((l) => l.scope === scope)
}

export const laneLabel = (c: CanvasChallenge, id: string) => lanes(c).find((l) => l.id === id)?.label ?? id

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

export function addNode(c: CanvasChallenge, d: Design, type: string, lane: string): Design | string {
  const p = c.palette.find((x) => x.id === type)
  if (!p) return 'Unknown component.'
  if (d.nodes.length >= MAX_NODES) return `A design can have at most ${MAX_NODES} components.`
  if (!lanesFor(c, type).some((l) => l.id === lane)) return `${p.label} can't go in ${laneLabel(c, lane)}.`
  const base = slug(p.short ?? p.label)
  let n = 1
  while (d.nodes.some((x) => x.id === `${base}-${n}`)) n++
  return { ...d, nodes: [...d.nodes, { id: `${base}-${n}`, type, lane }] }
}

export function moveNode(c: CanvasChallenge, d: Design, id: string, lane: string): Design | string {
  const node = d.nodes.find((n) => n.id === id)
  if (!node) return 'Unknown component.'
  if (!lanesFor(c, node.type).some((l) => l.id === lane)) return `${id} can't go in ${laneLabel(c, lane)}.`
  return { ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, lane } : n)) }
}

export const removeNode = (d: Design, id: string): Design => ({
  nodes: d.nodes.filter((n) => n.id !== id),
  edges: d.edges.filter((e) => e.from !== id && e.to !== id),
})

// Which components `from` may link to with this kind of link.
export function targets(c: CanvasChallenge, d: Design, from: string, kind: Kind): string[] {
  return d.nodes.map((n) => n.id).filter((to) => typeof connect(c, d, from, to, kind) !== 'string')
}

export function connect(c: CanvasChallenge, d: Design, from: string, to: string, kind: Kind): Design | string {
  const isStore = (id: string) => {
    const n = d.nodes.find((x) => x.id === id)
    return !!n && !!c.palette.find((p) => p.id === n.type)?.roles.includes('write-store')
  }
  if (from === to) return "A component can't link to itself."
  if (to === USERS) return "Nothing sends traffic to users."
  if (from !== USERS && !d.nodes.some((n) => n.id === from)) return 'Unknown component.'
  if (!d.nodes.some((n) => n.id === to)) return 'Unknown component.'
  if (d.edges.some((e) => e.from === from && e.to === to && e.kind === kind)) return 'That link already exists.'
  if (kind !== 'traffic') {
    if (!isStore(from) || !isStore(to)) return 'Replication links join two databases.'
    if (d.edges.some((e) => e.kind !== 'traffic' && e.to === to)) return `${to} already replicates from another database.`
    if (d.edges.some((e) => e.kind !== 'traffic' && e.from === to && e.to === from))
      return 'Those two databases are already linked the other way.'
  }
  return { ...d, edges: [...d.edges, { from, to, kind }] }
}

export const disconnect = (d: Design, i: number): Design => ({ ...d, edges: d.edges.filter((_, j) => j !== i) })
