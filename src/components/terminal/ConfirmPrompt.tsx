import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Prompting } from './session.ts'

// What `terraform apply` (or destroy) shows before it changes anything: the
// plan and its "Enter a value:" prompt. Enter answers; Esc answers '' (declines).
export default function ConfirmPrompt({ prompting }: { prompting: Prompting }) {
  const [value, setValue] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const out = useRef<HTMLPreElement>(null)
  useEffect(() => {
    field.current?.focus()
    if (out.current) out.current.scrollTop = out.current.scrollHeight // the prompt is at the bottom
  }, [])

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      prompting.done(value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      prompting.done('')
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Confirm terraform action" className="absolute inset-0 z-10 flex flex-col rounded-lg border border-accent bg-bg font-mono text-sm">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs">
        <span>terraform is waiting for an answer</span>
        <span className="text-muted">Enter answer · Esc decline</span>
      </div>
      <pre ref={out} className="min-h-0 flex-1 overflow-auto whitespace-pre p-3">
        {prompting.shown}
      </pre>
      <div className="flex items-center gap-2 border-t border-line p-3">
        <label htmlFor="confirm-prompt" className="text-muted">
          Enter a value
        </label>
        <input
          id="confirm-prompt"
          ref={field}
          value={value}
          onChange={(e) => setValue(e.target.value)}
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
