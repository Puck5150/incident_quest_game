import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Scenario } from '../schema/scenario.ts'
import { actionFor, normalize, NOT_YET, runCommand } from '../game/engine.ts'

type Line = { input: string; output: string }

// A deliberately simple fake shell: a text input plus a scrolling transcript.
// Real text (not a canvas) so screen readers and copy/paste just work.
export default function Terminal({
  scenario,
  taken,
  canAct,
  onRun,
}: {
  scenario: Scenario
  taken: Set<string>
  canAct: boolean // root cause declared: typed fix commands take effect
  onRun: (input: string) => void
}) {
  const prompt = scenario.terminal!.prompt
  const [lines, setLines] = useState<Line[]>([])
  const [history, setHistory] = useState<string[]>([])
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
    onRun(cmd)
    setHistory((h) => [...h, cmd])
    if (cmd === 'clear') return setLines([])
    const ran = runCommand(scenario, cmd, taken)
    // A command that takes an action reports the result right here, so it's
    // visible without looking away from the terminal.
    const action = ran.scripted ? undefined : actionFor(scenario, cmd)
    const output =
      cmd === 'history'
        ? [...history, cmd].map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join('\n')
        : action
          ? canAct
            ? action.feedback
            : NOT_YET
          : ran.output
    setLines((l) => [...l, { input: cmd, output }])
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
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
          Type <span className="text-fg">help</span> to see some commands. ↑/↓ for history.
          {scenario.actions.some((x) => x.match_regex) && ' Once you have named the root cause, you can type fixes here too.'}
        </p>
        {lines.map((l, i) => (
          <div key={i}>
            <div>
              <span className="text-ok">{prompt}</span> {l.input}
            </div>
            {l.output && <pre className="whitespace-pre">{l.output}</pre>}
          </div>
        ))}
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
