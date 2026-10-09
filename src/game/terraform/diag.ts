// Render a diagnostic the way the Terraform CLI prints an error.
import type { Diagnostic } from './types.ts'

// With preserveLines, text is kept as written line by line: blank lines are
// paragraph breaks and lines indented two spaces (lists) are not re-wrapped.
export function wrap(text: string, width: number, preserveLines = false): string[] {
  if (preserveLines) return text.split('\n').flatMap((l) => (l.startsWith('  ') || !l.trim() ? [l.trim() ? l : ''] : wrap(l, width)))
  const lines: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > width) {
      lines.push(cur)
      cur = word
    } else cur = cur ? `${cur} ${word}` : word
  }
  if (cur) lines.push(cur)
  return lines
}

export function formatDiagnostic(d: Diagnostic, source = '', opts: { preserveLines?: boolean } = {}): string {
  // The CLI always prints a blank line after the summary, even with nothing under it (a bare "Cycle: ..." error).
  const out = ['╷', `│ ${d.severity === 'warning' ? 'Warning' : 'Error'}: ${d.summary}`, '│ ']
  if (d.address) out.push(`│   with ${d.address},`)
  if (d.file && d.line) {
    out.push(`│   on ${d.file} line ${d.line}${d.context ? `, in ${d.context}` : ''}:`)
    const src = source.split('\n')[d.line - 1]
    if (src !== undefined) out.push(`│ ${String(d.line).padStart(4)}: ${src.replace(/\r$/, '')}`)
  }
  if (d.detail) out.push(...(out.length > 3 ? ['│ '] : []), ...wrap(d.detail, 76, opts.preserveLines).map((l) => `│ ${l}`))
  out.push('╵')
  return out.join('\n')
}
