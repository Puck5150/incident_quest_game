# Design Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a free-form design sandbox where a player builds an architecture from one cloud's real services, saves several designs in the browser, and runs standard failure checks against them.

**Architecture:** The scored canvas editor is extracted into a shared `CanvasEditor`. A new content kind (`content/sandbox/*.yaml`) extends each cloud's canvas challenge with extra `neutral`-role parts and is resolved at build time into an in-memory `SandboxChallenge`, so `canvasEdit.ts` and `evaluateCanvas` run almost unchanged. Pure modules own check generation (`sandbox.ts`) and storage (`sandboxStore.ts`); two new screens sit behind `#/sandbox` routes.

**Tech Stack:** TypeScript, React, Zod (content schemas, build only), Vite virtual modules, Vitest + React Testing Library (jsdom), Tailwind, oxlint.

**Spec:** `docs/superpowers/specs/2026-10-27-design-sandbox-design.md`

## Global Constraints

- One design is one cloud (`aws` | `azure` | `gcp`). No mixed-cloud designs. Layout is fixed per cloud: two regions with two zones each, plus the global lane (`global: true`).
- New role `neutral` in `ROLES` (`src/schema/constants.ts`). The engine ignores neutral parts. Sandbox extras use only `roles: [neutral]`.
- Sandbox node cap is `SANDBOX_MAX_NODES = 40`; traffic-spike multiple is `SPIKE = 3`. Scored challenges keep `MAX_NODES = 12`.
- Scored canvas behaviour must not change: `tests/canvas-ui.test.tsx` and `tests/canvas-edit.test.ts` pass unchanged after Task 3.
- Storage: key `incident-quest:sandbox`, value `{ version: 1, designs: [{ id, name, provider, design, updatedAt }] }`. Separate from `incident-quest:v1` and `incident-quest:categories`. Hand-validated (no Zod in the startup bundle). Invalid data is copied to `incident-quest:sandbox:backup-<time>` before starting empty. `localStorage` is looked up inside a `try`.
- Export file: `{ version: 1, name, provider, design }`, one design per file. Import never produces a design the editor could not have produced.
- No score, XP or progress write from the sandbox. The Clearance map, category filter, shifts and preview do not read sandbox data.
- Content rules: facts and sources for new parts come from the vendor documentation, written in our own words, never copied; `retrieved` is the date you read the page. `sources` is required in each sandbox file.
- Routes: `#/sandbox` (list) and `#/sandbox/<id>` (editor); nav button "Design sandbox" beside "Clearance map"; not gated by unlocks; an unknown id falls back to the list.
- Repo shell is zsh (`$VAR` is not word-split); macOS `sed -i ''`; `rm` and `cp` are interactive here, use `rm -f` and `cp -f`.
- Git: the user commits, pushes and opens PRs only when they say so. Do not commit, push or open a PR at the end of a task unless told. Show the diff first (user rule: evaluate before commit, no rework after a push).

## Review Focus

Each line is pinned by a test in the task named in brackets.

1. The refactor and the node cap must not change scored canvases: the 12-component limit still applies to them, and the build-and-submit flow still works. [Tasks 2 and 3]
2. A design with nothing the checks can judge (empty, or only neutral parts) must not show a vacuous "Survived": no checks are offered. A neutral-only component type gets no "lose any one" check. [Task 4]
3. Choosing one zone check must report only that zone, not other occupied zones' outages (the engine adds unnamed occupied zones to every zone test). [Task 4]
4. Hostile or garbled saved and imported data: non-JSON, wrong shape, `__proto__` keys, over-cap node lists, a component from another cloud's palette, a wrong lane: rejected or backed up with a plain message, never a crash. [Task 6]
5. A saved design that references a part no longer in the palette, or a blocked `localStorage`, must not crash the editor: the screen explains and offers export and back. [Task 7]
6. `#/sandbox/<unknown-id>` lands on the list, not a blank page. [Task 7]

## File Structure

| File | Responsibility |
|---|---|
| `src/schema/constants.ts` (modify) | `ROLES` gains `neutral`. |
| `schemas/*.json` (regenerate, add `sandbox.json`) | Generated JSON Schemas. |
| `src/schema/canvas.ts` (modify) | Export `PaletteItemSchema` and a shared `LayoutSchema`. |
| `src/game/canvasEdit.ts` (modify) | `addNode` honours an optional `max_nodes`. |
| `src/components/canvas/CanvasEditor.tsx` (create) | Palette, board, inspector, drag, keyboard, connect mode, announcements. Extracted from `CanvasScreen`. |
| `src/screens/CanvasScreen.tsx` (modify) | Brief, hints, cost, stress runs around `CanvasEditor`. |
| `src/schema/sandbox.ts` (create) | `SandboxSchema`, `SandboxFile`, `SandboxChallenge`. |
| `src/game/sandbox.ts` (create) | `resolveSandbox`, `sandboxChecks`, `runCheck`, `validateDesign`, constants. |
| `src/content/item.ts` (modify) | `contentKind` recognises `sandbox`; `parseItem` refuses to preview one. |
| `vite-plugin-content.ts`, `src/virtual-content.d.ts` (modify) | Load `content/sandbox/*.yaml`, expose `loadSandbox(provider)`. |
| `scripts/schemas.ts` (modify) | `sandbox` entry. |
| `content/sandbox/{aws,azure,gcp}-sandbox.yaml` (create) | Per-cloud sandbox definition. |
| `src/game/sandboxStore.ts` (create) | Pure store functions, load/save, export and import parsing. |
| `src/components/useSandbox.ts` (create) | Hook holding the store in React state and saving on change. |
| `src/screens/SandboxListScreen.tsx`, `src/screens/SandboxScreen.tsx` (create) | List and editor screens. |
| `src/App.tsx` (modify) | Route, nav button, lazy screens. |
| `README.md`, `AUTHORING.md` (modify) | Document the sandbox and the new content kind. |

Tests: `tests/sandbox-roles.test.ts`, `tests/canvas-edit-cap.test.ts`, `tests/sandbox-engine.test.ts`, `tests/sandbox-content.test.ts`, `tests/sandbox-store.test.ts`, `tests/sandbox-ui.test.tsx`.

---

### Task 1: The `neutral` role

**Files:**
- Create: `tests/sandbox-roles.test.ts`
- Modify: `src/schema/constants.ts:8`
- Regenerate: `schemas/canvas.json`, `schemas/pick-cloud-canvas.json` (via `npm run schemas`)

**Interfaces:**
- Consumes: nothing.
- Produces: `ROLES` is `['route', 'serve', 'write-store', 'neutral']`; canvas palette items may now declare `roles: [neutral]`.

- [ ] **Step 1: Write the failing test**

Create `tests/sandbox-roles.test.ts`:

```ts
// `neutral` is the role for parts the sandbox checks do not judge yet
// (queues, caches, object storage, CDNs).

import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ROLES } from '../src/schema/constants.ts'
import { CanvasChallengeSchema } from '../src/schema/canvas.ts'
import { checkRaw } from '../src/content/item.ts'

it('neutral is a role', () => {
  expect(ROLES).toContain('neutral')
})

it('the canvas schema accepts a palette item with only the neutral role', () => {
  const file = path.resolve(import.meta.dirname, '../content/cloud-design/aws-checkout-canvas.yaml')
  // The first palette item (the load balancer) becomes neutral; the rest of the file is untouched.
  // checkRaw validates shape only, so the reference designs are not run against the engine here.
  const raw = fs.readFileSync(file, 'utf8').replace('roles: [route]', 'roles: [neutral]')
  const errors: string[] = []
  expect(checkRaw(raw, CanvasChallengeSchema, 'aws-checkout-canvas', errors)).toBeTruthy()
  expect(errors).toEqual([])
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/sandbox-roles.test.ts`
Expected: FAIL (`ROLES` does not contain `neutral`; the schema rejects it).

- [ ] **Step 3: Add the role**

In `src/schema/constants.ts` change line 8 to:

```ts
export const ROLES = ['route', 'serve', 'write-store', 'neutral'] as const
```

Add a comment line above it: `// neutral: placed and linked like any part, but the engine's checks ignore it.`

- [ ] **Step 4: Regenerate JSON Schemas and run tests**

Run: `npm run schemas && npx vitest run tests/sandbox-roles.test.ts tests/schemas.test.ts && npx tsc -b && npx oxlint`
Expected: PASS; `git diff --stat schemas/` shows only `canvas.json` and `pick-cloud-canvas.json` changed (the enum gains `"neutral"`). If `tsc` reports a non-exhaustive use of the role union (a `Record<Role, …>` or a `switch`), handle `neutral` there as "no behaviour" and note it in the report.

- [ ] **Step 5: Checkpoint**

Run `npm test`. Expected: PASS. Show `git diff` to the user. Do not commit unless told.

---

### Task 2: Per-challenge node cap

**Files:**
- Create: `tests/canvas-edit-cap.test.ts`
- Modify: `src/game/canvasEdit.ts` (`addNode`, around lines 36-45)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export type Capped = CanvasChallenge & { max_nodes?: number }` in `canvasEdit.ts`; `addNode(c: Capped, d, type, lane)` uses `c.max_nodes ?? MAX_NODES`.

- [ ] **Step 1: Write the failing test**

Create `tests/canvas-edit-cap.test.ts`:

```ts
// The 12-component limit belongs to scored challenges; a challenge can carry
// its own cap (the sandbox uses 40).

