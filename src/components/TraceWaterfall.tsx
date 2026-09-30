import type { Scenario } from '../schema/scenario.ts'

type Span = NonNullable<Scenario['traces']>[number]['spans'][number]

// One row per span, children under their parent, bars positioned on a
// shared timeline. Like the waterfall view in Jaeger or Grafana Tempo.
export default function TraceWaterfall({ spans }: { spans: Span[] }) {
  const total = Math.max(...spans.map((s) => s.start_ms + s.duration_ms))
  const rows = order(spans)
  const ticks = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div className="overflow-x-auto p-3 text-xs">
      <div className="min-w-[36rem]">
        <div className="mb-1 grid grid-cols-[16rem_minmax(0,1fr)] text-muted" aria-hidden>
          <span>Service · operation</span>
          <div className="relative h-4">
            {ticks.map((t) => (
              <span key={t} className="absolute -translate-x-1/2 font-mono last:-translate-x-full first:translate-x-0" style={{ left: `${t * 100}%` }}>
                {fmt(total * t)}
              </span>
            ))}
          </div>
        </div>
        <ol aria-label="Spans">
          {rows.map(({ span: s, depth }) => {
            const err = s.status === 'error'
            const wide = s.duration_ms / total > 0.3
            const late = (s.start_ms + s.duration_ms) / total > 0.7
            return (
              <li key={s.id} className="grid grid-cols-[16rem_minmax(0,1fr)] items-center border-t border-line py-1.5">
                <div className="pr-2 break-words" style={{ paddingLeft: `${depth}rem` }}>
                  <span className="font-medium">{s.service}</span> <span className="font-mono text-muted">{s.operation}</span>
                  {s.note && <div className="text-muted">{s.note}</div>}
                </div>
                <div className="relative h-5">
                  <div
                    className={`absolute top-0.5 h-4 rounded-sm ${err ? 'bg-crit' : 'bg-series-1'}`}
                    style={{ left: `${(s.start_ms / total) * 100}%`, width: `max(2px, ${(s.duration_ms / total) * 100}%)` }}
                  />
                  {/* Label goes inside a wide bar, else after it, else before it near the right edge. */}
                  <span
                    className={`absolute top-0.5 px-1 font-mono whitespace-nowrap tabular-nums ${wide ? 'text-bg' : ''}`}
                    style={
                      wide
                        ? { left: `${(s.start_ms / total) * 100}%` }
                        : late
                          ? { right: `${100 - (s.start_ms / total) * 100}%` }
                          : { left: `${((s.start_ms + s.duration_ms) / total) * 100}%` }
                    }
                  >
                    {fmt(s.duration_ms)}
                    {err && <span className={wide ? '' : 'text-crit'}> · error</span>}
                  </span>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

// Depth-first: each span followed by its children, sorted by start time.
function order(spans: Span[]) {
  const out: { span: Span; depth: number }[] = []
  const visit = (parent: string | undefined, depth: number) =>
    spans
      .filter((s) => s.parent === parent)
      .sort((a, b) => a.start_ms - b.start_ms)
      .forEach((s) => {
        out.push({ span: s, depth })
        visit(s.id, depth + 1)
      })
  visit(undefined, 0)
  return out
}

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s` : `${Math.round(ms)}ms`)
