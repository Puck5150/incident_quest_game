import { useEffect } from 'react'
import type { Scenario, Track } from '../schema/scenario.ts'
import type { Progress } from '../game/progress.ts'
import Icon from '../components/Icon.tsx'

// The incident queue: tracks that have content, in tracks.yaml order,
// incidents easiest first. Locked tracks say what unlocks them.
export default function HomeScreen({
  tracks,
  scenarios,
  progress,
  unlocked,
  focusTrack,
  onPlay,
}: {
  tracks: Track[]
  scenarios: Scenario[]
  progress: Progress
  unlocked: Set<string>
  focusTrack?: string
  onPlay: (id: string) => void
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
        Incident queue
      </h1>
      {tracks.map((track) => {
        const items = scenarios.filter((s) => s.track === track.id).sort((a, b) => a.difficulty - b.difficulty)
        if (!items.length) return null
        const open = unlocked.has(track.id)
        return (
          <section key={track.id} aria-labelledby={`track-${track.id}`}>
            <h2
              id={`track-${track.id}`}
              tabIndex={-1}
              className="mb-3 flex scroll-mt-4 flex-wrap items-center gap-3 text-lg font-semibold focus:outline-none"
            >
              {track.name}
              {!open && (
                <span className="flex items-center gap-1.5 text-sm font-normal text-muted">
                  <Icon name="lock" className="h-3.5 w-3.5" />
                  Locked: resolve an incident in {track.requires.map(name).join(' and ')}
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
                      className="h-full w-full rounded-lg border border-line bg-panel p-4 text-left hover:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="flex items-center justify-between gap-2 text-xs text-muted">
                        <span className="font-mono">{s.ticket.priority}</span>
                        <span className="flex gap-1" role="img" aria-label={`Difficulty ${s.difficulty} of 5`}>
                          {[1, 2, 3, 4, 5].map((n) => (
                            <span key={n} className={`h-1.5 w-3 rounded-full ${n <= s.difficulty ? 'bg-accent' : 'bg-line'}`} />
                          ))}
                        </span>
                      </span>
                      <span className="mt-2 block font-medium">{s.title}</span>
                      <span className="mt-2 block text-sm text-muted">
                        {done ? (
                          <>
                            <span className="inline-flex items-center gap-1 text-ok">
                              <Icon name="check" className="h-3.5 w-3.5" /> Resolved
                            </span>{' '}
                            · best <span className="tabular-nums">{done.bestScore}</span> XP
                            {done.clean && ' · clean'}
                          </>
                        ) : (
                          'Open'
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
