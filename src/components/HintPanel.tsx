import { HINT_TIERS } from '../game/engine.ts'
import Prose from './Prose.tsx'

// Hints unlock one tier at a time. The analogy arrives with the "direction"
// tier: it explains the concept, which is a big clue on its own.
// Takes just what it shows, so incidents and design challenges can share it.
export default function HintPanel({
  scenario,
  used,
  onRequest,
}: {
  scenario: { hints: Record<'nudge' | 'direction' | 'answer', string>; analogy: { title: string; text: string } }
  used: number
  onRequest: () => void
}) {
  const next = HINT_TIERS[used]
  return (
    <section aria-labelledby="hints-h" className="rounded-lg border border-line bg-panel p-4">
      <h2 id="hints-h" className="mb-2 font-semibold">
        Ask HQ
      </h2>
      <ol className="space-y-3 text-sm">
        {HINT_TIERS.slice(0, used).map((t) => (
          <li key={t.key}>
            <span className="text-muted">{t.label}: </span>
            {scenario.hints[t.key]}
            {t.key === 'direction' && (
              <div className="mt-2 border-l-2 border-accent pl-3">
                <p className="text-muted">Think of it like {scenario.analogy.title.toLowerCase()}:</p>
                <Prose text={scenario.analogy.text} />
              </div>
            )}
          </li>
        ))}
      </ol>
      {next ? (
        <button
          onClick={onRequest}
          className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          Show {next.label.toLowerCase()} hint (−{next.cost}% XP)
        </button>
      ) : (
        <p className="mt-3 text-sm text-muted">No hints left.</p>
      )}
    </section>
  )
}
