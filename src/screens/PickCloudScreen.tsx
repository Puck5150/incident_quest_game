import { useId, useState } from 'react'
import type { CanvasChallenge } from '../schema/canvas.ts'
import { PROVIDER_NAMES, type Provider } from '../schema/multi.ts'
import Icon from '../components/Icon.tsx'

// Choose the cloud for a "pick your cloud" challenge. Same brief and stress
// tests on every provider; only the services (and their facts) change.
export default function PickCloudScreen({
  title,
  variants,
  completedOn,
  onPick,
}: {
  title: string
  variants: Partial<Record<Provider, CanvasChallenge>>
  completedOn: string[]
  onPick: (p: Provider) => void
}) {
  const uid = useId()
  const providers = Object.keys(variants) as Provider[]
  const [choice, setChoice] = useState<Provider>(providers.find((p) => !completedOn.includes(p)) ?? providers[0])

  return (
    <form
      className="mx-auto max-w-3xl space-y-6"
      onSubmit={(e) => {
        e.preventDefault()
        onPick(choice)
      }}
    >
      <div>
        <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
          {title}
        </h1>
        <p className="mt-2 text-muted">
          Pick a cloud. The brief and stress tests are the same on each; the services, their names and their facts
          change. Finishing it again on another cloud shows the equivalents side by side.
        </p>
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="sr-only">Cloud provider</legend>
        {providers.map((p) => {
          const v = variants[p]!
          const done = completedOn.includes(p)
          return (
            <label
              key={p}
              className="flex cursor-pointer flex-col gap-2 rounded-lg border border-line bg-panel p-4 hover:border-accent/60 has-checked:border-accent has-checked:bg-accent/5 has-focus-visible:outline-2 has-focus-visible:outline-accent"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-semibold">
                  <input
                    type="radio"
                    name={`${uid}-cloud`}
                    checked={choice === p}
                    onChange={() => setChoice(p)}
                    className="accent-accent focus:outline-none"
                  />
                  {PROVIDER_NAMES[p]}
                </span>
                {done && (
                  <span className="inline-flex items-center gap-1 text-xs text-ok">
                    <Icon name="check" className="h-3 w-3" /> done
                  </span>
                )}
              </span>
              <span className="text-xs text-muted">You'll build with:</span>
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {v.palette.map((x) => (
                  <li key={x.id}>{x.label}</li>
                ))}
              </ul>
            </label>
          )
        })}
      </fieldset>

      <button
        type="submit"
        className="rounded-md bg-accent px-4 py-2 font-medium text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Start on {PROVIDER_NAMES[choice]}
      </button>
    </form>
  )
}
