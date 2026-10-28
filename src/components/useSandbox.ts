import { useRef, useState } from 'react'
import { canSave, exportDesign, recoveredBackupKey, loadSandbox, saveSandbox, type SandboxData, type SavedDesign } from '../game/sandboxStore.ts'

// This visit's designs when storage refused them, so moving between the list
// and a design doesn't lose them (each screen otherwise reloads from storage).
let unsaved: SandboxData | undefined

// The sandbox store in React state. Every change is saved at once; `saved` is
// false when storage refused the write (the designs then last for this visit only).
export function useSandbox() {
  const [data, setData] = useState(() => unsaved ?? loadSandbox())
  const [saved, setSaved] = useState(() => !unsaved && canSave())
  // Why saving may be off, and where unreadable data was copied (both from the latest load).
  const [unreadable] = useState(() => !canSave())
  const [backup] = useState(recoveredBackupKey)
  const latest = useRef(data)
  const update = (f: (d: SandboxData) => SandboxData) => {
    const next = f(latest.current)
    latest.current = next
    setData(next)
    const ok = saveSandbox(next)
    unsaved = ok ? undefined : next
    setSaved(ok)
  }
  return { data, update, saved, unreadable, backup }
}

// Saves a design as a JSON file in the browser (no server involved).
export function download(d: SavedDesign) {
  const url = URL.createObjectURL(new Blob([exportDesign(d)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${d.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'design'}.json`
  a.click()
  URL.revokeObjectURL(url)
}
