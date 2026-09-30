import { useReducer, useState } from 'react'
import type { Scenario } from '../schema/scenario.ts'
import { actionsTaken, fixComplete, hintsUsed, newSession, step, type Feedback, type GameEvent, type Session } from '../game/engine.ts'
import Terminal from '../components/Terminal.tsx'
import TextViewer from '../components/TextViewer.tsx'
import HintPanel from '../components/HintPanel.tsx'
import Tabs from '../components/Tabs.tsx'

// Status is never shown by color alone: every tone also has a text label.
const TONE: Record<Feedback['tone'], { label: string; className: string }> = {
  good: { label: 'Correct', className: 'border-ok text-ok' },
  bad: { label: 'Not quite', className: 'border-warn text-warn' },
  danger: { label: 'Harmful', className: 'border-crit text-crit' },
}

const PHASE_LABEL: Record<Session['phase'], string> = {
  briefing: 'New',
  investigating: 'Investigating',
  acting: 'Mitigating',
  resolved: 'Resolved',
}

const button =
  'rounded-md px-4 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'

// Events without the timestamp; `send` stamps them. (The conditional type
// applies Omit to each event type separately; Omit on a union loses fields.)
type WithoutAt<E> = E extends GameEvent ? Omit<E, 'at'> : never
type Intent = WithoutAt<GameEvent>

export default function IncidentScreen({
  scenario,
  onResolved,
}: {
  scenario: Scenario
  onResolved: (log: GameEvent[]) => void
}) {
  const [session, dispatch] = useReducer((s: Session, e: GameEvent) => step(scenario, s, e), undefined, newSession)
  const send = (e: Intent) => dispatch({ ...e, at: Date.now() } as GameEvent)
  const [picked, setPicked] = useState<string>()
  const taken = actionsTaken(session.log)
  const { phase, feedback } = session

  // Closing hands the finished log to App for scoring. `step` is pure, so
  // running it here too gives exactly the log the reducer will store.
  function close() {
    const next = step(scenario, session, { type: 'CLOSE_INCIDENT', at: Date.now() })
    if (next.phase === 'resolved') onResolved(next.log)
  }

  const tools = [
    scenario.terminal && {
      id: 'terminal',
      label: 'Terminal',
      panel: <Terminal scenario={scenario} taken={taken} onRun={(input) => send({ type: 'RUN_COMMAND', input })} />,
    },
    scenario.logs && {
      id: 'logs',
      label: 'Logs',
      panel: (
        <TextViewer
          kind="log"
          items={scenario.logs.map((l) => ({ name: l.name, content: l.lines }))}
          onOpen={(name) => send({ type: 'OPEN_ARTIFACT', kind: 'log', name })}
        />
      ),
    },
    scenario.files && {
      id: 'files',
      label: 'Files',
      panel: (
        <TextViewer
          kind="file"
          items={scenario.files.map((f) => ({ name: f.path, content: f.content }))}
          onOpen={(name) => send({ type: 'OPEN_ARTIFACT', kind: 'file', name })}
        />
      ),
    },
  ].filter((t) => !!t)

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{scenario.title}</h1>
        <span className="rounded border border-crit px-2 py-0.5 font-mono text-sm text-crit">
          {scenario.ticket.priority}
        </span>
        <span className="rounded border border-line px-2 py-0.5 text-sm text-muted">{PHASE_LABEL[phase]}</span>
      </header>

      <section aria-labelledby="ticket-h" className="rounded-lg border border-line bg-panel p-4">
        <h2 id="ticket-h" className="text-sm text-muted">
          Ticket from {scenario.ticket.from}
        </h2>
        <p className="mt-2 whitespace-pre-line">{scenario.ticket.body}</p>
        <h3 className="mt-4 text-sm text-muted">Environment</h3>
        <p className="mt-1 whitespace-pre-line">{scenario.environment}</p>
      </section>

      {phase === 'briefing' ? (
        <button className={`${button} bg-accent text-bg`} onClick={() => send({ type: 'START' })}>
          Take incident
        </button>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <Tabs label="Investigation tools" tabs={tools} />

          <div className="space-y-4">
            {phase === 'investigating' && (
              <form
                className="rounded-lg border border-line bg-panel p-4"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (picked) send({ type: 'DECLARE_HYPOTHESIS', id: picked })
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
                          onClick={() => send({ type: 'TAKE_ACTION', id: a.id })}
                          className={`${button} w-full border border-line text-left font-mono text-sm hover:border-accent`}
                        >
                          {done ? '✓ ' : ''}
                          {a.label}
                        </button>
                      </li>
                    )
                  })}
                </ul>
                {fixComplete(scenario, session.log) && (
                  <button className={`${button} mt-4 w-full bg-ok text-bg`} onClick={close}>
                    Close incident
                  </button>
                )}
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

            <HintPanel scenario={scenario} used={hintsUsed(session.log)} onRequest={() => send({ type: 'REQUEST_HINT' })} />
          </div>
        </div>
      )}
    </div>
  )
}
