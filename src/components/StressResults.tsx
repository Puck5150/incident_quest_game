import type { RefObject } from 'react'
import Icon from './Icon.tsx'

type Result = {
  tests: { id: string; label: string; pass: boolean; reasons: string[] }[]
  cost: number
  withinBudget: boolean
  pass: boolean
}

export default function StressResults({
  result,
  budget,
  runNumber,
  revealed,
  running,
  stale,
  emptyText,
  titleRef,
  onSkip,
  onSubmit,
  selected,
  onSelect,
}: {
  result?: Result
  budget: number
  runNumber: number
  revealed: number
  running: boolean
  stale: boolean
  emptyText: string
  titleRef: RefObject<HTMLHeadingElement | null>
  onSkip: () => void
  onSubmit: () => void
  selected?: string // test currently shown on the design (canvas only)
  onSelect?: (id: string) => void
}) {
  return (
    <section aria-labelledby="results-h" className="rounded-lg border border-line bg-panel p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="results-h" ref={titleRef} tabIndex={-1} className="font-semibold focus:outline-none">
          Stress tests{runNumber > 0 && <span className="font-normal text-muted"> · run {runNumber}</span>}
        </h2>
        {running && (
          <button onClick={onSkip} className="text-sm text-muted underline underline-offset-2 hover:text-fg">
            Skip
          </button>
        )}
      </div>
      {!result ? (
        <p className="mt-2 text-sm text-muted">{emptyText}</p>
      ) : (
        <>
          {stale && <p className="mt-2 text-sm text-warn">You've changed the design since this run.</p>}
          <ul className="mt-3 space-y-3 text-sm">
            {result.tests.map((t, i) =>
              i < revealed ? (
                <li key={t.id} className="anim-rise">
                  <span className={`flex items-center gap-1.5 font-medium ${t.pass ? 'text-ok' : 'text-crit'}`}>
                    <Icon name={t.pass ? 'check' : 'x'} />
                    {t.pass ? 'Survived' : 'Failed'}: <span className="text-fg">{t.label}</span>
                  </span>
                  {t.reasons.map((r) => (
                    <p key={r} className="mt-0.5 pl-5.5 text-muted">
                      {r}
                    </p>
                  ))}
                  {onSelect && !t.pass && !stale && (
                    <button
                      onClick={() => onSelect(t.id)}
                      aria-pressed={selected === t.id}
                      className="mt-1 ml-5.5 text-xs text-accent underline underline-offset-2 aria-pressed:no-underline aria-pressed:font-medium"
                    >
                      {selected === t.id ? 'Shown on the design' : 'Show on the design'}
                    </button>
                  )}
                </li>
              ) : (
                <li key={t.id} className="flex items-center gap-1.5 text-muted">
                  <span aria-hidden className={`h-2 w-2 rounded-full ${i === revealed ? 'animate-pulse bg-accent' : 'bg-line'}`} />
                  {i === revealed ? 'Running' : 'Queued'}: {t.label}
                </li>
              ),
            )}
            {!running && (
              <li className="anim-rise">
                <span className={`flex items-center gap-1.5 font-medium ${result.withinBudget ? 'text-ok' : 'text-crit'}`}>
                  <Icon name={result.withinBudget ? 'check' : 'x'} />
                  Budget:{' '}
                  <span className="text-fg tabular-nums">
                    {result.cost} / {budget} units
                  </span>
                </span>
              </li>
            )}
          </ul>
          {/* One announcement per run, when it's finished, instead of a live play-by-play. */}
          <p role="status" className="sr-only">
            {!running &&
              `Run ${runNumber}: ${result.tests.filter((t) => t.pass).length} of ${result.tests.length} stress tests passed, ${result.withinBudget ? 'within' : 'over'} budget.`}
          </p>
          {!running && result.pass && !stale && (
            <button
              onClick={onSubmit}
              className="anim-rise mt-4 w-full rounded-md bg-ok px-4 py-2 font-medium text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Submit design
            </button>
          )}
        </>
      )}
    </section>
  )
}
