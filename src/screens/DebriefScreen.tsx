import type { ReactNode } from 'react'
import { artifacts, type Scenario } from '../schema/scenario.ts'
import { evidenceSeen, type GameEvent } from '../game/engine.ts'
import Prose from '../components/Prose.tsx'
import type { Score } from '../game/scoring.ts'

export default function DebriefScreen({
  scenario,
  log,
  score,
  gained,
  rankUp,
  streak,
  onHome,
  onReplay,
}: {
  scenario: Scenario
  log: GameEvent[]
  score: Score
  gained: number
  rankUp?: string
  streak: number
  onHome: () => void
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
      <header className="rounded-lg border border-ok bg-panel p-6">
        <p className="text-sm text-ok">✓ Incident resolved in {mmss(score.elapsedMs)}</p>
        <h1 className="mt-1 text-2xl font-semibold">{scenario.title}</h1>
        <p className="mt-4 font-mono text-4xl font-semibold text-accent">+{gained} XP</p>
        {gained < score.total && (
          <p className="mt-1 text-sm text-muted">
            Scored {score.total}. Replays only earn the improvement over your best.
          </p>
        )}
        <p className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {rankUp && <strong className="text-warn">★ Promoted to {rankUp}</strong>}
          <span className="text-muted">Clean streak: {streak}</span>
        </p>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Card title="Score breakdown">
          <table className="w-full text-sm">
            <tbody>
              {score.lines.map((l) => (
                <tr key={l.label} className="border-b border-line last:border-0">
                  <td className="py-1.5">{l.label}</td>
                  <td className={`py-1.5 text-right font-mono ${l.xp < 0 ? 'text-crit' : 'text-ok'}`}>
                    {l.xp > 0 ? '+' : ''}
                    {l.xp}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th className="pt-2 text-left">Total</th>
                <td className="pt-2 text-right font-mono font-semibold">{score.total}</td>
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
                <span className="text-muted">{mmss(s.at)}</span>
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
              {seen.has(tag) ? <span className="text-ok">✓ Found</span> : <span className="text-warn">✗ Missed</span>}{' '}
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
      return `Hypothesis: ${h?.text} ${h?.correct ? '✓' : '✗'}`
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
