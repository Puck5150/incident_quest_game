import type { Breakdown } from '../schema/commands.ts'

// The after-action command breakdown (PLAN_COMMAND_BREAKDOWN.md): every
// command that found key evidence or verifies the fix, plus anything the
// player ran, each explained from the shared command library.
export default function CommandBreakdown({
  breakdown,
  notes,
  ran,
}: {
  breakdown: Breakdown
  notes?: Record<string, string>
  ran: Set<string>
}) {
  const shown = breakdown.commands.filter((c) => c.key || c.verify || ran.has(c.command))
  if (!shown.length) return null
  return (
    <section aria-labelledby="breakdown-h" className="rounded-lg border border-line bg-panel p-4">
      <h2 id="breakdown-h" className="mb-3 font-semibold">
        Command breakdown
      </h2>
      <ul className="space-y-2">
        {shown.map(({ command, entry: id, key, verify }) => {
          const e = breakdown.entries[id]
          const tags = [key && 'found key evidence', verify && 'verifies the fix', ran.has(command) && 'you ran it'].filter(Boolean)
          return (
            <li key={command}>
              <details className="rounded-md border border-line p-3">
                <summary className="cursor-pointer">
                  <code className="font-mono text-sm break-all">$ {command}</code>
                  <span className="mt-1 block text-sm text-muted">
                    {e.summary}
                    {tags.length > 0 && <span className="ml-2 font-mono text-xs text-accent">[{tags.join(' · ')}]</span>}
                  </span>
                </summary>
                <dl className="mt-3 space-y-3 text-sm">
                  <div>
                    <dt className="text-muted">Parts</dt>
                    <dd>
                      <table className="mt-1 w-full text-left">
                        <tbody>
                          {e.parts.map((p) => (
                            <tr key={p.token} className="border-t border-line align-top">
                              <td className="py-1 pr-3 font-mono whitespace-nowrap">{p.token}</td>
                              <td className="py-1">{p.meaning}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Why this one</dt>
                    <dd>
                      {e.why}
                      {notes?.[command] && <span className="mt-1 block">Here: {notes[command]}</span>}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Alternatives</dt>
                    <dd>
                      <ul className="mt-1 space-y-1">
                        {e.alternatives.map((a) => (
                          <li key={a.command}>
                            <code className="font-mono">{a.command}</code>
                            <span className="text-muted"> — {a.note}</span>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Docs</dt>
                    <dd>
                      <a href={e.docs.url} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
                        {e.docs.title}
                      </a>
                    </dd>
                  </div>
                </dl>
              </details>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
