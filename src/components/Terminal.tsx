import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Scenario } from '../schema/scenario.ts'
import { atStage, stageAt } from '../schema/stages.ts'
import { actionsTaken, commandsRun, complete, engineHandles, normalize, terminalOutput, transcript, type GameEvent } from '../game/engine.ts'
import type { IncidentShell } from '../game/shell.ts'

type Line = { id: number; prompt: string; input: string; output: string; completions?: boolean; pending?: boolean }

// The prompt as it would read in `cwd`: "ops@media-01:~$" becomes
// "ops@media-01:/var/log$" after cd /var/log. Prompts without a path stay as written.
function promptIn(prompt: string, cwd: string | undefined, home: string | undefined): string {
  const m = prompt.match(/^(.*:)(\S*)([$#])\s*$/)
  if (!m || !cwd) return prompt
  const shown = home && (cwd === home || cwd.startsWith(home + '/')) ? '~' + cwd.slice(home.length) : cwd
  return `${m[1]}${shown}${m[3]}`
}

// The terminal: a scrolling transcript and a prompt. Lines the game scripts
// (help, scripted commands, typed fixes) are answered by the engine as before;
// everything else runs in a real shell (src/game/shell.ts), so pipes, files,
// cd and variables work. Real text (not a canvas), so screen readers and
// copy/paste just work.
export default function Terminal({
  scenario,
  log,
  onRun,
}: {
  scenario: Scenario
  log: GameEvent[] // the session so far: the transcript and history start from it
  onRun: (input: string) => void
}) {
  const basePrompt = scenario.terminal!.prompt
  const nextId = useRef(0)
  const id = () => nextId.current++
  const [lines, setLines] = useState<Line[]>(() => transcript(scenario, log).map((l) => ({ ...l, id: id(), prompt: basePrompt })))
  const [history, setHistory] = useState<string[]>(() => commandsRun(log))
  const [cursor, setCursor] = useState<number>() // position while browsing history with ↑/↓
  const [input, setInput] = useState('')
  const [cwd, setCwd] = useState<string>()
  const home = useRef<string>(undefined)
  const out = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)

  // The shell loads on first use, and commands run one at a time, in order.
  const shell = useRef<Promise<IncidentShell>>(undefined)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const getShell = () =>
    (shell.current ??= import('../game/shell.ts').then((m) => {
      const sh = new m.IncidentShell(scenario)
      home.current = sh.home
      return sh
    }))

  // On mount, replay the session's shell commands so the transcript and the
  // shell's state (directory, files, variables) match what the player did.
  const replayed = useRef(false)
  useEffect(() => {
    if (replayed.current) return
    replayed.current = true
    const needsShell = log.some((e, i) => e.type === 'RUN_COMMAND' && !engineHandles(scenario, e.input, log.slice(0, i)))
    if (!needsShell) return
    const snapshot = log
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
        const prompt = promptIn(basePrompt, sh.cwd, sh.home)
        const output = engineHandles(scenario, cmd, before)
          ? terminalOutput(scenario, cmd, before)
          : (await sh.run(cmd, atStage(scenario, stageAt(before)), actionsTaken(before))).output
        rebuilt.push({ id: id(), prompt, input: cmd, output })
      }
      setLines(rebuilt)
      setCwd(sh.cwd)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount, from the log as it was then
  }, [])

  useEffect(() => {
    if (out.current) out.current.scrollTop = out.current.scrollHeight
  }, [lines])

  const prompt = promptIn(basePrompt, cwd, home.current)

  function submit() {
    const cmd = normalize(input)
    setInput('')
    setCursor(undefined)
    if (!cmd) return setLines((l) => [...l, { id: id(), prompt, input: '', output: '' }])
    const before = log // the session before this command
    onRun(cmd)
    setHistory((h) => [...h, cmd])
    if (cmd === 'clear') return setLines([])
    if (engineHandles(scenario, cmd, before)) return setLines((l) => [...l, { id: id(), prompt, input: cmd, output: terminalOutput(scenario, cmd, before) }])
    const lineId = id()
    setLines((l) => [...l, { id: lineId, prompt, input: cmd, output: '', pending: true }])
    queue.current = queue.current.then(async () => {
      const sh = await getShell()
      const r = await sh.run(cmd, atStage(scenario, stageAt(before)), actionsTaken(before))
      setLines((l) => l.map((x) => (x.id === lineId ? { ...x, output: r.output, pending: false } : x)))
      setCwd(sh.cwd)
    })
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Tab completes only when there's something to complete; on an empty
    // prompt (or with Shift) it moves focus as usual, so the terminal never
    // traps keyboard users.
    if (e.key === 'Tab' && !e.shiftKey && input.trim()) {
      e.preventDefault()
      const c = complete(atStage(scenario, stageAt(log)), input)
      setInput(c.input)
      if (c.options) setLines((l) => [...l, { id: id(), prompt, input, output: c.options!.join('  '), completions: true }])
    } else if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.ctrlKey && e.key === 'c') {
      // Ctrl-C abandons the line, as in a real shell.
      e.preventDefault()
      setLines((l) => [...l, { id: id(), prompt, input: input + '^C', output: '' }])
      setInput('')
      setCursor(undefined)
    } else if (e.ctrlKey && e.key === 'l') {
      e.preventDefault()
      setLines([])
    } else if (e.ctrlKey && e.key === 'u') {
      e.preventDefault()
      setInput('')
    } else if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault()
      const i = cursor === undefined ? history.length - 1 : Math.max(0, cursor - 1)
      setCursor(i)
      setInput(history[i])
    } else if (e.key === 'ArrowDown' && cursor !== undefined) {
      e.preventDefault()
      const i = cursor + 1
      setCursor(i < history.length ? i : undefined)
      setInput(i < history.length ? history[i] : '')
    }
  }

  return (
    // Clicking anywhere focuses the prompt, unless the player is selecting text to copy.
    <div
      className="flex h-[28rem] flex-col rounded-lg border border-line bg-bg font-mono text-sm"
      onClick={() => window.getSelection()?.isCollapsed && field.current?.focus()}
    >
      <div ref={out} role="log" aria-label="Terminal output" className="flex-1 overflow-auto p-3">
        <p className="text-muted">
          Type <span className="text-fg">help</span> to see some commands. It's a real shell: pipes, files, cd and variables work. Tab completes, ↑/↓ for history.
          {[scenario, ...(scenario.stages ?? [])].some((x) => x.actions.some((a) => a.match_regex)) && ' Once you have named the root cause, you can type fixes here too.'}
        </p>
        {lines.map((l) =>
          l.completions ? (
            <pre key={l.id} className="whitespace-pre-wrap text-muted">
              {l.output}
            </pre>
          ) : (
            <div key={l.id}>
              <div>
                <span className="text-ok">{l.prompt}</span> {l.input}
              </div>
              {l.pending ? <span className="text-muted">…</span> : l.output && <pre className="whitespace-pre">{l.output}</pre>}
            </div>
          ),
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-line p-3">
        <label htmlFor="terminal-input" className="sr-only">
          Terminal command
        </label>
        <span aria-hidden className="text-ok">
          {prompt}
        </span>
        <input
          id="terminal-input"
          ref={field}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent caret-accent outline-none"
        />
      </div>
    </div>
  )
}
