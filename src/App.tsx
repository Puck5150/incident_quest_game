import { useEffect, useState } from 'react'
import content from 'virtual:content'
import type { GameEvent } from './game/engine.ts'
import { score, type Score } from './game/scoring.ts'
import { loadProgress, rankFor, recordResult, saveProgress, unlockedTracks } from './game/progress.ts'
import HomeScreen from './screens/HomeScreen.tsx'
import IncidentScreen from './screens/IncidentScreen.tsx'
import DebriefScreen from './screens/DebriefScreen.tsx'

// Four screens don't need a router (see PARKING_LOT.md). `run` remounts the
// incident screen on replay so it starts from a clean session.
type Screen =
  | { name: 'home' }
  | { name: 'incident'; id: string; run: number }
  | { name: 'debrief'; id: string; log: GameEvent[]; score: Score; gained: number; rankUp?: string }

export default function App() {
  const [progress, setProgress] = useState(loadProgress)
  const [screen, setScreen] = useState<Screen>({ name: 'home' })
  const scenario = screen.name !== 'home' ? content.scenarios.find((s) => s.id === screen.id) : undefined
  const { rank, next } = rankFor(progress.xp)

  useEffect(() => saveProgress(progress), [progress])
  useEffect(() => {
    document.documentElement.classList.toggle('dark', progress.settings.theme === 'dark')
  }, [progress.settings.theme])

  const play = (id: string) => setScreen({ name: 'incident', id, run: Date.now() })

  function resolved(id: string, log: GameEvent[]) {
    const s = score(scenario!, log)
    const result = recordResult(progress, id, s, new Date())
    const newRank = rankFor(result.progress.xp).rank
    setProgress(result.progress)
    setScreen({ name: 'debrief', id, log, score: s, gained: result.gained, rankUp: newRank !== rank ? newRank.name : undefined })
  }

  const toggleTheme = () =>
    setProgress((p) => ({ ...p, settings: { ...p.settings, theme: p.settings.theme === 'dark' ? 'light' : 'dark' } }))

  return (
    <>
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 lg:px-6">
          <button
            onClick={() => setScreen({ name: 'home' })}
            className="font-mono font-semibold tracking-tight text-accent focus-visible:outline-2 focus-visible:outline-accent"
          >
            incident_quest
          </button>
          <dl className="flex flex-wrap gap-x-5 text-sm">
            <div className="flex gap-1.5">
              <dt className="text-muted">Rank</dt>
              <dd>{rank.name}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-muted">XP</dt>
              <dd className="font-mono">
                {progress.xp}
                {next && <span className="text-muted"> / {next.xp}</span>}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-muted">Clean streak</dt>
              <dd className="font-mono">{progress.streak.current}</dd>
            </div>
          </dl>
          <button
            onClick={toggleTheme}
            className="ml-auto rounded-md border border-line px-3 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
          >
            {progress.settings.theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-4 lg:p-6">
        {screen.name === 'home' && (
          <HomeScreen
            tracks={content.tracks}
            scenarios={content.scenarios}
            progress={progress}
            unlocked={unlockedTracks(content.tracks, content.scenarios, progress.completed)}
            onPlay={play}
          />
        )}
        {screen.name === 'incident' && (
          <IncidentScreen key={screen.run} scenario={scenario!} onResolved={(log) => resolved(screen.id, log)} />
        )}
        {screen.name === 'debrief' && (
          <DebriefScreen
            scenario={scenario!}
            log={screen.log}
            score={screen.score}
            gained={screen.gained}
            rankUp={screen.rankUp}
            streak={progress.streak.current}
            onHome={() => setScreen({ name: 'home' })}
            onReplay={() => play(screen.id)}
          />
        )}
      </main>
    </>
  )
}
