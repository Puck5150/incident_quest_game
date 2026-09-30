import type { Challenge } from '../schema/challenge.ts'
import { evaluate, type ChallengeScore, type Run } from '../game/challenge.ts'
import Prose from '../components/Prose.tsx'
import Icon from '../components/Icon.tsx'
import Card from '../components/Card.tsx'
import ScoreTable from '../components/ScoreTable.tsx'
import ResultHeader from '../components/ResultHeader.tsx'
import CrossCloudCard, { type CrossCloud } from '../components/CrossCloud.tsx'

export default function ChallengeDebrief({
  challenge: c,
  runs,
  score,
  outcome,
  streak,
  onHome,
  onTree,
  onReplay,
  crossCloud,
}: {
  challenge: Challenge
  runs: Run[]
  score: ChallengeScore
  outcome: { gained: number; rankUp?: string; unlocked: string[] }
  streak: number
  onHome: () => void
  onTree: () => void
  onReplay: () => void
  crossCloud?: CrossCloud // "pick your cloud" challenges only
}) {
  const picks = runs.at(-1)!.picks
  const mine = evaluate(c, picks)
  const option = (tier: string, id: string) => c.tiers.find((t) => t.id === tier)?.options.find((o) => o.id === id)
  const earlier = runs.slice(0, -1).map((r, i) => ({ n: i + 1, e: evaluate(c, r.picks) }))

  const wentWell = [
    score.firstRunPass && 'Your first design passed every stress test.',
    score.lean && 'You met the brief without paying for more than it asked.',
    score.clean && 'No hints.',
  ].filter(Boolean)
  const improve = [
    runs.length > 1 && 'Reason from the option facts before testing. Each extra run cost XP, just like guessing in an incident.',
    mine.overkill.length > 0 && 'Parts of your design go beyond the brief. Extra resilience costs money and complexity; match it to the requirements.',
  ].filter(Boolean)

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

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <Card title="Score breakdown">
          <ScoreTable lines={score.lines} total={score.total} />
        </Card>
        <Card title="How you did">
          {wentWell.length > 0 && (
            <>
              <h3 className="text-sm text-ok">Went well</h3>
              <ul className="mt-1 mb-3 list-disc space-y-1 pl-5 text-sm">
                {wentWell.map((t) => (
                  <li key={t as string}>{t}</li>
                ))}
              </ul>
            </>
          )}
          {improve.length > 0 && (
            <>
              <h3 className="text-sm text-warn">Next time</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {improve.map((t) => (
                  <li key={t as string}>{t}</li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      <Card title="Your design vs. the reference">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-muted">
                <th className="py-1.5 pr-3 font-normal">Tier</th>
                <th className="py-1.5 pr-3 font-normal">Yours</th>
                {c.reference_designs.map((d) => (
                  <th key={d.name} className="py-1.5 pr-3 font-normal">
                    {d.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {c.tiers.map((t) => (
                <tr key={t.id} className="border-b border-line">
                  <td className="py-1.5 pr-3 text-muted">{t.label}</td>
                  <td className="py-1.5 pr-3">{option(t.id, picks[t.id])?.label}</td>
                  {c.reference_designs.map((d) => (
                    <td key={d.name} className="py-1.5 pr-3">
                      <span className="flex items-start gap-1.5">
                        {d.picks[t.id] === picks[t.id] && (
                          <Icon name="check" className="mt-0.5 h-3.5 w-3.5 text-ok" />
                        )}
                        {option(t.id, d.picks[t.id])?.label}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td className="py-1.5 pr-3 text-muted">Cost</td>
                <td className="py-1.5 pr-3 font-mono tabular-nums">{mine.cost} units</td>
                {c.reference_designs.map((d) => (
                  <td key={d.name} className="py-1.5 pr-3 font-mono tabular-nums">
                    {evaluate(c, d.picks).cost} units
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        {c.reference_designs.map((d) => (
          <p key={d.name} className="mt-3 text-sm">
            <span className="font-medium">{d.name}: </span>
            <span className="text-muted">{d.why}</span>
          </p>
        ))}
        {mine.overkill.length > 0 && (
          <div className="mt-4 text-sm">
            <h3 className="flex items-center gap-1.5 text-warn">
              <Icon name="alert" /> More than the brief needed
            </h3>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {mine.overkill.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {crossCloud && <CrossCloudCard data={crossCloud} />}

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
