import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Scenario } from '../schema/scenario.ts'
import type { GameEvent } from '../game/engine.ts'
import { hint, useTerminalSession, type Line } from './terminal/session.ts'

const XtermTerminal = lazy(() => import('./terminal/XtermTerminal.tsx'))

type Props = {
  scenario: Scenario
  log: GameEvent[] // the session so far: the transcript and history start from it
  onRun: (input: string) => void
  onShellRan?: (commands: string[]) => void // scripted commands the shell ran inside a pipeline
}

// The full terminal (xterm.js) where it works well: a real browser with a
// mouse or trackpad, unless the player chose the simple terminal. Otherwise
// (screen readers, phones, tests) the plain-text transcript below.
function wantsFull(): boolean {
  if (document.documentElement.dataset.terminal === 'simple') return false
  if (typeof window.matchMedia !== 'function') return false
  return !window.matchMedia('(pointer: coarse)').matches
}

export default function Terminal(props: Props) {
  const [full] = useState(wantsFull)
  if (!full) return <SimpleTerminal {...props} />
  return (
    <Suspense fallback={<div className="h-[28rem] rounded-lg border border-line bg-bg" />}>
      <XtermTerminal {...props} />
    </Suspense>
  )
}

// A text input plus a scrolling transcript. Real text (not a canvas), so
// screen readers and copy/paste just work.
function SimpleTerminal({ scenario, log, onRun, onShellRan }: Props) {
  const session = useTerminalSession(scenario, log, onRun, onShellRan)
  const [lines, setLines] = useState<Line[]>(session.initial)
  const [cursor, setCursor] = useState<number>() // position while browsing history with ↑/↓
  const [input, setInput] = useState('')
  const out = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const { history, prompt } = session

  // When the shell has replayed the session, show its transcript instead.
  const [shownReplay, setShownReplay] = useState(session.replayed)
  if (session.replayed !== shownReplay) {
    setShownReplay(session.replayed)
    if (session.replayed) setLines(session.replayed)
  }

  useEffect(() => {
    if (out.current) out.current.scrollTop = out.current.scrollHeight
  }, [lines])

  function submit() {
    const r = session.run(input)
    setInput('')
    setCursor(undefined)
    if (r.clear) return setLines([])
    setLines((l) => [...l, r.line])
    if (r.line.pending) r.done.then((done) => setLines((l) => l.map((x) => (x.id === done.id ? done : x))))
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Tab completes only when there's something to complete; on an empty
    // prompt (or with Shift) it moves focus as usual, so the terminal never
    // traps keyboard users.
    if (e.key === 'Tab' && !e.shiftKey && input.trim()) {
      e.preventDefault()
      const show = (c: { input: string; options?: string[] }) => {
        setInput(c.input)
        if (c.options) setLines((l) => [...l, { id: session.id(), prompt, input, output: c.options!.join('  '), completions: true }])
      }
      const c = session.completeLine(input)
      // Nothing from the scripted commands: try the real filesystem.
      if (c.input === input && !c.options) session.completePath(input).then(show)
      else show(c)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.ctrlKey && e.key === 'c') {
      // Ctrl-C abandons the line, as in a real shell.
      e.preventDefault()
      setLines((l) => [...l, { id: session.id(), prompt, input: input + '^C', output: '' }])
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
        <p className="text-muted">{hint(scenario)}</p>
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
