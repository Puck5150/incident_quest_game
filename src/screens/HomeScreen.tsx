import type { Scenario, Track } from '../schema/scenario.ts'
import type { Progress } from '../game/progress.ts'

// The incident queue: tracks that have content, in tracks.yaml order,
// incidents easiest first. Locked tracks say what unlocks them.
export default function HomeScreen({
  tracks,
  scenarios,
  progress,
  unlocked,
  onPlay,
}: {
  tracks: Track[]
  scenarios: Scenario[]
  progress: Progress
  unlocked: Set<string>
  onPlay: (id: string) => void
}) {
  const name = (id: string) => tracks.find((t) => t.id === id)?.name ?? id

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Incident queue</h1>
      {tracks.map((track) => {
        const items = scenarios.filter((s) => s.track === track.id).sort((a, b) => a.difficulty - b.difficulty)
        if (!items.length) return null
        const open = unlocked.has(track.id)
        return (
          <section key={track.id} aria-labelledby={`track-${track.id}`}>
            <h2 id={`track-${track.id}`} className="mb-3 flex flex-wrap items-baseline gap-3 text-lg font-semibold">
              {track.name}
              {!open && (
                <span className="text-sm font-normal text-muted">
                  🔒 Locked: complete an incident in {track.requires.map(name).join(' and ')}
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
                        <span aria-label={`Difficulty ${s.difficulty} of 5`}>
                          {'●'.repeat(s.difficulty)}
                          {'○'.repeat(5 - s.difficulty)}
                        </span>
                      </span>
                      <span className="mt-2 block font-medium">{s.title}</span>
                      <span className="mt-2 block text-sm text-muted">
                        {done ? (
                          <>
                            <span className="text-ok">✓ Resolved</span> · best {done.bestScore} XP
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
