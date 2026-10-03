import { useMemo, useReducer, useState } from 'react'
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
import FieldGuide from '../components/FieldGuide.tsx'
import Tabs from '../components/Tabs.tsx'
import Prose from '../components/Prose.tsx'
import Icon, { type IconName } from '../components/Icon.tsx'
import { missionId } from '../game/mission.ts'
import { mmss } from '../game/format.ts'
import { atStage, sinceStageStart, stageAt, stageCount } from '../schema/stages.ts'
import { play } from '../game/sound.ts'

// Status is never shown by color alone: every tone also has a text label.
const TONE: Record<Feedback['tone'], { label: string; className: string; icon: IconName }> = {
  good: { label: 'Correct', className: 'border-ok/60 text-ok', icon: 'check' },
  bad: { label: 'Not quite', className: 'border-warn/60 text-warn', icon: 'alert' },
  danger: { label: 'Harmful', className: 'border-crit/60 text-crit', icon: 'x' },
  reopened: { label: 'Reopened', className: 'border-crit/60 text-crit', icon: 'alert' },
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
  initial,
  onChange,
  onResolved,
}: {
  scenario: Scenario
  initial?: Session // resume where the player left off (a shift switching between incidents)
  onChange?: (s: Session) => void
  onResolved: (log: GameEvent[]) => void
}) {
  const [session, dispatch] = useReducer((s: Session, e: GameEvent) => step(scenario, s, e), initial, (i) => i ?? newSession())
  // `step` is pure, so the next session can be reported without waiting for the reducer.
  const send = (intent: Intent) => {
    const e = { ...intent, at: Date.now() } as GameEvent
    dispatch(e)
    onChange?.(step(scenario, session, e))
  }
  const [selected, setPicked] = useState<string>()
  // Authors list the right answer first; shuffle so order isn't a tell. Seeded
  // by when the incident was taken, so the order survives a remount.
  const seed = session.log.find((e) => e.type === 'START')?.at ?? 0
  // Multi-stage incidents show the current stage: its causes, actions, hints,
  // and the artifacts revealed so far (schema/stages.ts).
  const stage = stageAt(session.log)
  const stages = stageCount(scenario)
  const view = useMemo(() => atStage(scenario, stage), [scenario, stage])
  // A choice from an earlier stage's list doesn't carry over.
  const picked = view.hypotheses.some((h) => h.id === selected) ? selected : undefined
  // The ticket's update timeline: one entry per reopen so far, timed from the start.
  const started = session.log.find((e) => e.type === 'START')?.at ?? 0
  const updates = (scenario.stages ?? []).slice(0, stage).map((st, i) => ({
    text: st.update,
    at: session.log.filter((e) => e.type === 'CLOSE_INCIDENT')[i].at - started,
  }))
  const hypotheses = useMemo(() => shuffle(view.hypotheses, seed), [view, seed])
  const actions = useMemo(() => shuffle(view.actions, seed + 1), [view, seed])
  const taken = actionsTaken(session.log)
  const { phase, feedback } = session

  // Closing hands the finished log to App for scoring. `step` is pure, so
  // running it here too gives exactly the log the reducer will store.
  // Closing either resolves the incident (handed to App for scoring) or, in a
  // multi-stage incident, reopens it into the next stage.
  function close() {
    const e: GameEvent = { type: 'CLOSE_INCIDENT', at: Date.now() }
    const next = step(scenario, session, e)
    if (next.phase === 'resolved') return onResolved(next.log)
    dispatch(e)
    onChange?.(next)
  }

  const tools = [
    scenario.terminal && {
      id: 'terminal',
      label: 'Terminal',
      panel: (
        <Terminal
          scenario={scenario}
          log={session.log}
          onRun={(input) => send({ type: 'RUN_COMMAND', input })}
          onShellRan={(commands) => send({ type: 'SHELL_RAN', commands })}
        />
      ),
    },
    view.logs && {
      id: 'logs',
      label: 'Logs',
      panel: (
        <Browser
          noun="log"
          onOpen={(name) => send({ type: 'OPEN_ARTIFACT', kind: 'log', name })}
          items={view.logs.map((l) => ({ name: l.name, render: () => <TextView content={l.lines} isLog /> }))}
        />
      ),
    },
    view.files && {
      id: 'files',
      label: 'Files',
      panel: (
        <Browser
          noun="file"
          onOpen={(name) => send({ type: 'OPEN_ARTIFACT', kind: 'file', name })}
          items={view.files.map((f) => ({ name: f.path, render: () => <TextView content={f.content} /> }))}
        />
      ),
    },
    view.traces && {
      id: 'traces',
      label: 'Traces',
      panel: (
        <Browser
          noun="trace"
          onOpen={(name) => send({ type: 'OPEN_ARTIFACT', kind: 'trace', name })}
          items={view.traces.map((t) => ({ name: t.name, render: () => <TraceWaterfall spans={t.spans} /> }))}
        />
      ),
    },
    view.metrics && {
      id: 'metrics',
      label: 'Metrics',
      panel: (
        <Browser
          noun="metric"
          onOpen={(name) => send({ type: 'OPEN_ARTIFACT', kind: 'metric', name })}
          items={view.metrics.map((m) => ({ name: m.name, render: () => <MetricChart metric={m} /> }))}
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
          {scenario.ticket.severity}
        </span>
        <span className="rounded border border-line px-2 py-0.5 font-mono text-sm text-muted">
          {missionId(scenario.id, 'incident')}
        </span>
        <span className="flex items-center gap-2 rounded border border-line px-2 py-0.5 text-sm text-muted">
          <span aria-hidden className={`h-2 w-2 rounded-full ${PHASE[phase].dot}`} />
          {PHASE[phase].label}
        </span>
        {stages > 1 && (
          <span className="rounded border border-warn px-2 py-0.5 font-mono text-sm text-warn">
            Stage {stage + 1} of {stages}
          </span>
        )}
      </header>

      {/* The ticket starts open and stays open after accepting; the player can
          fold it to one line. React sets `open` only on mount, so their choice
          sticks. A multi-stage reopen (new key) opens it again to show the update.
          Once work starts its body is height-capped and scrolls, so the tools
          stay near the top; focusable so keyboard users can scroll it too. */}
      <details key={stage} open className="group rounded-lg border border-line bg-panel p-4">
        <summary className="cursor-pointer text-sm text-muted hover:text-fg">
          Ticket from {scenario.ticket.from}
          <span className="block truncate text-fg group-open:hidden">
            {(updates.at(-1)?.text ?? scenario.ticket.body).replace(/\s+/g, ' ')}
          </span>
        </summary>
        <div
          {...(phase !== 'briefing' && { tabIndex: 0, role: 'region', 'aria-label': 'Ticket details' })}
          className={`mt-2 ${phase === 'briefing' ? '' : 'max-h-72 overflow-y-auto pr-2 focus-visible:outline-2 focus-visible:outline-accent'}`}
        >
          <Prose text={scenario.ticket.body} />
          {updates.length > 0 && (
            <>
              <h2 className="mt-4 text-sm text-muted">Updates</h2>
              <ol className="mt-2 space-y-2">
                {updates.map((u, i) => (
                  <li key={i} className="border-l-2 border-crit pl-3">
                    <span className="font-mono text-xs text-muted tabular-nums">+{mmss(u.at)} · stage {i + 2}</span>
                    <Prose text={u.text} />
                  </li>
                ))}
              </ol>
            </>
          )}
          <h2 className="mt-4 text-sm text-muted">Environment</h2>
          <Prose className="mt-2" text={scenario.environment} />
          {view.diagram && (
            <div className="mt-4">
              <h3 className="mb-2 text-sm text-muted">System diagram (current monitoring status)</h3>
              <Diagram diagram={view.diagram} />
            </div>
          )}
        </div>
      </details>

      {/* The accept moment: a brief alert card over the workspace. Purely
          visual and click-through; hidden entirely when motion is reduced. */}
      {phase !== 'briefing' && (
        <div aria-hidden className="accept-flash pointer-events-none fixed inset-0 z-40 items-center justify-center">
          <div className="rounded-lg border border-crit bg-panel px-8 py-6 text-center font-mono shadow-2xl">
            <p className="tracking-[0.3em] text-crit uppercase">Mission accepted</p>
            <p className="mt-2 text-sm text-muted">
              {missionId(scenario.id, 'incident')} · {scenario.ticket.severity}
            </p>
          </div>
        </div>
      )}

      {phase === 'briefing' ? (
        <button className={`${button} bg-accent text-bg`} onClick={() => {
            play('accept')
            send({ type: 'START' })
          }}
        >
          Accept mission
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
                {fixComplete(view, session.log) && (
                  <button className={`${button} mt-4 w-full bg-ok text-bg`} onClick={close}>
                    Close out
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

            <FieldGuide mode="incident" phase={phase} concepts={scenario.concepts} />
            <HintPanel scenario={view} used={hintsUsed(sinceStageStart(session.log))} onRequest={() => send({ type: 'REQUEST_HINT' })} />
          </div>
        </div>
      )}
    </div>
  )
}

// Fisher-Yates with a small seeded generator (mulberry32): same seed, same order.
function shuffle<T>(xs: T[], seed: number): T[] {
  let t = seed >>> 0
  const random = () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
