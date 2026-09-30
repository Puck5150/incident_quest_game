import type { CSSProperties, ReactNode } from 'react'
import { artifacts, type Scenario } from '../schema/scenario.ts'
import { evidenceSeen, type GameEvent } from '../game/engine.ts'
import Prose from '../components/Prose.tsx'
import Icon from '../components/Icon.tsx'
import CountUp from '../components/CountUp.tsx'
import type { Score } from '../game/scoring.ts'

export default function DebriefScreen({
  scenario,
  log,
  score,
  gained,
  rankUp,
  unlocked,
  streak,
  onHome,
  onTree,
  onReplay,
}: {
  scenario: Scenario
  log: GameEvent[]
  score: Score
  gained: number
  rankUp?: string
  unlocked: string[]
  streak: number
  onHome: () => void
  onTree: () => void
  onReplay: () => void
}) {
  const seen = evidenceSeen(scenario, log)
  const start = log[0]?.at ?? 0
  const steps = log.map((e) => ({ at: e.at - start, text: describe(scenario, e) }))
  const { debrief, analogy } = scenario

  const wentWell = [
    score.methodical && 'You found all the key evidence before deciding on a cause.',
    score.verified && 'You verified the fix before closing the incident.',
    score.clean && 'No hints and nothing destructive: a clean resolution.',
    score.mistakes.wrongHypotheses === 0 && 'Your first hypothesis was right.',
  ].filter(Boolean)
  const improve = [
    !score.methodical && 'Gather all the key evidence before committing to a root cause.',
    !score.verified && 'After fixing, re-run a check to prove the system is healthy before closing.',
    score.mistakes.destructive > 0 &&
      'A destructive action cost you. In real life, that means extra downtime or lost data.',
  ].filter(Boolean)

  return (
    <div className="space-y-6">
      {/* The resolve moment: an all-clear scan crosses the header, XP counts
          up, then promotion and unlocks land once the count finishes. */}
      <header className="relative overflow-hidden rounded-lg border border-ok bg-panel p-6">
        <div aria-hidden className="anim-sweep pointer-events-none absolute inset-0 bg-ok/10 opacity-0" />
        <p className="flex items-center gap-1.5 text-sm text-ok">
          <Icon name="check" /> Incident resolved in <span className="tabular-nums">{mmss(score.elapsedMs)}</span>
        </p>
        <h1 id="screen-title" tabIndex={-1} className="mt-1 text-2xl font-semibold focus:outline-none">
          {scenario.title}
        </h1>
        <p className="mt-4 font-mono text-4xl font-semibold text-accent">
          +<CountUp value={gained} /> XP
        </p>
        {gained < score.total && (
          <p className="mt-1 text-sm text-muted">
            Scored <span className="tabular-nums">{score.total}</span>. Replays only earn the improvement over your best.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          {rankUp && (
            <strong className="anim-rise flex items-center gap-1.5 rounded-md border border-warn px-2.5 py-1 text-warn" style={{ '--delay': '1150ms' } as CSSProperties}>
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

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Card title="Score breakdown">
          <table className="w-full text-sm">
            <tbody>
              {score.lines.map((l, i) => (
                <tr
                  key={l.label}
                  className="anim-rise border-b border-line last:border-0"
                  style={{ '--delay': `${300 + Math.min(i, 8) * 60}ms` } as CSSProperties}
                >
                  <td className="py-1.5">{l.label}</td>
                  <td className={`py-1.5 text-right font-mono tabular-nums ${l.xp < 0 ? 'text-crit' : 'text-ok'}`}>
                    {l.xp > 0 ? '+' : ''}
                    {l.xp}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th className="pt-2 text-left">Total</th>
                <td className="pt-2 text-right font-mono font-semibold tabular-nums">{score.total}</td>
              </tr>
            </tfoot>
          </table>
        </Card>

        <Card title="How you did">
          {wentWell.length > 0 && (
            <>
              <h3 className="text-sm text-ok">Went well</h3>
              <ul className="mt-1 mb-3 list-disc space-y-1 pl-5 text-sm">
                {wentWell.map((t) => <li key={t as string}>{t}</li>)}
              </ul>
            </>
          )}
          {improve.length > 0 && (
            <>
              <h3 className="text-sm text-warn">Next time</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {improve.map((t) => <li key={t as string}>{t}</li>)}
              </ul>
            </>
          )}
        </Card>
      </div>

      <Card title="Root cause">
        <Prose text={debrief.root_cause} />
      </Card>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Card title="Ideal path">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            {debrief.ideal_path.map((p) => <li key={p}>{p}</li>)}
          </ol>
        </Card>
        <Card title="Your path">
          <ol className="max-h-80 space-y-1 overflow-auto font-mono text-xs">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="text-muted tabular-nums">{mmss(s.at)}</span>
                <span>{s.text}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Card title="Key evidence">
        <ul className="space-y-1.5 text-sm">
          {scenario.key_evidence.map((tag) => (
            <li key={tag}>
              {seen.has(tag) ? (
                <span className="inline-flex items-center gap-1 text-ok">
                  <Icon name="check" className="h-3.5 w-3.5" /> Found
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-warn">
                  <Icon name="x" className="h-3.5 w-3.5" /> Missed
                </span>
              )}{' '}
              <span className="font-mono">{tag}</span>
              <span className="text-muted"> in </span>
              <span className="font-mono text-muted">{whereIs(scenario, tag).join(', ')}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={`Analogy: ${analogy.title}`}>
        <Prose text={analogy.text} />
      </Card>

      {debrief.real_world && (
        <Card title="In the real world">
          <Prose text={debrief.real_world} />
        </Card>
      )}

      <Card title="Learn more (official docs)">
        <ul className="space-y-1 text-sm">
          {scenario.sources.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
                {s.title}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              <span className="text-muted"> (retrieved {s.retrieved})</span>
            </li>
          ))}
        </ul>
      </Card>

      <div className="flex flex-wrap gap-3">
        <button onClick={onHome} className="rounded-md bg-accent px-4 py-2 font-medium text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          Back to queue
        </button>
        <button onClick={onReplay} className="rounded-md border border-line px-4 py-2 hover:border-accent focus-visible:outline-2 focus-visible:outline-accent">
          Replay incident
        </button>
      </div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel p-4">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
    </section>
  )
}

const mmss = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function describe(scenario: Scenario, e: GameEvent): string {
  switch (e.type) {
    case 'START':
      return 'Took the incident'
    case 'RUN_COMMAND':
      return `$ ${e.input}`
    case 'OPEN_ARTIFACT':
      return `Opened ${e.kind} ${e.name}`
    case 'REQUEST_HINT':
      return 'Asked for a hint'
    case 'DECLARE_HYPOTHESIS': {
      const h = scenario.hypotheses.find((x) => x.id === e.id)
      return `Hypothesis: ${h?.text} (${h?.correct ? 'correct' : 'wrong'})`
    }
    case 'TAKE_ACTION': {
      const a = scenario.actions.find((x) => x.id === e.id)
      return `Action: ${a?.label}${a?.kind === 'fix' ? '' : ` (${a?.kind})`}`
    }
    case 'CLOSE_INCIDENT':
      return 'Closed the incident'
  }
}

// Where a piece of evidence could be found, for the "missed" list.
function whereIs(scenario: Scenario, tag: string): string[] {
  return [
    ...(scenario.terminal?.commands ?? []).filter((c) => c.evidence === tag).map((c) => `$ ${c.match ?? c.match_regex}`),
    ...artifacts(scenario).filter((a) => a.evidence === tag).map((a) => `${a.kind} ${a.name}`),
  ]
}
