import { useEffect, useRef, useState } from 'react'
import content from 'virtual:content'
import type { GameEvent } from './game/engine.ts'
import { score, type Score } from './game/scoring.ts'
import { loadProgress, rankFor, recordResult, saveProgress, unlockedTracks, type Progress } from './game/progress.ts'
import HomeScreen from './screens/HomeScreen.tsx'
import IncidentScreen from './screens/IncidentScreen.tsx'
import DebriefScreen from './screens/DebriefScreen.tsx'
import SkillTreeScreen from './screens/SkillTreeScreen.tsx'
import Icon from './components/Icon.tsx'

// A handful of screens don't need a router (see PARKING_LOT.md). `run`
// remounts the incident screen on replay so it starts from a clean session.
type Screen =
  | { name: 'home'; track?: string }
  | { name: 'tree' }
  | { name: 'incident'; id: string; run: number }
  | { name: 'debrief'; id: string; log: GameEvent[]; score: Score; gained: number; rankUp?: string; unlocked: string[] }

const unlocks = (p: Progress) => unlockedTracks(content.tracks, content.scenarios, p.completed)

export default function App() {
  const [progress, setProgress] = useState(loadProgress)
  const [screen, setScreen] = useState<Screen>({ name: 'home' })
  const scenario = 'id' in screen ? content.scenarios.find((s) => s.id === screen.id) : undefined
  const { rank, next } = rankFor(progress.xp)
  const { theme, motion = 'system' } = progress.settings

  useEffect(() => saveProgress(progress), [progress])
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.classList.toggle('reduce-motion', motion === 'reduce')
  }, [theme, motion])

  // Keyboard and screen-reader users land on the new screen's heading, not
  // wherever focus happened to be on the old one.
  // (Opening a specific track is the exception: HomeScreen focuses that track.)
  // Skipped on first load so the first Tab still reaches the skip link.
  const shown = useRef(screen)
  useEffect(() => {
    if (shown.current === screen) return
    shown.current = screen
    if (screen.name === 'home' && screen.track) return
    document.getElementById('screen-title')?.focus()
  }, [screen])

  const play = (id: string) => setScreen({ name: 'incident', id, run: Date.now() })

  function resolved(id: string, log: GameEvent[]) {
    const s = score(scenario!, log)
    const result = recordResult(progress, id, s, new Date())
    const newRank = rankFor(result.progress.xp).rank
    const before = unlocks(progress)
    const newlyUnlocked = content.tracks
      .filter((t) => !before.has(t.id) && unlocks(result.progress).has(t.id) && content.scenarios.some((x) => x.track === t.id))
      .map((t) => t.name)
    setProgress(result.progress)
    setScreen({
      name: 'debrief',
      id,
      log,
      score: s,
      gained: result.gained,
      rankUp: newRank !== rank ? newRank.name : undefined,
      unlocked: newlyUnlocked,
    })
  }

  const setting = (patch: Partial<Progress['settings']>) =>
    setProgress((p) => ({ ...p, settings: { ...p.settings, ...patch } }))

  const navButton = (label: string, target: Screen, current: boolean) => (
    <button
      onClick={() => setScreen(target)}
      aria-current={current ? 'page' : undefined}
      className="rounded-md px-2.5 py-1 text-sm text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent aria-[current=page]:bg-bg aria-[current=page]:text-fg"
    >
      {label}
    </button>
  )
  const toggle =
    'flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-accent'

  return (
    <>
      <a
        href="#main"
        className="sr-only z-10 rounded-md bg-accent px-3 py-2 text-bg focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to main content
      </a>
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 lg:px-6">
          <span className="font-semibold tracking-tight">
            Incident <span className="text-accent">Quest</span>
          </span>
          <nav aria-label="Main" className="flex gap-1">
            {navButton('Queue', { name: 'home' }, screen.name === 'home')}
            {navButton('Skill tree', { name: 'tree' }, screen.name === 'tree')}
          </nav>
          <dl className="flex flex-wrap gap-x-5 text-sm">
            <div className="flex gap-1.5">
              <dt className="text-muted">Rank</dt>
              <dd>{rank.name}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-muted">XP</dt>
              <dd className="font-mono tabular-nums">
                {progress.xp}
                {next && <span className="text-muted"> / {next.xp}</span>}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-muted">Clean streak</dt>
              <dd className="font-mono tabular-nums">{progress.streak.current}</dd>
            </div>
          </dl>
          <div className="ml-auto flex gap-2">
            <button className={toggle} aria-pressed={motion === 'reduce'} onClick={() => setting({ motion: motion === 'reduce' ? 'system' : 'reduce' })}>
              Reduce motion
            </button>
            <button className={toggle} onClick={() => setting({ theme: theme === 'dark' ? 'light' : 'dark' })}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-7xl p-4 lg:p-6">
        {screen.name === 'home' && (
          <HomeScreen
            tracks={content.tracks}
            scenarios={content.scenarios}
            progress={progress}
            unlocked={unlocks(progress)}
            focusTrack={screen.track}
            onPlay={play}
          />
        )}
        {screen.name === 'tree' && (
          <SkillTreeScreen
            tracks={content.tracks}
            scenarios={content.scenarios}
            progress={progress}
            unlocked={unlocks(progress)}
            onOpenTrack={(track) => setScreen({ name: 'home', track })}
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
            unlocked={screen.unlocked}
            streak={progress.streak.current}
            onHome={() => setScreen({ name: 'home' })}
            onTree={() => setScreen({ name: 'tree' })}
            onReplay={() => play(screen.id)}
          />
        )}
      </main>
    </>
  )
}
