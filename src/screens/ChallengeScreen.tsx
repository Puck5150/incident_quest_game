import { useState } from 'react'
import type { Challenge, Picks } from '../schema/challenge.ts'
import { evaluate, isComplete, type Run } from '../game/challenge.ts'
import StressResults from '../components/StressResults.tsx'
import CostMeter from '../components/CostMeter.tsx'
import { useStressRun } from '../components/useStressRun.ts'
import HintPanel from '../components/HintPanel.tsx'
import FieldGuide from '../components/FieldGuide.tsx'
import Prose from '../components/Prose.tsx'
import Diagram from '../components/Diagram.tsx'

export default function ChallengeScreen({
  challenge: c,
  onFinished,
}: {
  challenge: Challenge
  onFinished: (runs: Run[], hintsUsed: number) => void
}) {
  const [picks, setPicks] = useState<Picks>({})
  const [runs, setRuns] = useState<Run[]>([])
  const [hints, setHints] = useState(0)

  const last = runs.at(-1)
  const result = last && evaluate(c, last.picks)
  const current = evaluate(c, picks)
  const { revealed, running, titleRef, start, skip } = useStressRun(result?.tests.length ?? 0)
  // Results describe the design that was tested; once a pick changes they're stale.
  const stale = !!last && JSON.stringify(last.picks) !== JSON.stringify(picks)

  function run() {
    if (!isComplete(c, picks)) return
    setRuns((r) => [...r, { picks, at: Date.now() }])
    start(c.stress_tests.length)
  }

  // Diagram: users -> one box per tier, showing the current pick. While a run
  // plays, boxes that break a revealed test go down.
  const shown = result && !stale ? result.tests.slice(0, revealed) : []
  const failedOptions = new Set(shown.flatMap((t) => t.failing))
  const diagram = {
    nodes: [
      { id: 'users', label: 'users', col: 0, row: 0, status: 'idle' as const },
      // One tier per row, so the diagram fits the narrow side column.
      ...c.tiers.map((t, i) => {
        const o = t.options.find((x) => x.id === picks[t.id])
        return {
          id: t.id,
          label: o ? (o.short ?? o.label.slice(0, 20)) : `${t.label}?`,
          col: 0,
          row: i + 1,
          status: !o || shown.length === 0 ? ('idle' as const) : failedOptions.has(o.id) ? ('down' as const) : ('ok' as const),
        }
      }),
    ],
    edges: c.tiers.map((t, i) => ({ from: i === 0 ? 'users' : c.tiers[i - 1].id, to: t.id })),
  }


  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
          {c.title}
        </h1>
        <span className="rounded border border-accent px-2 py-0.5 text-sm text-accent">Design challenge</span>
        <span className="rounded border border-line px-2 py-0.5 font-mono text-sm text-muted uppercase">{c.provider}</span>
      </header>

      <section aria-labelledby="brief-h" className="rounded-lg border border-line bg-panel p-4">
        <h2 id="brief-h" className="text-sm text-muted">
          Brief
        </h2>
        <Prose className="mt-2" text={c.brief} />
        <h3 className="mt-4 text-sm text-muted">Requirements</h3>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {c.requirements.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            run()
          }}
        >
          {c.tiers.map((t) => (
            <fieldset key={t.id} className="rounded-lg border border-line bg-panel p-4">
              <legend className="px-1 font-semibold">{t.label}</legend>
              <div className="mt-2 grid gap-2">
                {t.options.map((o) => (
                  <label
                    key={o.id}
                    className="flex cursor-pointer gap-3 rounded-md border border-line p-3 hover:border-accent/60 has-checked:border-accent has-checked:bg-accent/5 has-focus-visible:outline-2 has-focus-visible:outline-accent"
                  >
                    <input
                      type="radio"
                      name={t.id}
                      value={o.id}
                      checked={picks[t.id] === o.id}
                      onChange={() => setPicks((p) => ({ ...p, [t.id]: o.id }))}
                      className="mt-1 accent-accent focus:outline-none"
                    />
                    <span className="flex-1">
                      <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="font-medium">{o.label}</span>
                        <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-xs text-muted tabular-nums">
                          {o.cost} {o.cost === 1 ? 'unit' : 'units'}
                        </span>
                      </span>
                      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm text-muted">
                        {o.facts.map((f) => (
                          <li key={f}>{f}</li>
                        ))}
                      </ul>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}

          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-panel p-4">
            <CostMeter cost={current.cost} budget={c.budget} />
            <button
              type="submit"
              disabled={!isComplete(c, picks) || running}
              className="rounded-md bg-accent px-4 py-2 font-medium text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            >
              {runs.length ? 'Run stress tests again' : 'Run stress tests'}
            </button>
          </div>
        </form>

        {/* Sticky on wide screens so the diagram stays in view while tests run. */}
        <div className="space-y-4 self-start lg:sticky lg:top-4">
          <section aria-labelledby="design-h" className="rounded-lg border border-line bg-panel p-4">
            <h2 id="design-h" className="mb-2 font-semibold">
              Your design
            </h2>
            <Diagram diagram={diagram} label="Your design" />
          </section>
          <StressResults
            result={result}
            budget={c.budget}
            runNumber={runs.length}
            revealed={revealed}
            running={running}
            stale={stale}
            emptyText="Pick an option for every tier, then run the tests."
            titleRef={titleRef}
            onSkip={skip}
            onSubmit={() => onFinished(runs, hints)}
          />
          <FieldGuide mode="design" />
          <HintPanel scenario={c} used={hints} onRequest={() => setHints((h) => Math.min(3, h + 1))} />
        </div>
      </div>
    </div>
  )
}

