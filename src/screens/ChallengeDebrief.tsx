import type { Challenge, Picks } from '../schema/challenge.ts'
import { evaluate, type ChallengeScore } from '../game/challenge.ts'
import Prose from '../components/Prose.tsx'
import Icon from '../components/Icon.tsx'
import CountUp from '../components/CountUp.tsx'

// Milestone D2: plain debrief. D3 brings it in line with the incident debrief.
export default function ChallengeDebrief({
  challenge: c,
  picks,
  score,
  gained,
  onHome,
  onReplay,
}: {
  challenge: Challenge
  picks: Picks
  score: ChallengeScore
  gained: number
  onHome: () => void
  onReplay: () => void
}) {
  const label = (tier: string, opt: string) =>
    c.tiers.find((t) => t.id === tier)?.options.find((o) => o.id === opt)?.label ?? opt
  const mine = evaluate(c, picks)

  return (
    <div className="space-y-6">
      <header className="rounded-lg border border-ok bg-panel p-6">
        <p className="flex items-center gap-1.5 text-sm text-ok">
          <Icon name="check" /> Design accepted
        </p>
        <h1 id="screen-title" tabIndex={-1} className="mt-1 text-2xl font-semibold focus:outline-none">
          {c.title}
        </h1>
        <p className="mt-4 font-mono text-4xl font-semibold text-accent">
          +<CountUp value={gained} /> XP
        </p>
      </header>

      <section className="rounded-lg border border-line bg-panel p-4">
        <h2 className="mb-3 font-semibold">Score breakdown</h2>
        <table className="w-full text-sm">
          <tbody>
            {score.lines.map((l) => (
              <tr key={l.label} className="border-b border-line last:border-0">
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
      </section>

      <section className="rounded-lg border border-line bg-panel p-4">
        <h2 className="mb-3 font-semibold">Your design vs. the reference</h2>
        <ul className="space-y-1 text-sm">
          {c.tiers.map((t) => (
            <li key={t.id}>
              <span className="text-muted">{t.label}: </span>
              {label(t.id, picks[t.id])}
            </li>
          ))}
          <li className="text-muted tabular-nums">Cost: {mine.cost} units</li>
        </ul>
        {mine.overkill.length > 0 && (
          <div className="mt-3 text-sm">
            <h3 className="text-warn">More than the brief needed</h3>
            <ul className="mt-1 list-disc pl-5">
              {mine.overkill.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </div>
        )}
        {c.reference_designs.map((d) => (
          <div key={d.name} className="mt-4 text-sm">
            <h3 className="font-medium">
              {d.name} <span className="font-normal text-muted tabular-nums">({evaluate(c, d.picks).cost} units)</span>
            </h3>
            <ul className="mt-1 space-y-0.5">
              {c.tiers.map((t) => (
                <li key={t.id}>
                  <span className="text-muted">{t.label}: </span>
                  {label(t.id, d.picks[t.id])}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-muted">{d.why}</p>
          </div>
        ))}
      </section>

      <section className="rounded-lg border border-line bg-panel p-4">
        <h2 className="mb-3 font-semibold">What this teaches</h2>
        <Prose text={c.debrief.summary} />
        {c.debrief.real_world && <Prose className="mt-3" text={c.debrief.real_world} />}
      </section>

      <section className="rounded-lg border border-line bg-panel p-4">
        <h2 className="mb-3 font-semibold">Analogy: {c.analogy.title}</h2>
        <Prose text={c.analogy.text} />
      </section>

      <section className="rounded-lg border border-line bg-panel p-4">
        <h2 className="mb-3 font-semibold">Learn more (official docs)</h2>
        <ul className="space-y-1 text-sm">
          {c.sources.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
                {s.title}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

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
