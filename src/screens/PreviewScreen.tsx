import { useId, useState } from 'react'
import { itemMeta, parseItem, type Item } from '../content/item.ts'
import type { Track } from '../schema/scenario.ts'

const button =
  'rounded-md px-4 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'

// Play a content file without adding it to the repo: paste it or pick it,
// and it's checked by the same per-file validation as the build. Nothing
// played here is saved to progress. Loaded on demand, since it brings the
// YAML parser and full schemas the rest of the game doesn't need.
export default function PreviewScreen({
  text,
  tracks,
  onText,
  onPlay,
}: {
  text: string
  tracks: Track[]
  onText: (text: string) => void
  onPlay: (item: Item) => void
}) {
  const uid = useId()
  const [errors, setErrors] = useState<string[]>([])

  function check() {
    const { item, errors } = parseItem(text, 'Your file')
    // The one cross-file check that matters for playing: the track must exist.
    // (id-matches-filename and unique ids only apply once it's in content/.)
    if (item && !tracks.some((t) => t.id === itemMeta(item).track))
      errors.push(`Your file: track "${itemMeta(item).track}" is not defined in tracks.yaml`)
    setErrors(errors)
    if (item && !errors.length) onPlay(item)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
          Preview a content file
        </h1>
        <p className="mt-2 text-muted">
          Paste an incident or design challenge YAML file, or pick one, to check it and play it. It's validated
          exactly like <code>npm test</code> checks a single file. Nothing you play here is saved to your progress.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor={`${uid}-file`} className="block text-sm text-muted">
          Choose a .yaml file
        </label>
        <input
          id={`${uid}-file`}
          type="file"
          accept=".yaml,.yml,text/yaml"
          onChange={async (e) => {
            const file = e.target.files?.[0]
            if (file) onText(await file.text())
          }}
          className="block text-sm"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor={`${uid}-yaml`} className="block text-sm text-muted">
          or paste it here
        </label>
        <textarea
          id={`${uid}-yaml`}
          value={text}
          onChange={(e) => onText(e.target.value)}
          rows={16}
          spellCheck={false}
          className="w-full rounded-lg border border-line bg-bg p-3 font-mono text-sm focus-visible:outline-2 focus-visible:outline-accent"
        />
      </div>

      <button className={`${button} bg-accent text-bg`} disabled={!text.trim()} onClick={check}>
        Check and play
      </button>

      {errors.length > 0 && (
        <section role="alert" aria-labelledby={`${uid}-errors`} className="rounded-lg border border-crit bg-panel p-4">
          <h2 id={`${uid}-errors`} className="font-semibold text-crit">
            {errors.length === 1 ? '1 problem' : `${errors.length} problems`} to fix
          </h2>
          <ul className="mt-2 space-y-3">
            {errors.map((e, i) => (
              <li key={i}>
                <pre className="whitespace-pre-wrap font-mono text-sm">{e}</pre>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
