// `terraform plan` output. resourceBlock renders one plan item; renderPlan
// renders the whole plan.
import { formatDiagnostic } from './diag.ts'
import { equal, type Value } from './eval.ts'
import type { PlanItem, PlanResult } from './plan.ts'
import { diffLines, lines, row, scalar } from './render-value.ts'
import { findInstance } from './state.ts'

const SENSITIVE = '(sensitive value)'
const plural = (n: number) => `${n} unchanged attribute${n === 1 ? '' : 's'} hidden`

function headerLines(item: PlanItem): string[] {
  const a = item.address
  const out: string[] = []
  switch (item.action) {
    case 'create':
      out.push(`${a} will be created`)
      break
    case 'update':
      out.push(`${a} will be updated in-place`)
      break
    case 'replace':
      out.push(
        item.reason === 'tainted'
          ? `${a} is tainted, so must be replaced`
          : item.reason === 'requested'
            ? `${a} will be replaced, as requested`
            : item.reason === 'triggered'
              ? `${a} will be replaced due to changes in replace_triggered_by`
              : `${a} must be replaced`,
      )
      break
    case 'destroy':
      out.push(`${a} will be destroyed`)
      out.push(
        `(because ${
          item.destroyReason === 'count-index' ? `index [${item.key}] is out of range for count` : item.destroyReason === 'for-each-key' ? `key [${JSON.stringify(item.key)}] is not in for_each map` : `${item.type}.${item.name} is not in configuration`
        })`,
      )
      break
    case 'forget':
      out.push(`${a} will no longer be managed by Terraform, but will not be destroyed`, '(destroy = false is set in the configuration)')
      break
    default:
      out.push(item.movedFrom ? `${item.movedFrom} has moved to ${a}` : item.importing ? `${a} will be imported` : a)
  }
  if (item.movedFrom && item.action !== 'noop') out.push(`(moved from ${item.movedFrom})`)
  if (item.importing && item.action !== 'noop') out.push(`(imported from "${item.importing}")`)
  return out.map((l) => `  # ${l}`)
}

// A sensitive change prints the same placeholder on both sides.
function sensitiveRow(sym: string, name: string, width: number, suffix = ''): string {
  return row(6, sym, `${name.padEnd(width)} = ${SENSITIVE}${suffix}`)
}

function bodyLines(item: PlanItem): string[] {
  const changes = item.changes
  if (item.action === 'create') {
    const w = Math.max(0, ...changes.map((c) => c.name.length))
    return changes.flatMap((c) => (c.sensitive ? [sensitiveRow('+', c.name, w)] : lines(6, '+', c.name, w, c.after)))
  }
  if (item.action === 'destroy') {
    const shown = changes.filter((c) => c.before !== null && c.before !== undefined)
    const w = Math.max(0, ...shown.map((c) => c.name.length))
    return shown.flatMap((c) => {
      if (c.sensitive) return [sensitiveRow('-', c.name, w, ' -> null')]
      const l = lines(6, '-', c.name, w, c.before as never)
      l[l.length - 1] += ' -> null'
      return l
    })
  }
  if (item.action === 'forget') return []
  const unchanged = item.unchanged ?? {}
  const changed = new Set(changes.map((c) => c.name))
  const showId = Object.hasOwn(unchanged, 'id') && !changed.has('id')
  const names = [...changes.map((c) => c.name), ...(showId ? ['id'] : [])]
  const w = Math.max(0, ...names.map((n) => n.length))
  const rows = [
    ...changes.map((c) => ({ name: c.name, out: c.sensitive ? [sensitiveRow('~', c.name, w)] : diffLines(6, c.name, w, c.before, c.after, c.forcesReplacement) })),
    ...(showId ? [{ name: 'id', out: [row(6, ' ', `${'id'.padEnd(w)} = ${scalar(unchanged.id)}`)] }] : []),
  ].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
  const hidden = Object.keys(unchanged).filter((n) => !changed.has(n) && !(showId && n === 'id')).length
  return [...rows.flatMap((r) => r.out), ...(hidden ? [row(6, ' ', `# (${plural(hidden)})`)] : [])]
}

export function resourceBlock(item: PlanItem): string {
  const open = `resource "${item.type}" "${item.name}" {`
  const header = headerLines(item)
  if (item.action === 'forget') return [...header, row(2, ' ', `resource "${item.type}" "${item.name}" {}`)].join('\n')
  const resourceRow =
    item.action === 'replace' ? (item.createBeforeDestroy ? row(0, '+/-', open) : row(0, '-/+', open)) : row(2, item.action === 'create' ? '+' : item.action === 'update' ? '~' : item.action === 'destroy' ? '-' : ' ', open)
  return [...header, resourceRow, ...bodyLines(item), row(2, ' ', '}')].join('\n')
}

const RULE = '─'.repeat(77)
const symbolOf = (a: string) => (a === 'create' ? '+' : a === 'update' ? '~' : a === 'destroy' ? '-' : '')

