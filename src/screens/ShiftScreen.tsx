import { useEffect, useReducer, useRef, useState } from 'react'
import content, { loadItem } from 'virtual:content'
import type { Scenario } from '../schema/scenario.ts'
import type { GameEvent } from '../game/engine.ts'
import { score, type Score } from '../game/scoring.ts'
import { ACK_TARGET, isCritical, newShift, SHIFT_LENGTHS, shiftReport, shiftStep, type Page, type Severity, type Shift } from '../game/shift.ts'
import { missionId } from '../game/mission.ts'
import { play } from '../game/sound.ts'
import IncidentScreen from './IncidentScreen.tsx'
import DebriefScreen from './DebriefScreen.tsx'
import Card from '../components/Card.tsx'
import type { Breakdown } from '../schema/commands.ts'
import { mmss } from '../game/format.ts'
import { stageAt } from '../schema/stages.ts'
import WorldMap, { type Sector } from '../components/WorldMap.tsx'

// An on-call shift (PLAN_ONCALL_SHIFT.md): pick a length, then pages arrive
// and you switch between them from the queue. The shift logic is pure
// (game/shift.ts); this screen feeds it time and clicks, keeps the loaded
// scenarios, and records each resolved incident through App.

export type Candidate = { id: string; track: string; title: string; severity: Severity; difficulty: number; resolved: boolean }
type Outcome = { gained: number; rankUp?: string; cleared?: string; unlocked: string[] }
type Finished = { log: GameEvent[]; score: Score; outcome: Outcome }

const TICK = 1000
const button =
  'rounded-md px-4 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

