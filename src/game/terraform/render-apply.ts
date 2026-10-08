// Rendering an apply: the streaming progress lines, the completion summary and the boxed errors.
import type { ApplyResult, ApplyStep } from './apply.ts'
import { formatDiagnostic } from './diag.ts'
import { formatDuration } from './provider.ts'
import { outputsText } from './views.ts'

const WORD = { create: 'creating', update: 'modifying', delete: 'destroying' } as const

function stepLines(s: ApplyStep): string[] {
  const a = s.address
  const id = s.id === undefined ? '' : ` [id=${s.id}]`
  if (s.op === 'forget') return []
  if (s.op === 'import') return [`${a}: Importing...${id}`, ...(s.ok ? [`${a}: Import complete${id}`] : [])]
  const start = { create: 'Creating...', update: `Modifying...${id}`, delete: `Destroying...${id}` }[s.op]
  const lines = [`${a}: ${start}`]
  if (!s.ok) return lines
  const still = s.op === 'create' ? '' : `${id.trim().slice(1, -1)}, `
  for (let t = 10; t < s.seconds; t += 10) lines.push(`${a}: Still ${WORD[s.op]}... [${still}${formatDuration(t)} elapsed]`)
  const done = {
    create: `Creation complete after ${formatDuration(s.seconds)}${id}`,
    update: `Modifications complete after ${formatDuration(s.seconds)}${id}`,
    delete: `Destruction complete after ${formatDuration(s.seconds)}`,
  }[s.op]
  lines.push(`${a}: ${done}`)
  return lines
}

export const renderProgress = (r: ApplyResult): string => r.steps.flatMap(stepLines).join('\n')

export function renderApplyEnd(r: ApplyResult, mode: 'apply' | 'destroy'): string {
  if (r.errors.length) return ''
  const { imported, added, changed, destroyed } = r.counts
  if (mode === 'destroy') return `\nDestroy complete! Resources: ${destroyed} destroyed.`
  const head = `\nApply complete! Resources: ${imported ? `${imported} imported, ` : ''}${added} added, ${changed} changed, ${destroyed} destroyed.`
  return Object.keys(r.state.outputs).length ? `${head}\n\nOutputs:\n\n${outputsText(r.state.outputs, undefined, 'hcl').stdout}` : head
}

export const renderApplyErrors = (r: ApplyResult, sources: Record<string, string>): string =>
  r.errors.map((d) => formatDiagnostic(d, sources[d.file] ?? '')).join('\n')
