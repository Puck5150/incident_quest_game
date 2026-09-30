import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { USERS, type CanvasChallenge, type Design } from '../schema/canvas.ts'
import { evaluateCanvas } from '../game/canvas.ts'
import { addNode, connect, disconnect, emptyDesign, laneLabel, lanesFor, moveNode, removeNode, targets } from '../game/canvasEdit.ts'
import Board, { type DragPayload } from '../components/canvas/Board.tsx'
import Inspector from '../components/canvas/Inspector.tsx'
import StressResults from '../components/StressResults.tsx'
import { useStressRun } from '../components/useStressRun.ts'
import CostMeter from '../components/CostMeter.tsx'
import HintPanel from '../components/HintPanel.tsx'
import Prose from '../components/Prose.tsx'

export type CanvasRun = { design: Design; at: number }
type Kind = Design['edges'][number]['kind']

export default function CanvasScreen({
  challenge: c,
  onFinished,
}: {
  challenge: CanvasChallenge
  onFinished: (runs: CanvasRun[], hintsUsed: number) => void
}) {
  const uid = useId()
  const [design, setDesign] = useState<Design>(emptyDesign)
  const [selected, setSelected] = useState<string>()
  const [selections, setSelections] = useState(0) // re-selecting the same component still refocuses the inspector
  const [connecting, setConnecting] = useState<{ from: string; kind: Kind }>()
  const [drag, setDrag] = useState<{ payload: DragPayload; x: number; y: number }>()
  const [message, setMessage] = useState('') // announced to screen readers
  const [runs, setRuns] = useState<CanvasRun[]>([])
  const [hints, setHints] = useState(0)
  const [shownTest, setShownTest] = useState<string>()
  const justDragged = useRef(false)

  const last = runs.at(-1)
  const result = last && evaluateCanvas(c, last.design)
  const { revealed, running, titleRef, start, skip } = useStressRun(result?.tests.length ?? 0)
  const stale = !!last && JSON.stringify(last.design) !== JSON.stringify(design)
  const cost = evaluateCanvas(c, design).cost

  // Which failed test to show on the board: the one picked, else the latest revealed failure.
  const revealedFails = result && !stale ? result.tests.slice(0, revealed).filter((t) => !t.pass) : []
  const focusTest = revealedFails.find((t) => t.id === shownTest) ?? revealedFails.at(-1)
  const down = new Set(focusTest?.down ?? [])

  // Every edit goes through the pure functions in canvasEdit.ts; a string
  // result is a rule violation, shown and announced instead of applied.
  function apply(r: Design | string, done: string) {
    if (typeof r === 'string') return setMessage(r)
    setDesign(r)
    setMessage(done)
  }
  const drop = (p: DragPayload, lane: string) =>
    p.kind === 'new'
      ? apply(addNode(c, design, p.type, lane), `Added to ${laneLabel(c, lane)}.`)
      : apply(moveNode(c, design, p.id, lane), `${p.id} moved to ${laneLabel(c, lane)}.`)

  // Pointer drag: a press that moves more than a few pixels becomes a drag; on
  // release, whatever lane is under the pointer receives the component. A plain
  // click still selects (the click handler checks justDragged).
  function beginDrag(e: ReactPointerEvent, payload: DragPayload) {
    // Touch never starts a drag: on phones a swipe must scroll the page, and
    // the Add buttons and inspector do everything dragging does.
    if (e.button !== 0 || connecting || e.pointerType === 'touch') return
    const sx = e.clientX
    const sy = e.clientY
    let active = false
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) active = true
      if (active) setDrag({ payload, x: ev.clientX, y: ev.clientY })
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', esc)
    }
    // Escape cancels a drag in progress, like closing a menu.
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      stop()
      if (active) {
        justDragged.current = true
        setTimeout(() => (justDragged.current = false))
      }
      setDrag(undefined)
    }
    const up = (ev: PointerEvent) => {
      stop()
      if (!active) return
      justDragged.current = true
      setTimeout(() => (justDragged.current = false))
      setDrag(undefined)
      const lane = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)
        ?.closest('[data-lane]')
        ?.getAttribute('data-lane')
      if (lane) drop(payload, lane)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', esc)
  }

  function select(id: string) {
    if (justDragged.current) return
    if (connecting) {
      if (id !== connecting.from) {
        apply(connect(c, design, connecting.from, id, connecting.kind), `Linked ${connecting.from} to ${id} (${connecting.kind}).`)
      }
      setConnecting(undefined)
      return
    }
    setSelected(id)
    setSelections((n) => n + 1)
  }

  useEffect(() => {
    if (!connecting) return
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setConnecting(undefined)
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [connecting])

  function run() {
    setRuns((r) => [...r, { design, at: Date.now() }])
    setShownTest(undefined)
    start(c.stress_tests.length)
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
          {c.title}
        </h1>
        <span className="rounded border border-accent px-2 py-0.5 text-sm text-accent">Design canvas</span>
        <span className="rounded border border-line px-2 py-0.5 font-mono text-sm text-muted uppercase">{c.provider}</span>
      </header>

      <section aria-labelledby={`${uid}-brief`} className="rounded-lg border border-line bg-panel p-4">
        <h2 id={`${uid}-brief`} className="text-sm text-muted">
          Brief
        </h2>
        <Prose className="mt-2" text={c.brief} />
        <h3 className="mt-4 text-sm text-muted">Requirements</h3>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {c.requirements.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_22rem]">
        <section aria-labelledby={`${uid}-palette`} className="space-y-2 self-start">
          <h2 id={`${uid}-palette`} className="font-semibold">
            Palette
          </h2>
          <p className="text-xs text-muted">Drag a component into a lane, or choose a lane and press Add.</p>
          {c.palette.map((p) => (
            <PaletteCard
              key={p.id}
              item={p}
              lanes={lanesFor(c, p.id)}
              onPointerDown={(e) => beginDrag(e, { kind: 'new', type: p.id })}
              onAdd={(lane) => {
                const r = addNode(c, design, p.id, lane)
                apply(r, `Added to ${laneLabel(c, lane)}.`)
                if (typeof r !== 'string') setSelected(r.nodes.at(-1)!.id)
              }}
            />
          ))}
        </section>

        <div className="min-w-0 space-y-4">
          <details className="rounded-lg border border-line bg-panel px-4 py-2 text-sm">
            <summary className="cursor-pointer font-medium">How to build</summary>
            <ul className="mt-2 mb-1 list-disc space-y-1 pl-5 text-muted">
              <li>Add components with a palette card's lane menu and Add button, or drag a card into a lane (mouse or pen).</li>
              <li>Select a component to move it, link it, or remove it in the inspector. "Pick on design" lets you click the target instead.</li>
              <li>Keyboard: Tab between controls; in a menu, type the first letters of a choice to pick it. Escape cancels picking or dragging.</li>
              <li>Traffic links carry requests. Replication links copy a database: sync fails over by itself, async doesn't.</li>
            </ul>
          </details>
          {connecting && (
            <p className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent bg-accent/5 px-3 py-2 text-sm">
              <span>
                Choose where <span className="font-mono">{connecting.from}</span>{' '}
                {connecting.kind === 'traffic' ? 'sends traffic' : `replicates (${connecting.kind})`}: select a highlighted component.
              </span>
              <button className="text-sm underline underline-offset-2" onClick={() => setConnecting(undefined)}>
                Cancel (Esc)
              </button>
            </p>
          )}
          <Board
            c={c}
            design={design}
            selected={selected}
            down={down}
            connectFrom={connecting?.from}
            validTargets={new Set(connecting ? targets(c, design, connecting.from, connecting.kind) : [])}
            dragging={drag?.payload}
            onSelect={select}
            onPointerDownChip={(e, id) => beginDrag(e, { kind: 'move', id })}
          />
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-panel p-4">
            <CostMeter cost={cost} budget={c.budget} />
            <button
              onClick={run}
              disabled={!design.nodes.length || running}
              className="rounded-md bg-accent px-4 py-2 font-medium text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            >
              {runs.length ? 'Run stress tests again' : 'Run stress tests'}
            </button>
          </div>
          <DesignList c={c} design={design} />
        </div>

        <div className="space-y-4 self-start lg:col-span-2 xl:col-span-1">
          <Inspector
            key={`${selected}-${selections}`}
            c={c}
            design={design}
            selected={selected === USERS || design.nodes.some((n) => n.id === selected) ? selected : undefined}
            onMove={(id, lane) => apply(moveNode(c, design, id, lane), `${id} moved to ${laneLabel(c, lane)}.`)}
            onConnect={(from, to, kind) => apply(connect(c, design, from, to, kind), `Linked ${from} to ${to} (${kind}).`)}
            onPickTarget={(from, kind) => {
              setConnecting({ from, kind })
              setMessage(`Choose where ${from} ${kind === 'traffic' ? 'sends traffic' : `replicates (${kind})`}. Select a component on the design, or press Escape.`)
            }}
            autoFocus={narrow()}
            onDisconnect={(i) => apply(disconnect(design, i), 'Link removed.')}
            onRemove={(id) => {
              apply(removeNode(design, id), `${id} removed.`)
              setSelected(undefined)
            }}
          />
          <StressResults
            result={result}
            budget={c.budget}
            runNumber={runs.length}
            revealed={revealed}
            running={running}
            stale={stale}
            emptyText="Build your design, then run the tests."
            titleRef={titleRef}
            onSkip={skip}
            onSubmit={() => onFinished(runs, hints)}
            selected={focusTest?.id}
            onSelect={setShownTest}
          />
          <HintPanel scenario={c} used={hints} onRequest={() => setHints((h) => Math.min(3, h + 1))} />
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {message}
      </p>

      {drag && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 rounded-md border border-accent bg-panel px-2.5 py-1.5 font-mono text-sm shadow-lg"
          style={{ left: drag.x + 12, top: drag.y + 12 }}
        >
          {ghostLabel(c, drag.payload)}
        </div>
      )}
    </div>
  )
}

