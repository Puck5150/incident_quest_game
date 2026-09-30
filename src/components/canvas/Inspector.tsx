import { useId, useState } from 'react'
import { USERS, type CanvasChallenge, type Design } from '../../schema/canvas.ts'
import { laneLabel, lanesFor, targets } from '../../game/canvasEdit.ts'

type Kind = Design['edges'][number]['kind']

const button =
  'rounded-md border border-line px-2.5 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50'
const select = 'w-full rounded-md border border-line bg-bg px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-accent'

// Everything you can do to the selected component, without dragging
// (WCAG 2.2 SC 2.5.7): move it, link it, unlink it, remove it.
export default function Inspector({
  c,
  design,
  selected,
  onMove,
  onConnect,
  onPickTarget,
  onDisconnect,
  onRemove,
}: {
  c: CanvasChallenge
  design: Design
  selected?: string
  onMove: (id: string, lane: string) => void
  onConnect: (from: string, to: string, kind: Kind) => void
  onPickTarget: (from: string, kind: Kind) => void // enter click-to-connect mode
  onDisconnect: (edgeIndex: number) => void
  onRemove: (id: string) => void
}) {
  const uid = useId()
  const node = design.nodes.find((n) => n.id === selected)
  const item = node && c.palette.find((p) => p.id === node.type)
  const isStore = !!item?.roles.includes('write-store')
  const [trafficTo, setTrafficTo] = useState('')
  const [replTo, setReplTo] = useState('')
  const [replKind, setReplKind] = useState<'sync' | 'async'>('sync')

  if (!selected || (selected !== USERS && !node)) {
    return (
      <section aria-labelledby={`${uid}-h`} className="rounded-lg border border-line bg-panel p-4">
        <h2 id={`${uid}-h`} className="font-semibold">
          Inspector
        </h2>
        <p className="mt-2 text-sm text-muted">Select a component on the design, or add one from the palette.</p>
      </section>
    )
  }

  const trafficTargets = targets(c, design, selected, 'traffic')
  const replTargets = isStore ? targets(c, design, selected, replKind) : []
  const links = design.edges.map((e, i) => ({ ...e, i })).filter((e) => e.from === selected || e.to === selected)
  const describe = (e: (typeof links)[number]) =>
    e.kind === 'traffic'
      ? e.from === selected
        ? `sends traffic to ${e.to}`
        : `receives traffic from ${e.from}`
      : e.from === selected
        ? `replicates (${e.kind}) to ${e.to}`
        : `replica (${e.kind}) of ${e.from}`

  return (
    <section aria-label={`Inspector: ${selected}`} className="space-y-4 rounded-lg border border-line bg-panel p-4">
      <div>
        <h2 id={`${uid}-h`} tabIndex={-1} className="font-mono font-semibold focus:outline-none">
          {selected}
        </h2>
        <p className="text-sm text-muted">
          {selected === USERS ? 'Where requests come from.' : `${item!.label} · ${laneLabel(c, node!.lane)}`}
        </p>
      </div>

      {node && lanesFor(c, node.type).length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${uid}-lane`} className="text-sm text-muted">
            Move to
          </label>
          <select id={`${uid}-lane`} className={select} value={node.lane} onChange={(e) => onMove(node.id, e.target.value)}>
            {lanesFor(c, node.type).map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor={`${uid}-traffic`} className="block text-sm text-muted">
          Send traffic to
        </label>
        <div className="flex flex-wrap gap-2">
          <select id={`${uid}-traffic`} className={select} value={trafficTo} onChange={(e) => setTrafficTo(e.target.value)}>
            <option value="">Choose a component…</option>
            {trafficTargets.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            className={button}
            disabled={!trafficTo || !trafficTargets.includes(trafficTo)}
            onClick={() => {
              onConnect(selected, trafficTo, 'traffic')
              setTrafficTo('')
            }}
          >
            Link
          </button>
          <button className={button} disabled={!trafficTargets.length} onClick={() => onPickTarget(selected, 'traffic')}>
            Pick on design
          </button>
        </div>
      </div>

      {isStore && (
        <div className="space-y-2">
          <label htmlFor={`${uid}-repl`} className="block text-sm text-muted">
            Replicate to another database
          </label>
          <fieldset className="flex gap-3 text-sm">
            <legend className="sr-only">Replication type</legend>
            {(['sync', 'async'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="radio" name={`${uid}-kind`} checked={replKind === k} onChange={() => setReplKind(k)} className="accent-accent" />
                {k}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <select id={`${uid}-repl`} className={select} value={replTo} onChange={(e) => setReplTo(e.target.value)}>
              <option value="">Choose a database…</option>
              {replTargets.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              className={button}
              disabled={!replTo || !replTargets.includes(replTo)}
              onClick={() => {
                onConnect(selected, replTo, replKind)
                setReplTo('')
              }}
            >
              Link
            </button>
            <button className={button} disabled={!replTargets.length} onClick={() => onPickTarget(selected, replKind)}>
              Pick on design
            </button>
          </div>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
            {c.link_facts[replKind].map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="text-sm text-muted">Links</h3>
        {links.length ? (
          <ul className="mt-1 space-y-1 text-sm">
            {links.map((e) => (
              <li key={e.i} className="flex items-center justify-between gap-2">
                <span>{describe(e)}</span>
                <button
                  aria-label={`Unlink: ${selected} ${describe(e)}`}
                  className="text-xs text-muted underline underline-offset-2 hover:text-crit"
                  onClick={() => onDisconnect(e.i)}
                >
                  Unlink
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-muted">No links yet.</p>
        )}
      </div>

      {node && (
        <button className={`${button} text-crit`} onClick={() => onRemove(node.id)}>
          Remove {node.id}
        </button>
      )}
    </section>
  )
}
