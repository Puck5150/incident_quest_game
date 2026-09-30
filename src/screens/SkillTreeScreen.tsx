import type { Track } from '../schema/scenario.ts'

type Item = { id: string; track: string; kind?: 'incident' | 'challenge' }
import type { Progress } from '../game/progress.ts'
import Icon from '../components/Icon.tsx'

const W = 200 // node width
const H = 88 // node height
const COL = 260
const ROW = 116

type Node = { track: Track; col: number; row: number; done: number; total: number; open: boolean; design: boolean }

// Tracks laid out left to right by how deep their prerequisites go. Only
// tracks with content appear (PLAN.md milestone 6).
export default function SkillTreeScreen({
  tracks,
  scenarios,
  progress,
  unlocked,
  onOpenTrack,
}: {
  tracks: Track[]
  scenarios: Item[]
  progress: Progress
  unlocked: Set<string>
  onOpenTrack: (trackId: string) => void
}) {
  const nodes = layout(tracks, scenarios, progress, unlocked)
  const byId = new Map(nodes.map((n) => [n.track.id, n]))
  const width = Math.max(...nodes.map((n) => n.col)) * COL + W
  const height = Math.max(...nodes.map((n) => n.row)) * ROW + H

  function nodeButton(n: Node) {
    const state = !n.open ? 'locked' : n.done === n.total ? 'mastered' : 'open'
    const needs = n.track.requires.filter((r) => byId.has(r) && byId.get(r)!.done === 0).map((r) => byId.get(r)!.track.name)
    return (
      <button
        onClick={() => onOpenTrack(n.track.id)}
        className={`flex h-full w-full flex-col justify-between rounded-lg border bg-panel p-3 text-left hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
          state === 'mastered' ? 'border-ok' : state === 'open' ? 'border-accent/60' : 'border-line text-muted'
        }`}
      >
        <span className="flex items-start justify-between gap-2 font-medium">
          <span>
            {n.track.name}
            {n.design && <span className="ml-2 align-middle text-xs font-normal text-accent">Design</span>}
          </span>
          {state === 'locked' && <Icon name="lock" />}
          {state === 'mastered' && <Icon name="check" className="h-4 w-4 text-ok" />}
        </span>
        <span className="text-xs text-muted">
          {state === 'locked' ? (
            <>Needs {needs.join(' + ')}</>
          ) : (
            <span className="tabular-nums">
              {n.done}/{n.total} resolved
            </span>
          )}
        </span>
        <span className="sr-only">
          {state === 'locked' ? 'Locked.' : state === 'mastered' ? 'All incidents resolved.' : 'Unlocked.'}
        </span>
      </button>
    )
  }

  return (
    <div className="space-y-4">
      <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
        Skill tree
      </h1>
      <p className="max-w-prose text-muted">
        Finish an incident or challenge in a track to unlock the tracks that build on it. Select a track to see its incidents.
      </p>

      {/* Phones: the same nodes as a list, one tier after another. */}
      <ol className="space-y-5 sm:hidden" aria-label="Tracks by tier">
        {[...new Set(nodes.map((n) => n.col))].map((col) => (
          <li key={col}>
            <h2 className="mb-2 text-sm text-muted">{col === 0 ? 'Start here' : `Tier ${col + 1}`}</h2>
            <ul className="space-y-2">
              {nodes
                .filter((n) => n.col === col)
                .map((n) => (
                  <li key={n.track.id} className="h-20">
                    {nodeButton(n)}
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ol>

      <div className="hidden overflow-x-auto pb-2 sm:block">
        <div className="relative" style={{ width, height }}>
          <svg className="absolute inset-0" width={width} height={height} aria-hidden>
            {nodes.flatMap((n) =>
              n.track.requires
                .map((r) => byId.get(r))
                .filter((r) => !!r)
                .map((r) => {
                  const x1 = r.col * COL + W
                  const y1 = r.row * ROW + H / 2
                  const x2 = n.col * COL
                  const y2 = n.row * ROW + H / 2
                  const mid = (x1 + x2) / 2
                  const met = r.done > 0
                  return (
                    <path
                      key={`${r.track.id}-${n.track.id}`}
                      d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                      fill="none"
                      stroke={met ? 'var(--ok)' : 'var(--line)'}
                      strokeWidth={met ? 2 : 1.5}
                    />
                  )
                }),
            )}
          </svg>

          <ul aria-label="Tracks">
            {nodes.map((n) => (
              <li key={n.track.id} className="absolute" style={{ left: n.col * COL, top: n.row * ROW, width: W, height: H }}>
                {nodeButton(n)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

function layout(tracks: Track[], scenarios: Item[], progress: Progress, unlocked: Set<string>): Node[] {
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
  // Roots stack top to bottom; a dependent track sits level with the average
  // of its prerequisites, so edges stay short and mostly horizontal.
  const rowOf = new Map<string, number>()
  const nextRoot = { row: 0 }
  const sorted = [...withContent].sort((a, b) => depthOf(a) - depthOf(b))
  sorted.forEach((t) => {
    const reqRows = t.requires.filter((r) => rowOf.has(r)).map((r) => rowOf.get(r)!)
    let row = reqRows.length ? reqRows.reduce((a, b) => a + b, 0) / reqRows.length : nextRoot.row++
    const taken = () => sorted.some((o) => o !== t && rowOf.get(o.id) === row && depthOf(o) === depthOf(t))
    while (taken()) row += 1
    rowOf.set(t.id, row)
  })

  // An edge that skips a column (Networking -> Microservices) must not run
  // behind a node in the column it skips, or it reads as a dependency on that
  // node. Move any such node down to the next clear row.
  const byTrack = new Map(withContent.map((t) => [t.id, t]))
  const skipping = withContent.flatMap((t) =>
    t.requires.filter((r) => byTrack.has(r)).map((r) => ({ from: r, to: t.id })),
  )
  const blocked = (id: string, row: number) =>
    skipping.some(({ from, to }) => {
      const [a, b, c] = [depthOf(byTrack.get(from)!), depthOf(byTrack.get(to)!), depthOf(byTrack.get(id)!)]
      if (!(a < c && c < b)) return false
      const y = rowOf.get(from)! + ((rowOf.get(to)! - rowOf.get(from)!) * (c - a)) / (b - a)
      return Math.abs(y - row) < 0.75
    })
  sorted.forEach((t) => {
    let row = rowOf.get(t.id)!
    const clash = (r: number) => sorted.some((o) => o !== t && rowOf.get(o.id) === r && depthOf(o) === depthOf(t))
    while (blocked(t.id, row) || clash(row)) row += 1
    rowOf.set(t.id, row)
  })
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
