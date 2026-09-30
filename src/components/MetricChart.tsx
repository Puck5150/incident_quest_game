import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { Scenario } from '../schema/scenario.ts'

type Metric = NonNullable<Scenario['metrics']>[number]

const W = 640
const H = 240
const M = { top: 12, right: 112, bottom: 28, left: 52 }
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)']

// A plain SVG line chart: one y-axis, 2px lines, a hover/keyboard crosshair
// with a tooltip, direct end labels, and a data table for screen readers.
// ponytail: hand-rolled instead of a chart library; swap in one if we ever
// need zooming, log scales or many series.
export default function MetricChart({ metric }: { metric: Metric }) {
  const [hover, setHover] = useState<number>()
  const xs = metric.series[0].points.map((p) => p[0])
  const max = niceMax(Math.max(...metric.series.flatMap((s) => s.points.map((p) => p[1])), metric.threshold?.value ?? 0))
  const px = (i: number) => M.left + (i / (xs.length - 1)) * (W - M.left - M.right)
  const py = (v: number) => H - M.bottom - (v / max) * (H - M.top - M.bottom)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max)
  const every = Math.ceil(xs.length / 6) // at most ~6 x labels so they never collide
  const fmt = (v: number) => `${+v.toFixed(2)}${metric.unit === '%' ? '%' : ` ${metric.unit}`}`

  function onPointer(e: PointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    const frac = (e.clientX - r.left) / r.width
    setHover(Math.round(frac * (xs.length - 1)))
  }
  function onKey(e: KeyboardEvent) {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!d) return
    e.preventDefault()
    setHover((h) => Math.min(xs.length - 1, Math.max(0, (h ?? (d > 0 ? -1 : xs.length)) + d)))
  }

  // Keep end labels from overlapping: push each one down if it's too close to the one above.
  const ends = metric.series
    .map((s, i) => ({ label: s.label, color: SERIES[i], y: py(s.points.at(-1)![1]) }))
    .sort((a, b) => a.y - b.y)
  ends.forEach((e, i) => i && (e.y = Math.max(e.y, ends[i - 1].y + 14)))

  return (
    <figure className="p-3">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {metric.name} <span className="text-sm text-muted">({metric.unit})</span>
        </span>
        {metric.series.length > 1 && (
          <span className="flex flex-wrap gap-3 text-xs text-muted">
            {metric.series.map((s, i) => (
              <span key={s.label} className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-4" style={{ background: SERIES[i] }} />
                {s.label}
              </span>
            ))}
          </span>
        )}
      </figcaption>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full focus-visible:outline-2 focus-visible:outline-accent"
          tabIndex={0}
          role="img"
          aria-label={`${metric.name} chart. Use left and right arrow keys to read values.`}
          onKeyDown={onKey}
          onBlur={() => setHover(undefined)}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={W - M.right} y1={py(v)} y2={py(v)} stroke="var(--line)" strokeWidth="1" />
              <text x={M.left - 6} y={py(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
                {+v.toFixed(2)}
              </text>
            </g>
          ))}
          {xs.map((x, i) =>
            i % every === 0 || i === xs.length - 1 ? (
              <text key={x} x={px(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--muted)">
                {x}
              </text>
            ) : null,
          )}
          {metric.threshold && (
            <g>
              <line x1={M.left} x2={W - M.right} y1={py(metric.threshold.value)} y2={py(metric.threshold.value)} stroke="var(--fg)" strokeWidth="1" opacity="0.6" />
              <text x={M.left + 4} y={py(metric.threshold.value) - 4} fontSize="11" fill="var(--muted)">
                {metric.threshold.label}
              </text>
            </g>
          )}
          {metric.series.map((s, i) => (
            <g key={s.label}>
              <polyline
                points={s.points.map((p, j) => `${px(j)},${py(p[1])}`).join(' ')}
                fill="none"
                stroke={SERIES[i]}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <circle cx={px(xs.length - 1)} cy={py(s.points.at(-1)![1])} r="4" fill={SERIES[i]} stroke="var(--bg)" strokeWidth="2" />
            </g>
          ))}
          {ends.map((e) => (
            <text key={e.label} x={W - M.right + 8} y={e.y + 4} fontSize="11" fill="var(--fg)">
              {e.label}
            </text>
          ))}
          {hover !== undefined && (
            <g>
              <line x1={px(hover)} x2={px(hover)} y1={M.top} y2={H - M.bottom} stroke="var(--muted)" strokeWidth="1" />
              {metric.series.map((s, i) => (
                <circle key={s.label} cx={px(hover)} cy={py(s.points[hover][1])} r="4" fill={SERIES[i]} stroke="var(--bg)" strokeWidth="2" />
              ))}
            </g>
          )}
          {/* Hit area bigger than the marks: the whole plot. */}
          <rect
            x={M.left}
            y={M.top}
            width={W - M.left - M.right}
            height={H - M.top - M.bottom}
            fill="transparent"
            onPointerMove={onPointer}
            onPointerLeave={() => setHover(undefined)}
          />
        </svg>

        {hover !== undefined && (
          <div
            className="pointer-events-none absolute top-2 rounded-md border border-line bg-panel px-2 py-1 text-xs shadow"
            style={{ left: `${(px(hover) / W) * 100}%`, transform: `translateX(${hover > xs.length / 2 ? 'calc(-100% - 8px)' : '8px'})` }}
          >
            <div className="font-mono text-muted">{xs[hover]}</div>
            {metric.series.map((s, i) => (
              <div key={s.label} className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: SERIES[i] }} />
                {s.label}: <span className="font-mono">{fmt(s.points[hover][1])}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted">Data table</summary>
        <div className="mt-1 max-h-48 overflow-auto">
          <table className="w-full font-mono">
            <thead>
              <tr className="text-left text-muted">
                <th className="pr-3 font-normal">time</th>
                {metric.series.map((s) => (
                  <th key={s.label} className="pr-3 font-normal">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {xs.map((x, j) => (
                <tr key={x}>
                  <td className="pr-3">{x}</td>
                  {metric.series.map((s) => (
                    <td key={s.label} className="pr-3">
                      {fmt(s.points[j][1])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}

// Round the axis max up to 1, 2 or 5 × a power of ten.
function niceMax(v: number) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v)!
}
