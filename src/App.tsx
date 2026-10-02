import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import content, { loadItem, type Item, type MultiChallenge } from 'virtual:content'
import type { GameEvent } from './game/engine.ts'
import { score, type Score } from './game/scoring.ts'
import { loadProgress, rankFor, recordResult, saveProgress, unlockedTracks, type Progress } from './game/progress.ts'
import HomeScreen from './screens/HomeScreen.tsx'
import SkillTreeScreen from './screens/SkillTreeScreen.tsx'
import { scoreChallenge, scoreRuns, type ChallengeScore, type Run } from './game/challenge.ts'
import type { CanvasRun } from './screens/CanvasScreen.tsx'
import { evaluateCanvas } from './game/canvas.ts'
import type { Provider } from './schema/multi.ts'
import type { CanvasChallenge } from './schema/canvas.ts'
import type { Challenge, Picks } from './schema/challenge.ts'
import type { Design } from './schema/canvas.ts'
import type { CrossCloud } from './components/CrossCloud.tsx'
import Icon from './components/Icon.tsx'
import Callsign from './components/Callsign.tsx'
import { setSound } from './game/sound.ts'
import { SHIFT_UNLOCK, type Priority } from './game/shift.ts'

// Home and skill tree load up front; play and debrief screens load on first use.
const IncidentScreen = lazy(() => import('./screens/IncidentScreen.tsx'))
const DebriefScreen = lazy(() => import('./screens/DebriefScreen.tsx'))
const ChallengeScreen = lazy(() => import('./screens/ChallengeScreen.tsx'))
const ChallengeDebrief = lazy(() => import('./screens/ChallengeDebrief.tsx'))
const CanvasScreen = lazy(() => import('./screens/CanvasScreen.tsx'))
const CanvasDebrief = lazy(() => import('./screens/CanvasDebrief.tsx'))
const PickCloudScreen = lazy(() => import('./screens/PickCloudScreen.tsx'))
const PreviewScreen = lazy(() => import('./screens/PreviewScreen.tsx'))
const ShiftScreen = lazy(() => import('./screens/ShiftScreen.tsx'))

// Screens are plain state; the routable ones mirror the URL hash (see `go`).
// `run` remounts the incident screen on replay so it starts from a clean session.
type Screen =
  | { name: 'home'; track?: string }
  | { name: 'tree' }
  | { name: 'incident'; id: string; run: number }
  | ({ name: 'debrief'; id: string; log: GameEvent[]; score: Score } & Outcome)
  | { name: 'challenge'; id: string; run: number; provider?: Provider }
  | ({ name: 'challenge-debrief'; id: string; runs: Run[]; score: ChallengeScore; provider?: Provider } & Outcome)
  | { name: 'pick-cloud'; id: string }
  | { name: 'preview' }
  | { name: 'shift'; run: number }
  | { name: 'canvas'; id: string; run: number; provider?: Provider }
  | ({ name: 'canvas-debrief'; id: string; runs: CanvasRun[]; score: ChallengeScore; provider?: Provider } & Outcome)

// What finishing something changed, shown in the debrief header.
type Outcome = { gained: number; rankUp?: string; cleared?: string; unlocked: string[] }

// Everything playable, for the queue, the skill tree and unlocks.
const items = content.items
const unlocks = (p: Progress) => unlockedTracks(content.tracks, items, p.completed)
const resolvedIncidents = (p: Progress) => items.filter((x) => x.kind === 'incident' && p.completed[x.id]).length

