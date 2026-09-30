import type { CSSProperties, ReactNode } from 'react'
import Icon from './Icon.tsx'
import CountUp from './CountUp.tsx'

// The resolve moment, shared by incident and challenge debriefs: an all-clear
// scan crosses the header, XP counts up, then promotion and unlocks land.
export default function ResultHeader({
  status,
  title,
  gained,
  total,
  rankUp,
  unlocked,
  streak,
  onTree,
}: {
  status: ReactNode
  title: string
  gained: number
  total: number
  rankUp?: string
  unlocked: string[]
  streak: number
  onTree: () => void
}) {
  return (
    <header className="relative overflow-hidden rounded-lg border border-ok bg-panel p-6">
      <div aria-hidden className="anim-sweep pointer-events-none absolute inset-0 bg-ok/10 opacity-0" />
      <p className="flex items-center gap-1.5 text-sm text-ok">
        <Icon name="check" /> {status}
      </p>
      <h1 id="screen-title" tabIndex={-1} className="mt-1 text-2xl font-semibold focus:outline-none">
        {title}
      </h1>
      <p className="mt-4 font-mono text-4xl font-semibold text-accent">
        +<CountUp value={gained} /> XP
      </p>
      {gained < total && (
        <p className="mt-1 text-sm text-muted">
          Scored <span className="tabular-nums">{total}</span>. Replays only earn the improvement over your best.
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        {rankUp && (
          <strong
            className="anim-rise flex items-center gap-1.5 rounded-md border border-warn px-2.5 py-1 text-warn"
            style={{ '--delay': '1150ms' } as CSSProperties}
          >
            <Icon name="star" /> Promoted to {rankUp}
          </strong>
        )}
        {unlocked.map((t, i) => (
          <button
            key={t}
            onClick={onTree}
            className="anim-rise anim-power-on flex items-center gap-1.5 rounded-md border border-ok px-2.5 py-1 font-medium text-ok focus-visible:outline-2 focus-visible:outline-accent"
            style={{ '--delay': `${1300 + i * 150}ms` } as CSSProperties}
          >
            <Icon name="unlock" /> Track unlocked: {t}
          </button>
        ))}
        <span className="text-muted">
          Clean streak: <span className="tabular-nums">{streak}</span>
        </span>
      </div>
    </header>
  )
}