function driftBlock(r: PlanResult, d: PlanResult['drift'][number]): string {
  const [type, name] = d.address.replace(/\[.*$/, '').split('.')
  const open = `resource "${type}" "${name}" {`
  if (d.kind === 'deleted') {
    const shown = Object.entries(d.before ?? {}).filter(([, v]) => v !== null)
    const w = Math.max(0, ...shown.map(([n]) => n.length))
    const body = shown.sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([n, v]) => {
      const l = lines(6, '-', n, w, v)
      l[l.length - 1] += ' -> null'
      return l
    })
    return [`  # ${d.address} has been deleted`, row(2, '-', open), ...body, row(2, ' ', '}')].join('\n')
  }
  const attrs = findInstance(r.refreshed, d.address)?.instance.attributes ?? {}
  const changed = new Set(d.changes.map((c) => c.name))
  const showId = Object.hasOwn(attrs, 'id') && !changed.has('id')
  const names = [...d.changes.map((c) => c.name), ...(showId ? ['id'] : [])]
  const w = Math.max(0, ...names.map((n) => n.length))
  const rows = [
    ...d.changes.map((c) => ({ name: c.name, out: diffLines(6, c.name, w, c.before, c.after) })),
    ...(showId ? [{ name: 'id', out: [row(6, ' ', `${'id'.padEnd(w)} = ${scalar(attrs.id)}`)] }] : []),
  ].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
  const hidden = Object.entries(attrs).filter(([n, v]) => v !== null && !changed.has(n) && !(showId && n === 'id')).length
  return [`  # ${d.address} has changed`, row(2, '~', open), ...rows.flatMap((x) => x.out), ...(hidden ? [row(6, ' ', `# (${plural(hidden)})`)] : []), row(2, ' ', '}')].join('\n')
}

function outputChanges(r: PlanResult): string[] {
  const before = r.refreshed.outputs
  const rows: { name: string; sym: string; text: (w: number) => string[] }[] = []
  for (const o of r.outputs) {
    const had = Object.hasOwn(before, o.name)
    const old = had ? before[o.name].value : undefined
    if (had && equal(old as Value, o.value)) continue
    rows.push({
      name: o.name,
      sym: had ? '~' : '+',
      text: (w) => (o.sensitive ? [row(2, had ? '~' : '+', `${o.name.padEnd(w)} = ${SENSITIVE}`)] : had ? diffLines(2, o.name, w, old, o.value) : lines(2, '+', o.name, w, o.value)),
    })
  }
  for (const name of Object.keys(before)) {
    if (!r.outputs.some((o) => o.name === name)) {
      rows.push({ name, sym: '-', text: (w) => { const l = lines(2, '-', name, w, before[name].value); l[l.length - 1] += ' -> null'; return l } })
    }
  }
  const w = Math.max(0, ...rows.map((x) => x.name.length))
  return rows.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)).flatMap((x) => x.text(w))
}

export function renderPlan(r: PlanResult, sources: Record<string, string> = {}): string {
  const boxed = (list: PlanResult['diagnostics']) => list.map((d) => formatDiagnostic(d, sources[d.file] ?? ''))
  if (r.diagnostics.length) return [...boxed(r.warnings), ...boxed(r.diagnostics)].join('\n\n')

  const out: string[] = []
  const hasDrift = r.drift.length > 0
  if (hasDrift) {
    out.push(
      [
        'Note: Objects have changed outside of Terraform',
        '',
        'Terraform detected the following changes made outside of Terraform since the',
        'last "terraform apply" which may have affected this plan:',
        '',
        r.drift.map((d) => driftBlock(r, d)).join('\n\n'),
        '',
        'Unless you have made equivalent changes to your configuration, or ignored the',
        'relevant attributes using ignore_changes, the following plan may include',
        'actions to undo or respond to these changes.',
        '',
        RULE,
        '',
      ].join('\n'),
    )
  }

  const visible = r.items.filter((i) => i.action !== 'noop' || i.movedFrom || i.importing)
  const outputs = outputChanges(r)
  if (!visible.length && !outputs.length) {
    out.push(
      hasDrift
        ? 'No changes. Your infrastructure still matches the configuration.\n\nTerraform has checked that the real remote objects still match the result of your most recent changes, and found no differences.'
        : 'No changes. Your infrastructure matches the configuration.\n\nTerraform has compared your real infrastructure against your configuration\nand found no differences, so no changes are needed.',
    )
  } else {
    const legend: string[] = []
    const used = new Set(visible.map((i) => (i.action === 'replace' ? (i.createBeforeDestroy ? '+/-' : '-/+') : symbolOf(i.action))))
    if (used.has('+')) legend.push('  + create')
    if (used.has('~')) legend.push('  ~ update in-place')
    if (used.has('-')) legend.push('  - destroy')
    if (used.has('-/+')) legend.push('-/+ destroy and then create replacement')
    if (used.has('+/-')) legend.push('+/- create replacement and then destroy')
    const head = legend.length ? ['Terraform used the selected providers to generate the following execution', 'plan. Resource actions are indicated with the following symbols:', ...legend, ''] : []
    const parts = [...head, 'Terraform will perform the following actions:', '', visible.map(resourceBlock).join('\n\n')]
    if (visible.length) {
      const s = r.summary
      parts.push('', `Plan: ${r.imported > 0 ? `${r.imported} to import, ` : ''}${s.add} to add, ${s.change} to change, ${s.destroy} to destroy.`)
    }
    if (outputs.length) parts.push('', 'Changes to Outputs:', ...outputs)
    out.push(parts.join('\n'))
  }
  if (r.warnings.length) out.push(boxed(r.warnings).join('\n\n'))
  return out.join(hasDrift ? '\n' : '\n\n').replace(/\n\n\n+/g, '\n\n')
}
