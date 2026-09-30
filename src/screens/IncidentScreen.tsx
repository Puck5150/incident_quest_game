import { useReducer, useState } from 'react'
import type { Scenario } from '../schema/scenario.ts'
import { actionsTaken, fixComplete, hintsUsed, newSession, step, type Feedback, type GameEvent, type Session } from '../game/engine.ts'
import Terminal from '../components/Terminal.tsx'
import Browser from '../components/Browser.tsx'
import TextView from '../components/TextView.tsx'
import Diagram from '../components/Diagram.tsx'
import TraceWaterfall from '../components/TraceWaterfall.tsx'
import MetricChart from '../components/MetricChart.tsx'
import PipelineView from '../components/PipelineView.tsx'
import HintPanel from '../components/HintPanel.tsx'
import Tabs from '../components/Tabs.tsx'
import Prose from '../components/Prose.tsx'
import Icon, { type IconName } from '../components/Icon.tsx'

// Status is never shown by color alone: every tone also has a text label.
const TONE: Record<Feedback['tone'], { label: string; className: string; icon: IconName }> = {
  good: { label: 'Correct', className: 'border-ok/60 text-ok', icon: 'check' },
  bad: { label: 'Not quite', className: 'border-warn/60 text-warn', icon: 'alert' },
  danger: { label: 'Harmful', className: 'border-crit/60 text-crit', icon: 'x' },
}

// The phase pill doubles as the incident's status light.
const PHASE: Record<Session['phase'], { label: string; dot: string }> = {
  briefing: { label: 'New', dot: 'bg-crit' },
  investigating: { label: 'Investigating', dot: 'bg-warn' },
  acting: { label: 'Mitigating', dot: 'bg-accent' },
  resolved: { label: 'Resolved', dot: 'bg-ok' },
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
  // Authors list the right answer first; shuffle once per attempt so order isn't a tell.
  const [hypotheses] = useState(() => shuffle(scenario.hypotheses))
  const [actions] = useState(() => shuffle(scenario.actions))
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
        <Browser
          noun="log"
          onOpen={(name) => send({ type: 'OPEN_ARTIFACT', kind: 'log', name })}
          items={scenario.logs.map((l) => ({ name: l.name, render: () => <TextView content={l.lines} isLog /> }))}
        />
      ),
    },
    scenario.files && {
      id: 'files',
      label: 'Files',
      panel: (
        <Browser
          noun="file"
          onOpen={(name) => send({ type: 'OPEN_ARTIFACT', kind: 'file', name })}
          items={scenario.files.map((f) => ({ name: f.path, render: () => <TextView content={f.content} /> }))}
        />
      ),
    },
    scenario.traces && {
      id: 'traces',
      label: 'Traces',
      panel: (
        <Browser
          noun="trace"
          onOpen={(name) => send({ type: 'OPEN_ARTIFACT', kind: 'trace', name })}
          items={scenario.traces.map((t) => ({ name: t.name, render: () => <TraceWaterfall spans={t.spans} /> }))}
        />
      ),
    },
    scenario.metrics && {
      id: 'metrics',
      label: 'Metrics',
      panel: (
        <Browser
          noun="metric"
          onOpen={(name) => send({ type: 'OPEN_ARTIFACT', kind: 'metric', name })}
          items={scenario.metrics.map((m) => ({ name: m.name, render: () => <MetricChart metric={m} /> }))}
        />
      ),
    },
    scenario.pipeline && {
      id: 'pipeline',
      label: 'Pipeline',
      panel: <PipelineView pipeline={scenario.pipeline} onOpen={(name) => send({ type: 'OPEN_ARTIFACT', kind: 'stage', name })} />,
    },
  ].filter((t) => !!t)

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
          {scenario.title}
        </h1>
        <span className="rounded border border-crit px-2 py-0.5 font-mono text-sm text-crit">
          {scenario.ticket.priority}
        </span>
        <span className="flex items-center gap-2 rounded border border-line px-2 py-0.5 text-sm text-muted">
          <span aria-hidden className={`h-2 w-2 rounded-full ${PHASE[phase].dot}`} />
          {PHASE[phase].label}
        </span>
      </header>

      <section aria-labelledby="ticket-h" className="rounded-lg border border-line bg-panel p-4">
        <h2 id="ticket-h" className="text-sm text-muted">
          Ticket from {scenario.ticket.from}
        </h2>
        <Prose className="mt-2" text={scenario.ticket.body} />
        {/* Full context while briefing; tucked away once work starts so the
            tools sit near the top of the screen. */}
        <details open={phase === 'briefing'} className="group mt-3">
          <summary className="cursor-pointer text-sm text-muted hover:text-fg">
            Environment{scenario.diagram && ' and system diagram'}
          </summary>
          <Prose className="mt-2" text={scenario.environment} />
          {scenario.diagram && (
            <div className="mt-4">
              <h3 className="mb-2 text-sm text-muted">System diagram (current monitoring status)</h3>
              <Diagram diagram={scenario.diagram} />
            </div>
          )}
        </details>
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
                  {hypotheses.map((h) => (
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
                  {actions.map((a) => {
                    const done = a.kind === 'fix' && taken.has(a.id)
                    return (
                      <li key={a.id}>
                        <button
                          disabled={done}
                          onClick={() => send({ type: 'TAKE_ACTION', id: a.id })}
                          className={`${button} w-full border border-line text-left font-mono text-sm hover:border-accent`}
                        >
                          <span className="flex items-start gap-2">
                            {done && <Icon name="check" className="mt-0.5 h-4 w-4 text-ok" />}
                            {a.label}
                          </span>
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
                <p
                  key={session.log.length}
                  className={`anim-rise flex gap-2.5 rounded-lg border bg-panel p-4 ${TONE[feedback.tone].className}`}
                >
                  <Icon name={TONE[feedback.tone].icon} className="mt-0.5 h-4 w-4" />
                  <span>
                    <strong>{TONE[feedback.tone].label}: </strong>
                    <span className="text-fg">{feedback.text}</span>
                  </span>
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

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
