import { useState } from 'react'

type Item = { name: string; content: string }

// Shared viewer for logs and config files: pick an item, read it with line
// numbers. Logs also get a grep-style filter and severity highlighting.
export default function TextViewer({
  kind,
  items,
  onOpen,
}: {
  kind: 'log' | 'file'
  items: Item[]
  onOpen: (name: string) => void
}) {
  const [open, setOpen] = useState<string>()
  const [filter, setFilter] = useState('')
  const item = items.find((i) => i.name === open)
  const lines = (item?.content.replace(/\n$/, '') ?? '').split('\n').map((text, i) => ({ n: i + 1, text }))
  const shown = filter ? lines.filter((l) => l.text.toLowerCase().includes(filter.toLowerCase())) : lines

  return (
    <div className="grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
      <ul className="space-y-1" aria-label={kind === 'log' ? 'Log sources' : 'Files'}>
        {items.map((i) => (
          <li key={i.name}>
            <button
              aria-pressed={open === i.name}
              onClick={() => {
                setOpen(i.name)
                onOpen(i.name)
              }}
              className="w-full rounded px-2 py-1.5 text-left font-mono text-xs break-all hover:bg-panel focus-visible:outline-2 focus-visible:outline-accent aria-pressed:bg-panel aria-pressed:text-accent"
            >
              {i.name}
            </button>
          </li>
        ))}
      </ul>

      <div className="min-w-0 rounded-lg border border-line bg-bg">
        {!item ? (
          <p className="p-3 text-sm text-muted">Select a {kind} to view it.</p>
        ) : (
          <>
            {kind === 'log' && (
              <div className="border-b border-line p-2">
                <label className="sr-only" htmlFor="log-filter">
                  Filter lines
                </label>
                <input
                  id="log-filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter (like grep)…"
                  className="w-full rounded border border-line bg-panel px-2 py-1 font-mono text-xs focus-visible:outline-2 focus-visible:outline-accent"
                />
              </div>
            )}
            <pre className="max-h-[24rem] overflow-auto p-3 font-mono text-xs leading-relaxed">
              {shown.map((l) => (
                <div key={l.n} className={kind === 'log' ? severity(l.text) : undefined}>
                  <span aria-hidden className="mr-3 inline-block w-8 text-right text-muted select-none">
                    {l.n}
                  </span>
                  {l.text}
                </div>
              ))}
              {shown.length === 0 && <span className="text-muted">No lines match.</span>}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}

function severity(line: string) {
  if (/\b(error|crit|critical|fatal|emerg|alert)\b|Error:/i.test(line)) return 'text-crit'
  if (/\bwarn(ing)?\b/i.test(line)) return 'text-warn'
}
