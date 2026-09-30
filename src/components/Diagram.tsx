import type { Scenario } from '../schema/scenario.ts'

type D = NonNullable<Scenario['diagram']>

const COL = 190
const ROW = 96
const W = 150
const H = 56

// Status is what monitoring currently shows, never color alone: each box
// also says ok / degraded / down in text.
const STATUS = {
  ok: { text: 'ok', stroke: 'var(--ok)', mark: <circle r="3.5" fill="var(--ok)" /> },
  degraded: { text: 'degraded', stroke: 'var(--warn)', mark: <path d="M0,-4 L4,3.5 L-4,3.5 z" fill="var(--warn)" /> },
  down: { text: 'down', stroke: 'var(--crit)', mark: <path d="M-3,-3 L3,3 M3,-3 L-3,3" stroke="var(--crit)" strokeWidth="1.8" strokeLinecap="round" /> },
}

// Boxes on a grid, arrows between them. Positions come from the scenario
// (col/row), so there's no layout engine to reason about.
export default function Diagram({ diagram }: { diagram: D }) {
  const pos = new Map(diagram.nodes.map((n) => [n.id, { x: n.col * COL + W / 2 + 4, y: n.row * ROW + H / 2 + 4 }]))
  const width = Math.max(...diagram.nodes.map((n) => n.col)) * COL + W + 8
  const height = Math.max(...diagram.nodes.map((n) => n.row)) * ROW + H + 8
  const summary = diagram.nodes.map((n) => `${n.label}: ${n.status}`).join('; ')

  return (
    <figure className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full max-w-3xl min-w-[32rem]" role="img" aria-label={`System diagram. ${summary}`}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" />
          </marker>
        </defs>
        {diagram.edges.map((e) => {
          const a = pos.get(e.from)!
          const b = pos.get(e.to)!
          const [x1, y1] = edgePoint(a, b)
          const [x2, y2] = edgePoint(b, a)
          return (
            <line key={`${e.from}-${e.to}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--muted)" strokeWidth="1.5" markerEnd="url(#arrow)" />
          )
        })}
        {diagram.nodes.map((n) => {
          const { x, y } = pos.get(n.id)!
          const s = STATUS[n.status]
          return (
            <g key={n.id}>
              <rect x={x - W / 2} y={y - H / 2} width={W} height={H} rx="8" fill="var(--panel)" stroke={s.stroke} strokeWidth={n.status === 'ok' ? 1 : 2} />
              <text x={x} y={y - 4} textAnchor="middle" fill="var(--fg)" fontSize="14">
                {n.label}
              </text>
              {/* status mark + word, centred together */}
              <g transform={`translate(${x - s.text.length * 3.4 - 6}, ${y + 12})`}>{s.mark}</g>
              <text x={x + 6} y={y + 16} textAnchor="middle" fill={s.stroke} fontSize="12">
                {s.text}
              </text>
            </g>
          )
        })}
      </svg>
    </figure>
  )
}

// Where the line from box `a` toward box `b` leaves a's border (plus a small gap).
function edgePoint(a: { x: number; y: number }, b: { x: number; y: number }): [number, number] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const t = Math.min((W / 2 + 4) / Math.abs(dx || 1e-9), (H / 2 + 4) / Math.abs(dy || 1e-9))
  return [a.x + dx * t, a.y + dy * t]
}
