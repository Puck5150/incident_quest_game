import { artifacts } from '../schema/constants.ts'
import type { Scenario } from '../schema/scenario.ts'
import { commandsHit, evidenceSeen, type GameEvent } from '../game/engine.ts'
import CommandBreakdown from '../components/CommandBreakdown.tsx'
import type { Breakdown } from '../schema/commands.ts'
import { atStage, stageCount } from '../schema/stages.ts'
import Prose from '../components/Prose.tsx'
import Icon from '../components/Icon.tsx'
import Card from '../components/Card.tsx'
import { mmss } from '../game/format.ts'
import ScoreTable from '../components/ScoreTable.tsx'
import ResultHeader from '../components/ResultHeader.tsx'
import type { Score } from '../game/scoring.ts'

export default function DebriefScreen({
  scenario,
  log,
  score,
  gained,
  rankUp,
  cleared,
  unlocked,
  streak,
  onHome,
  onTree,
  onReplay,
  homeLabel = 'Back to ops board',
  breakdown,
}: {
  scenario: Scenario
  log: GameEvent[]
  score: Score
  gained: number
  rankUp?: string
  cleared?: string
  unlocked: string[]
  streak: number
  onHome: () => void
  onTree: () => void
  onReplay?: () => void // omitted inside a shift: replays happen from the ops board
  homeLabel?: string
  breakdown?: Breakdown // the build's command breakdown for this incident (absent in preview)
}) {
  const seen = evidenceSeen(scenario, log)
  const start = log[0]?.at ?? 0
  const closes: GameEvent[] = log.filter((e) => e.type === 'CLOSE_INCIDENT')
  const steps = log.filter((e) => e.type !== 'SHELL_RAN').map((e) => ({ at: e.at - start, text: describe(scenario, e, closes.indexOf(e)) }))
  const { debrief, analogy } = scenario
  // Multi-stage incidents: root cause, ideal path and evidence per stage.
  const n = stageCount(scenario)
  const parts = Array.from({ length: n }, (_, k) => ({ k, update: k > 0 ? scenario.stages![k - 1].update : undefined, view: atStage(scenario, k) }))
  const everything = atStage(scenario, n - 1) // all artifacts and commands, for "Where:"
  const stageHeading = (k: number) => n > 1 && <h3 className="mt-3 font-mono text-xs tracking-widest text-muted uppercase first:mt-0">Stage {k + 1}</h3>

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
      <ResultHeader
        status={
          score.relaxed || score.inShift ? (
            'Mission clear'
          ) : (
            <>
              Mission clear in <span className="tabular-nums">{mmss(score.elapsedMs)}</span>
            </>
          )
        }
        title={scenario.title}
        gained={gained}
        total={score.total}
        rankUp={rankUp}
        cleared={cleared}
        unlocked={unlocked}
        streak={streak}
        onTree={onTree}
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Card title="Score breakdown">
          <ScoreTable lines={score.lines} total={score.total} />
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
        {parts.map(({ k, update, view }) => (
          <div key={k}>
            {stageHeading(k)}
            {update && <Prose className="mb-1 text-sm text-muted" text={`Reopened: ${update}`} />}
            <Prose text={view.debrief.root_cause} />
          </div>
        ))}
      </Card>

      {scenario.concepts && (
        <Card title="Concepts">
          <dl className="space-y-3 text-sm">
            {scenario.concepts.map((c) => (
              <div key={c.term}>
                <dt className="font-semibold">{c.term}</dt>
                <dd className="text-muted">
                  {c.text}{' '}
                  <a href={c.url} target="_blank" rel="noreferrer" className="text-accent underline">
                    Docs
                    {' '}<span className="sr-only">for {c.term} (opens in a new tab)</span>
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Card title="Ideal path">
          {parts.map(({ k, view }) => (
            <div key={k}>
              {stageHeading(k)}
              <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                {view.debrief.ideal_path.map((p) => <li key={p}>{p}</li>)}
              </ol>
            </div>
          ))}
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
        {parts.map(({ k, view }) => (
        <div key={k}>
        {stageHeading(k)}
        <ul className="space-y-1.5 text-sm">
          {view.key_evidence.map((tag) => (
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
              {view.evidence_labels[tag]}
              <span className="block pl-5 text-muted">
                Where: <span className="font-mono">{whereIs(everything, tag).join(', ')}</span>
              </span>
            </li>
          ))}
        </ul>
        </div>
        ))}
      </Card>

      {scenario.red_herrings && (
        <Card title="What wasn't the cause">
          <ul className="space-y-2 text-sm">
            {scenario.red_herrings.map((r) => (
              <li key={r.evidence}>
                <span className="font-medium">{r.label}</span>
                {seen.has(r.evidence) && <span className="ml-2 font-mono text-xs text-muted">[you checked it]</span>}
                <span className="block">{r.why}</span>
                <span className="block text-muted">
                  Where: <span className="font-mono">{whereIs(everything, r.evidence).join(', ')}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {breakdown && <CommandBreakdown breakdown={breakdown} notes={scenario.command_notes} ran={commandsHit(scenario, log)} />}

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
              <a href={s.url} target="_blank" rel="noreferrer" aria-label={`${s.title} (opens in a new tab)`} className="text-accent underline underline-offset-2">
                {s.title}
                
              </a>
              <span className="text-muted"> (retrieved {s.retrieved})</span>
            </li>
          ))}
        </ul>
      </Card>

      <div className="flex flex-wrap gap-3">
        <button onClick={onHome} className="rounded-md bg-accent px-4 py-2 font-medium text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          {homeLabel}
        </button>
        {onReplay && (
          <button onClick={onReplay} className="rounded-md border border-line px-4 py-2 hover:border-accent focus-visible:outline-2 focus-visible:outline-accent">
            Replay incident
          </button>
        )}
      </div>
    </div>
  )
}

// `close`: which close-out this is (multi-stage incidents reopen on all but the last).
function describe(scenario: Scenario, e: GameEvent, close: number): string {
  const all = [scenario, ...(scenario.stages ?? [])]
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
      const h = all.flatMap((x) => x.hypotheses).find((x) => x.id === e.id)
      return `Hypothesis: ${h?.text} (${h?.correct ? 'correct' : 'wrong'})`
    }
    case 'TAKE_ACTION': {
      const a = all.flatMap((x) => x.actions).find((x) => x.id === e.id)
      return `Action: ${a?.label}${a?.kind === 'fix' ? '' : ` (${a?.kind})`}`
    }
    case 'SHELL_RAN':
      return '' // part of the command line before it; not a step of its own
    case 'CLOSE_INCIDENT':
      return close < all.length - 1 ? `Closed stage ${close + 1}: reopened` : 'Closed the incident'
  }
}

// Where a piece of evidence could be found. Regex-matched commands show as
// "terminal": a raw regex teaches nothing, and the ideal path names the command.
function whereIs(scenario: Scenario, tag: string): string[] {
  return [...new Set([
    ...(scenario.terminal?.commands ?? []).filter((c) => c.evidence === tag).map((c) => (c.match ? `$ ${c.match}` : 'terminal')),
    ...artifacts(scenario).filter((a) => a.evidence === tag).map((a) => `${a.kind} ${a.name}`),
  ])]
}