export default function ShiftScreen({
  candidates,
  relaxed,
  streak,
  onRecord,
  onBonus,
  onExit,
  onTree,
}: {
  candidates: Candidate[]
  relaxed: boolean
  streak: number
  onRecord: (id: string, s: Score) => Outcome
  onBonus: (xp: number) => void
  onExit: () => void
  onTree: () => void
}) {
  const [shift, dispatch] = useReducer(
    (s: Shift | undefined, e: Parameters<typeof shiftStep>[1] | { type: 'BEGIN'; shift: Shift }) =>
      e.type === 'BEGIN' ? e.shift : s && shiftStep(s, e),
    undefined,
  )
  const [scenarios, setScenarios] = useState<Record<string, Scenario>>({})
  const [breakdowns, setBreakdowns] = useState<Record<string, Breakdown | undefined>>({})
  const [finished, setFinished] = useState<Record<string, Finished>>({})
  const [last, setLast] = useState<string>() // the result card after a resolve
  const [viewing, setViewing] = useState<string>() // a full after-action report from the shift report
  const [confirmEnd, setConfirmEnd] = useState(false)
  const title = (id: string) => candidates.find((c) => c.id === id)?.title ?? id

  function begin(length: number) {
    const s = newShift(candidates, length, relaxed)
    // Every page's scenario loads up front, so switching is instant.
    Promise.all(s.pages.map((p) => loadItem(p.id))).then((loaded) => {
      const incidents = loaded.flatMap((x) => (x.kind === 'incident' ? [x] : []))
      setScenarios(Object.fromEntries(incidents.map((x) => [x.scenario.id, x.scenario])))
      setBreakdowns(Object.fromEntries(incidents.map((x) => [x.scenario.id, x.breakdown])))
    })
    dispatch({ type: 'BEGIN', shift: s })
  }

  // Shift time. ponytail: one-second ticks, so times are accurate to about a
  // second; the clock stops while the tab is hidden.
  const running = !!shift && !shift.ended
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => document.visibilityState === 'visible' && dispatch({ type: 'TICK', ms: TICK }), TICK)
    return () => clearInterval(t)
  }, [running])

  // A new page: pager alert (sound is opt-in), announced politely.
  const arrived = shift?.pages.filter((p) => p.arrivedAt !== undefined) ?? []
  const newest = arrived.length > 1 ? arrived.at(-1)!.id : undefined // the first page isn't an interruption
  useEffect(() => {
    if (newest) play('accept')
  }, [newest])
  const newestPage = newest ? shift!.pages.find((p) => p.id === newest)! : undefined
  // The pager banner stays until that page is picked up.
  const paging = newestPage && newestPage.ackAt === undefined ? newestPage : undefined

  // The shift bonus is paid once, when the shift ends.
  const paid = useRef(false)
  const report = shift && shiftReport(shift)
  useEffect(() => {
    if (shift?.ended && report && !paid.current) {
      paid.current = true
      if (report.bonus) onBonus(report.bonus)
    }
  })

  // Switching incidents moves focus to the new incident's heading.
  useEffect(() => {
    document.getElementById('screen-title')?.focus()
  }, [shift?.focus, viewing, shift?.ended])

  if (!shift) return <Setup relaxed={relaxed} available={candidates.length} onBegin={begin} />

  if (viewing) {
    const f = finished[viewing]
    return (
      <DebriefScreen
        scenario={scenarios[viewing]}
        breakdown={breakdowns[viewing]}
        log={f.log}
        score={f.score}
        gained={f.outcome.gained}
        rankUp={f.outcome.rankUp}
        cleared={f.outcome.cleared}
        unlocked={f.outcome.unlocked}
        streak={streak}
        onHome={() => setViewing(undefined)}
        onTree={onTree}
        homeLabel="Back to shift report"
      />
    )
  }

  if (shift.ended)
    return (
      <ShiftReport
        shift={shift}
        report={report!}
        title={title}
        finished={finished}
        sectors={sectors(candidates, shift.pages)}
        onView={setViewing}
        onExit={onExit}
      />
    )

  const focused = shift.pages.find((p) => p.id === shift.focus)
  function resolved(id: string, log: GameEvent[]) {
    const s = score(scenarios[id], log, relaxed, true)
    const outcome = onRecord(id, s)
    setFinished((f) => ({ ...f, [id]: { log, score: s, outcome } }))
    setLast(id)
    dispatch({ type: 'RESOLVE', id, total: s.total, clean: s.clean, parMinutes: scenarios[id].par_minutes })
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside aria-labelledby="queue-h" className="space-y-3">
        <section className="rounded-lg border border-line bg-panel p-4">
          <h2 id="queue-h">On-call queue</h2>
          {!relaxed && (
            <p className="mt-2 flex items-baseline justify-between font-mono">
              <span className="text-xs tracking-widest text-muted uppercase">Shift</span>
              <span className="text-2xl text-accent tabular-nums">{mmss(shift.clock)}</span>
            </p>
          )}
          <ul className="mt-3 space-y-2">
            {arrived.map((p) => (
              <li key={p.id}>
                <QueueRow page={p} shift={shift} title={title(p.id)} current={p.id === shift.focus} onOpen={() => dispatch({ type: 'OPEN', id: p.id })} />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">
            {arrived.length} of {shift.pages.length} pages so far.
          </p>
        </section>
        {confirmEnd ? (
          <div className="flex gap-2">
            <button className={`${button} bg-crit text-bg`} onClick={() => dispatch({ type: 'END' })}>
              End shift now
            </button>
            <button className={`${button} border border-line`} onClick={() => setConfirmEnd(false)}>
              Keep going
            </button>
          </div>
        ) : (
          <button className={`${button} w-full border border-line hover:border-accent`} onClick={() => setConfirmEnd(true)}>
            End shift
          </button>
        )}
      </aside>

      <div className="space-y-4">
        {paging && paging.id !== shift.focus && (
          <div className="anim-pager flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-crit bg-panel p-3 font-mono">
            <span>
              <span className="tracking-widest text-crit uppercase">Page</span> · {missionId(paging.id, 'incident')} ·{' '}
              <span className={isCritical(paging.severity) ? 'text-crit' : 'text-warn'}>{paging.severity}</span> ·{' '}
              <span className="font-sans">{title(paging.id)}</span>
            </span>
            <button className={`${button} border border-crit text-crit`} onClick={() => dispatch({ type: 'OPEN', id: paging.id })}>
              Acknowledge
            </button>
          </div>
        )}
        {focused ? (
          scenarios[focused.id] ? (
            <>
              <button className="text-sm text-muted hover:text-fg" onClick={() => dispatch({ type: 'LEAVE' })}>
                ← Back to the queue
              </button>
              <IncidentScreen
                key={focused.id}
                scenario={scenarios[focused.id]}
                initial={focused.session}
                onChange={(session) => dispatch({ type: 'SAVE', id: focused.id, session })}
                onResolved={(log) => resolved(focused.id, log)}
              />
            </>
          ) : (
            <p className="text-muted">Loading…</p>
          )
        ) : (
          <>
            <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
              On-call shift
            </h1>
            {last && finished[last] && (
              <Card title={`Resolved ${missionId(last, 'incident')}`}>
                <p className="font-medium">{title(last)}</p>
                <p className="mt-1 text-sm text-muted">
                  Scored <span className="tabular-nums">{finished[last].score.total}</span> XP
                  {finished[last].outcome.gained < finished[last].score.total && (
                    <> (+<span className="tabular-nums">{finished[last].outcome.gained}</span> over your best)</>
                  )}
                  . The full after-action report is in the shift report.
                </p>
              </Card>
            )}
            <p>{arrived.some((p) => !p.result) ? 'Pick a page from the queue. Urgent ones first.' : 'Queue clear. Stand by for the next page.'}</p>
            <WorldMap title="Shift wall" sectors={sectors(candidates, arrived)} />
          </>
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {newestPage && `New page: ${missionId(newestPage.id, 'incident')} ${newestPage.severity}, ${title(newestPage.id)}`}
      </p>
    </div>
  )
}

function Setup({ relaxed, available, onBegin }: { relaxed: boolean; available: number; onBegin: (n: number) => void }) {
  return (
    <div className="space-y-4">
      <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
        Start an on-call shift
      </h1>
      <p className="max-w-prose">
        Pages arrive while you work, and several can be open at once. Acknowledge the urgent ones first: each severity has a
        response target, and handling them in order earns a triage bonus.
        {relaxed && ' Relaxed mode is on: no clock, and each page arrives once the queue is clear.'}
      </p>
      <div className="flex flex-wrap gap-3">
        {SHIFT_LENGTHS.filter((n) => n <= available).map((n) => (
          <button key={n} className={`${button} border border-line hover:border-accent`} onClick={() => onBegin(n)}>
            {n === 2 ? 'Short' : n === 3 ? 'Standard' : 'Long'} shift: {n} pages
          </button>
        ))}
      </div>
    </div>
  )
}

const STATUS = (p: Page) => {
  const base =
    p.result ? 'Resolved' : p.ackAt === undefined ? 'New' : p.session?.phase === 'acting' ? 'Fixing' : p.session?.phase === 'investigating' ? 'Investigating' : 'Acknowledged'
  const stage = p.session && !p.result ? stageAt(p.session.log) : 0 // a multi-stage page that reopened
  return stage ? `${base} · stage ${stage + 1}` : base
}

function QueueRow({ page: p, shift, title, current, onOpen }: { page: Page; shift: Shift; title: string; current: boolean; onOpen: () => void }) {
  const waiting = p.ackAt === undefined && !p.result ? shift.clock - p.arrivedAt! : undefined
  const late = waiting !== undefined && !shift.relaxed && waiting > ACK_TARGET[p.severity]
  return (
    <button
      onClick={onOpen}
      disabled={!!p.result}
      aria-current={current ? 'true' : undefined}
      className={`w-full rounded-md border border-l-4 p-2 text-left text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 aria-[current=true]:border-accent ${p.result ? 'border-line border-l-ok' : isCritical(p.severity) ? 'border-line border-l-crit' : 'border-line border-l-warn'}`}
    >
      <span className="flex justify-between gap-2 font-mono text-xs text-muted">
        <span>{missionId(p.id, 'incident')}</span>
        <span className={isCritical(p.severity) ? 'text-crit' : ''}>{p.severity}</span>
      </span>
      <span className="mt-1 block">{title}</span>
      <span className="mt-1 flex justify-between font-mono text-xs">
        <span className={p.result ? 'text-ok' : 'text-muted'}>{STATUS(p)}</span>
        {waiting !== undefined && !shift.relaxed && (
          <span className={`tabular-nums ${late ? 'text-crit' : 'text-muted'}`}>waiting {mmss(waiting)}</span>
        )}
      </span>
    </button>
  )
}

function ShiftReport({
  shift,
  report,
  title,
  finished,
  sectors,
  onView,
  onExit,
}: {
  shift: Shift
  report: ReturnType<typeof shiftReport>
  title: (id: string) => string
  finished: Record<string, Finished>
  sectors: Sector[]
  onView: (id: string) => void
  onExit: () => void
}) {
  const gained = Object.values(finished).reduce((t, f) => t + f.outcome.gained, 0)
  return (
    <div className="space-y-6">
      <header className="rounded-lg border border-ok bg-panel p-6">
        <p className="font-mono text-sm tracking-widest text-ok uppercase">Shift over</p>
        <h1 id="screen-title" tabIndex={-1} className="mt-1 text-2xl font-semibold focus:outline-none">
          Shift report
        </h1>
        <p className="mt-4 font-mono text-4xl font-semibold text-accent">+{gained + report.bonus} XP</p>
        <p className="mt-1 text-sm text-muted">
          <span className="tabular-nums">{gained}</span> from incidents, <span className="tabular-nums">{report.bonus}</span> shift bonus
          {!shift.relaxed && <> · shift time {mmss(report.durationMs)}</>}
          {report.clean && ' · clean shift'}
        </p>
      </header>

      <WorldMap title="Shift wall" sectors={sectors} />

      <Card title="Pages">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-3 font-normal">Page</th>
                <th className="py-1 pr-3 font-normal">Responded</th>
                <th className="py-1 pr-3 font-normal">Time on it</th>
                {!shift.relaxed && <th className="py-1 pr-3 font-normal">Targets</th>}
                <th className="py-1 font-normal">Report</th>
              </tr>
            </thead>
            <tbody>
              {report.pages.map((p) => (
                <tr key={p.id} className="border-t border-line align-top">
                  <td className="py-2 pr-3">
                    <span className="font-mono text-xs text-muted">
                      {missionId(p.id, 'incident')} · {p.severity}
                    </span>
                    <span className="block">{title(p.id)}</span>
                  </td>
                  <td className="py-2 pr-3 font-mono tabular-nums">{p.responseMs === undefined ? '—' : mmss(p.responseMs)}</td>
                  <td className="py-2 pr-3 font-mono tabular-nums">{mmss(p.activeMs)}</td>
                  {!shift.relaxed && (
                    <td className="py-2 pr-3">
                      <span className={p.ackMet ? 'text-ok' : 'text-muted'}>Response {p.ackMet ? 'met' : 'missed'}</span>
                      <span className={`block ${p.resolveMet ? 'text-ok' : 'text-muted'}`}>Resolve {p.resolveMet ? 'met' : 'missed'}</span>
                      {p.bonus > 0 && <span className="block font-mono text-accent">+{p.bonus} XP</span>}
                    </td>
                  )}
                  <td className="py-2">
                    {finished[p.id] ? (
                      <button className="text-accent underline underline-offset-2" onClick={() => onView(p.id)}>
                        After-action report{' '}<span className="sr-only">for {title(p.id)}</span>
                      </button>
                    ) : (
                      <span className="text-muted">Handed over</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!shift.relaxed && (
          <p className="mt-3 text-sm">
            {report.triage ? (
              <span className="text-ok">Triage: urgent pages first, every time (+{report.triageBonus} XP).</span>
            ) : (
              <span className="text-muted">Triage: a less severe page was picked up while a more urgent one waited, or a page was never answered.</span>
            )}
          </p>
        )}
      </Card>

      <button className={`${button} bg-accent text-bg`} onClick={onExit}>
        Back to ops board
      </button>
    </div>
  )
}

// The wall map for a shift: one station per sector it paged, lit amber while
// any of that sector's pages is unresolved (or was handed over), green when clear.
function sectors(candidates: Candidate[], pages: Page[]): Sector[] {
  const trackOf = (id: string) => candidates.find((c) => c.id === id)?.track
  return content.tracks.flatMap((track) => {
    const mine = pages.filter((p) => trackOf(p.id) === track.id)
    return mine.length ? [{ track, total: mine.length, open: mine.filter((p) => !p.result).length, locked: false }] : []
  })
}