export default function App() {
  const [progress, setProgress] = useState(loadProgress)
  const [screen, setScreen] = useState<Screen>({ name: 'home' })
  // The item being played, loaded on demand (each item is its own chunk).
  const [item, setItem] = useState<Item>()
  const [previewing, setPreviewing] = useState(false) // playing a file from #/preview
  const [previewText, setPreviewText] = useState('') // kept while you play it
  const scenario = item?.kind === 'incident' ? item.scenario : undefined
  const multi = item?.kind === 'multi' ? item.multi : undefined
  const provider = 'provider' in screen ? screen.provider : undefined
  // A "pick your cloud" challenge plays as the chosen provider's ordinary
  // canvas or slot challenge; everything downstream is unchanged.
  const challenge =
    multi?.kind === 'slot' && provider ? multi.variants[provider] : item?.kind === 'challenge' ? item.challenge : undefined
  const canvas =
    multi?.kind === 'canvas' && provider ? multi.variants[provider] : item?.kind === 'canvas' ? item.canvas : undefined
  const { rank, next } = rankFor(progress.xp)
  const { theme, motion = 'system', relaxed = false, callsign, sound = false } = progress.settings

  useEffect(() => saveProgress(progress), [progress])
  useEffect(() => setSound(sound), [sound])
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

  // Routes live in the URL hash, so deep links work on GitHub Pages (no server
  // rewrites) and the back button moves between screens:
  //   #/  #/tree  #/track/<id>  #/play/<id>  #/play/<id>/<provider>  #/done/<id>  #/preview  #/shift
  // Debriefs aren't routable (they show one run's results): finishing replaces
  // the play URL with #/done/<id>, which opens that track's queue on reload.
  const go = (hash: string) => (location.hash === hash ? navigate(hash) : location.assign(hash))
  const play = (id: string) => go(`#/play/${id}`)

  // Latest navigation wins if an item is still loading when another starts.
  const navSeq = useRef(0)
  async function navigate(hash: string) {
    const seq = ++navSeq.current
    setPreviewing(false)
    const [route, id, extra] = hash.replace(/^#\/?/, '').split('/')
    const meta = items.find((x) => x.id === id)
    if (route === 'tree') return setScreen({ name: 'tree' })
    if (route === 'preview') return setScreen({ name: 'preview' })
    if (route === 'shift') return setScreen(resolvedIncidents(progress) >= SHIFT_UNLOCK ? { name: 'shift', run: seq } : { name: 'home' })
    if (route === 'track' && id) return setScreen({ name: 'home', track: id })
    if (route !== 'play' || !meta) return setScreen({ name: 'home', track: meta?.track })
    if (!unlocks(progress).has(meta.track)) return setScreen({ name: 'home', track: meta.track })
    const loaded = await loadItem(meta.id)
    if (seq !== navSeq.current) return
    start(loaded, seq, extra)
  }

  // Show an item's play screen (or the cloud picker). `run` must be unique per
  // start, so a replay remounts the screen with a clean session.
  function start(loaded: Item, run: number, provider?: string) {
    setItem(loaded)
    if (loaded.kind === 'multi') {
      const { id } = loaded.multi
      const p = loaded.multi.providers.find((x) => x === provider)
      if (!p) return setScreen({ name: 'pick-cloud', id })
      return setScreen(
        loaded.multi.kind === 'canvas' ? { name: 'canvas', id, run, provider: p } : { name: 'challenge', id, run, provider: p },
      )
    }
    setScreen(
      loaded.kind === 'canvas'
        ? { name: 'canvas', id: loaded.canvas.id, run }
        : loaded.kind === 'challenge'
          ? { name: 'challenge', id: loaded.challenge.id, run }
          : { name: 'incident', id: loaded.scenario.id, run },
    )
  }

  // Playing a file from the preview page: it isn't in the index or the URL
  // scheme, so replays and cloud picks restart it locally, and nothing is saved.
  const replay = (id: string, provider?: Provider) =>
    previewing ? start(item!, ++navSeq.current, provider) : go(`#/play/${id}${provider ? `/${provider}` : ''}`)

  // The listener is registered once, so it calls the current render's navigate.
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  })
  useEffect(() => {
    const onHashChange = () => navigateRef.current(location.hash)
    onHashChange()
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Save a finished incident or challenge and work out what it changed.
  // `inShift`: the shift keeps its own URL; a reload ends the shift, and the
  // incidents it recorded are already saved.
  function record(id: string, s: { total: number; clean: boolean; hintsUsed: number }, provider?: Provider, inShift = false): Outcome {
    if (previewing) return { gained: 0, unlocked: [] }
    if (!inShift) history.replaceState(null, '', `#/done/${id}`)
    const result = recordResult(progress, id, s, new Date(), provider)
    const newRank = rankFor(result.progress.xp).rank
    const before = unlocks(progress)
    const after = unlocks(result.progress)
    const track = items.find((x) => x.id === id)?.track
    const allDone = (p: Progress) => items.every((x) => x.track !== track || p.completed[x.id])
    setProgress(result.progress)
    return {
      gained: result.gained,
      rankUp: newRank !== rank ? newRank.name : undefined,
      cleared: !allDone(progress) && allDone(result.progress) ? content.tracks.find((t) => t.id === track)?.name : undefined,
      unlocked: content.tracks
        .filter((t) => !before.has(t.id) && after.has(t.id) && items.some((x) => x.track === t.id))
        .map((t) => t.name),
    }
  }

  function resolved(id: string, log: GameEvent[]) {
    const s = score(scenario!, log, relaxed)
    setScreen({ name: 'debrief', id, log, score: s, ...record(id, s) })
  }

  function canvasFinished(id: string, runs: CanvasRun[], hintsUsed: number, provider?: Provider) {
    const s = scoreRuns(canvas!.difficulty, runs.map((r) => evaluateCanvas(canvas!, r.design)), hintsUsed)
    setScreen({ name: 'canvas-debrief', id, runs, score: s, provider, ...record(id, s, provider) })
  }

  function challengeFinished(id: string, runs: Run[], hintsUsed: number, provider?: Provider) {
    const s = scoreChallenge(challenge!, runs, hintsUsed)
    setScreen({ name: 'challenge-debrief', id, runs, score: s, provider, ...record(id, s, provider) })
  }

  const setting = (patch: Partial<Progress['settings']>) =>
    setProgress((p) => ({ ...p, settings: { ...p.settings, ...patch } }))

  const navButton = (label: string, target: string, current: boolean) => (
    <button
      onClick={() => go(target)}
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
          <span className="font-mono font-semibold tracking-widest uppercase">
            Incident<span className="text-accent">//</span>Quest
          </span>
          <Callsign value={callsign} onChange={(c) => setting({ callsign: c })} />
          <nav aria-label="Main" className="flex gap-1">
            {navButton('Ops board', '#/', screen.name === 'home')}
            {navButton('Clearance map', '#/tree', screen.name === 'tree')}
          </nav>
          <dl className="flex flex-wrap gap-x-5 text-sm">
            <div className="flex gap-1.5">
              <dt className="text-muted">Clearance</dt>
              <dd>{rank.name}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-muted">XP</dt>
              <dd className="flex items-center gap-2 font-mono tabular-nums">
                {progress.xp}
                {next && <span className="text-muted"> / {next.xp}</span>}
                {next && (
                  <meter
                    aria-hidden // the numbers beside it say the same thing
                    min={rank.xp}
                    max={next.xp}
                    value={progress.xp}
                    className="h-1.5 w-20 [&::-moz-meter-bar]:bg-accent [&::-webkit-meter-bar]:rounded-full [&::-webkit-meter-bar]:border-0 [&::-webkit-meter-bar]:bg-line [&::-webkit-meter-optimum-value]:rounded-full [&::-webkit-meter-optimum-value]:bg-accent"
                  />
                )}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-muted">Missions cleared</dt>
              <dd className="font-mono tabular-nums">{Object.keys(progress.completed).length}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-muted">Clean streak</dt>
              <dd className="font-mono tabular-nums">{progress.streak.current}</dd>
            </div>
          </dl>
          <div className="ml-auto flex gap-2">
            <button
              className={toggle}
              aria-pressed={relaxed}
              title="No time bonus on incidents, and no clock in the debrief"
              onClick={() => setting({ relaxed: !relaxed })}
            >
              Relaxed mode
            </button>
            <button className={toggle} aria-pressed={sound} title="Alert tones on accept and clear" onClick={() => setting({ sound: !sound })}>
              Sound
            </button>
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
        {previewing && (
          <p className="mb-4 flex flex-wrap items-center gap-x-3 rounded-lg border border-accent/60 bg-panel px-4 py-2 text-sm">
            Previewing a file: nothing is saved to your progress.
            <button className="text-accent underline" onClick={() => go('#/preview')}>
              Back to the preview page
            </button>
          </p>
        )}
        <Suspense fallback={<p className="text-muted">Loading…</p>}>
          {screen.name === 'preview' && (
            <PreviewScreen
              text={previewText}
              tracks={content.tracks}
              onText={setPreviewText}
              onPlay={(loaded) => {
                setPreviewing(true)
                start(loaded, ++navSeq.current)
              }}
            />
          )}
          {screen.name === 'home' && (
            <HomeScreen
              tracks={content.tracks}
              items={items}
              progress={progress}
              unlocked={unlocks(progress)}
              focusTrack={screen.track}
              onPlay={play}
              shiftNeeds={Math.max(0, SHIFT_UNLOCK - resolvedIncidents(progress))}
              onShift={() => go('#/shift')}
            />
          )}
          {screen.name === 'tree' && (
            <SkillTreeScreen
              tracks={content.tracks}
              scenarios={items}
              progress={progress}
              unlocked={unlocks(progress)}
              onOpenTrack={(track) => go(`#/track/${track}`)}
            />
          )}
          {screen.name === 'shift' && (
            <ShiftScreen
              key={screen.run}
              candidates={items
                .filter((x) => x.kind === 'incident' && unlocks(progress).has(x.track))
                .map((x) => ({ id: x.id, track: x.track, title: x.title, priority: x.tag as Priority, difficulty: x.difficulty, resolved: !!progress.completed[x.id] }))}
              relaxed={relaxed}
              streak={progress.streak.current}
              onRecord={(id, s) => record(id, s, undefined, true)}
              onBonus={(xp) => setProgress((p) => ({ ...p, xp: p.xp + xp }))}
              onExit={() => go('#/')}
              onTree={() => go('#/tree')}
            />
          )}
          {screen.name === 'incident' && (
            <IncidentScreen key={screen.run} scenario={scenario!} onResolved={(log) => resolved(screen.id, log)} />
          )}
          {screen.name === 'challenge' && (
            <ChallengeScreen
              key={screen.run}
              challenge={challenge!}
              onFinished={(runs, hints) => challengeFinished(screen.id, runs, hints, screen.provider)}
            />
          )}
          {screen.name === 'pick-cloud' && multi && (
            <PickCloudScreen
              title={multi.title}
              providers={multi.providers}
              summary={(p) => cloudSummary(multi, p)}
              completedOn={progress.completed[multi.id]?.providers ?? []}
              onPick={(provider) => (previewing ? start(item!, ++navSeq.current, provider) : go(`#/play/${multi.id}/${provider}`))}
            />
          )}
          {screen.name === 'canvas' && (
            <CanvasScreen
              key={screen.run}
              challenge={canvas!}
              onFinished={(runs, hints) => canvasFinished(screen.id, runs, hints, screen.provider)}
            />
          )}
          {screen.name === 'canvas-debrief' && (
            <CanvasDebrief
              challenge={canvas!}
              runs={screen.runs}
              score={screen.score}
              outcome={screen}
              streak={progress.streak.current}
              onHome={() => go('#/')}
              onTree={() => go('#/tree')}
              onReplay={() => replay(screen.id, 'provider' in screen ? screen.provider : undefined)}
              crossCloud={multi && screen.provider ? crossCloud(multi, screen.provider, screen.runs.at(-1)!.design) : undefined}
            />
          )}
          {screen.name === 'challenge-debrief' && (
            <ChallengeDebrief
              challenge={challenge!}
              runs={screen.runs}
              score={screen.score}
              outcome={screen}
              streak={progress.streak.current}
              onHome={() => go('#/')}
              onTree={() => go('#/tree')}
              onReplay={() => replay(screen.id, 'provider' in screen ? screen.provider : undefined)}
              crossCloud={multi && screen.provider ? crossCloud(multi, screen.provider, screen.runs.at(-1)!.picks) : undefined}
            />
          )}
          {screen.name === 'debrief' && (
            <DebriefScreen
              scenario={scenario!}
              breakdown={item?.kind === 'incident' ? item.breakdown : undefined}
              log={screen.log}
              score={screen.score}
              gained={screen.gained}
              rankUp={screen.rankUp}
              cleared={screen.cleared}
              unlocked={screen.unlocked}
              streak={progress.streak.current}
              onHome={() => go('#/')}
              onTree={() => go('#/tree')}
              onReplay={() => replay(screen.id)}
            />
          )}
        </Suspense>
      </main>
    </>
  )
}

// What the picker lists for each cloud: canvas parts, or each tier's options.
function cloudSummary(m: MultiChallenge, p: Provider): string[] {
  if (m.kind === 'canvas') {
    const v: CanvasChallenge | undefined = m.variants[p]
    return v?.palette.map((x) => x.label) ?? []
  }
  const v: Challenge | undefined = m.variants[p]
  return v?.tiers.map((t) => `${t.label}: ${t.options.map((o) => o.short ?? o.label).join(' · ')}`) ?? []
}

// The debrief's cross-cloud table: parts used in the player's design or the
// reference, named on every cloud the challenge supports.
function crossCloud(m: MultiChallenge, p: Provider, mine: Design | Picks): CrossCloud {
  const clouds: Provider[] = m.providers
  const sources = Object.fromEntries(clouds.map((q) => [q, m.variants[q]?.sources ?? []]))
  if (m.kind === 'canvas') {
    const variants = m.variants as Partial<Record<Provider, CanvasChallenge>>
    const d = mine as Design
    const ref = variants[p]!.reference_designs.flatMap((r) => r.design.nodes.map((n) => n.type))
    const ids = [...new Set([...d.nodes.map((n) => n.type), ...ref])]
    return {
      current: p,
      providers: m.providers,
      sources,
      rows: ids.map((id) => ({
        id,
        names: Object.fromEntries(clouds.map((q) => [q, variants[q]?.palette.find((x) => x.id === id)?.label ?? ''])),
        differences: m.differences[id] ?? '',
      })),
    }
  }
  const variants = m.variants as Partial<Record<Provider, Challenge>>
  const picks = mine as Picks
  const base = variants[p]!
  const ids = [...new Set([...Object.values(picks), ...base.reference_designs.flatMap((r) => Object.values(r.picks))])]
  return {
    current: p,
    providers: m.providers,
    sources,
    rows: ids.map((id) => ({
      id,
      tier: base.tiers.find((t) => t.options.some((o) => o.id === id))?.label,
      names: Object.fromEntries(
        clouds.map((q) => [q, variants[q]?.tiers.flatMap((t) => t.options).find((o) => o.id === id)?.label ?? '']),
      ),
      differences: m.differences[id] ?? '',
    })),
  }
}
