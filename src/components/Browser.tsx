import { useState, type ReactNode } from 'react'

export type BrowserItem = { name: string; label?: ReactNode; render: () => ReactNode }

// Pick-one-to-open layout shared by logs, files, traces, metrics and
// pipeline stages. Opening an item is what counts as "seeing" its evidence.
export default function Browser({
  noun,
  items,
  onOpen,
}: {
  noun: string
  items: BrowserItem[]
  onOpen: (name: string) => void
}) {
  const [open, setOpen] = useState<string>()
  const item = items.find((i) => i.name === open)

  return (
    <div className="grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
      <ul className="space-y-1" aria-label={`${noun}s`}>
        {items.map((i) => (
          <li key={i.name}>
            <button
              aria-pressed={open === i.name}
              onClick={() => {
                setOpen(i.name)
                onOpen(i.name)
              }}
              className="w-full rounded px-2 py-1.5 text-left font-mono text-xs break-words hover:bg-panel focus-visible:outline-2 focus-visible:outline-accent aria-pressed:bg-panel aria-pressed:text-accent"
            >
              {i.label ?? i.name}
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 rounded-lg border border-line bg-bg">
        {item ? (
          // key resets per-item state (like a log filter) when switching items
          <div key={item.name}>{item.render()}</div>
        ) : (
          <p className="p-3 text-sm text-muted">Select a {noun} to view it.</p>
        )}
      </div>
    </div>
  )
}
