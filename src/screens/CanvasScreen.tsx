import { useId, useState } from 'react'
import type { CanvasChallenge, Design } from '../schema/canvas.ts'
import { evaluateCanvas } from '../game/canvas.ts'
import { emptyDesign } from '../game/canvasEdit.ts'
import CanvasEditor from '../components/canvas/CanvasEditor.tsx'
import StressResults from '../components/StressResults.tsx'
import { useStressRun } from '../components/useStressRun.ts'
import CostMeter from '../components/CostMeter.tsx'
import HintPanel from '../components/HintPanel.tsx'
import FieldGuide from '../components/FieldGuide.tsx'
import Prose from '../components/Prose.tsx'

export type CanvasRun = { design: Design; at: number }

export default function CanvasScreen({
  challenge: c,
  onFinished,
}: {
  challenge: CanvasChallenge
  onFinished: (runs: CanvasRun[], hintsUsed: number) => void
}) {
  const uid = useId()
  const [design, setDesign] = useState<Design>(emptyDesign)
  const [runs, setRuns] = useState<CanvasRun[]>([])
  const [hints, setHints] = useState(0)
  const [shownTest, setShownTest] = useState<string>()

  const last = runs.at(-1)
  const result = last && evaluateCanvas(c, last.design)
  const { revealed, running, titleRef, start, skip } = useStressRun(result?.tests.length ?? 0)
  const stale = !!last && JSON.stringify(last.design) !== JSON.stringify(design)
  const cost = evaluateCanvas(c, design).cost

  // Which failed test to show on the board: the one picked, else the latest revealed failure.
  const revealedFails = result && !stale ? result.tests.slice(0, revealed).filter((t) => !t.pass) : []
  const focusTest = revealedFails.find((t) => t.id === shownTest) ?? revealedFails.at(-1)
  const down = new Set(focusTest?.down ?? [])

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

      <CanvasEditor
        c={c}
        design={design}
        onChange={setDesign}
        down={down}
        belowBoard={
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
        }
        aside={
          <>
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
            <FieldGuide mode="design" />
            <HintPanel scenario={c} used={hints} onRequest={() => setHints((h) => Math.min(3, h + 1))} />
          </>
        }
      />
    </div>
  )
}
