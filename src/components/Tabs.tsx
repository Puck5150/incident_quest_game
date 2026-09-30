import { useState, type KeyboardEvent, type ReactNode } from 'react'

// WAI-ARIA tabs pattern: arrow keys move between tabs. Every panel stays
// mounted (just hidden) so the terminal keeps its transcript when you switch.
export default function Tabs({ label, tabs }: { label: string; tabs: { id: string; label: string; panel: ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0]?.id)

  function onKeyDown(e: KeyboardEvent) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    const i = (tabs.findIndex((t) => t.id === active) + step + tabs.length) % tabs.length
    setActive(tabs[i].id)
    document.getElementById(`tab-${tabs[i].id}`)?.focus()
  }

  return (
    <div>
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="mb-3 flex gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            aria-selected={active === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => setActive(t.id)}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted focus-visible:outline-2 focus-visible:outline-accent aria-selected:border-accent aria-selected:text-fg"
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} id={`panel-${t.id}`} role="tabpanel" aria-labelledby={`tab-${t.id}`} hidden={active !== t.id}>
          {t.panel}
        </div>
      ))}
    </div>
  )
}
