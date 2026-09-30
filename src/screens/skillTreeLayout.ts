// Skill tree layout: columns by prerequisite depth, rows chosen so boxes don't
// overlap and no edge runs behind an unrelated box. Pure, so it's testable.

import type { Track } from '../schema/scenario.ts'
import type { Progress } from '../game/progress.ts'

export type Item = { id: string; track: string; kind?: 'incident' | 'challenge' }
export type Node = { track: Track; col: number; row: number; done: number; total: number; open: boolean; design: boolean }

export function layout(tracks: Track[], scenarios: Item[], progress: Progress, unlocked: Set<string>): Node[] {
  const withContent = tracks.filter((t) => scenarios.some((s) => s.track === t.id))
  const ids = new Set(withContent.map((t) => t.id))
  const depth = new Map<string, number>()
  const depthOf = (t: Track): number => {
    if (!depth.has(t.id)) {
      const reqs = t.requires.filter((r) => ids.has(r)).map((r) => depthOf(withContent.find((x) => x.id === r)!))
      depth.set(t.id, reqs.length ? Math.max(...reqs) + 1 : 0)
    }
    return depth.get(t.id)!
  }
  // Roots stack top to bottom. A dependent track sits level with the average
  // of its prerequisites, moved down if it would overlap a box in its column
  // (rows can be fractional, so "overlap" means less than one row apart) or
  // sit on an edge that skips its column (Networking -> Microservices would
  // otherwise read as a dependency on whatever it runs behind).
  const byTrack = new Map(withContent.map((t) => [t.id, t]))
  const parents = (t: Track) => t.requires.filter((r) => byTrack.has(r))
  const sorted = [...withContent].sort((a, b) => depthOf(a) - depthOf(b))
  const rowOf = new Map<string, number>()
  sorted.filter((t) => !parents(t).length).forEach((t, i) => rowOf.set(t.id, i))
  sorted.filter((t) => parents(t).length).forEach((t) => rowOf.set(t.id, 0))

  const edges = withContent.flatMap((t) => parents(t).map((r) => ({ from: r, to: t.id })))
  const onSkippingEdge = (id: string, row: number) =>
    edges.some(({ from, to }) => {
      const [a, b, c] = [depthOf(byTrack.get(from)!), depthOf(byTrack.get(to)!), depthOf(byTrack.get(id)!)]
      if (!(a < c && c < b)) return false
      const y = rowOf.get(from)! + ((rowOf.get(to)! - rowOf.get(from)!) * (c - a)) / (b - a)
      return Math.abs(y - row) < 0.75
    })

  // A few passes let rows settle: moving one node can move the edges that
  // pass behind another.
  for (let pass = 0; pass < 4; pass++) {
    const placed: Track[] = sorted.filter((t) => !parents(t).length)
    sorted
      .filter((t) => parents(t).length)
      .forEach((t) => {
        const ps = parents(t).map((r) => rowOf.get(r)!)
        let row = ps.reduce((x, y) => x + y, 0) / ps.length
        const clash = (r: number) =>
          placed.some((o) => depthOf(o) === depthOf(t) && Math.abs(rowOf.get(o.id)! - r) < 1)
        while (clash(row) || onSkippingEdge(t.id, row)) row += 1
        rowOf.set(t.id, row)
        placed.push(t)
      })
  }
  return withContent.map((t) => {
    const col = depthOf(t)
    const row = rowOf.get(t.id)!
    const inTrack = scenarios.filter((s) => s.track === t.id)
    return {
      track: t,
      col,
      row,
      done: inTrack.filter((s) => progress.completed[s.id]).length,
      total: inTrack.length,
      open: unlocked.has(t.id),
      design: inTrack.every((s) => s.kind === 'challenge'),
    }
  })
}
