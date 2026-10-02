import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Scenario } from '../schema/scenario.ts'
import { atStage, stageAt } from '../schema/stages.ts'
import { commandsRun, complete, normalize, terminalOutput, transcript, type GameEvent } from '../game/engine.ts'

type Line = { input: string; output: string; completions?: boolean } // completions: Tab's list, not a run command

// A deliberately simple fake shell: a text input plus a scrolling transcript.
// Real text (not a canvas) so screen readers and copy/paste just work.
export default function Terminal({
  scenario,
  log,
  onRun,
}: {
  scenario: Scenario
  log: GameEvent[] // the session so far: the transcript and history start from it
  onRun: (input: string) => void
}) {
  const prompt = scenario.terminal!.prompt
  const [lines, setLines] = useState<Line[]>(() => transcript(scenario, log))
  const [history, setHistory] = useState<string[]>(() => commandsRun(log))
  const [cursor, setCursor] = useState<number>() // position while browsing history with ↑/↓
  const [input, setInput] = useState('')
  const out = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (out.current) out.current.scrollTop = out.current.scrollHeight
  }, [lines])

  function submit() {
    const cmd = normalize(input)
    setInput('')
    setCursor(undefined)
    if (!cmd) return setLines((l) => [...l, { input: '', output: '' }])
    const output = terminalOutput(scenario, cmd, log) // `log` is still the session before this command
    onRun(cmd)
    setHistory((h) => [...h, cmd])
    if (cmd === 'clear') return setLines([])
    setLines((l) => [...l, { input: cmd, output }])
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Tab completes only when there's something to complete; on an empty
    // prompt (or with Shift) it moves focus as usual, so the terminal never
    // traps keyboard users.
    if (e.key === 'Tab' && !e.shiftKey && input.trim()) {
      e.preventDefault()
      const c = complete(atStage(scenario, stageAt(log)), input)
      setInput(c.input)
      if (c.options) setLines((l) => [...l, { input, output: c.options!.join('  '), completions: true }])
    } else if (e.key === 'Enter') {
      e.preventDefault()
      submit()
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
          Type <span className="text-fg">help</span> to see some commands. Tab completes, ↑/↓ for history.
          {[scenario, ...(scenario.stages ?? [])].some((x) => x.actions.some((a) => a.match_regex)) && ' Once you have named the root cause, you can type fixes here too.'}
        </p>
        {lines.map((l, i) =>
          l.completions ? (
            <pre key={i} className="whitespace-pre-wrap text-muted">
              {l.output}
            </pre>
          ) : (
            <div key={i}>
              <div>
                <span className="text-ok">{prompt}</span> {l.input}
              </div>
              {l.output && <pre className="whitespace-pre">{l.output}</pre>}
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
