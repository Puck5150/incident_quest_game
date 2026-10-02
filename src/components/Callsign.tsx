import { useState } from 'react'
import { toCallsign } from '../game/progress.ts'

const WORDS = ['NIGHTOWL', 'VECTOR', 'HALCYON', 'SPARROW', 'KESTREL', 'CIPHER', 'NOMAD', 'ORBIT', 'RAVEN', 'TALON']
const suggest = () => `${WORDS[Math.floor(Math.random() * WORDS.length)]}-${Math.floor(Math.random() * 9) + 1}`

// The player's callsign, shown in the status bar. Unset until they pick one;
// editing happens in place so nothing blocks play.
export default function Callsign({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState<string>()

  if (draft === undefined)
    return (
      <button
        onClick={() => setDraft(value ?? suggest())}
        title="Change your callsign"
        className={`rounded-md border px-2.5 py-1 font-mono text-sm tracking-wider focus-visible:outline-2 focus-visible:outline-accent ${value ? 'border-transparent hover:border-line' : 'border-accent text-accent'}`}
      >
        {value ?? 'Choose callsign'}
      </button>
    )

  const save = () => {
    const c = toCallsign(draft)
    if (c) onChange(c)
    setDraft(undefined)
  }
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <label htmlFor="callsign" className="sr-only">
        Callsign
      </label>
      <input
        id="callsign"
        autoFocus
        value={draft}
        maxLength={16}
        onChange={(e) => setDraft(toCallsign(e.target.value))}
        onKeyDown={(e) => e.key === 'Escape' && setDraft(undefined)}
        className="w-36 rounded-md border border-line bg-bg px-2 py-1 font-mono text-sm tracking-wider"
      />
      <button type="submit" className="rounded-md border border-accent px-2.5 py-1 text-sm text-accent">
        Save
      </button>
    </form>
  )
}
