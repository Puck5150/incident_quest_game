import { useReducer, useState } from 'react'
import type { Scenario } from '../schema/scenario.ts'
import { actionsTaken, newSession, step, type Feedback } from '../game/engine.ts'

// Status is never shown by color alone: every tone also has a text label.
const TONE: Record<Feedback['tone'], { label: string; className: string }> = {
  good: { label: 'Correct', className: 'border-ok text-ok' },
  bad: { label: 'Not quite', className: 'border-warn text-warn' },
  danger: { label: 'Harmful', className: 'border-crit text-crit' },
}

const button =
  'rounded-md px-4 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'

export default function IncidentScreen({ scenario }: { scenario: Scenario }) {
  const [session, dispatch] = useReducer(
    (s: ReturnType<typeof newSession>, e: Parameters<typeof step>[2]) => step(scenario, s, e),
    undefined,
    newSession,
  )
  const [picked, setPicked] = useState<string>()
  const taken = actionsTaken(session.log)
  const { phase, feedback } = session

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{scenario.title}</h1>
        <span className="rounded border border-crit px-2 py-0.5 font-mono text-sm text-crit">
          {scenario.ticket.priority}
        </span>
      </header>

      <section aria-labelledby="ticket-h" className="rounded-lg border border-line bg-panel p-4">
        <h2 id="ticket-h" className="text-sm text-muted">
          Ticket from {scenario.ticket.from}
        </h2>
        <p className="mt-2 whitespace-pre-line">{scenario.ticket.body}</p>
        <h3 className="mt-4 text-sm text-muted">Environment</h3>
        <p className="mt-1 whitespace-pre-line">{scenario.environment}</p>
      </section>

      {phase === 'briefing' && (
        <button className={`${button} bg-accent text-bg`} onClick={() => dispatch({ type: 'START', at: Date.now() })}>
          Take incident
        </button>
      )}

      {phase === 'investigating' && (
        <form
          className="rounded-lg border border-line bg-panel p-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (picked) dispatch({ type: 'DECLARE_HYPOTHESIS', id: picked, at: Date.now() })
          }}
        >
          <fieldset className="space-y-2">
            <legend className="mb-2 font-semibold">What's the root cause?</legend>
            {scenario.hypotheses.map((h) => (
              <label key={h.id} className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="hypothesis"
                  value={h.id}
                  checked={picked === h.id}
                  onChange={() => setPicked(h.id)}
                  className="mt-1 accent-accent"
                />
                {h.text}
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={!picked} className={`${button} mt-4 bg-accent text-bg`}>
            Declare hypothesis
          </button>
        </form>
      )}

      {phase === 'acting' && (
        <section aria-labelledby="actions-h" className="rounded-lg border border-line bg-panel p-4">
          <h2 id="actions-h" className="mb-3 font-semibold">
            Take action
          </h2>
          <ul className="space-y-2">
            {scenario.actions.map((a) => {
              const done = a.kind === 'fix' && taken.has(a.id)
              return (
                <li key={a.id}>
                  <button
                    disabled={done}
                    onClick={() => dispatch({ type: 'TAKE_ACTION', id: a.id, at: Date.now() })}
                    className={`${button} w-full border border-line text-left font-mono text-sm hover:border-accent`}
                  >
                    {done ? '✓ ' : ''}
                    {a.label}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {/* aria-live so screen readers announce the result of each choice. */}
      <div role="status" aria-live="polite">
        {feedback && (
          <p className={`rounded-lg border-l-4 bg-panel p-4 ${TONE[feedback.tone].className}`}>
            <strong>{TONE[feedback.tone].label}: </strong>
            <span className="text-fg">{feedback.text}</span>
          </p>
        )}
      </div>

      {phase === 'resolved' && (
        <section className="rounded-lg border border-ok bg-panel p-4">
          <h2 className="text-xl font-semibold text-ok">✓ Incident resolved</h2>
          <p className="mt-2 text-muted">Debrief and scoring arrive in Milestone 4.</p>
        </section>
      )}
    </main>
  )
}