function PaletteCard({
  item,
  lanes,
  onPointerDown,
  onAdd,
}: {
  item: CanvasChallenge['palette'][number]
  lanes: { id: string; label: string }[]
  onPointerDown: (e: ReactPointerEvent) => void
  onAdd: (lane: string) => void
}) {
  const uid = useId()
  const [lane, setLane] = useState(lanes[0]?.id ?? '')
  return (
    <div className="rounded-md border border-line bg-panel p-3">
      <div
        onPointerDown={onPointerDown}
        className="flex cursor-grab items-baseline justify-between gap-2 select-none active:cursor-grabbing"
        title="Drag into a lane"
      >
        <span className="text-sm font-medium">{item.label}</span>
        <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-xs text-muted tabular-nums">{item.cost}u</span>
      </div>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-muted">
        {item.facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <div className="mt-2 flex gap-1.5">
        <label htmlFor={`${uid}-lane`} className="sr-only">
          Lane for {item.label}
        </label>
        <select
          id={`${uid}-lane`}
          value={lane}
          onChange={(e) => setLane(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-line bg-bg px-1.5 py-1 text-xs focus-visible:outline-2 focus-visible:outline-accent"
        >
          {lanes.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => onAdd(lane)}
          aria-label={`Add ${item.label}`}
          className="rounded-md border border-line px-2 py-1 text-xs hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          Add
        </button>
      </div>
    </div>
  )
}

// The same design as text, for screen readers and small screens.
function DesignList({ c, design }: { c: CanvasChallenge; design: Design }) {
  return (
    <details className="rounded-lg border border-line bg-panel p-4 text-sm">
      <summary className="cursor-pointer font-medium">Design as a list</summary>
      {design.nodes.length === 0 ? (
        <p className="mt-2 text-muted">No components yet.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {design.nodes.map((n) => (
            <li key={n.id}>
              <span className="font-mono">{n.id}</span> ({c.palette.find((p) => p.id === n.type)?.label}) in {laneLabel(c, n.lane)}
            </li>
          ))}
          {design.edges.map((e, i) => (
            <li key={i} className="text-muted">
              {e.from} → {e.to} ({e.kind})
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}

const ghostLabel = (c: CanvasChallenge, p: DragPayload) =>
  p.kind === 'new' ? (c.palette.find((x) => x.id === p.type)?.short ?? p.type) : p.id

// Below the xl breakpoint the inspector sits under the board, so selecting a
// component moves focus (and the screen) to it.
const narrow = () => !window.matchMedia?.('(min-width: 1280px)').matches
