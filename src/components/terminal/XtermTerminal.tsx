import { useEffect, useLayoutEffect, useRef } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Scenario } from '../../schema/scenario.ts'
import type { GameEvent } from '../../game/engine.ts'
import { hint, useTerminalSession, type Line } from './session.ts'
import FileEditor from './FileEditor.tsx'
import ConfirmPrompt from './ConfirmPrompt.tsx'

const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`

// The theme's colours, read from the CSS custom properties, so the terminal
// follows dark and light mode.
function theme() {
  const css = getComputedStyle(document.documentElement)
  // xterm.js takes hex or rgb colours; the stylesheet uses oklch, so paint one
  // pixel and read it back as RGB.
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const v = (name: string) => {
    const value = css.getPropertyValue(name).trim()
    if (!value || !ctx) return undefined
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `rgb(${r}, ${g}, ${b})`
  }
  return { background: v('--bg'), foreground: v('--fg'), cursor: v('--accent'), selectionBackground: v('--line'), green: v('--ok'), brightGreen: v('--ok') }
}

// A real terminal emulator (xterm.js) with a small line editor in front of the
// shared session: cursor keys, history, Ctrl-R search, Tab completion, the
// usual Ctrl shortcuts, and paste.
export default function XtermTerminal({
  scenario,
  log,
  onRun,
  onShellRan,
  onTakeAction,
  onEdited,
  onAnswered,
}: {
  scenario: Scenario
  log: GameEvent[]
  onRun: (input: string) => void
  onShellRan?: (commands: string[]) => void
  onTakeAction?: (id: string) => void
  onEdited?: (path: string, content: string) => void
  onAnswered?: (value: string) => void
}) {
  const session = useTerminalSession(scenario, log, onRun, onShellRan, onTakeAction, onEdited, onAnswered)
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Xterm>(undefined)
  // The session changes every render; the terminal's handlers read the latest.
  const s = useRef(session)
  useLayoutEffect(() => {
    s.current = session
  })

  const ed = useRef({ buf: '', pos: 0, busy: false, hist: -1, search: undefined as undefined | { q: string; from: number } })

  useEffect(() => {
    const t = new Xterm({ convertEol: true, cursorBlink: true, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, theme: theme(), scrollback: 5000 })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(host.current!)
    fit.fit()
    term.current = t
    const resize = new ResizeObserver(() => fit.fit())
    resize.observe(host.current!)

    const e = ed.current
    const plen = () => s.current.prompt.length + 1
    // Redraw the input line, wrapped across rows, and put the cursor at `pos`.
    let shownRow = 0 // the row offset (from the prompt's row) where the cursor is now
    const draw = () => {
      const cols = t.cols
      let out = shownRow > 0 ? `\x1b[${shownRow}A` : ''
      out += '\r\x1b[J'
      if (e.search) {
        const hit = findBack(e.search.q, e.search.from)
        out += `(reverse-i-search)\`${e.search.q}': ${hit?.text ?? ''}`
        t.write(out)
        shownRow = Math.floor((`(reverse-i-search)\`${e.search.q}': ${hit?.text ?? ''}`.length) / cols)
        return
      }
      out += GREEN(s.current.prompt) + ' ' + e.buf
      const end = plen() + e.buf.length
      const at = plen() + e.pos
      const endRow = Math.floor(end / cols)
      const atRow = Math.floor(at / cols)
      if (endRow > atRow) out += `\x1b[${endRow - atRow}A`
      out += '\r' + (at % cols ? `\x1b[${at % cols}C` : '')
      t.write(out)
      shownRow = atRow
    }
    const newline = () => {
      t.write('\r\n')
      shownRow = 0
    }
    const print = (text: string) => {
      if (text) t.write(text.endsWith('\n') ? text : text + '\n')
    }
    const showPrompt = () => {
      shownRow = 0
      draw()
    }
    const findBack = (q: string, from: number) => {
      const h = s.current.history
      for (let i = Math.min(from, h.length - 1); i >= 0; i--) if (h[i].includes(q)) return { text: h[i], index: i }
      return undefined
    }

    const submit = () => {
      const cmd = e.buf
      e.pos = e.buf.length
      draw()
      newline()
      e.buf = ''
      e.pos = 0
      e.hist = -1
      const r = s.current.run(cmd)
      if (r.clear) {
        t.clear()
        t.write('\x1b[2J\x1b[H')
        return showPrompt()
      }
      if (!r.line.pending) {
        print(r.line.output)
        return showPrompt()
      }
      e.busy = true
      r.done.then((done) => {
        print(done.output)
        e.busy = false
        showPrompt()
      })
    }

    const insert = (text: string) => {
      e.buf = e.buf.slice(0, e.pos) + text + e.buf.slice(e.pos)
      e.pos += text.length
      draw()
    }

    const onData = (data: string) => {
      if (e.busy) return
      if (e.search) {
        const hit = findBack(e.search.q, e.search.from)
        if (data === '\x12') {
          // Ctrl-R again: the next older match
          if (hit) e.search.from = hit.index - 1
          return draw()
        }
        if (data === '\x7f') {
          e.search.q = e.search.q.slice(0, -1)
          return draw()
        }
        if (data === '\x03' || data === '\x07') {
          e.search = undefined
          return draw()
        }
        if (data.length === 1 && data >= ' ') {
          e.search.q += data
          e.search.from = s.current.history.length - 1
          return draw()
        }
        // Anything else accepts the match into the line, then acts as usual.
        e.search = undefined
        e.buf = hit?.text ?? e.buf
        e.pos = e.buf.length
        draw()
        if (data === '\r') return submit()
        if (data === '\x1b') return
      }
      switch (data) {
        case '\r':
          return submit()
        case '\x7f': // Backspace
          if (e.pos > 0) {
            e.buf = e.buf.slice(0, e.pos - 1) + e.buf.slice(e.pos)
            e.pos--
          }
          return draw()
        case '\x1b[3~': // Delete
          e.buf = e.buf.slice(0, e.pos) + e.buf.slice(e.pos + 1)
          return draw()
        case '\x1b[D':
          e.pos = Math.max(0, e.pos - 1)
          return draw()
        case '\x1b[C':
          e.pos = Math.min(e.buf.length, e.pos + 1)
          return draw()
        case '\x1b[H':
        case '\x01': // Ctrl-A
          e.pos = 0
          return draw()
        case '\x1b[F':
        case '\x05': // Ctrl-E
          e.pos = e.buf.length
          return draw()
        case '\x1b[A': {
          const h = s.current.history
          if (!h.length) return
          e.hist = e.hist === -1 ? h.length - 1 : Math.max(0, e.hist - 1)
          e.buf = h[e.hist]
          e.pos = e.buf.length
          return draw()
        }
        case '\x1b[B': {
          const h = s.current.history
          if (e.hist === -1) return
          e.hist = e.hist + 1 < h.length ? e.hist + 1 : -1
          e.buf = e.hist === -1 ? '' : h[e.hist]
          e.pos = e.buf.length
          return draw()
        }
        case '\x03': // Ctrl-C
          e.pos = e.buf.length
          draw()
          t.write('^C')
          newline()
          e.buf = ''
          e.pos = 0
          e.hist = -1
          return showPrompt()
        case '\x0c': // Ctrl-L
          t.write('\x1b[2J\x1b[H')
          return showPrompt()
        case '\x15': // Ctrl-U
          e.buf = e.buf.slice(e.pos)
          e.pos = 0
          return draw()
        case '\x0b': // Ctrl-K
          e.buf = e.buf.slice(0, e.pos)
          return draw()
        case '\x17': {
          // Ctrl-W: delete the word before the cursor
          const head = e.buf.slice(0, e.pos).replace(/\S+\s*$/, '')
          e.buf = head + e.buf.slice(e.pos)
          e.pos = head.length
          return draw()
        }
        case '\x12': // Ctrl-R
          e.search = { q: '', from: s.current.history.length - 1 }
          return draw()
        case '\t': {
          if (!e.buf.trim() || e.pos !== e.buf.length) return
          const show = (c: { input: string; options?: string[] }) => {
            if (c.options) {
              newline()
              print(DIM(c.options.join('  ')))
            }
            e.buf = c.input
            e.pos = e.buf.length
            draw()
          }
          const c = s.current.completeLine(e.buf)
          // Nothing from the scripted commands: try the real filesystem.
          if (c.input === e.buf && !c.options) {
            const typed = e.buf
            s.current.completePath(typed).then((p) => e.buf === typed && show(p))
            return
          }
          return show(c)
        }
      }
      if (data.startsWith('\x1b')) return // other escape sequences: ignore
      // Typed or pasted text: each line of a paste runs, like a real shell.
      const parts = data.replace(/\r\n?/g, '\n').split('\n')
      parts.forEach((part, i) => {
        const text = [...part].filter((ch) => ch >= ' ').join('') // drop control characters
        if (text) insert(text)
        if (i < parts.length - 1) submit()
      })
    }

    // Welcome text, the session so far, then the prompt.
    t.write(DIM(hint(scenario)) + '\r\n')
    const replay = (lines: Line[]) =>
      lines.forEach((l) => {
        t.write(GREEN(l.prompt) + ' ' + l.input + '\r\n')
        print(l.output)
      })
    replay(s.current.initial)
    showPrompt()
    const sub = t.onData(onData)
    t.focus()
    return () => {
      sub.dispose()
      resize.disconnect()
      t.dispose()
    }
    // the terminal is created once; handlers read the latest session through refs
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Back to the prompt when the editor or a confirm prompt closes.
  useEffect(() => {
    if (!session.editing && !session.prompting) term.current?.focus()
  }, [session.editing, session.prompting])

  // When the shell has replayed the session, redraw the transcript with its output.
  useEffect(() => {
    const t = term.current
    if (!t || !session.replayed) return
    t.write('\x1b[2J\x1b[3J\x1b[H')
    t.write(DIM(hint(scenario)) + '\r\n')
    for (const l of session.replayed) {
      t.write(GREEN(l.prompt) + ' ' + l.input + '\r\n')
      if (l.output) t.write(l.output.endsWith('\n') ? l.output : l.output + '\n')
    }
    t.write(GREEN(session.prompt) + ' ' + ed.current.buf)
  }, [session.replayed]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative h-[28rem] rounded-lg border border-line bg-bg p-2">
      {session.editing && <FileEditor key={session.editing.path} editing={session.editing} />}
      {session.prompting && <ConfirmPrompt prompting={session.prompting} />}
      <div ref={host} className="h-full w-full" role="application" aria-label="Terminal (switch to the simple terminal in the header for screen readers)" />
    </div>
  )
}
