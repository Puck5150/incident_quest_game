// Free, always-available reference: how to approach the problem, how the
// tools work, and (for incidents) the platform ideas in play. Unlike hints it
// never points at this problem's answer, so it costs nothing.
// See PLAN_GUIDANCE.md for the line between guidance and a hint.

type Mode = 'incident' | 'design'
type Concept = { term: string; text: string; url: string }

const COACH: Record<string, string> = {
  investigating: 'Reread the ticket for symptoms, not causes. Collect evidence from more than one place before naming a cause. Rule things out as well as in.',
  acting: 'You named the cause. Fix it with the smallest safe change, and keep anything others depend on intact.',
  design: 'Turn each requirement in the brief into a question your design must answer, then run the tests early.',
}

const METHOD: Record<Mode, [string, string][]> = {
  incident: [
    ['Read the whole error', 'Who refused it, and what reason did they give? Error codes usually name the layer that failed.'],
    ['Compare working with broken', 'What differs between the users, hosts or paths that work and those that don’t?'],
    ['Ask what changed', 'Deploys, config edits, expiry dates, traffic growth: most incidents start with a change.'],
    ['Test the cheap theories first', 'One command that rules a whole layer in or out beats guessing at the top of the stack.'],
    ['Change one thing, then verify', 'Prefer the fix that leaves other people’s work and safety controls in place.'],
  ],
  design: [
    ['Requirements become tests', 'Each line of the brief (traffic, outage, recovery, budget) is something a test will check.'],
    ['Find the single points', 'Which component lives in only one place? What happens to the rest when it goes?'],
    ['Read the facts, not the names', 'Every option lists what it does and costs. Match those to the brief, not to what sounds bigger.'],
    ['Cheapest design that passes', 'Over-building fails the budget just like under-building fails the outage test.'],
  ],
}

const TOOLS: Record<Mode, string[]> = {
  incident: [
    'Terminal: type help for commands to try. Tab completes, ↑/↓ recalls history.',
    'Logs, files, traces, metrics, pipeline: open each item to read it. Everything you open counts as evidence.',
    'Declare a root cause when you can back it up. Wrong guesses cost XP but tell you why they’re wrong.',
    'After declaring, take actions (or type fixes in the terminal), then close the incident.',
    'Bonus XP: Methodical for finding all the key evidence before declaring, Verified for checking your fix before closing.',
  ],
  design: [
    'Select an option or component to read its facts and monthly cost.',
    'Run the stress tests as often as you like; the results show which requirement failed and why.',
    'Submit when every test passes within budget.',
  ],
}

export default function FieldGuide({
  mode,
  phase,
  concepts,
}: {
  mode: Mode
  phase?: string
  concepts?: Concept[]
}) {
  const coach = COACH[phase ?? mode]
  return (
    <section aria-labelledby="guide-h" className="rounded-lg border border-line bg-panel p-4 text-sm">
      <h2 id="guide-h" className="mb-2 font-semibold">
        Field guide <span className="font-normal text-muted">(free)</span>
      </h2>
      {coach && <p>{coach}</p>}

      {concepts && (
        <details className="mt-3">
          <summary className="cursor-pointer text-muted hover:text-fg">Concepts in this scenario</summary>
          <dl className="mt-2 space-y-2">
            {concepts.map((c) => (
              <div key={c.term}>
                <dt className="font-semibold">{c.term}</dt>
                <dd className="text-muted">
                  {c.text}{' '}
                  <a href={c.url} target="_blank" rel="noreferrer" className="text-accent underline">
                    Docs<span className="sr-only"> for {c.term} (opens in a new tab)</span>
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-muted hover:text-fg">How to approach it</summary>
        <dl className="mt-2 space-y-2">
          {METHOD[mode].map(([t, d]) => (
            <div key={t}>
              <dt className="font-semibold">{t}</dt>
              <dd className="text-muted">{d}</dd>
            </div>
          ))}
        </dl>
      </details>

      <details className="mt-3">
        <summary className="cursor-pointer text-muted hover:text-fg">Using this screen</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
          {TOOLS[mode].map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </details>
    </section>
  )
}
