import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Editing } from './session.ts'

// What `nano FILE` or `vi FILE` opens: a plain editor over the terminal.
// Ctrl-S (or Ctrl-O) saves and exits; Esc (or Ctrl-X) exits without saving.
export default function FileEditor({ editing }: { editing: Editing }) {
  const [text, setText] = useState(editing.content)
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => area.current?.focus(), [])

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'o')) {
      e.preventDefault()
      editing.done(text)
    } else if (e.key === 'Escape' || (e.ctrlKey && e.key === 'x')) {
      e.preventDefault()
      editing.done(null)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={`Editing ${editing.path}`} className="absolute inset-0 z-10 flex flex-col rounded-lg border border-accent bg-bg font-mono text-sm">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs">
        <span>
          <span className="text-muted">editing </span>
          {editing.path}
        </span>
        <span className="text-muted">Ctrl-S save and exit · Esc exit without saving</span>
      </div>
      <label htmlFor="file-editor" className="sr-only">
        Contents of {editing.path}
      </label>
      <textarea
        id="file-editor"
        ref={area}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="flex-1 resize-none bg-transparent p-3 outline-none"
      />
      <div className="flex gap-2 border-t border-line p-2">
        <button className="rounded-md border border-accent px-3 py-1 text-accent" onClick={() => editing.done(text)}>
          Save and exit
        </button>
        <button className="rounded-md border border-line px-3 py-1" onClick={() => editing.done(null)}>
          Exit without saving
        </button>
      </div>
    </div>
  )
}
