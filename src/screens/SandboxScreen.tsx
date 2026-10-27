import { useEffect, useState } from 'react'
import { loadSandbox as loadCloud } from 'virtual:content'
import type { Design } from '../schema/canvas.ts'
import type { SandboxChallenge } from '../schema/sandbox.ts'
import type { CanvasTestResult } from '../game/canvas.ts'
import { runCheck, sandboxChecks, validateDesign } from '../game/sandbox.ts'
import { updateDesign } from '../game/sandboxStore.ts'
import { PROVIDER_NAMES } from '../schema/constants.ts'
import CanvasEditor from '../components/canvas/CanvasEditor.tsx'
import FieldGuide from '../components/FieldGuide.tsx'
import Icon from '../components/Icon.tsx'
import { download, useSandbox } from '../components/useSandbox.ts'

const button =
  'rounded-md border border-line px-2.5 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50'

// One saved design in the editor. No scoring, XP or progress: a check shows
// what survives and why, and cost is only information.
export default function SandboxScreen({ id, onBack, onMissing }: { id: string; onBack: () => void; onMissing: () => void }) {
  const { data, update, saved } = useSandbox()
  const entry = data.designs.find((d) => d.id === id)
  const [c, setC] = useState<SandboxChallenge | null>() // null: this cloud's sandbox couldn't load
  const [checkId, setCheckId] = useState('')
  const [ran, setRan] = useState<{ design: Design; result: CanvasTestResult }>()

  // An id with no saved design (a stale link) goes back to the list.
  useEffect(() => {
    if (!entry) onMissing()
  }, [entry, onMissing])
  const provider = entry?.provider
  useEffect(() => {
    if (provider)
      loadCloud(provider).then(
        (x) => setC(x ?? null),
        () => setC(null),
      )
  }, [provider])
  // App focuses the heading on navigation, but the cloud loads after that: focus it once it's here.
  useEffect(() => {
    if (c !== undefined) document.getElementById('screen-title')?.focus()
  }, [c])

  if (!entry) return null
  const back = (
    <button className="text-sm text-accent underline" onClick={onBack}>
      ← All designs
    </button>
  )
  if (c === undefined) return <p className="text-muted">Loading…</p>

  // A saved design may predate a change to the palette: say so instead of crashing the editor.
  const problem = c ? validateDesign(c, entry.design) : `the ${PROVIDER_NAMES[entry.provider]} sandbox couldn't be loaded.`
  if (!c || problem)
    return (
      <div className="space-y-4">
        {back}
        <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
          {entry.name}
        </h1>
        <p role="alert" className="rounded-md border border-warn px-3 py-2 text-sm">
          This design can't be opened: {problem}
        </p>
        <button className={button} onClick={() => download(entry)}>
          Export
        </button>
      </div>
    )

  const design = entry.design
  const checks = sandboxChecks(c, design)
  const selectedId = checks.some((t) => t.id === checkId) ? checkId : (checks[0]?.id ?? '')
  const stale = !!ran && JSON.stringify(ran.design) !== JSON.stringify(design)
  const down = new Set(ran && !stale && !ran.result.pass ? ran.result.down : [])
  const part = (type: string) => c.palette.find((p) => p.id === type)
  const cost = design.nodes.reduce((sum, n) => sum + (part(n.type)?.cost ?? 0), 0)
  const hasNeutral = design.nodes.some((n) => part(n.type)?.roles.includes('neutral'))

  return (
    <div className="space-y-4">
      {back}
      <header className="flex flex-wrap items-center gap-3">
        <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
          {entry.name}
        </h1>
        <span className="rounded border border-accent px-2 py-0.5 text-sm text-accent">Design sandbox</span>
        <span className="rounded border border-line px-2 py-0.5 font-mono text-sm text-muted uppercase">{PROVIDER_NAMES[entry.provider]}</span>
        <span role="status" aria-live="polite" className={`ml-auto text-sm ${saved ? 'text-muted' : 'text-warn'}`}>
          {saved ? 'Saved in this browser' : "Storage is blocked, so this design won't be saved: export it to keep it"}
        </span>
        <button className={button} onClick={() => download(entry)}>
          Export
        </button>
      </header>

      <CanvasEditor
        c={c}
        design={design}
        onChange={(d) => update((s) => updateDesign(s, id, d))}
        down={down}
        downNoun="check"
        belowBoard={
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-panel p-4">
            <label className="min-w-48 flex-1 text-sm">
              <span className="block text-muted">Check</span>
              <select
                value={selectedId}
                onChange={(e) => setCheckId(e.target.value)}
                disabled={!checks.length}
                className="w-full rounded-md border border-line bg-bg px-2 py-1"
              >
                {checks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="rounded-md bg-accent px-4 py-2 font-medium text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
              disabled={!checks.length}
              onClick={() => {
                const result = runCheck(c, design, selectedId)
                if (result) setRan({ design, result })
              }}
            >
              Run check
            </button>
            <span className="text-sm text-muted tabular-nums">Total cost: {cost} units (illustrative)</span>
            {!checks.length && <p className="w-full text-sm text-muted">Add a web server or a database to run checks.</p>}
          </div>
        }
        aside={
          <>
            <section aria-labelledby="check-h" className="rounded-lg border border-line bg-panel p-4">
              <h2 id="check-h" className="font-semibold">
                Check result
              </h2>
              <div aria-live="polite" className="mt-2 text-sm">
                {!ran ? (
                  <p className="text-muted">Pick a check and run it to see what survives.</p>
                ) : (
                  <>
                    {stale && <p className="mb-2 text-warn">You've changed the design since this run.</p>}
                    <span className={`flex items-center gap-1.5 font-medium ${ran.result.pass ? 'text-ok' : 'text-crit'}`}>
                      <Icon name={ran.result.pass ? 'check' : 'x'} />
                      {ran.result.pass ? 'Survived' : 'Failed'}: <span className="text-fg">{ran.result.label}</span>
                    </span>
                    {ran.result.reasons.map((r) => (
                      <p key={r} className="mt-0.5 pl-5.5 text-muted">
                        {r}
                      </p>
                    ))}
                  </>
                )}
              </div>
              {hasNeutral && (
                <p className="mt-3 text-xs text-muted">
                  Queues, caches, CDNs and object storage aren't judged by these checks yet. A link through one is treated as a direct link to what's behind it.
                </p>
              )}
            </section>
            <FieldGuide mode="design" />
          </>
        }
      />
    </div>
  )
}
