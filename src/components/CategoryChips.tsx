import { useState } from 'react'
import { CATEGORIES, type Category } from '../game/categories.ts'

// Multi-select filter for the Ops board. The last pressed chip refuses to
// turn off and says so to screen readers.
export default function CategoryChips({
  selected,
  open,
  onToggle,
}: {
  selected: ReadonlySet<Category>
  open: Record<Category, number>
  onToggle: (id: Category) => void
}) {
  const [notice, setNotice] = useState('')
  return (
    <div role="group" aria-label="Show categories" className="flex flex-wrap items-center gap-2">
      {CATEGORIES.map(({ id, label }) => {
        const on = selected.has(id)
        const last = on && selected.size === 1
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            aria-disabled={last || undefined}
            onClick={() => {
              if (last) return setNotice('At least one category must stay on')
              setNotice('')
              onToggle(id)
            }}
            className={`rounded-md border px-3 py-1.5 font-mono text-sm tracking-wider focus-visible:outline-2 focus-visible:outline-accent ${on ? 'border-accent text-accent' : 'border-line text-muted hover:border-accent'} ${last ? 'cursor-not-allowed' : ''}`}
          >
            {label} · <span className="tabular-nums">{open[id]}</span> open
          </button>
        )
      })}
      <span role="status" className="sr-only">
        {notice}
      </span>
    </div>
  )
}
