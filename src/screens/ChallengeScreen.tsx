import { useState } from 'react'
import type { Challenge, Picks } from '../schema/challenge.ts'
import { evaluate, isComplete, type Run } from '../game/challenge.ts'
import HintPanel from '../components/HintPanel.tsx'
import Prose from '../components/Prose.tsx'
import Icon from '../components/Icon.tsx'

// Milestone D2: a plain, fully working design screen. Option cards, live
// diagram and the stress-test sequence get their polish in D3.
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
  const cost = evaluate(c, picks).cost
  // Results describe the design that was tested; once the player changes a
  // pick they're stale, so say so rather than showing old passes.
  const stale = !!last && JSON.stringify(last.picks) !== JSON.stringify(picks)

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
            if (isComplete(c, picks)) setRuns((r) => [...r, { picks, at: Date.now() }])
          }}
        >
          {c.tiers.map((t) => (
            <fieldset key={t.id} className="rounded-lg border border-line bg-panel p-4">
              <legend className="px-1 font-semibold">{t.label}</legend>
              <div className="mt-2 space-y-2">
                {t.options.map((o) => (
                  <label
                    key={o.id}
                    className="flex cursor-pointer gap-3 rounded-md border border-line p-3 has-checked:border-accent"
                  >
                    <input
                      type="radio"
                      name={t.id}
                      value={o.id}
                      checked={picks[t.id] === o.id}
                      onChange={() => setPicks((p) => ({ ...p, [t.id]: o.id }))}
                      className="mt-1 accent-accent"
                    />
                    <span className="flex-1">
                      <span className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium">{o.label}</span>
                        <span className="font-mono text-sm text-muted tabular-nums">{o.cost} units</span>
                      </span>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">
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

          <div className="flex flex-wrap items-center gap-4">
            <button
              type="submit"
              disabled={!isComplete(c, picks)}
              className="rounded-md bg-accent px-4 py-2 font-medium text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            >
              Run stress tests
            </button>
            <p className={`font-mono text-sm tabular-nums ${cost > c.budget ? 'text-crit' : 'text-muted'}`}>
              Cost: {cost} / {c.budget} units
            </p>
          </div>
        </form>

        <div className="space-y-4">
          <section aria-labelledby="results-h" className="rounded-lg border border-line bg-panel p-4" aria-live="polite">
            <h2 id="results-h" className="font-semibold">
              Stress tests{runs.length > 0 && <span className="font-normal text-muted"> · run {runs.length}</span>}
            </h2>
            {!result ? (
              <p className="mt-2 text-sm text-muted">Pick an option for every tier, then run the tests.</p>
            ) : (
              <>
                {stale && <p className="mt-2 text-sm text-warn">You've changed the design since this run.</p>}
                <ul className="mt-3 space-y-3 text-sm">
                  {result.tests.map((t) => (
                    <li key={t.id}>
                      <span className={`flex items-center gap-1.5 font-medium ${t.pass ? 'text-ok' : 'text-crit'}`}>
                        <Icon name={t.pass ? 'check' : 'x'} />
                        {t.pass ? 'Survived' : 'Failed'}: <span className="text-fg">{t.label}</span>
                      </span>
                      {t.reasons.map((r) => (
                        <p key={r} className="mt-0.5 pl-5.5 text-muted">
                          {r}
                        </p>
                      ))}
                    </li>
                  ))}
                  <li>
                    <span className={`flex items-center gap-1.5 font-medium ${result.withinBudget ? 'text-ok' : 'text-crit'}`}>
                      <Icon name={result.withinBudget ? 'check' : 'x'} />
                      Budget: <span className="text-fg tabular-nums">{result.cost} / {c.budget} units</span>
                    </span>
                  </li>
                </ul>
                {result.pass && !stale && (
                  <button
                    onClick={() => onFinished(runs, hints)}
                    className="mt-4 w-full rounded-md bg-ok px-4 py-2 font-medium text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    Submit design
                  </button>
                )}
              </>
            )}
          </section>
          <HintPanel scenario={c} used={hints} onRequest={() => setHints((h) => Math.min(3, h + 1))} />
        </div>
      </div>
    </div>
  )
}
