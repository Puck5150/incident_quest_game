// Render a diagnostic the way the Terraform CLI prints an error.
import type { Diagnostic } from './types.ts'

export function wrap(text: string, width: number): string[] {
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

export function formatDiagnostic(d: Diagnostic, source = ''): string {
  const out = ['╷', `│ ${d.severity === 'warning' ? 'Warning' : 'Error'}: ${d.summary}`]
  if (d.file && d.line) {
    out.push('│ ', `│   on ${d.file} line ${d.line}${d.context ? `, in ${d.context}` : ''}:`)
    const src = source.split('\n')[d.line - 1]
    if (src !== undefined) out.push(`│ ${String(d.line).padStart(4)}: ${src.replace(/\r$/, '')}`)
  }
  if (d.detail) out.push('│ ', ...wrap(d.detail, 76).map((l) => `│ ${l}`))
  out.push('╵')
  return out.join('\n')
}