import path from 'node:path'
import { expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { addNode, emptyDesign } from '../src/game/canvasEdit.ts'
import { MAX_NODES } from '../src/schema/constants.ts'
import type { Design } from '../src/schema/canvas.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const aws = canvases.find((c) => c.id === 'aws-checkout-canvas')!

const fill = (c: Parameters<typeof addNode>[0], n: number): Design | string => {
  let d: Design | string = emptyDesign()
  for (let i = 0; i < n && typeof d !== 'string'; i++) d = addNode(c, d, 'ec2-web', 'use1-az1')
  return d
}

it('a scored challenge stops at 12 components', () => {
  expect(typeof fill(aws, MAX_NODES)).toBe('object')
  const full = fill(aws, MAX_NODES) as Design
  expect(addNode(aws, full, 'ec2-web', 'use1-az1')).toBe(`A design can have at most ${MAX_NODES} components.`)
})

it('a challenge with its own cap uses it', () => {
  const roomy = { ...aws, max_nodes: MAX_NODES + 2 }
  const d = fill(roomy, MAX_NODES + 1) as Design
  expect(d.nodes).toHaveLength(MAX_NODES + 1)
  expect(addNode(roomy, fill(roomy, MAX_NODES + 2) as Design, 'ec2-web', 'use1-az1')).toBe(
    `A design can have at most ${MAX_NODES + 2} components.`,
  )
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/canvas-edit-cap.test.ts`
Expected: FAIL on "a challenge with its own cap uses it" (the cap is still 12).

- [ ] **Step 3: Implement**

In `src/game/canvasEdit.ts`, above `addNode` add:

```ts
// A challenge may carry its own cap (the sandbox does); scored ones use MAX_NODES.
export type Capped = CanvasChallenge & { max_nodes?: number }
```

and change `addNode` to:

```ts
export function addNode(c: Capped, d: Design, type: string, lane: string): Design | string {
  const p = c.palette.find((x) => x.id === type)
  if (!p) return 'Unknown component.'
  const max = c.max_nodes ?? MAX_NODES
  if (d.nodes.length >= max) return `A design can have at most ${max} components.`
```

(the remaining lines of the function are unchanged).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/canvas-edit-cap.test.ts tests/canvas-edit.test.ts tests/canvas.test.ts && npx tsc -b && npx oxlint`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Show `git diff`. Do not commit unless told.

---

### Task 3: Extract `CanvasEditor`

A pure refactor of a shipped screen: `CanvasScreen`'s editing surface moves into a shared component. No behaviour change; `tests/canvas-ui.test.tsx` and `tests/canvas-edit.test.ts` pass unchanged before and after.

**Files:**
- Create: `src/components/canvas/CanvasEditor.tsx`
- Modify: `src/screens/CanvasScreen.tsx` (rewrite as below)

**Interfaces:**
- Consumes: `Capped` from `src/game/canvasEdit.ts` (Task 2).
- Produces: default export `CanvasEditor` with props
  `{ c: Capped; design: Design; onChange: (d: Design) => void; down: Set<string>; belowBoard?: ReactNode; aside?: ReactNode }`.
  It renders the three-column grid (palette | how-to, connect banner, board, `belowBoard`, design list | inspector, `aside`), the polite status line and the drag ghost, as a fragment. `CanvasScreen` still exports `type CanvasRun`.

- [ ] **Step 1: Baseline**

Run: `npx vitest run tests/canvas-ui.test.tsx tests/canvas-edit.test.ts`
Expected: PASS. Note the counts; they must be identical at Step 4.

- [ ] **Step 2: Create `src/components/canvas/CanvasEditor.tsx`**

```tsx
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { USERS } from '../../schema/constants.ts'
import type { CanvasChallenge, Design } from '../../schema/canvas.ts'
import { addNode, connect, disconnect, laneLabel, lanesFor, moveNode, removeNode, targets, type Capped } from '../../game/canvasEdit.ts'
import Board, { type DragPayload } from './Board.tsx'
import Inspector from './Inspector.tsx'

type Kind = Design['edges'][number]['kind']

// The design surface shared by the scored canvas and the sandbox: palette,
// board, inspector, pointer drag, keyboard and touch controls, connect mode and
// screen-reader announcements. The parent owns the design; every edit goes
// through the pure functions in canvasEdit.ts and comes out through onChange.
export default function CanvasEditor({
  c,
  design,
  onChange,
  down,
  belowBoard,
  aside,
}: {
  c: Capped
  design: Design
  onChange: (d: Design) => void
  down: Set<string> // components to show as lost (a stress test or check result)
  belowBoard?: ReactNode // under the board: cost and the run button
  aside?: ReactNode // under the inspector: results, field guide, hints
}) {
  const uid = useId()
  const [selected, setSelected] = useState<string>()
  const [selections, setSelections] = useState(0) // re-selecting the same component still refocuses the inspector
  const [connecting, setConnecting] = useState<{ from: string; kind: Kind }>()
  const [drag, setDrag] = useState<{ payload: DragPayload; x: number; y: number }>()
  const [message, setMessage] = useState('') // announced to screen readers
  const justDragged = useRef(false)

  // Every edit goes through the pure functions in canvasEdit.ts; a string
  // result is a rule violation, shown and announced instead of applied.
  function apply(r: Design | string, done: string) {
    if (typeof r === 'string') return setMessage(r)
    onChange(r)
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

  return (
    <>
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
          {belowBoard}
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
          {aside}
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
    </>
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
```

- [ ] **Step 3: Replace `src/screens/CanvasScreen.tsx`**

```tsx
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
```

- [ ] **Step 4: Verify nothing changed**

Run: `npx vitest run tests/canvas-ui.test.tsx tests/canvas-edit.test.ts tests/canvas.test.ts tests/multi-ui.test.tsx && npx tsc -b && npx oxlint`
Expected: PASS with the same counts as Step 1. If `tsc` flags an unused import in `CanvasScreen.tsx`, remove it.

- [ ] **Step 5: Checkpoint**

Run `npm test` (full suite). Show `git diff --stat`. Do not commit unless told.

---

### Task 4: Sandbox schema, resolver, checks

**Files:**
- Modify: `src/schema/canvas.ts` (export `PaletteItemSchema`; extract and export `LayoutSchema`)
- Create: `src/schema/sandbox.ts`
- Create: `src/game/sandbox.ts`
- Create: `tests/sandbox-engine.test.ts`

**Interfaces:**
- Consumes: `Capped`/`lanes` from `canvasEdit.ts`; `evaluateCanvas`, `CanvasTestResult` from `canvas.ts`; `ROLES`/`USERS` from constants.
- Produces:
  - `SandboxSchema`, `type SandboxFile`, `type SandboxChallenge = CanvasChallenge & { max_nodes: number }` (`src/schema/sandbox.ts`).
  - `SANDBOX_MAX_NODES = 40`, `SPIKE = 3`.
  - `resolveSandbox(f: SandboxFile, base: CanvasChallenge): SandboxChallenge | string` (string = error message).
  - `sandboxChecks(c: SandboxChallenge, d: Design): CanvasTest[]`.
  - `runCheck(c: SandboxChallenge, d: Design, testId: string): CanvasTestResult | undefined`.
  - `validateDesign(c: SandboxChallenge, d: Design): string | undefined` (first problem, or undefined).

- [ ] **Step 1: Export the shared schema pieces**

In `src/schema/canvas.ts`: change `const PaletteItemSchema =` to `export const PaletteItemSchema =`. Extract the inline `layout:` object into

```ts
export const LayoutSchema = z.strictObject({
  regions: z
    .array(
      z.strictObject({
        id,
        label: z.string().min(1),
        zones: z.array(z.strictObject({ id, label: z.string().min(1) })).min(1),
      }),
    )
    .min(1),
  global: z.boolean().default(false),
})
```

placed above `CanvasChallengeSchema`, and replace the inline object with `layout: LayoutSchema,`. Run `npx vitest run tests/schemas.test.ts`; expected PASS (generated JSON unchanged).

- [ ] **Step 2: Write the failing tests**

Create `tests/sandbox-engine.test.ts`:

```ts
// The sandbox adapter and checks against the real engine. The sandbox file is
// built inline here; tests/sandbox-content.test.ts covers the shipped files.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { resolveSandbox, runCheck, sandboxChecks, validateDesign, SANDBOX_MAX_NODES } from '../src/game/sandbox.ts'
import type { SandboxChallenge, SandboxFile } from '../src/schema/sandbox.ts'
import type { Design } from '../src/schema/canvas.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const base = canvases.find((c) => c.id === 'aws-checkout-canvas')!

const file: SandboxFile = {
  type: 'sandbox',
  id: 'aws-sandbox',
  provider: 'aws',
  title: 'AWS design sandbox',
  extends: 'aws-checkout-canvas',
  layout: {
    regions: [
      { id: 'use1', label: 'us-east-1', zones: [{ id: 'use1-az1', label: 'us-east-1a' }, { id: 'use1-az2', label: 'us-east-1b' }] },
      { id: 'usw2', label: 'us-west-2', zones: [{ id: 'usw2-az1', label: 'us-west-2a' }, { id: 'usw2-az2', label: 'us-west-2b' }] },
    ],
    global: true,
  },
  palette: [
    { id: 'sqs', label: 'Amazon SQS queue', short: 'SQS', scope: 'regional', roles: ['neutral'], capacity: 0, cost: 1, facts: ['A message queue.'] },
    { id: 'cdn', label: 'Amazon CloudFront', short: 'CDN', scope: 'global', roles: ['neutral'], capacity: 0, cost: 2, facts: ['A CDN.'] },
  ],
  sources: [{ title: 'Example', url: 'https://example.com', retrieved: '2026-10-27' }],
}
const resolved = resolveSandbox(file, base)
if (typeof resolved === 'string') throw new Error(resolved)
const c: SandboxChallenge = resolved

const node = (id: string, type: string, lane: string) => ({ id, type, lane })
const traffic = (from: string, to: string) => ({ from, to, kind: 'traffic' as const })

// Load balancer, two web servers and two databases (sync standby) across two zones of one region.
const twoZone: Design = {
  nodes: [
    node('alb-1', 'alb', 'use1'),
    node('web-1', 'ec2-web', 'use1-az1'),
    node('web-2', 'ec2-web', 'use1-az2'),
    node('rds-1', 'rds', 'use1-az1'),
    node('rds-2', 'rds', 'use1-az2'),
  ],
  edges: [
    traffic('users', 'alb-1'),
    traffic('alb-1', 'web-1'),
    traffic('alb-1', 'web-2'),
    traffic('web-1', 'rds-1'),
    traffic('web-2', 'rds-1'),
    { from: 'rds-1', to: 'rds-2', kind: 'sync' },
  ],
}
// Everything in one zone.
const oneZone: Design = {
  nodes: [node('alb-1', 'alb', 'use1'), node('web-1', 'ec2-web', 'use1-az1'), node('rds-1', 'rds', 'use1-az1')],
  edges: [traffic('users', 'alb-1'), traffic('alb-1', 'web-1'), traffic('web-1', 'rds-1')],
}

const outcome = (d: Design) => Object.fromEntries(sandboxChecks(c, d).map((t) => [t.id, runCheck(c, d, t.id)!.pass]))

describe('resolveSandbox', () => {
  it('merges the base palette with the extras and carries the sandbox node cap', () => {
    expect(c.palette.map((p) => p.id)).toEqual([...base.palette.map((p) => p.id), 'sqs', 'cdn'])
    expect(c.max_nodes).toBe(SANDBOX_MAX_NODES)
    expect(c.layout.regions).toHaveLength(2)
    expect(c.provider).toBe('aws')
  })

  it('refuses a base from another cloud or a colliding palette id', () => {
    const azure = canvases.find((x) => x.provider === 'azure')!
    expect(resolveSandbox(file, azure)).toMatch(/aws/)
    expect(resolveSandbox({ ...file, palette: [{ ...file.palette[0], id: 'alb' }] }, base)).toMatch(/alb/)
  })
})

describe('sandboxChecks', () => {
  it('offers nothing for an empty design or one with only neutral parts', () => {
    expect(sandboxChecks(c, { nodes: [], edges: [] })).toEqual([])
    expect(sandboxChecks(c, { nodes: [node('sqs-1', 'sqs', 'use1')], edges: [] })).toEqual([])
  })

  it('builds the menu from what the design uses', () => {
    expect(sandboxChecks(c, twoZone).map((t) => t.id)).toEqual([
      'zone-use1-az1',
      'zone-use1-az2',
      'region-use1',
      'one-alb',
      'one-ec2-web',
      'one-rds',
      'spike',
    ])
  })

  it('gives a neutral-only type no "lose any one" check', () => {
    const withQueue: Design = { ...twoZone, nodes: [...twoZone.nodes, node('sqs-1', 'sqs', 'use1')] }
    expect(sandboxChecks(c, withQueue).some((t) => t.id === 'one-sqs')).toBe(false)
  })

  it('only requires roles the design contains, and the spike only with a web tier', () => {
    const noDb: Design = { nodes: [node('alb-1', 'alb', 'use1'), node('web-1', 'ec2-web', 'use1-az1')], edges: [traffic('users', 'alb-1'), traffic('alb-1', 'web-1')] }
    const checks = sandboxChecks(c, noDb)
    expect(checks.every((t) => !t.check.reach.includes('write-store'))).toBe(true)
    expect(outcome(noDb)['zone-use1-az1']).toBe(false) // the only web server is gone, not "no database"
    const dbOnly: Design = { nodes: [node('rds-1', 'rds', 'use1-az1')], edges: [] }
    expect(sandboxChecks(c, dbOnly).some((t) => t.id === 'spike')).toBe(false)
  })
})

describe('runCheck', () => {
  it('a two-zone design survives losing either zone and a spike, but not a region or its only load balancer', () => {
    expect(outcome(twoZone)).toEqual({
      'zone-use1-az1': true,
      'zone-use1-az2': true,
      'region-use1': false,
      'one-alb': false,
      'one-ec2-web': true,
      'one-rds': true,
      spike: true,
    })
  })

  it('a one-zone design fails the zone check for that zone, with a reason', () => {
    const r = runCheck(c, oneZone, 'zone-use1-az1')!
    expect(r.pass).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/web server/)
    expect(r.down).toEqual(expect.arrayContaining(['web-1', 'rds-1']))
  })

  it('one zone check reports only that zone, not other occupied zones', () => {
    const r = runCheck(c, twoZone, 'zone-use1-az2')!
    expect(r.pass).toBe(true)
    expect(r.reasons).toEqual([])
  })

  it('an unknown check id gives undefined', () => {
    expect(runCheck(c, twoZone, 'nope')).toBeUndefined()
  })

  it('neutral parts neither help nor hurt a result', () => {
    const withQueue: Design = { nodes: [...twoZone.nodes, node('sqs-1', 'sqs', 'use1')], edges: [...twoZone.edges, traffic('web-1', 'sqs-1')] }
    expect(outcome(withQueue)).toEqual(outcome(twoZone))
  })
})

describe('validateDesign', () => {
  it('accepts a design the editor could have built', () => {
    expect(validateDesign(c, twoZone)).toBeUndefined()
  })

  it.each([
    ['an unknown part', { nodes: [node('x-1', 'lambda', 'use1')], edges: [] }, /lambda/],
    ['a part in the wrong kind of lane', { nodes: [node('web-1', 'ec2-web', 'use1')], edges: [] }, /can't go in/],
    ['a duplicate id', { nodes: [node('a', 'alb', 'use1'), node('a', 'alb', 'use1')], edges: [] }, /Duplicate/],
    ['the reserved id', { nodes: [node('users', 'alb', 'use1')], edges: [] }, /reserved/],
    ['a link to nowhere', { nodes: [node('alb-1', 'alb', 'use1')], edges: [traffic('alb-1', 'ghost')] }, /ghost/],
    [
      'replication between non-databases',
      { nodes: [node('alb-1', 'alb', 'use1'), node('web-1', 'ec2-web', 'use1-az1')], edges: [{ from: 'alb-1', to: 'web-1', kind: 'sync' as const }] },
      /two databases/,
    ],
  ])('rejects %s', (_name, d, message) => {
    expect(validateDesign(c, d as Design)).toMatch(message)
  })

  it('rejects a design over the cap', () => {
    const many: Design = { nodes: Array.from({ length: SANDBOX_MAX_NODES + 1 }, (_, i) => node(`w-${i}`, 'ec2-web', 'use1-az1')), edges: [] }
    expect(validateDesign(c, many)).toMatch(/40/)
  })
})
```

- [ ] **Step 3: Run and confirm failure**

Run: `npx vitest run tests/sandbox-engine.test.ts`
Expected: FAIL, cannot resolve `../src/game/sandbox.ts`.

- [ ] **Step 4: Create `src/schema/sandbox.ts`**

```ts
// Sandbox content (content/sandbox/*.yaml): one file per cloud. It extends
// that cloud's single-provider canvas challenge (reusing its palette, link
// facts and sources) with extra parts and a fixed layout. resolveSandbox() in
// src/game/sandbox.ts turns one into an ordinary CanvasChallenge for the
// engine, so every editor and check downstream is reused.

import { z } from 'zod'
import { SourcesSchema, id } from './scenario.ts'
import { LayoutSchema, PaletteItemSchema, type CanvasChallenge } from './canvas.ts'
import { PROVIDERS } from './constants.ts'

export const SandboxSchema = z
  .strictObject({
    type: z.literal('sandbox'),
    id,
    provider: z.enum(PROVIDERS),
    title: z.string().min(1),
    extends: id, // the canvas challenge whose palette is reused
    layout: LayoutSchema,
    palette: z.array(PaletteItemSchema).min(1), // extra parts, all neutral
    sources: SourcesSchema,
  })
  .superRefine((f, ctx) => {
    f.palette.forEach((p, i) => {
      if (p.roles.length !== 1 || p.roles[0] !== 'neutral')
        ctx.addIssue({ code: 'custom', message: 'sandbox parts are neutral: roles must be [neutral]', path: ['palette', i, 'roles'], input: f })
    })
    const zones = f.layout.regions.flatMap((r) => r.zones.map((z) => z.id))
    const lanes = [...zones, ...f.layout.regions.map((r) => r.id), 'global']
    if (new Set(lanes).size !== lanes.length)
      ctx.addIssue({ code: 'custom', message: 'lane ids must be unique across regions and zones', path: ['layout'], input: f })
    if (!f.layout.global)
      ctx.addIssue({ code: 'custom', message: 'the sandbox layout needs the global lane (global: true)', path: ['layout', 'global'], input: f })
  })

export type SandboxFile = z.infer<typeof SandboxSchema>

// A resolved sandbox: an ordinary canvas challenge plus its own node cap.
export type SandboxChallenge = CanvasChallenge & { max_nodes: number }
```

- [ ] **Step 5: Create `src/game/sandbox.ts`**

```ts
// The design sandbox, as pure functions: turning a sandbox file into a
// challenge the canvas engine understands, building the menu of failure checks
// from what the design actually contains, and validating a design against a
// cloud's palette and lanes (used on import and when a saved design is opened).
//
// No scoring: a check shows what survives and why.

import { USERS } from '../schema/constants.ts'
import type { CanvasTest, Design } from '../schema/canvas.ts'
import type { SandboxChallenge, SandboxFile } from '../schema/sandbox.ts'
import type { CanvasChallenge } from '../schema/canvas.ts'
import { evaluateCanvas, type CanvasTestResult } from './canvas.ts'
import { lanes } from './canvasEdit.ts'

export const SANDBOX_MAX_NODES = 40
export const SPIKE = 3 // the traffic-spike check: this many times normal traffic

// Returns an error message when the file can't extend the base.
export function resolveSandbox(f: SandboxFile, base: CanvasChallenge): SandboxChallenge | string {
  if (base.provider !== f.provider) return `extends "${base.id}", which is a ${base.provider} challenge, not ${f.provider}`
  const taken = new Set(base.palette.map((p) => p.id))
  const clash = f.palette.find((p) => taken.has(p.id))
  if (clash) return `palette id "${clash.id}" is already in ${base.id}'s palette`
  return {
    type: 'challenge',
    mode: 'canvas',
    id: f.id,
    track: base.track,
    difficulty: 1,
    title: f.title,
    provider: f.provider,
    par_minutes: 1,
    brief: 'A free-form sandbox: build anything, then run the checks.',
    requirements: ['No requirements: the checks show what survives and why.'],
    budget: 1_000_000,
    layout: f.layout,
    palette: [...base.palette, ...f.palette],
    link_facts: base.link_facts,
    stress_tests: [],
    reference_designs: [],
    counter_examples: [],
    hints: base.hints,
    analogy: base.analogy,
    debrief: base.debrief,
    sources: [...base.sources, ...f.sources],
    max_nodes: SANDBOX_MAX_NODES,
  }
}

const rolesOf = (c: SandboxChallenge, type: string) => c.palette.find((p) => p.id === type)?.roles ?? []

// The checks on offer for this design. Only roles the design contains are
// required, so a design with no database isn't failed for lacking one; a design
// with nothing the engine judges (no web server, no database) gets no checks,
// because every one would pass without meaning anything.
export function sandboxChecks(c: SandboxChallenge, d: Design): CanvasTest[] {
  const has = (role: 'serve' | 'write-store') => d.nodes.some((n) => rolesOf(c, n.type).includes(role))
  const reach = (['serve', 'write-store'] as const).filter(has)
  if (!reach.length) return []
  const check = { reach }
  const occupied = (lane: string) => d.nodes.some((n) => n.lane === lane)
  const label = (type: string) => c.palette.find((p) => p.id === type)?.label ?? type
  const judged = [...new Set(d.nodes.filter((n) => rolesOf(c, n.type).some((r) => r !== 'neutral')).map((n) => n.type))]

  const tests: CanvasTest[] = [
    ...c.layout.regions.flatMap((r) => r.zones).filter((z) => occupied(z.id)).map((z): CanvasTest => ({ id: `zone-${z.id}`, label: `Lose ${z.label}`, event: { zone_outage: z.id }, check })),
    ...c.layout.regions
      .filter((r) => occupied(r.id) || r.zones.some((z) => occupied(z.id)))
      .map((r): CanvasTest => ({ id: `region-${r.id}`, label: `Lose region ${r.label}`, event: { region_outage: r.id }, check })),
    ...judged.map((t): CanvasTest => ({ id: `one-${t}`, label: `Lose any one ${label(t)}`, event: { single_failure: t }, check })),
  ]
  if (has('serve')) tests.push({ id: 'spike', label: `Traffic spike: ${SPIKE}× normal`, event: { none: true }, check: { reach, capacity: SPIKE } })
  return tests
}

// Runs one check. The engine fails every occupied zone that no zone test names
// (so a design can't hide in an unlisted zone); passing the whole generated
// menu names every occupied zone, so a single zone check reports only its zone.
export function runCheck(c: SandboxChallenge, d: Design, testId: string): CanvasTestResult | undefined {
  return evaluateCanvas({ ...c, stress_tests: sandboxChecks(c, d) }, d).tests.find((t) => t.id === testId)
}

// The first reason this design couldn't have been built in this cloud's editor, or undefined.
export function validateDesign(c: SandboxChallenge, d: Design): string | undefined {
  if (d.nodes.length > c.max_nodes) return `A design can have at most ${c.max_nodes} components.`
  const palette = new Map(c.palette.map((p) => [p.id, p]))
  const laneScope = new Map(lanes(c).map((l) => [l.id, l.scope]))
  const ids = new Set<string>()
  for (const n of d.nodes) {
    if (n.id === USERS) return `"${USERS}" is reserved and can't be a component id.`
    if (ids.has(n.id)) return `Duplicate component id "${n.id}".`
    ids.add(n.id)
    const p = palette.get(n.type)
    if (!p) return `"${n.id}" is a ${n.type}, which isn't in this cloud's palette.`
    if (laneScope.get(n.lane) !== p.scope) return `${n.id} (${p.label}) can't go in lane "${n.lane}".`
  }
  const isStore = (id: string) => rolesOf(c, d.nodes.find((n) => n.id === id)?.type ?? '').includes('write-store')
  for (const e of d.edges) {
    if (e.from !== USERS && !ids.has(e.from)) return `A link starts at "${e.from}", which isn't in the design.`
    if (!ids.has(e.to)) return `A link ends at "${e.to}", which isn't in the design.`
    if (e.kind !== 'traffic' && !(isStore(e.from) && isStore(e.to))) return 'Replication links must join two databases.'
  }
}
```

- [ ] **Step 6: Run tests, types, lint**

Run: `npx vitest run tests/sandbox-engine.test.ts tests/schemas.test.ts && npx tsc -b && npx oxlint`
Expected: PASS. If an outcome in "a two-zone design survives…" differs from the table, do not edit the table to match: read the reason from `runCheck`, and decide whether the engine or the expectation is wrong (use systematic debugging); record any ruling.

- [ ] **Step 7: Checkpoint**

Run `npm test`. Show `git diff` and new files. Do not commit unless told.

---

### Task 5: Content plumbing and the AWS sandbox file

**Files:**
- Modify: `src/content/item.ts` (`ContentKind`, `contentKind`, `parseItem`)
- Modify: `scripts/schemas.ts` (add `sandbox`)
- Modify: `vite-plugin-content.ts` (`Content`, `loadContent`, `scenarioFiles`, plugin)
- Modify: `src/virtual-content.d.ts`
- Create: `content/sandbox/aws-sandbox.yaml`
- Create: `schemas/sandbox.json` (generated)
- Create: `tests/sandbox-content.test.ts`
- Modify: any `Content` literal that lacks `sandboxes` (find with `grep -rn "canvases: \[\]" src tests vite-plugin-content.ts`)

**Interfaces:**
- Consumes: `SandboxSchema`, `SandboxChallenge` (Task 4); `resolveSandbox` (Task 4).
- Produces:
  - `Content.sandboxes: SandboxChallenge[]` from `loadContent`.
  - `contentKind(raw)` returns `'sandbox'` for `type: sandbox`.
  - Virtual module export `loadSandbox(provider: 'aws' | 'azure' | 'gcp'): Promise<SandboxChallenge | undefined>`.
  - `content/sandbox/aws-sandbox.yaml` (id `aws-sandbox`).

- [ ] **Step 1: Write the failing test**

Create `tests/sandbox-content.test.ts`:

```ts
// The shipped sandbox files: they resolve against their canvas challenge, only
// add neutral parts, and every part explains itself.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentKind, loadContent } from '../vite-plugin-content.ts'
import { parseItem } from '../src/content/item.ts'

const dir = path.resolve(import.meta.dirname, '../content')
const content = loadContent(dir)

describe('contentKind', () => {
  it('recognises a sandbox file', () => {
    expect(contentKind('# comment\ntype: sandbox\nid: x\n')).toBe('sandbox')
    expect(contentKind('type: challenge\nmode: canvas\n')).toBe('canvas')
  })
})

describe('the preview page', () => {
  it('says sandbox files are checked by the build instead of misreading them as incidents', () => {
    const { item, errors } = parseItem('type: sandbox\nid: x\n', 'Your file')
    expect(item).toBeUndefined()
    expect(errors.join(' ')).toMatch(/sandbox files are checked by the build/)
  })
})

describe('sandbox files', () => {
  it('are loaded, never listed as playable challenges', () => {
    expect(content.sandboxes.length).toBeGreaterThan(0)
    for (const s of content.sandboxes) expect(content.canvases.some((c) => c.id === s.id)).toBe(false)
  })

  it.each(content.sandboxes.map((s) => [s.id, s] as const))('%s: extends a same-cloud canvas and adds only explained neutral parts', (_id, s) => {
    const raw = fs.readFileSync(path.join(dir, 'sandbox', `${s.id}.yaml`), 'utf8')
    expect(raw.split('\n')[0]).toBe('# yaml-language-server: $schema=../../schemas/sandbox.json')
    const extras = s.palette.filter((p) => p.roles.includes('neutral'))
    expect(extras.length).toBeGreaterThanOrEqual(3)
    for (const p of extras) {
      expect(p.roles, p.id).toEqual(['neutral'])
      expect(p.facts.length, p.id).toBeGreaterThan(0)
    }
    expect(s.layout.global).toBe(true)
    expect(s.layout.regions).toHaveLength(2)
    for (const r of s.layout.regions) expect(r.zones, r.id).toHaveLength(2)
    expect(new Set(s.palette.map((p) => p.id)).size).toBe(s.palette.length)
  })

  it('a sandbox file whose extends names another cloud is rejected by the build', () => {
    const tmp = fs.mkdtempSync(path.join(import.meta.dirname, '.tmp-sb-'))
    try {
      fs.cpSync(dir, tmp, { recursive: true })
      const file = path.join(tmp, 'sandbox', 'aws-sandbox.yaml')
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('extends: aws-checkout-canvas', 'extends: azure-portal-canvas'))
      expect(() => loadContent(tmp)).toThrow(/aws-sandbox\.yaml.*not aws/s)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/sandbox-content.test.ts`
Expected: FAIL (`content.sandboxes` is undefined; `contentKind` returns `incident`).

- [ ] **Step 3: `src/content/item.ts`**

Change the `ContentKind` type to `'incident' | 'challenge' | 'canvas' | 'pick-cloud-canvas' | 'pick-cloud-slot' | 'sandbox'`, and at the top of `contentKind`:

```ts
  if (/^type:\s*sandbox\s*$/m.test(raw)) return 'sandbox'
```

Update the doc comment above it to mention sandbox files. In `parseItem`, immediately after `const kind = contentKind(raw)` add:

```ts
  if (kind === 'sandbox')
    return { errors: [`${where}: sandbox files are checked by the build (run npm test); the preview page can't play them.`] }
```

- [ ] **Step 4: `scripts/schemas.ts`**

Add `import { SandboxSchema } from '../src/schema/sandbox.ts'` and `sandbox: SandboxSchema,` to `SCHEMAS`. Run `npm run schemas`; expected: `schemas/sandbox.json` created.

- [ ] **Step 5: `vite-plugin-content.ts`**

1. Imports: `import { SandboxSchema, type SandboxChallenge } from './src/schema/sandbox.ts'` and `import { resolveSandbox } from './src/game/sandbox.ts'`.
2. `Content` gains `sandboxes: SandboxChallenge[] // content/sandbox/*.yaml, resolved against their canvas challenge`; the initial object in `loadContent` gains `sandboxes: []`.
3. Next to `const COMMANDS_DIR = 'commands'` add `const SANDBOX_DIR = 'sandbox'`, and in `scenarioFiles` extend the filter with `&& !f.startsWith(SANDBOX_DIR + path.sep)`. Update that function's comment ("…the command library and the sandbox files, which are not playable scenarios").
4. In `loadContent`, after the `for (const file of scenarioFiles(dir))` loop and before the `tracks.forEach` check, add:

```ts
  // Sandbox files: one per cloud, resolved against the canvas challenge they extend.
  const sandboxDir = path.join(dir, SANDBOX_DIR)
  if (fs.existsSync(sandboxDir))
    for (const f of fs.readdirSync(sandboxDir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      const file = path.join(sandboxDir, f)
      const where = path.relative(process.cwd(), file)
      const s = check(file, SandboxSchema, errors)
      if (!s) continue
      if (s.id !== f.replace(/\.ya?ml$/, '')) errors.push(`${where}: id "${s.id}" must match the filename`)
      if (seen.has(s.id)) errors.push(`${where}: duplicate id "${s.id}"`)
      seen.add(s.id)
      const base = content.canvases.find((c) => c.id === s.extends)
      if (!base) {
        errors.push(`${where}: extends "${s.extends}", which is not a canvas challenge`)
        continue
      }
      const resolved = resolveSandbox(s, base)
      if (typeof resolved === 'string') errors.push(`${where}: ${resolved}`)
      else content.sandboxes.push(resolved)
    }
```

5. Plugin: add `const SANDBOX_PREFIX = VIRTUAL_ID + '/sandbox/'`; `resolveId` returns `'\0' + id` also for `id.startsWith(SANDBOX_PREFIX)`; in `load` for the main module add, after the `loaders` line:

```ts
        const sandboxes = c.sandboxes.map((s) => `${JSON.stringify(s.provider)}: () => import(${JSON.stringify(SANDBOX_PREFIX + s.provider)})`)
```

and push these two lines into the returned array: `` `const sandboxLoaders = {${sandboxes.join(',')}}` `` and `` `export const loadSandbox = (provider) => sandboxLoaders[provider]?.().then((m) => m.default)` ``; add a `load` branch:

```ts
      if (id.startsWith('\0' + SANDBOX_PREFIX)) {
        const provider = id.slice(1 + SANDBOX_PREFIX.length)
        return `export default ${JSON.stringify(content().sandboxes.find((s) => s.provider === provider))}`
      }
```

(place it before the `ITEM_PREFIX` branch; the two prefixes differ so order does not matter for correctness).

- [ ] **Step 6: `src/virtual-content.d.ts`**

Inside the module declaration add:

```ts
  // One cloud's design sandbox, loaded on demand as its own chunk (undefined if that cloud has none).
  export function loadSandbox(provider: 'aws' | 'azure' | 'gcp'): Promise<import('./schema/sandbox.ts').SandboxChallenge | undefined>
```

- [ ] **Step 7: Research and write `content/sandbox/aws-sandbox.yaml`**

Read these pages first and write every fact in your own words (do not copy phrasing); set each source's `retrieved` to the date you read it:

- Amazon SQS: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html (and the "standard queues" page for durability)
- Amazon ElastiCache Multi-AZ: https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/AutoFailover.html
- Amazon S3 durability and where data lives: https://docs.aws.amazon.com/AmazonS3/latest/userguide/DataDurability.html
- Amazon CloudFront (what it is, edge locations): https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html

For each part decide `scope` from the docs (a queue and object storage are Regional services; a cache node lives in one Availability Zone; CloudFront is global) and record any scope you chose differently from this in your report. Use `cost` 1 for SQS and S3, 2 for ElastiCache and CloudFront, `capacity: 0`, `roles: [neutral]`.

File shape (first line is required by `tests/schemas.test.ts`):

```yaml
# yaml-language-server: $schema=../../schemas/sandbox.json
type: sandbox
id: aws-sandbox
provider: aws
title: "AWS design sandbox"
extends: aws-checkout-canvas

layout:
  global: true
  regions:
    - id: use1
      label: "us-east-1"
      zones:
        - { id: use1-az1, label: "us-east-1a" }
        - { id: use1-az2, label: "us-east-1b" }
    - id: usw2
      label: "us-west-2"
      zones:
        - { id: usw2-az1, label: "us-west-2a" }
        - { id: usw2-az2, label: "us-west-2b" }

palette:
  - id: sqs
    label: "Amazon SQS queue"
    short: "SQS"
    scope: regional
    roles: [neutral]
    cost: 1
    facts:
      - "<one or two verified facts, own words>"
  # ...elasticache (short "cache", scope per docs), s3 (short "S3"), cloudfront (short "CDN", scope: global)
  # each with the same fields

sources:
  - title: "<page title>"
    url: "<url>"
    retrieved: <YYYY-MM-DD>
```

Every part needs at least one fact; every page you used needs a `sources` entry. `short` is at most 22 characters.

- [ ] **Step 8: Run tests**

Run: `npx vitest run tests/sandbox-content.test.ts tests/schemas.test.ts tests/content.test.ts && npx tsc -b && npx oxlint`
Expected: PASS. Then run `node -e "import('./vite-plugin-content.ts').then(m=>{try{m.loadContent('content');console.log('OK')}catch(e){console.log(e.message)}})"`; expected `OK`.

- [ ] **Step 9: Checkpoint**

Run `npm test`. Show `git diff` and the new files. Do not commit unless told.

---

### Task 6: Azure and Google Cloud sandbox files

**Files:**
- Create: `content/sandbox/azure-sandbox.yaml`, `content/sandbox/gcp-sandbox.yaml`
- Modify: `tests/sandbox-content.test.ts` (one new test)

**Interfaces:**
- Consumes: the file format and loader from Task 5.
- Produces: `loadContent(...).sandboxes` has one entry for each of `aws`, `azure`, `gcp`.

- [ ] **Step 1: Write the failing test**

Append to `tests/sandbox-content.test.ts`:

```ts
it('every cloud has a sandbox', () => {
  expect(content.sandboxes.map((s) => s.provider).sort()).toEqual(['aws', 'azure', 'gcp'])
})
```

Run `npx vitest run tests/sandbox-content.test.ts`; expected FAIL (azure, gcp missing).

- [ ] **Step 2: Azure file**

`extends: azure-portal-canvas`. The base palette already has Azure Front Door (global, the CDN role), so Azure gets **three** extras, not four: queue (Azure Service Bus), cache (Azure Cache for Redis), object storage (Azure Blob Storage). Layout (global lane on):

```yaml
layout:
  global: true
  regions:
    - id: eus2
      label: "East US 2"
      zones:
        - { id: eus2-z1, label: "Zone 1" }
        - { id: eus2-z2, label: "Zone 2" }
    - id: wus2
      label: "West US 2"
      zones:
        - { id: wus2-z1, label: "Zone 1 (West US 2)" }
        - { id: wus2-z2, label: "Zone 2 (West US 2)" }
```

Read and cite: Service Bus (https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-messaging-overview and its availability-zones/geo-recovery page), Azure Cache for Redis or its current successor's reliability page (https://learn.microsoft.com/en-us/azure/reliability/reliability-azure-cache-for-redis), Blob Storage redundancy (https://learn.microsoft.com/en-us/azure/storage/common/storage-redundancy). If Microsoft's docs say Azure Cache for Redis is being retired in favour of another service, use the current service named there and say so in your report. Same rules as Task 5 for scope, cost, capacity, facts and sources; first line `# yaml-language-server: $schema=../../schemas/sandbox.json`; `id: azure-sandbox`.

- [ ] **Step 3: Google Cloud file**

`extends: gcp-signup-canvas`. Four extras: queue (Pub/Sub), cache (Memorystore), object storage (Cloud Storage), CDN (Cloud CDN). Layout:

```yaml
layout:
  global: true
  regions:
    - id: usc1
      label: "us-central1"
      zones:
        - { id: usc1-a, label: "us-central1-a" }
        - { id: usc1-b, label: "us-central1-b" }
    - id: use1
      label: "us-east1"
      zones:
        - { id: use1-b, label: "us-east1-b" }
        - { id: use1-c, label: "us-east1-c" }
```

Read and cite: Pub/Sub overview (https://cloud.google.com/pubsub/docs/overview), Memorystore high availability (https://cloud.google.com/memorystore/docs/redis/high-availability or the current Memorystore page), Cloud Storage locations (https://cloud.google.com/storage/docs/locations), Cloud CDN overview (https://cloud.google.com/cdn/docs/overview). Same rules; `id: gcp-sandbox`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/sandbox-content.test.ts tests/schemas.test.ts && npm test && npx tsc -b && npx oxlint && npm run check-links`
Expected: PASS (`check-links` may report pre-existing external 403s such as `dev.mysql.com`; every new URL must resolve).

- [ ] **Step 5: Checkpoint**

Show the two new files and the facts you wrote with the page each came from. Do not commit unless told.

---

### Task 7: Store, export and import

**Files:**
- Create: `src/game/sandboxStore.ts`
- Create: `tests/sandbox-store.test.ts`

**Interfaces:**
- Consumes: `Design` type; `PROVIDERS`/`Provider`; `validateDesign`, `SandboxChallenge` (Task 4).
- Produces (all exported from `src/game/sandboxStore.ts`):
  - `type SavedDesign = { id: string; name: string; provider: Provider; design: Design; updatedAt: string }`
  - `type SandboxData = { version: 1; designs: SavedDesign[] }`
  - `KEY = 'incident-quest:sandbox'`
  - `emptySandbox(): SandboxData`
  - `loadSandbox(storage?: Store): SandboxData`
  - `saveSandbox(data: SandboxData, storage?: Store): boolean` (false when storage failed)
  - `createDesign(data, args: { id: string; name: string; provider: Provider; now?: Date }): SandboxData`
  - `renameDesign(data, id, name): SandboxData`, `updateDesign(data, id, design, now?): SandboxData`, `deleteDesign(data, id): SandboxData`
  - `newId(): string`
  - `exportDesign(d: SavedDesign): string`
  - `readExport(text: string): { name: string; provider: Provider; design: Design } | { error: string }` (shape only; callers then run `validateDesign`)
  - `type Store = Pick<Storage, 'getItem' | 'setItem'>`

- [ ] **Step 1: Write the failing tests**

Create `tests/sandbox-store.test.ts`:

```ts
// Saved sandbox designs: what is remembered, what is refused, what is never lost.
// Storage and imported files are untrusted.

import { describe, expect, it } from 'vitest'
import {
  KEY, createDesign, deleteDesign, emptySandbox, exportDesign, loadSandbox, newId, readExport, renameDesign, saveSandbox, updateDesign,
} from '../src/game/sandboxStore.ts'
import type { Design } from '../src/schema/canvas.ts'

const fake = (initial?: string) => {
  const data = new Map<string, string>(initial === undefined ? [] : [[KEY, initial]])
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
}
const design: Design = { nodes: [{ id: 'alb-1', type: 'alb', lane: 'use1' }], edges: [{ from: 'users', to: 'alb-1', kind: 'traffic' }] }
const now = new Date('2026-10-27T10:00:00Z')

describe('the pure operations', () => {
  it('create, rename, update and delete without mutating the input', () => {
    const empty = emptySandbox()
    const one = createDesign(empty, { id: 'a1', name: '  My shop  ', provider: 'aws', now })
    expect(empty.designs).toHaveLength(0)
    expect(one.designs[0]).toEqual({ id: 'a1', name: 'My shop', provider: 'aws', design: { nodes: [], edges: [] }, updatedAt: now.toISOString() })
    expect(renameDesign(one, 'a1', 'Renamed').designs[0].name).toBe('Renamed')
    expect(updateDesign(one, 'a1', design, new Date('2026-10-28T00:00:00Z')).designs[0]).toMatchObject({ design, updatedAt: '2026-10-28T00:00:00.000Z' })
    expect(deleteDesign(one, 'a1').designs).toEqual([])
    expect(deleteDesign(one, 'nope')).toEqual(one)
  })

  it('names are trimmed, never empty and at most 60 characters', () => {
    expect(createDesign(emptySandbox(), { id: 'a', name: '   ', provider: 'gcp', now }).designs[0].name).toBe('Untitled design')
    expect(createDesign(emptySandbox(), { id: 'a', name: 'x'.repeat(100), provider: 'gcp', now }).designs[0].name).toHaveLength(60)
  })

  it('newId is URL-safe and differs between calls', () => {
    const a = newId()
    expect(a).toMatch(/^[a-z0-9]+$/)
    expect(newId()).not.toBe(a)
  })
})

describe('loadSandbox and saveSandbox', () => {
  it('starts empty and round-trips', () => {
    expect(loadSandbox(fake())).toEqual(emptySandbox())
    const s = fake()
    const data = createDesign(emptySandbox(), { id: 'a1', name: 'One', provider: 'azure', now })
    expect(saveSandbox(data, s)).toBe(true)
    expect(loadSandbox(s)).toEqual(data)
  })

  it.each([
    ['not json', 'not json'],
    ['wrong version', JSON.stringify({ version: 2, designs: [] })],
    ['designs not an array', JSON.stringify({ version: 1, designs: {} })],
    ['unknown provider', JSON.stringify({ version: 1, designs: [{ id: 'a', name: 'n', provider: 'ibm', design, updatedAt: 'x' }] })],
    ['a node missing its lane', JSON.stringify({ version: 1, designs: [{ id: 'a', name: 'n', provider: 'aws', design: { nodes: [{ id: 'a', type: 'alb' }], edges: [] }, updatedAt: 'x' }] })],
    ['an unknown link kind', JSON.stringify({ version: 1, designs: [{ id: 'a', name: 'n', provider: 'aws', design: { nodes: [], edges: [{ from: 'a', to: 'b', kind: 'magic' }] }, updatedAt: 'x' }] })],
    ['null', 'null'],
  ])('%s: backed up, then starts empty', (_name, raw) => {
    const s = fake(raw)
    expect(loadSandbox(s)).toEqual(emptySandbox())
    const backups = [...s.data.entries()].filter(([k]) => k.startsWith(`${KEY}:backup-`))
    expect(backups).toHaveLength(1)
    expect(backups[0][1]).toBe(raw)
  })

  it('works when storage throws on read, and reports a failed write', () => {
    const boom = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') } }
    expect(loadSandbox(boom)).toEqual(emptySandbox())
    expect(saveSandbox(emptySandbox(), boom)).toBe(false)
  })
})

describe('export and import', () => {
  const saved = createDesign(emptySandbox(), { id: 'a1', name: 'Shop', provider: 'aws', now }).designs[0]

  it('exports one design as a versioned file and reads it back', () => {
    const text = exportDesign({ ...saved, design })
    expect(JSON.parse(text)).toEqual({ version: 1, name: 'Shop', provider: 'aws', design })
    expect(readExport(text)).toEqual({ name: 'Shop', provider: 'aws', design })
  })

  it.each([
    ['not json', 'nope', /JSON/],
    ['an array', '[]', /design file/],
    ['wrong version', JSON.stringify({ version: 9, name: 'x', provider: 'aws', design }), /version/],
    ['an unknown cloud', JSON.stringify({ version: 1, name: 'x', provider: 'ibm', design }), /cloud/],
    ['no name', JSON.stringify({ version: 1, provider: 'aws', design }), /name/],
    ['a bad design', JSON.stringify({ version: 1, name: 'x', provider: 'aws', design: { nodes: 'no', edges: [] } }), /design/],
  ])('rejects %s with a plain message', (_name, text, message) => {
    const r = readExport(text)
    expect('error' in r && r.error).toMatch(message)
  })

  it('a __proto__ key in the file does not pollute anything and the result carries no extra keys', () => {
    const text = '{"version":1,"name":"x","provider":"aws","__proto__":{"polluted":true},"design":{"nodes":[],"edges":[],"__proto__":{"polluted":true}}}'
    const r = readExport(text)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect('error' in r).toBe(false)
    expect(Object.keys(r)).toEqual(['name', 'provider', 'design'])
    expect(Object.keys((r as { design: Design }).design)).toEqual(['nodes', 'edges'])
  })

  it('rebuilds nodes and edges field by field, dropping unknown fields', () => {
    const text = JSON.stringify({ version: 1, name: 'x', provider: 'aws', design: { nodes: [{ id: 'a', type: 'alb', lane: 'use1', extra: 1 }], edges: [{ from: 'users', to: 'a', kind: 'traffic', extra: 1 }] } })
    const r = readExport(text) as { design: Design }
    expect(r.design.nodes[0]).toEqual({ id: 'a', type: 'alb', lane: 'use1' })
    expect(r.design.edges[0]).toEqual({ from: 'users', to: 'a', kind: 'traffic' })
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/sandbox-store.test.ts`
Expected: FAIL, cannot resolve `../src/game/sandboxStore.ts`.

- [ ] **Step 3: Implement `src/game/sandboxStore.ts`**

```ts
// Saved design-sandbox designs. Kept apart from the progress save so a bad value
// here can never touch progress. Saved data and imported files are untrusted: a
// player can edit them, and an old app version may have written a different
// shape. Anything that fails validation is backed up, not silently thrown away.
// Hand-written rather than Zod so no Zod code is in the startup bundle.
// `localStorage` is looked up inside the try because merely touching it can
// throw when storage is blocked.

import { PROVIDERS, type Provider } from '../schema/constants.ts'
import type { Design } from '../schema/canvas.ts'

export const KEY = 'incident-quest:sandbox'
export type Store = Pick<Storage, 'getItem' | 'setItem'>

export type SavedDesign = { id: string; name: string; provider: Provider; design: Design; updatedAt: string }
export type SandboxData = { version: 1; designs: SavedDesign[] }

export const emptySandbox = (): SandboxData => ({ version: 1, designs: [] })

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const isStr = (x: unknown): x is string => typeof x === 'string'
const isProvider = (x: unknown): x is Provider => PROVIDERS.includes(x as Provider)
const KINDS = ['traffic', 'sync', 'async']

// Rebuilds a design field by field, so unknown keys (including __proto__) never travel.
function readDesign(x: unknown): Design | undefined {
  if (!isObj(x) || !Array.isArray(x.nodes) || !Array.isArray(x.edges)) return undefined
  const nodes: Design['nodes'] = []
  for (const n of x.nodes) {
    if (!isObj(n) || !isStr(n.id) || !isStr(n.type) || !isStr(n.lane)) return undefined
    nodes.push({ id: n.id, type: n.type, lane: n.lane })
  }
  const edges: Design['edges'] = []
  for (const e of x.edges) {
    if (!isObj(e) || !isStr(e.from) || !isStr(e.to) || !KINDS.includes(e.kind as string)) return undefined
    edges.push({ from: e.from, to: e.to, kind: e.kind as Design['edges'][number]['kind'] })
  }
  return { nodes, edges }
}

function readData(x: unknown): SandboxData | undefined {
  if (!isObj(x) || x.version !== 1 || !Array.isArray(x.designs)) return undefined
  const designs: SavedDesign[] = []
  for (const d of x.designs) {
    if (!isObj(d) || !isStr(d.id) || !d.id || !isStr(d.name) || !isProvider(d.provider) || !isStr(d.updatedAt)) return undefined
    const design = readDesign(d.design)
    if (!design) return undefined
    designs.push({ id: d.id, name: d.name, provider: d.provider, design, updatedAt: d.updatedAt })
  }
  return { version: 1, designs }
}

export function loadSandbox(storage?: Store): SandboxData {
  try {
    const store = storage ?? localStorage
    const raw = store.getItem(KEY)
    if (raw === null) return emptySandbox()
    try {
      const data = readData(JSON.parse(raw))
      if (data) return data
    } catch {
      // not JSON: fall through to the backup
    }
    store.setItem(`${KEY}:backup-${Date.now()}`, raw)
  } catch {
    // storage blocked: fall through to an empty store
  }
  return emptySandbox()
}

// false when the write failed (blocked or full): the designs last for this visit only.
export function saveSandbox(data: SandboxData, storage?: Store): boolean {
  try {
    const store = storage ?? localStorage
    store.setItem(KEY, JSON.stringify(data))
    return true
  } catch {
    return false
  }
}

const cleanName = (s: string) => s.trim().slice(0, 60) || 'Untitled design'
export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const createDesign = (data: SandboxData, a: { id: string; name: string; provider: Provider; now?: Date }): SandboxData => ({
  ...data,
  designs: [...data.designs, { id: a.id, name: cleanName(a.name), provider: a.provider, design: { nodes: [], edges: [] }, updatedAt: (a.now ?? new Date()).toISOString() }],
})
export const renameDesign = (data: SandboxData, id: string, name: string): SandboxData => ({
  ...data,
  designs: data.designs.map((d) => (d.id === id ? { ...d, name: cleanName(name) } : d)),
})
export const updateDesign = (data: SandboxData, id: string, design: Design, now = new Date()): SandboxData => ({
  ...data,
  designs: data.designs.map((d) => (d.id === id ? { ...d, design, updatedAt: now.toISOString() } : d)),
})
export const deleteDesign = (data: SandboxData, id: string): SandboxData => ({ ...data, designs: data.designs.filter((d) => d.id !== id) })

export const exportDesign = (d: SavedDesign): string => JSON.stringify({ version: 1, name: d.name, provider: d.provider, design: d.design }, null, 2)

// Shape only. The caller then runs validateDesign against that cloud's sandbox.
export function readExport(text: string): { name: string; provider: Provider; design: Design } | { error: string } {
  let x: unknown
  try {
    x = JSON.parse(text)
  } catch {
    return { error: "That file isn't valid JSON." }
  }
  if (!isObj(x)) return { error: "That isn't a design file." }
  if (x.version !== 1) return { error: `Unsupported design file version (${String(x.version)}).` }
  if (!isProvider(x.provider)) return { error: 'The design file names a cloud this game does not have.' }
  if (!isStr(x.name)) return { error: 'The design file has no name.' }
  const design = readDesign(x.design)
  if (!design) return { error: 'The design in the file is malformed.' }
  return { name: cleanName(x.name), provider: x.provider, design }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/sandbox-store.test.ts && npx tsc -b && npx oxlint`
Expected: PASS. If the `__proto__` test fails because `JSON.parse` created an own `__proto__` property that `isObj` accepted, that is fine: `readDesign` and the final object only copy named fields; fix the implementation, not the test.

- [ ] **Step 5: Checkpoint**

Run `npm test`. Show `git diff` / new files. Do not commit unless told.

---

### Task 8: Screens, hook and routing

**Files:**
- Create: `src/components/useSandbox.ts`
- Create: `src/screens/SandboxListScreen.tsx`
- Create: `src/screens/SandboxScreen.tsx`
- Modify: `src/App.tsx`
- Create: `tests/sandbox-ui.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 3-7 (`CanvasEditor`, `loadSandbox` from `virtual:content`, `sandboxChecks`/`runCheck`/`validateDesign`, the store functions).
- Produces:
  - `useSandbox(): { data: SandboxData; update: (f: (d: SandboxData) => SandboxData) => void; saved: boolean }`.
  - `SandboxListScreen({ onOpen }: { onOpen: (id: string) => void })`.
  - `SandboxScreen({ id, onBack }: { id: string; onBack: () => void })`.
  - Routes `#/sandbox`, `#/sandbox/<id>`.

- [ ] **Step 1: Write the failing UI test**

Create `tests/sandbox-ui.test.tsx`:

```tsx
// @vitest-environment jsdom
// The design sandbox through the real UI: create a design, build it without
// dragging, run a check, reload and find it again, import and export.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import App from '../src/App.tsx'
import { KEY } from '../src/game/sandboxStore.ts'

globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
File.prototype.text ??= function (this: Blob) {
  return new Promise<string>((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.readAsText(this)
  })
}

beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', location.pathname)
  localStorage.setItem(
    'incident-quest:v1',
    JSON.stringify({ version: 1, xp: 0, completed: {}, streak: { current: 0, best: 0 }, settings: { theme: 'dark', motion: 'reduce' } }),
  )
})
afterEach(cleanup)

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Design sandbox' }))
const palette = () => screen.getByRole('region', { name: 'Palette' })
const add = (label: string, lane: string) => {
  const button = within(palette()).getByRole('button', { name: `Add ${label}` })
  fireEvent.change(within(button.parentElement!).getByRole('combobox'), { target: { value: lane } })
  fireEvent.click(button)
}
const inspector = () => screen.getByRole('region', { name: /^Inspector: / })
const selectNode = (id: string) => fireEvent.click(screen.getAllByRole('button', { name: new RegExp(`^${id}(,|$)`) })[0])
const link = (from: string, to: string) => {
  selectNode(from)
  fireEvent.change(within(inspector()).getByLabelText('Send traffic to'), { target: { value: to } })
  fireEvent.click(within(inspector()).getAllByRole('button', { name: 'Link' })[0])
}
const create = async (name: string, cloud: string) => {
  fireEvent.change(screen.getByLabelText('Design name'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Cloud'), { target: { value: cloud } })
  fireEvent.click(screen.getByRole('button', { name: 'Create design' }))
  await screen.findByRole('region', { name: 'Palette' })
}

it('create, build, run a check, and find the design again after a reload', async () => {
  render(<App />)
  open()
  expect(await screen.findByRole('heading', { name: 'Design sandbox' })).toBeTruthy()
  await create('My shop', 'aws')

  add('Application Load Balancer', 'use1')
  add('EC2 web server', 'use1-az1')
  add('RDS for PostgreSQL DB instance', 'use1-az1')
  link('users', 'alb-1')
  link('alb-1', 'web-1')
  link('web-1', 'rds-1')

  // Pick the zone check and run it: everything is in one zone, so it fails.
  fireEvent.change(screen.getByLabelText('Check'), { target: { value: 'zone-use1-az1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Run check' }))
  const result = screen.getByRole('region', { name: 'Check result' })
  expect(result.textContent).toMatch(/Failed: Lose us-east-1a/)
  expect(screen.getByRole('button', { name: /^web-1, .*down in this check/ })).toBeTruthy()
  expect(result.textContent).not.toMatch(/Budget|XP/)

  // Edits were saved without pressing anything.
  const saved = JSON.parse(localStorage.getItem(KEY)!)
  expect(saved.designs[0].design.nodes).toHaveLength(3)

  // A fresh page load lists it and reopens it with the components in place.
  cleanup()
  render(<App />)
  open()
  fireEvent.click(await screen.findByRole('button', { name: /My shop/ }))
  await screen.findByRole('region', { name: 'Palette' })
  expect(screen.getAllByRole('button', { name: /^web-1(,|$)/ }).length).toBeGreaterThan(0)
})

it('offers no checks until the design has something to judge, and says neutral parts are not judged', async () => {
  render(<App />)
  open()
  await screen.findByRole('heading', { name: 'Design sandbox' })
  await create('Empty', 'aws')
  expect((screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/Add a web server or a database to run checks/)).toBeTruthy()
  add('Amazon SQS queue', 'use1')
  expect((screen.getByRole('button', { name: 'Run check' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/aren't judged by these checks/)).toBeTruthy()
})

it('an unknown design id falls back to the list', async () => {
  history.replaceState(null, '', `${location.pathname}#/sandbox/nope`)
  render(<App />)
  expect(await screen.findByRole('heading', { name: 'Design sandbox' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Create design' })).toBeTruthy()
})

it('a saved design that uses a part no longer in the palette explains itself instead of crashing', async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({ version: 1, designs: [{ id: 'old1', name: 'Old', provider: 'aws', updatedAt: 'x', design: { nodes: [{ id: 'x-1', type: 'mainframe', lane: 'use1' }], edges: [] } }] }),
  )
  history.replaceState(null, '', `${location.pathname}#/sandbox/old1`)
  render(<App />)
  expect(await screen.findByText(/isn't in this cloud's palette/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy()
})

it('imports a design file, and rejects a bad one with a message', async () => {
  render(<App />)
  open()
  await screen.findByRole('heading', { name: 'Design sandbox' })
  const input = screen.getByLabelText('Import a design') as HTMLInputElement
  const good = { version: 1, name: 'Imported', provider: 'aws', design: { nodes: [{ id: 'alb-1', type: 'alb', lane: 'use1' }], edges: [] } }
  fireEvent.change(input, { target: { files: [new File([JSON.stringify(good)], 'd.json', { type: 'application/json' })] } })
  await screen.findByRole('button', { name: /Imported/ })

  const bad = { ...good, name: 'Bad', design: { nodes: [{ id: 'web-1', type: 'ec2-web', lane: 'use1' }], edges: [] } }
  fireEvent.change(input, { target: { files: [new File([JSON.stringify(bad)], 'b.json', { type: 'application/json' })] } })
  expect((await screen.findByRole('alert')).textContent).toMatch(/can't go in/)
  expect(screen.queryByRole('button', { name: /Bad/ })).toBeNull()
})

it('rename and delete (with a confirmation) from the list', async () => {
  localStorage.setItem(KEY, JSON.stringify({ version: 1, designs: [{ id: 'a1', name: 'First', provider: 'gcp', updatedAt: '2026-10-27T00:00:00.000Z', design: { nodes: [], edges: [] } }] }))
  render(<App />)
  open()
  await screen.findByRole('button', { name: /First/ })
  fireEvent.click(screen.getByRole('button', { name: 'Rename First' }))
  fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Second' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
  await screen.findByRole('button', { name: /Second/ })
  fireEvent.click(screen.getByRole('button', { name: 'Delete Second' }))
  fireEvent.click(screen.getByRole('button', { name: 'Yes, delete Second' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: /Second/ })).toBeNull())
  expect(JSON.parse(localStorage.getItem(KEY)!).designs).toEqual([])
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/sandbox-ui.test.tsx`
Expected: FAIL (no "Design sandbox" nav button).

- [ ] **Step 3: `src/components/useSandbox.ts`**

```ts
import { useRef, useState } from 'react'
import { loadSandbox, saveSandbox, type SandboxData } from '../game/sandboxStore.ts'

// The sandbox store in React state. Every change is saved at once; `saved` is
// false when storage refused the write (the designs then last for this visit only).
export function useSandbox() {
  const [data, setData] = useState(loadSandbox)
  const [saved, setSaved] = useState(true)
  const latest = useRef(data)
  const update = (f: (d: SandboxData) => SandboxData) => {
    const next = f(latest.current)
    latest.current = next
    setData(next)
    setSaved(saveSandbox(next))
  }
  return { data, update, saved }
}
```

- [ ] **Step 4: `src/screens/SandboxListScreen.tsx`**

```tsx
import { useState } from 'react'
import { loadSandbox as loadCloud } from 'virtual:content'
import { PROVIDERS, PROVIDER_NAMES, type Provider } from '../schema/constants.ts'
import { validateDesign } from '../game/sandbox.ts'
import { createDesign, deleteDesign, exportDesign, newId, readExport, renameDesign, type SavedDesign } from '../game/sandboxStore.ts'
import { useSandbox } from '../components/useSandbox.ts'

const button =
  'rounded-md border border-line px-2.5 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-accent'

// Saves a design as a JSON file in the browser (no server involved).
export function download(d: SavedDesign) {
  const url = URL.createObjectURL(new Blob([exportDesign(d)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${d.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'design'}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export default function SandboxListScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, update, saved } = useSandbox()
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<Provider>('aws')
  const [renaming, setRenaming] = useState<{ id: string; name: string }>()
  const [deleting, setDeleting] = useState<string>()
  const [problem, setProblem] = useState('')

  async function importFile(file: File) {
    setProblem('')
    const r = readExport(await file.text())
    if ('error' in r) return setProblem(r.error)
    const cloud = await loadCloud(r.provider)
    if (!cloud) return setProblem(`There is no ${PROVIDER_NAMES[r.provider]} sandbox in this version.`)
    const bad = validateDesign(cloud, r.design)
    if (bad) return setProblem(bad)
    const id = newId()
    update((d) => {
      const next = createDesign(d, { id, name: r.name, provider: r.provider })
      return { ...next, designs: next.designs.map((x) => (x.id === id ? { ...x, design: r.design } : x)) }
    })
  }

  return (
    <div className="space-y-6">
      <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
        Design sandbox
      </h1>
      <p className="max-w-prose text-muted">
        Build an architecture from one cloud's real services with no brief and no score, then run failure checks to see what survives. Designs are
        saved in this browser.
      </p>
      {!saved && (
        <p role="status" className="rounded-md border border-warn px-3 py-2 text-sm">
          This browser is blocking storage, so designs last only until you close this tab. Export a design to keep it.
        </p>
      )}

      <form
        className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-panel p-4"
        onSubmit={(e) => {
          e.preventDefault()
          const id = newId()
          update((d) => createDesign(d, { id, name, provider }))
          onOpen(id)
        }}
      >
        <label className="text-sm">
          <span className="block text-muted">Design name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="rounded-md border border-line bg-bg px-2 py-1" />
        </label>
        <label className="text-sm">
          <span className="block text-muted">Cloud</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)} className="rounded-md border border-line bg-bg px-2 py-1">
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_NAMES[p]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-md bg-accent px-4 py-1.5 font-medium text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          Create design
        </button>
      </form>

      <section aria-labelledby="designs-h" className="space-y-3">
        <h2 id="designs-h" className="font-semibold">
          Your designs
        </h2>
        {data.designs.length === 0 && <p className="text-sm text-muted">No designs yet. Create one above, or import a file.</p>}
        <ul className="space-y-2">
          {data.designs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel p-3">
              {renaming?.id === d.id ? (
                <>
                  <label className="text-sm">
                    <span className="sr-only">New name</span>
                    <input
                      aria-label="New name"
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: d.id, name: e.target.value })}
                      maxLength={60}
                      className="rounded-md border border-line bg-bg px-2 py-1"
                    />
                  </label>
                  <button
                    className={button}
                    onClick={() => {
                      update((s) => renameDesign(s, d.id, renaming.name))
                      setRenaming(undefined)
                    }}
                  >
                    Save name
                  </button>
                  <button className={button} onClick={() => setRenaming(undefined)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="text-left font-medium underline-offset-2 hover:underline" onClick={() => onOpen(d.id)}>
                    {d.name}
                    <span className="ml-2 font-mono text-xs font-normal text-muted uppercase">{PROVIDER_NAMES[d.provider]}</span>
                    <span className="ml-2 text-xs font-normal text-muted">
                      {d.design.nodes.length} components
                    </span>
                  </button>
                  <span className="flex-1" />
                  <button className={button} aria-label={`Rename ${d.name}`} onClick={() => setRenaming({ id: d.id, name: d.name })}>
                    Rename
                  </button>
                  <button className={button} aria-label={`Export ${d.name}`} onClick={() => download(d)}>
                    Export
                  </button>
                  {deleting === d.id ? (
                    <>
                      <button
                        className={`${button} border-crit text-crit`}
                        aria-label={`Yes, delete ${d.name}`}
                        onClick={() => {
                          update((s) => deleteDesign(s, d.id))
                          setDeleting(undefined)
                        }}
                      >
                        Yes, delete
                      </button>
                      <button className={button} onClick={() => setDeleting(undefined)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button className={button} aria-label={`Delete ${d.name}`} onClick={() => setDeleting(d.id)}>
                      Delete
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="import-h" className="space-y-2">
        <h2 id="import-h" className="font-semibold">
          Import
        </h2>
        <label className="block text-sm">
          <span className="block text-muted">Import a design</span>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importFile(f)
              e.target.value = ''
            }}
          />
        </label>
        {problem && (
          <p role="alert" className="text-sm text-crit">
            {problem}
          </p>
        )}
      </section>
    </div>
  )
}
```

(Note: the Export and Delete buttons' accessible names come from `aria-label`; the export test in Step 1 uses the name `Export` on the editor screen, which has its own button. In the list the names are `Export <name>`.)

- [ ] **Step 5: `src/screens/SandboxScreen.tsx`**

```tsx
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
import { useSandbox } from '../components/useSandbox.ts'
import { download } from './SandboxListScreen.tsx'

const button =
  'rounded-md border border-line px-2.5 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50'

export default function SandboxScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, update, saved } = useSandbox()
  const entry = data.designs.find((d) => d.id === id)
  const [c, setC] = useState<SandboxChallenge>()
  const [checkId, setCheckId] = useState('')
  const [ran, setRan] = useState<{ design: Design; result: CanvasTestResult }>()

  // An id with no saved design (a stale link) goes back to the list.
  useEffect(() => {
    if (!entry) onBack()
  }, [entry, onBack])
  useEffect(() => {
    if (entry) void loadCloud(entry.provider).then(setC)
  }, [entry?.provider]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!entry) return null
  const back = (
    <button className="text-sm text-accent underline" onClick={onBack}>
      ← All designs
    </button>
  )
  if (!c) return <p className="text-muted">Loading…</p>

  // A saved design may predate a change to the palette: say so instead of crashing the editor.
  const problem = validateDesign(c, entry.design)
  if (problem)
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
  const cost = design.nodes.reduce((sum, n) => sum + (c.palette.find((p) => p.id === n.type)?.cost ?? 0), 0)
  const hasNeutral = design.nodes.some((n) => c.palette.find((p) => p.id === n.type)?.roles.includes('neutral'))

  return (
    <div className="space-y-4">
      {back}
      <header className="flex flex-wrap items-center gap-3">
        <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
          {entry.name}
        </h1>
        <span className="rounded border border-accent px-2 py-0.5 text-sm text-accent">Design sandbox</span>
        <span className="rounded border border-line px-2 py-0.5 font-mono text-sm text-muted uppercase">{PROVIDER_NAMES[entry.provider]}</span>
        <span className="ml-auto text-sm text-muted">{saved ? 'Saved in this browser' : 'Storage is blocked: export to keep this design'}</span>
      </header>

      <CanvasEditor
        c={c}
        design={design}
        onChange={(d) => update((s) => updateDesign(s, id, d))}
        down={down}
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
              {!ran ? (
                <p className="mt-2 text-sm text-muted">Pick a check and run it to see what survives.</p>
              ) : (
                <div className="mt-2 text-sm">
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
                </div>
              )}
              {hasNeutral && (
                <p className="mt-3 text-xs text-muted">
                  Queues, caches, CDNs and object storage aren't judged by these checks yet; they can be placed and linked, and the checks ignore them.
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
```

Requirements this must satisfy from the Step 1 test: the region has the accessible name "Check result" (it does via `aria-labelledby`); the board's "down" chip label must read "down in this check" for sandbox boards — see Step 6.

- [ ] **Step 6: Make the "down" label neutral**

`Board.tsx` labels a lost chip with "down in this test". Read how it builds that label (`grep -n "down in this" src/components/canvas/Board.tsx`). Change the label to take its noun from an optional `Board` prop `downNoun` defaulting to `'test'`, thread an optional `downNoun?: 'test' | 'check'` through `CanvasEditor` (prop, default `'test'`) to `Board`, and pass `downNoun="check"` from `SandboxScreen`. The scored screen is unchanged because the default stays `'test'`. Run `npx vitest run tests/canvas-ui.test.tsx` to confirm the existing label still matches.

- [ ] **Step 7: `src/App.tsx`**

1. Add lazy imports next to the others:

```tsx
const SandboxListScreen = lazy(() => import('./screens/SandboxListScreen.tsx'))
const SandboxScreen = lazy(() => import('./screens/SandboxScreen.tsx'))
```

2. In the `Screen` union add `| { name: 'sandbox'; id?: string }`.
3. In the routes comment add `#/sandbox  #/sandbox/<id>`.
4. In `navigate`, after the `tree` route line add:

```tsx
    if (route === 'sandbox') return setScreen({ name: 'sandbox', id })
```

5. In the nav: `{navButton('Design sandbox', '#/sandbox', screen.name === 'sandbox')}` after the Clearance map button.
6. In the render block, after the `tree` screen:

```tsx
          {screen.name === 'sandbox' &&
            (screen.id ? (
              <SandboxScreen key={screen.id} id={screen.id} onBack={() => go('#/sandbox')} />
            ) : (
              <SandboxListScreen onOpen={(id) => go(`#/sandbox/${id}`)} />
            ))}
```

`onBack` is a new function each render; `SandboxScreen`'s effect depends on it, which re-runs only while `entry` is missing and calls `go` (idempotent). If a render loop appears, wrap `onBack` with `useCallback` in `App`.

- [ ] **Step 8: Run tests**

Run: `npx vitest run tests/sandbox-ui.test.tsx tests/canvas-ui.test.tsx && npx tsc -b && npx oxlint`
Expected: PASS. If `react-hooks/exhaustive-deps` is not a rule in this repo's `oxlint` config, delete the `eslint-disable-line` comment in `SandboxScreen`; do not leave a disable comment for a rule the linter doesn't know.

- [ ] **Step 9: Full verification**

Run: `npx tsc -b && npx oxlint && npm test && npm run check-links`
Expected: all PASS (known pre-existing external link 403s aside). Run `node -e "import('./vite-plugin-content.ts').then(m=>{try{m.loadContent('content');console.log('OK')}catch(e){console.log(e.message)}})"`; expected `OK`.

- [ ] **Step 10: Checkpoint**

Show `git diff --stat`. Do not commit unless told.

---

### Task 9: Docs and the browser check

**Files:**
- Modify: `README.md` (the design-challenges paragraph near line 22-30)
- Modify: `AUTHORING.md` (a short "Sandbox files" section)

**Interfaces:**
- Consumes: the finished feature.
- Produces: documentation only.

- [ ] **Step 1: README**

After the "Design challenges" paragraph add:

```markdown
**Design sandbox** is the free-form version: pick a cloud, build an architecture
from its real services (load balancers, web servers, databases, plus queues, caches,
object storage and CDNs), save several designs in your browser, and run checks like
"lose a zone", "lose a region" or a traffic spike to see what survives and why.
There is no score. Queues, caches, object storage and CDNs can be placed and linked,
but the checks don't judge them yet.
```

- [ ] **Step 2: AUTHORING.md**

Read the file's structure first (`grep -n '^#' AUTHORING.md`) and add a "Sandbox files" section in the same voice, covering: the file lives in `content/sandbox/<provider>-sandbox.yaml` with `id` matching the filename; it `extends` that cloud's single-provider canvas challenge and may add only `roles: [neutral]` parts; the layout is two regions with two zones each plus `global: true`; facts and sources come from vendor docs in your own words; `npm run schemas` after any schema change; `npm test` validates it (the preview page cannot play sandbox files).

- [ ] **Step 3: Verify the docs build**

Run: `npm test && npm run check-links`
Expected: PASS (README/AUTHORING links resolve).

- [ ] **Step 4: Check it in the browser**

Run `npm run dev` and, with Claude in Chrome connected (if the extension is not connected, stop and tell the user instead of retrying), open `http://localhost:5173/#/sandbox` and confirm:

- the nav shows "Design sandbox" and the list screen explains the feature;
- create an AWS design, add a load balancer, two web servers and a database across two zones, link them, run "Lose us-east-1a", and the failed components highlight;
- add an SQS queue: the "aren't judged" note appears and the check results do not change;
- reload: the design is still listed and reopens intact;
- Export downloads a JSON file, and importing it creates a second design;
- an Azure and a Google Cloud design each show their own parts and lanes;
- `#/sandbox/nope` lands on the list;
- the Clearance map, Ops board and a scored canvas challenge still behave as before.

Report anything that does not match. Stop the dev server when done.

- [ ] **Step 5: Checkpoint**

Show the final `git status` and `git diff --stat`. Do not commit unless told.

---

## Self-Review

**Spec coverage:** content kind, `extends`, fixed layout, four extras per cloud (three on Azure, see below), `neutral` role (Tasks 1, 5, 6); adapter and node cap (Tasks 2, 4); generated checks and `runCheck` (Task 4); storage, backup, export and import validation (Task 7); `CanvasEditor` extraction first (Task 3); list and editor screens, routing, nav, unknown-id fallback, blocked-storage note, stale-design handling (Task 8); testing list (every named test file exists); out-of-scope items are not built.

**Deliberate differences from the spec** (to be written into the spec before execution starts):
1. Azure gets three extras, not four: its base palette already includes Azure Front Door as the global CDN-role part, and a second one would duplicate it.
2. A palette type with only neutral roles gets no "lose any one" check (it would always "survive", implying the part was judged); a design with no web server and no database gets no checks at all; the traffic spike is offered only with a web server.
3. The spec's "known-good three-tier design passes every generated check" becomes an exact pass/fail map (zone checks pass; region and sole-load-balancer checks fail by design in a single-region design).
4. The sandbox layout adds the global lane for all three clouds because CloudFront and Cloud CDN are global-scope parts.
5. `retrieved` dates and each part's `scope` are set from the docs when authoring.

**Placeholders:** none in code steps. Content steps (5, 6) specify exact pages to read and the exact file shape; the facts themselves must be authored from those pages by design (user rule: facts from docs, never copied).

**Type consistency:** `Capped` (Task 2) is consumed by `CanvasEditor` (Task 3); `SandboxChallenge`, `SandboxFile`, `resolveSandbox`, `sandboxChecks`, `runCheck`, `validateDesign`, `SANDBOX_MAX_NODES` (Task 4) are used with the same names in Tasks 5, 7 and 8; `loadSandbox` is the *virtual-module* loader (cloud challenge) in Tasks 5 and 8 and the *store* loader in Task 7 and the hook: the screens import the virtual one as `loadCloud` to keep them apart. `SavedDesign`, `SandboxData` and the store functions match between Tasks 7 and 8.

**Known risk:** Task 3 moves about 300 lines of a shipped screen; its gate is the unchanged `canvas-ui` and `canvas-edit` tests plus the identical counts recorded in Step 1.
