// `terraform plan` output. resourceBlock renders one plan item; renderPlan
// renders the whole plan.
import { formatDiagnostic } from './diag.ts'
import { equal, type Value } from './eval.ts'
import type { PlanItem, PlanResult } from './plan.ts'
import { body, diffLines, lines, masked, row, type Field } from './render-value.ts'
import { schemaFor } from './resources.ts'
import { findInstance } from './state.ts'

const hasVal = (v: Value | undefined) => v !== null && v !== undefined

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

function bodyLines(item: PlanItem): string[] {
  const changes = item.changes
  if (item.action === 'forget') return []
  if (item.action === 'create') return body(6, changes.map((c) => ({ name: c.name, op: '+', after: c.after, sensitive: c.sensitive })))
  if (item.action === 'destroy') return body(6, changes.filter((c) => hasVal(c.before)).map((c) => ({ name: c.name, op: '-', before: c.before, sensitive: c.sensitive })))
  const changed = new Set(changes.map((c) => c.name))
  const fields: Field[] = [
    ...changes.map((c): Field => ({ name: c.name, op: '~', before: c.before, after: c.after, sensitive: c.sensitive, forces: c.forcesReplacement })),
    ...Object.entries(item.unchanged ?? {})
      .filter(([n, v]) => !changed.has(n) && hasVal(v))
      .map(([n, v]): Field => ({ name: n, op: ' ', before: v, after: v })),
  ]
  return body(6, fields)
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
  const attrSpecs = schemaFor(type)?.attrs ?? {}
  const secret = (n: string) => Object.hasOwn(attrSpecs, n) && attrSpecs[n].sensitive === true
  if (d.kind === 'deleted') {
    const fields = Object.entries(d.before ?? {})
      .filter(([, v]) => v !== null)
      .map(([n, v]): Field => ({ name: n, op: '-', before: v, sensitive: secret(n) }))
    return [`  # ${d.address} has been deleted`, row(2, '-', open), ...body(6, fields), row(2, ' ', '}')].join('\n')
  }
  const attrs = findInstance(r.refreshed, d.address)?.instance.attributes ?? {}
  const changed = new Set(d.changes.map((c) => c.name))
  const fields: Field[] = [
    ...d.changes.map((c): Field => ({ name: c.name, op: '~', before: c.before, after: c.after, sensitive: secret(c.name) })),
    ...Object.entries(attrs)
      .filter(([n, v]) => v !== null && !changed.has(n))
      .map(([n, v]): Field => ({ name: n, op: ' ', before: v, after: v, sensitive: secret(n) })),
  ]
  return [`  # ${d.address} has changed`, row(2, '~', open), ...body(6, fields), row(2, ' ', '}')].join('\n')
}

function outputChanges(r: PlanResult): string[] {
  const before = r.refreshed.outputs
  const rows: { name: string; text: (w: number) => string[] }[] = []
  for (const o of r.outputs) {
    const had = Object.hasOwn(before, o.name)
    const old = had ? before[o.name].value : undefined
    if (had && equal(old as Value, o.value)) continue
    const hide = o.sensitive || (had && before[o.name].sensitive === true)
    const sym = had ? '~' : '+'
    rows.push({
      name: o.name,
      text: (w) => (hide ? [masked(2, sym, o.name, w)] : had ? diffLines(2, o.name, w, old, o.value) : lines(2, '+', o.name, w, o.value)),
    })
  }
  for (const name of Object.keys(before)) {
    if (!r.outputs.some((o) => o.name === name)) {
      const hide = before[name].sensitive === true
      rows.push({ name, text: (w) => (hide ? [masked(2, '-', name, w, ' -> null')] : lines(2, '-', name, w, before[name].value, '', true)) })
    }
  }
  const w = rows.reduce((m, x) => Math.max(m, x.name.length), 0)
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
