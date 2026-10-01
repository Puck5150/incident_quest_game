import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { USERS } from '../../schema/constants.ts'
import type { CanvasChallenge, Design } from '../../schema/canvas.ts'
import { lanes, type Lane } from '../../game/canvasEdit.ts'

export type DragPayload = { kind: 'new'; type: string } | { kind: 'move'; id: string }

type Line = { x1: number; y1: number; x2: number; y2: number; kind: Design['edges'][number]['kind']; key: string }

// The design surface: region boxes containing a regional lane and one lane per
// zone. Components are chips; links are drawn in an SVG layer behind them,
// measured from the chips' real positions so layout stays plain HTML.
export default function Board({
  c,
  design,
  selected,
  down,
  connectFrom,
  validTargets,
  dragging,
  onSelect,
  onPointerDownChip,
  readOnly,
}: {
  c: CanvasChallenge
  design: Design
  selected?: string
  down: Set<string> // components lost in the stress test being shown
  connectFrom?: string // in connect mode: the source component
  validTargets: Set<string>
  dragging?: DragPayload
  onSelect?: (id: string) => void
  onPointerDownChip?: (e: ReactPointerEvent, id: string) => void
  readOnly?: boolean // debrief: a picture of a design, no interaction
}) {
  const arrowId = useId() // unique per board: the debrief shows two
  const box = useRef<HTMLDivElement>(null)
  const chips = useRef(new Map<string, HTMLElement>())
  const [lines, setLines] = useState<Line[]>([])
  const all = lanes(c)
  const palette = new Map(c.palette.map((p) => [p.id, p]))
  const scopeOfDrag =
    dragging &&
    palette.get(dragging.kind === 'new' ? dragging.type : (design.nodes.find((n) => n.id === dragging.id)?.type ?? ''))?.scope

  // Measure after layout (in a frame callback, not synchronously in the effect)
  // and again whenever the board resizes.
  useEffect(() => {
    const measure = () => {
      const origin = box.current?.getBoundingClientRect()
      if (!origin) return
      const rect = (id: string) => chips.current.get(id)?.getBoundingClientRect()
      setLines(
        design.edges.flatMap((e, i) => {
          const a = rect(e.from)
          const b = rect(e.to)
          if (!a || !b) return []
          const [x1, y1] = border(a, b, origin)
          const [x2, y2] = border(b, a, origin)
          return [{ x1, y1, x2, y2, kind: e.kind, key: `${i}-${e.from}-${e.to}-${e.kind}` }]
        }),
      )
    }
    const raf = requestAnimationFrame(measure)
    const ro = new ResizeObserver(() => requestAnimationFrame(measure))
    if (box.current) ro.observe(box.current)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [design])

  const chip = (id: string, label: string, sub?: string) => {
    const isDown = down.has(id)
    const target = connectFrom && validTargets.has(id)
    const dim = connectFrom && connectFrom !== id && !target
    const look = `relative z-10 min-w-24 rounded-md border bg-panel px-2.5 py-1.5 text-left text-sm select-none ${
      isDown ? 'border-crit text-crit' : selected === id ? 'border-accent ring-2 ring-accent/40' : 'border-line'
    }`
    const body = (
      <>
        <span className="block font-mono font-medium">{label}</span>
        {sub && <span className="block text-xs text-muted">{isDown ? 'down' : sub}</span>}
      </>
    )
    const register = (el: HTMLElement | null) => {
      if (el) chips.current.set(id, el)
      else chips.current.delete(id)
    }
    if (readOnly) {
      return (
        <div key={id} ref={register} className={look}>
          {body}
        </div>
      )
    }
    return (
      <button
        key={id}
        ref={register}
        type="button"
        data-node={id}
        onClick={() => onSelect?.(id)}
        onPointerDown={id === USERS ? undefined : (e) => onPointerDownChip?.(e, id)}
        aria-pressed={selected === id}
        aria-label={`${label}${sub ? `, ${sub}` : ''}${isDown ? ', down in this test' : ''}${target ? ', can be linked' : ''}`}
        className={`${look} hover:border-accent/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
          target ? 'border-dashed border-accent' : ''
        } ${dim ? 'opacity-40' : ''}`}
      >
        {body}
      </button>
    )
  }

  const lane = (l: Lane) => {
    const here = design.nodes.filter((n) => n.lane === l.id)
    const accepts = !!dragging && scopeOfDrag === l.scope
    return (
      <div
        key={l.id}
        data-lane={l.id}
        className={`min-h-20 rounded-md border p-2 ${
          accepts ? 'border-accent bg-accent/5' : dragging ? 'border-line opacity-50' : 'border-line/70'
        }`}
      >
        <p className="mb-2 text-xs text-muted">{l.label}</p>
        <div className="flex flex-wrap gap-2">
          {here.map((n) => chip(n.id, n.id, palette.get(n.type)?.short ?? palette.get(n.type)?.label))}
          {!here.length && <span className="text-xs text-muted/70">{accepts ? 'Drop here' : 'Empty'}</span>}
        </div>
      </div>
    )
  }

  return (
    // Read-only boards are pictures; the debrief pairs each with a text version.
    <div ref={box} aria-hidden={readOnly || undefined} className="relative rounded-lg border border-line bg-panel p-4">
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" />
          </marker>
        </defs>
        {lines.map((l) => (
          <g key={l.key}>
            <line
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              stroke={l.kind === 'traffic' ? 'var(--muted)' : 'var(--accent)'}
              strokeWidth={l.kind === 'traffic' ? 1.5 : 2.5}
              strokeDasharray={l.kind === 'async' ? '6 4' : undefined}
              markerEnd={l.kind === 'traffic' ? `url(#${CSS.escape(arrowId)})` : undefined}
            />
            {l.kind !== 'traffic' && (
              <text
                x={(l.x1 + l.x2) / 2}
                y={(l.y1 + l.y2) / 2 - 4}
                textAnchor="middle"
                fontSize="11"
                fill="var(--accent)"
                stroke="var(--panel)"
                strokeWidth="4"
                paintOrder="stroke"
              >
                {l.kind}
              </text>
            )}
          </g>
        ))}
      </svg>

      <div className="relative space-y-4">
        <div className="flex">{chip(USERS, USERS)}</div>
        {all.filter((l) => l.scope === 'global').map(lane)}
        {c.layout.regions.map((r) => {
          const zones = all.filter((l) => l.scope === 'zonal' && l.region === r.id)
          return (
            <section key={r.id} aria-label={r.label} className="space-y-2 rounded-lg border border-dashed border-line p-3">
              <h3 className="text-sm font-medium">{r.label}</h3>
              {lane(all.find((l) => l.id === r.id)!)}
              <div className={`grid gap-2 sm:grid-cols-2 ${zones.length >= 3 ? 'xl:grid-cols-3' : ''}`}>{zones.map(lane)}</div>
            </section>
          )
        })}
      </div>

      <p className="relative mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden>
            <line x1="0" y1="3" x2="22" y2="3" stroke="var(--muted)" strokeWidth="1.5" />
          </svg>
          traffic
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden>
            <line x1="0" y1="3" x2="22" y2="3" stroke="var(--accent)" strokeWidth="2.5" />
          </svg>
          sync replication
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden>
            <line x1="0" y1="3" x2="22" y2="3" stroke="var(--accent)" strokeWidth="2.5" strokeDasharray="6 4" />
          </svg>
          async replication
        </span>
      </p>
    </div>
  )
}

// Where the line from rectangle a toward rectangle b leaves a's border,
// relative to the board.
function border(a: DOMRect, b: DOMRect, origin: DOMRect): [number, number] {
  const ax = a.left + a.width / 2 - origin.left
  const ay = a.top + a.height / 2 - origin.top
  const dx = b.left + b.width / 2 - origin.left - ax
  const dy = b.top + b.height / 2 - origin.top - ay
  const t = Math.min((a.width / 2 + 3) / Math.abs(dx || 1e-9), (a.height / 2 + 3) / Math.abs(dy || 1e-9))
  return [ax + dx * t, ay + dy * t]
}
