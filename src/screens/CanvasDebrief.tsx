import type { CanvasChallenge, Design } from '../schema/canvas.ts'
import { evaluateCanvas } from '../game/canvas.ts'
import { laneLabel } from '../game/canvasEdit.ts'
import type { ChallengeScore } from '../game/challenge.ts'
import type { CanvasRun } from './CanvasScreen.tsx'
import Prose from '../components/Prose.tsx'
import Icon from '../components/Icon.tsx'
import Card from '../components/Card.tsx'
import ScoreTable from '../components/ScoreTable.tsx'
import ResultHeader from '../components/ResultHeader.tsx'
import Board from '../components/canvas/Board.tsx'

export default function CanvasDebrief({
  challenge: c,
  runs,
  score,
  outcome,
  streak,
  onHome,
  onTree,
  onReplay,
}: {
  challenge: CanvasChallenge
  runs: CanvasRun[]
  score: ChallengeScore
  outcome: { gained: number; rankUp?: string; unlocked: string[] }
  streak: number
  onHome: () => void
  onTree: () => void
  onReplay: () => void
}) {
  const mine = runs.at(-1)!.design
  const final = evaluateCanvas(c, mine)
  const earlier = runs.slice(0, -1).map((r, i) => ({ n: i + 1, e: evaluateCanvas(c, r.design) }))

  return (
    <div className="space-y-6">
      <ResultHeader
        status={runs.length === 1 ? 'Design accepted on the first run' : `Design accepted on run ${runs.length}`}
        title={c.title}
        gained={outcome.gained}
        total={score.total}
        rankUp={outcome.rankUp}
        unlocked={outcome.unlocked}
        streak={streak}
        onTree={onTree}
      />

      <Card title="Score breakdown">
        <ScoreTable lines={score.lines} total={score.total} />
      </Card>

      {/* Side by side on wide screens: the shape you built vs. the reference shape. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-2">
        <Card title={`Your design (${final.cost} units)`}>
          <Board c={c} design={mine} down={none} validTargets={none} readOnly />
          <div className="mt-3">
            <DesignText c={c} d={mine} />
          </div>
          {final.overkill.length > 0 && (
            <div className="mt-3 text-sm">
              <h3 className="flex items-center gap-1.5 text-warn">
                <Icon name="alert" /> More than the brief needed
              </h3>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {final.overkill.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
        {c.reference_designs.map((r) => (
          <Card key={r.name} title={`${r.name} (${evaluateCanvas(c, r.design).cost} units)`}>
            <Board c={c} design={r.design} down={none} validTargets={none} readOnly />
            <p className="mt-3 text-sm text-muted">{r.why}</p>
            <div className="mt-2">
              <DesignText c={c} d={r.design} />
            </div>
          </Card>
        ))}
      </div>

      {earlier.length > 0 && (
        <Card title="What failed along the way">
          <ol className="space-y-3 text-sm">
            {earlier.map(({ n, e }) => (
              <li key={n}>
                <span className="font-medium">Run {n}</span>
                <ul className="mt-1 space-y-1">
                  {e.tests
                    .filter((t) => !t.pass)
                    .map((t) => (
                      <li key={t.id}>
                        <span className="text-crit">{t.label}: </span>
                        <span className="text-muted">{t.reasons.join(' ')}</span>
                      </li>
                    ))}
                  {!e.withinBudget && (
                    <li>
                      <span className="text-crit">Over budget: </span>
                      <span className="text-muted tabular-nums">
                        {e.cost} / {c.budget} units
                      </span>
                    </li>
                  )}
                </ul>
              </li>
            ))}
          </ol>
        </Card>
      )}

      <Card title="What this teaches">
        <Prose text={c.debrief.summary} />
        {c.debrief.real_world && <Prose className="mt-3" text={c.debrief.real_world} />}
      </Card>
      <Card title={`Analogy: ${c.analogy.title}`}>
        <Prose text={c.analogy.text} />
      </Card>
      <Card title="Learn more (official docs)">
        <ul className="space-y-1 text-sm">
          {c.sources.map((s) => (
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
          Back to queue
        </button>
        <button onClick={onReplay} className="rounded-md border border-line px-4 py-2 hover:border-accent focus-visible:outline-2 focus-visible:outline-accent">
          Try another design
        </button>
      </div>
    </div>
  )
}

function DesignText({ c, d }: { c: CanvasChallenge; d: Design }) {
  const byLane = [...new Set(d.nodes.map((n) => n.lane))]
  return (
    <ul className="space-y-1 text-sm">
      {byLane.map((l) => (
        <li key={l}>
          <span className="text-muted">{laneLabel(c, l)}: </span>
          <span className="font-mono">
            {d.nodes
              .filter((n) => n.lane === l)
              .map((n) => n.id)
              .join(', ')}
          </span>
        </li>
      ))}
      {[...new Set(d.edges.filter((e) => e.kind === 'traffic').map((e) => e.from))].map((from) => (
        <li key={`t-${from}`} className="text-muted">
          <span className="font-mono">{from}</span> sends traffic to{' '}
          <span className="font-mono">
            {d.edges
              .filter((e) => e.kind === 'traffic' && e.from === from)
              .map((e) => e.to)
              .join(', ')}
          </span>
        </li>
      ))}
      {d.edges
        .filter((e) => e.kind !== 'traffic')
        .map((e) => (
          <li key={`${e.from}-${e.to}`} className="text-muted">
            <span className="font-mono">{e.from}</span> → <span className="font-mono">{e.to}</span> ({e.kind} replication)
          </li>
        ))}
    </ul>
  )
}

const none = new Set<string>()
