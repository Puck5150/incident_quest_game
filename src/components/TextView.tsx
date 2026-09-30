import { useId, useState } from 'react'

// Text with line numbers. Logs also get a grep-style filter and severity
// highlighting; config files are shown as-is.
export default function TextView({ content, isLog }: { content: string; isLog?: boolean }) {
  const [filter, setFilter] = useState('')
  const filterId = useId()
  const lines = content.replace(/\n$/, '').split('\n').map((text, i) => ({ n: i + 1, text }))
  const shown = filter ? lines.filter((l) => l.text.toLowerCase().includes(filter.toLowerCase())) : lines

  return (
    <>
      {isLog && (
        <div className="border-b border-line p-2">
          <label className="sr-only" htmlFor={filterId}>
            Filter lines
          </label>
          <input
            id={filterId}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter (like grep)…"
            className="w-full rounded border border-line bg-panel px-2 py-1 font-mono text-xs focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>
      )}
      <pre className="max-h-[24rem] overflow-auto p-3 font-mono text-xs leading-relaxed">
        {shown.map((l) => (
          <div key={l.n} className={isLog ? severity(l.text) : undefined}>
            <span aria-hidden className="mr-3 inline-block w-8 text-right text-muted select-none">
              {l.n}
            </span>
            {l.text}
          </div>
        ))}
        {shown.length === 0 && <span className="text-muted">No lines match.</span>}
      </pre>
    </>
  )
}

function severity(line: string) {
  if (/\b(error|crit|critical|fatal|emerg|alert|failed)\b|Error:/i.test(line)) return 'text-crit'
  if (/\bwarn(ing)?\b/i.test(line)) return 'text-warn'
}
