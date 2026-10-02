import { useEffect } from 'react'
import type { Track } from '../schema/scenario.ts'
import type { Progress } from '../game/progress.ts'
import Icon from '../components/Icon.tsx'
import WorldMap from '../components/WorldMap.tsx'
import { missionId } from '../game/mission.ts'

// Incidents and design challenges share the queue.
export type QueueItem = {
  id: string
  track: string
  title: string
  difficulty: number
  kind: 'incident' | 'challenge'
  tag: string // incident priority (P1..P4) or "Design"
  providers?: string[] // "pick your cloud": the clouds it can be played on
}

const CLOUD: Record<string, string> = { aws: 'AWS', azure: 'Azure', gcp: 'GCP' }

// The incident queue: tracks that have content, in tracks.yaml order,
// incidents easiest first. Locked tracks say what unlocks them.
export default function HomeScreen({
  tracks,
  items: allItems,
  progress,
  unlocked,
  focusTrack,
  onPlay,
  shiftNeeds,
  onShift,
}: {
  tracks: Track[]
  items: QueueItem[]
  progress: Progress
  unlocked: Set<string>
  focusTrack?: string
  onPlay: (id: string) => void
  shiftNeeds: number // resolved incidents still needed before shifts open
  onShift: () => void
}) {
  const name = (id: string) => tracks.find((t) => t.id === id)?.name ?? id

  // Arriving from the skill tree: jump to (and focus) that track's section.
  useEffect(() => {
    if (!focusTrack) return
    // focus() also scrolls the heading into view (scroll-mt keeps a gap above it)
    document.getElementById(`track-${focusTrack}`)?.focus()
  }, [focusTrack])

  return (
    <div className="space-y-8">
      <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
        Ops board
      </h1>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onShift}
          disabled={shiftNeeds > 0}
          className="rounded-md border border-crit px-4 py-2 font-mono text-sm tracking-widest text-crit uppercase hover:bg-crit/10 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start on-call shift
        </button>
        {shiftNeeds > 0 && (
          <span className="text-sm text-muted">
            Opens after {shiftNeeds} more resolved {shiftNeeds === 1 ? 'incident' : 'incidents'}.
          </span>
        )}
      </div>
      <WorldMap
        sectors={tracks.flatMap((track) => {
          const mine = allItems.filter((s) => s.track === track.id)
          if (!mine.length) return []
          const open = mine.filter((s) => !progress.completed[s.id]).length
          return [{ track, open, total: mine.length, locked: !unlocked.has(track.id) }]
        })}
        onSelect={(id) => document.getElementById(`track-${id}`)?.focus()}
      />
      {tracks.map((track) => {
        const items = allItems.filter((s) => s.track === track.id).sort((a, b) => a.difficulty - b.difficulty)
        if (!items.length) return null
        const open = unlocked.has(track.id)
        return (
          <section key={track.id} aria-labelledby={`track-${track.id}`}>
            <h2
              id={`track-${track.id}`}
              tabIndex={-1}
              className="mb-3 flex scroll-mt-4 flex-wrap items-center gap-3 text-lg font-semibold focus:outline-none"
            >
              <span
                aria-hidden
                className={`h-2 w-2 rounded-full ${!open ? 'bg-line' : items.every((s) => progress.completed[s.id]) ? 'bg-ok' : 'bg-warn'}`}
              />
              <span className="font-mono tracking-widest uppercase">
                <span className="text-muted">Sector // </span>
                {track.name}
              </span>
              <span className="font-mono text-sm font-normal text-muted tabular-nums">
                {items.filter((s) => progress.completed[s.id]).length}/{items.length} clear
              </span>
              {!open && (
                <span className="flex items-center gap-1.5 text-sm font-normal text-muted">
                  <Icon name="lock" className="h-3.5 w-3.5" />
                  Locked: finish something in {track.requires.map(name).join(track.requires_any ? ' or ' : ' and ')}
                </span>
              )}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((s) => {
                const done = progress.completed[s.id]
                return (
                  <li key={s.id}>
                    <button
                      disabled={!open}
                      onClick={() => onPlay(s.id)}
                      className={`h-full w-full rounded-lg border border-l-4 border-line bg-panel p-4 text-left hover:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${done ? 'border-l-ok' : 'border-l-warn'}`}
                    >
                      <span className="flex items-center justify-between gap-2 text-xs text-muted">
                        <span className="flex gap-2 font-mono">
                          <span>{missionId(s.id, s.kind)}</span>
                          <span className={s.kind === 'challenge' ? 'text-accent' : ''}>{s.tag}</span>
                          {s.kind === 'incident' && s.difficulty === 5 && <span className="text-crit">MAJOR INCIDENT</span>}
                        </span>
                        <span className="flex gap-1" role="img" aria-label={`Difficulty ${s.difficulty} of 5`}>
                          {[1, 2, 3, 4, 5].map((n) => (
                            <span key={n} className={`h-1.5 w-3 rounded-full ${n <= s.difficulty ? 'bg-accent' : 'bg-line'}`} />
                          ))}
                        </span>
                      </span>
                      <span className="mt-2 block font-medium">{s.title}</span>
                      {s.providers && (
                        <span className="mt-2 flex flex-wrap gap-1.5" aria-label="Clouds">
                          {s.providers.map((p) => {
                            const doneOn = done?.providers?.includes(p)
                            return (
                              <span
                                key={p}
                                className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${doneOn ? 'border-ok text-ok' : 'border-line text-muted'}`}
                              >
                                {doneOn && <Icon name="check" className="h-3 w-3" />}
                                {CLOUD[p]}
                                {doneOn && <span className="sr-only">, completed</span>}
                              </span>
                            )
                          })}
                        </span>
                      )}
                      <span className="mt-2 block text-sm text-muted">
                        {done ? (
                          <>
                            <span className="inline-flex items-center gap-1 text-ok">
                              <Icon name="check" className="h-3.5 w-3.5" /> {s.kind === 'challenge' ? 'Completed' : 'Resolved'}
                            </span>{' '}
                            · best <span className="tabular-nums">{done.bestScore}</span> XP
                            {done.clean && ' · clean'}
                          </>
                        ) : (
                          <span className="font-mono tracking-wider text-warn uppercase">Open</span>
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
