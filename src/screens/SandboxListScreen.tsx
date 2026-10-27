import { useEffect, useRef, useState } from 'react'
import { loadSandbox as loadCloud } from 'virtual:content'
import { PROVIDERS, PROVIDER_NAMES, type Provider } from '../schema/constants.ts'
import type { Design } from '../schema/canvas.ts'
import { validateDesign } from '../game/sandbox.ts'
import { createDesign, deleteDesign, newId, readExport, renameDesign } from '../game/sandboxStore.ts'
import { download, useSandbox } from '../components/useSandbox.ts'

const button =
  'rounded-md border border-line px-2.5 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-accent'

export default function SandboxListScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, update, saved, unreadable, backup } = useSandbox()
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<Provider>('aws')
  const [renaming, setRenaming] = useState<{ id: string; name: string }>()
  const [deleting, setDeleting] = useState<string>()
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('') // announced: what an import did
  const listTitle = useRef<HTMLHeadingElement>(null)
  // After closing a rename or delete confirm, focus goes back to the button that opened it.
  const refocus = useRef('')
  useEffect(() => {
    if (!refocus.current) return
    document.getElementById(refocus.current)?.focus()
    refocus.current = ''
  })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => void (mounted.current = false)
  }, [])
  const closeRename = (id: string) => {
    refocus.current = `rename-${id}`
    setRenaming(undefined)
  }
  const keep = (id: string) => {
    refocus.current = `delete-${id}`
    setDeleting(undefined)
  }

  // createDesign swaps in a fresh id if ours is taken, so read it back (the new design is last).
  function add(a: { name: string; provider: Provider; design?: Design }) {
    let id = ''
    update((d) => {
      const next = createDesign(d, { id: newId(), ...a })
      const made = next.designs.at(-1)!
      id = made.id
      return a.design ? { ...next, designs: [...next.designs.slice(0, -1), { ...made, design: a.design }] } : next
    })
    return id
  }

  async function importFile(file: File) {
    setProblem('')
    setNotice('')
    if (file.size > 1_000_000) return setProblem('That file is too big to be a design (over 1 MB).')
    let text: string
    try {
      text = await file.text()
    } catch {
      return setProblem("Couldn't read that file.")
    }
    const r = readExport(text)
    if ('error' in r) return setProblem(r.error)
    const cloud = await loadCloud(r.provider).catch(() => undefined)
    // Left the screen meanwhile: another screen may have saved since, so don't write.
    if (!mounted.current) return
    if (!cloud) return setProblem(`The ${PROVIDER_NAMES[r.provider]} sandbox couldn't be loaded, so this file can't be checked. Try again later.`)
    const bad = validateDesign(cloud, r.design)
    if (bad) return setProblem(bad)
    add(r) // update() merges onto the latest state, so edits made while loading are kept
    setNotice(`Imported ${r.name}.`)
  }

  return (
    <div className="space-y-6">
      <h1 id="screen-title" tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
        Design sandbox
      </h1>
      <p className="max-w-prose text-muted">
        Build an architecture from one cloud's real services with no brief and no score, then run failure checks to see what survives. Designs are
        saved in this browser.
      </p>
      <p role="status" aria-live="polite">
        {backup && (
          <span className="block rounded-md border border-warn px-3 py-2 text-sm">
            Your saved designs couldn't be read, so a copy was kept in this browser ({backup}) and the sandbox started empty.
          </span>
        )}
        {!saved && (
          <span className="block rounded-md border border-warn px-3 py-2 text-sm">
            {unreadable
              ? "Your saved designs couldn't be read and a backup copy couldn't be written, so nothing will be saved until that's fixed. Export what you build."
              : 'This browser is blocking storage, so designs last only until you reload or close this tab. Export a design to keep it.'}
          </span>
        )}
        {notice && <span className="block text-sm text-muted">{notice}</span>}
      </p>

      <form
        className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-panel p-4"
        onSubmit={(e) => {
          e.preventDefault()
          onOpen(add({ name, provider }))
        }}
      >
        <label className="text-sm">
          <span className="block text-muted">Design name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="rounded-md border border-line bg-bg px-2 py-1" />
        </label>
        <label className="text-sm">
          <span className="block text-muted">Cloud</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)} className="rounded-md border border-line bg-bg px-2 py-1">
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_NAMES[p]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-1.5 font-medium text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Create design
        </button>
      </form>

      <section aria-labelledby="designs-h" className="space-y-3">
        <h2 id="designs-h" ref={listTitle} tabIndex={-1} className="font-semibold focus:outline-none">
          Your designs
        </h2>
        {data.designs.length === 0 && <p className="text-sm text-muted">No designs yet. Create one above, or import a file.</p>}
        <ul className="space-y-2">
          {data.designs.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel p-3"
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                if (renaming?.id === d.id) closeRename(d.id)
                else if (deleting === d.id) keep(d.id)
              }}
            >
              {renaming?.id === d.id ? (
                <form
                  className="flex flex-wrap items-center gap-3"
                  onSubmit={(e) => {
                    e.preventDefault()
                    update((s) => renameDesign(s, d.id, renaming.name))
                    closeRename(d.id)
                  }}
                >
                  <input
                    aria-label="New name"
                    autoFocus
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: d.id, name: e.target.value })}
                    maxLength={60}
                    className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
                  />
                  <button type="submit" className={button}>
                    Save name
                  </button>
                  <button type="button" className={button} onClick={() => closeRename(d.id)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <button className="text-left font-medium underline-offset-2 hover:underline" onClick={() => onOpen(d.id)}>
                    {d.name}
                    <span className="ml-2 font-mono text-xs font-normal text-muted uppercase">{PROVIDER_NAMES[d.provider]}</span>
                    <span className="ml-2 text-xs font-normal text-muted">{d.design.nodes.length} components</span>
                  </button>
                  <span className="flex-1" />
                  <button id={`rename-${d.id}`} className={button} aria-label={`Rename ${d.name}`} onClick={() => setRenaming({ id: d.id, name: d.name })}>
                    Rename
                  </button>
                  <button className={button} aria-label={`Export ${d.name}`} onClick={() => download(d)}>
                    Export
                  </button>
                  {deleting === d.id ? (
                    <>
                      <button
                        className={`${button} border-crit text-crit`}
                        aria-label={`Yes, delete ${d.name}`}
                        onClick={() => {
                          update((s) => deleteDesign(s, d.id))
                          setDeleting(undefined)
                          listTitle.current?.focus()
                        }}
                      >
                        Yes, delete
                      </button>
                      <button className={button} autoFocus onClick={() => keep(d.id)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button id={`delete-${d.id}`} className={button} aria-label={`Delete ${d.name}`} onClick={() => setDeleting(d.id)}>
                      Delete
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="import-h" className="space-y-2">
        <h2 id="import-h" className="font-semibold">
          Import
        </h2>
        <label className="block text-sm">
          <span className="block text-muted">Import a design</span>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importFile(f)
              e.target.value = ''
            }}
          />
        </label>
        {problem && (
          <p role="alert" className="text-sm text-crit">
            {problem}
          </p>
        )}
      </section>
    </div>
  )
}
