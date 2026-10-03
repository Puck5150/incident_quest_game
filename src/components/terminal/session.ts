import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Scenario } from '../../schema/scenario.ts'
import { atStage, stageAt } from '../../schema/stages.ts'
import { actionsTaken, commandsRun, complete, engineHandles, namedRootCause, normalize, terminalOutput, transcript, type GameEvent } from '../../game/engine.ts'
import type { IncidentShell } from '../../game/shell.ts'

export type Line = { id: number; prompt: string; input: string; output: string; completions?: boolean; pending?: boolean }

// The terminal's welcome line.
export const hint = (scenario: Scenario) =>
  "Type help to see some commands. It's a real shell: pipes, files, cd and variables work. Tab completes, ↑/↓ for history." +
  ([scenario, ...(scenario.stages ?? [])].some((x) => x.actions.some((a) => a.match_regex)) ? ' Once you have named the root cause, you can type fixes here too.' : '')

// The prompt on another host: "ops@media-01:~$" after ssh db-01 is "ops@db-01:~$".
const onHost = (prompt: string, host: string | undefined) => (host ? prompt.replace(/^([\w.-]+@)[\w.-]+/, `$1${host}`) : prompt)

// The prompt as it would read in `cwd`: "ops@media-01:~$" becomes
// "ops@media-01:/var/log$" after cd /var/log. Prompts without a path stay as written.
export function promptIn(prompt: string, cwd: string | undefined, home: string | undefined): string {
  const m = prompt.match(/^(.*:)(\S*)([$#])\s*$/)
  if (!m || !cwd) return prompt
  const shown = home && (cwd === home || cwd.startsWith(home + '/')) ? '~' + cwd.slice(home.length) : cwd
  return `${m[1]}${shown}${m[3]}`
}

// Everything a terminal view needs, whatever it looks like: lines the game
// scripts (help, scripted commands, typed fixes) are answered by the engine;
// everything else runs in the real shell (src/game/shell.ts), loaded on first
// use, one command at a time, in order. On mount the session's shell commands
// are replayed so the shell's state (directory, files, variables) matches.
export type Editing = { path: string; content: string; done: (content: string | null) => void }

export function useTerminalSession(
  scenario: Scenario,
  log: GameEvent[],
  onRun: (input: string) => void,
  onShellRan?: (commands: string[]) => void,
  onTakeAction?: (id: string) => void,
) {
  const basePrompt = scenario.terminal!.prompt
  const nextId = useRef(0)
  const id = () => nextId.current++
  const latest = useRef(log)
  useLayoutEffect(() => {
    latest.current = log
  })
  const [history, setHistory] = useState<string[]>(() => commandsRun(log))
  const [cwd, setCwd] = useState<string>()
  const [home, setHome] = useState<string>()
  const [host, setHost] = useState<string>()
  const shell = useRef<Promise<IncidentShell>>(undefined)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const [editing, setEditing] = useState<Editing>()
  const getShell = () =>
    (shell.current ??= import('../../game/shell.ts').then((m) => {
      const sh = new m.IncidentShell(scenario)
      sh.onEdit = (path, content) => new Promise((done) => setEditing({ path, content, done: (c) => (setEditing(undefined), done(c)) }))
      setHome(sh.home)
      return sh
    }))

  // Fixes made by editing a file: once the file on disk matches, take the
  // action, through the same gate as the buttons (the root cause must be
  // named). Returns a note for the terminal if the edit doesn't count yet.
  const warned = useRef(new Set<string>())
  const checkFileFixes = async (sh: IncidentShell, now: GameEvent[]): Promise<string> => {
    const cur = atStage(scenario, stageAt(now))
    const taken = actionsTaken(now)
    const notes: string[] = []
    for (const a of cur.actions) {
      if (!a.file || taken.has(a.id)) continue
      const text = await sh.read(a.file.path)
      if (text === undefined || !new RegExp(a.file.matches, 'm').test(text)) continue
      if (namedRootCause(scenario, now)) onTakeAction?.(a.id)
      else if (!warned.current.has(a.id)) {
        warned.current.add(a.id)
        notes.push(`(Saved. The game counts this as a fix once you've named the root cause.)`)
      }
    }
    return notes.join('\n')
  }

  // When the log changes (an action taken with a button, a hypothesis named),
  // bring the disk up to date and re-check edits made earlier.
  useEffect(() => {
    if (!shell.current) return
    const now = log
    queue.current = queue.current.then(async () => {
      const sh = await getShell()
      await sh.update(atStage(scenario, stageAt(now)), actionsTaken(now))
      await checkFileFixes(sh, now)
    })
  }, [log]) // eslint-disable-line react-hooks/exhaustive-deps

  // The transcript as the engine alone can rebuild it (immediately), then
  // with shell commands replayed (once the shell has loaded), if there are any.
  const [initial] = useState<Line[]>(() => transcript(scenario, log).map((l, i) => ({ ...l, id: -1 - i, prompt: basePrompt })))
  const [replayed, setReplayed] = useState<Line[]>()
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const snapshot = latest.current
    if (!snapshot.some((e, i) => e.type === 'RUN_COMMAND' && !engineHandles(scenario, e.input, snapshot.slice(0, i)))) return
    queue.current = queue.current.then(async () => {
      const sh = await getShell()
      let rebuilt: Line[] = []
      for (const [i, e] of snapshot.entries()) {
        if (e.type !== 'RUN_COMMAND') continue
        const before = snapshot.slice(0, i)
        const cmd = normalize(e.input)
        if (cmd === 'clear') {
          rebuilt = []
          continue
        }
        const prompt = promptIn(onHost(basePrompt, sh.currentHost), sh.cwd, sh.home)
        const output = engineHandles(scenario, cmd, before)
          ? terminalOutput(scenario, cmd, before)
          : (await sh.run(cmd, atStage(scenario, stageAt(before)), actionsTaken(before))).output
        rebuilt.push({ id: id(), prompt, input: cmd, output })
      }
      setReplayed(rebuilt)
      setCwd(sh.cwd)
      setHost(sh.currentHost)
    })
    // once per mount, from the log as it was then
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const prompt = promptIn(onHost(basePrompt, host), cwd, home)

  // Run one typed line. Resolves with what to print; `clear` empties the screen.
  const run = useCallback(
    (input: string): { line: Line; done: Promise<Line>; clear?: boolean } => {
      const cmd = normalize(input)
      const before = latest.current // the session before this command
      const line: Line = { id: id(), prompt, input: cmd, output: '' }
      if (!cmd) return { line, done: Promise.resolve(line) }
      onRun(cmd)
      setHistory((h) => [...h, cmd])
      if (cmd === 'clear') return { line, done: Promise.resolve(line), clear: true }
      if (engineHandles(scenario, cmd, before)) {
        const l = { ...line, output: terminalOutput(scenario, cmd, before) }
        return { line: l, done: Promise.resolve(l) }
      }
      const done = (queue.current = queue.current.then(async () => {
        const sh = await getShell()
        const r = await sh.run(cmd, atStage(scenario, stageAt(before)), actionsTaken(before))
        setCwd(sh.cwd)
        setHost(sh.currentHost)
        if (r.hits.length) onShellRan?.(r.hits)
        const note = await checkFileFixes(sh, latest.current)
        return { ...line, output: [r.output, note].filter(Boolean).join('\n') }
      })) as Promise<Line>
      return { line: { ...line, pending: true }, done }
    },
    [prompt, scenario, onRun, onShellRan, onTakeAction], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const completeLine = (input: string) => complete(atStage(scenario, stageAt(latest.current)), input)

  // Tab on a path completes from the real filesystem: names in that directory
  // that start with what's typed (directories get a trailing /).
  const completePath = async (input: string): Promise<{ input: string; options?: string[] }> => {
    const word = input.split(' ').at(-1)!
    const slash = word.lastIndexOf('/')
    const dir = slash >= 0 ? word.slice(0, slash + 1) : ''
    const stem = word.slice(slash + 1)
    const sh = await getShell()
    const names = (await sh.list(dir.replace(/^~(?=\/|$)/, sh.home)))
      .filter((n) => n.name.startsWith(stem) && (stem.startsWith('.') || !n.name.startsWith('.')))
      .map((n) => n.name + (n.dir ? '/' : ''))
      .sort()
    if (!names.length) return { input }
    const head = input.slice(0, input.length - word.length) + dir
    if (names.length === 1) return { input: head + names[0] + (names[0].endsWith('/') ? '' : ' ') }
    const common = names.reduce((a, b) => {
      let i = 0
      while (i < a.length && a[i] === b[i]) i++
      return a.slice(0, i)
    })
    return common.length > stem.length ? { input: head + common } : { input, options: names }
  }

  return { initial, replayed, prompt, history, run, completeLine, completePath, id, editing }
}
