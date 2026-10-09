// `terraform plan` output. resourceBlock renders one plan item; renderPlan
// renders the whole plan.
import { parseResAddr } from './address.ts'
import { formatDiagnostic } from './diag.ts'
import { equal, type Value } from './eval.ts'
import type { PlanItem, PlanResult } from './plan.ts'
import { body, diffLines, lines, masked, row, type Field } from './render-value.ts'
import { schemaFor, type AttrSpec } from './resources.ts'
import { findInstance } from './state.ts'

const specOf = (type: string, n: string): AttrSpec | undefined => {
  const attrs = schemaFor(type)?.attrs
  return attrs && Object.hasOwn(attrs, n) ? attrs[n] : undefined
}
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
      // A destroy-mode plan gives no reason: everything goes.
      if (item.destroyReason === undefined) break
      out.push(
        `(because ${
          item.destroyReason === 'module-gone'
            ? `${item.module} is not in configuration`
            : item.destroyReason === 'count-index'
            ? `index [${item.key}] is out of range for count`
            : item.destroyReason === 'for-each-key'
              ? `key [${JSON.stringify(item.key)}] is not in for_each map`
              : item.destroyReason === 'wrong-repetition'
                ? typeof item.key === 'number'
                  ? 'resource does not use count'
                  : typeof item.key === 'string'
                    ? 'resource does not use for_each'
                    : 'resource uses count or for_each'
                : `${item.type}.${item.name} is not in configuration`
        })`,
      )
      break
    case 'forget':
      return [` # ${a} will no longer be managed by Terraform, but will not be destroyed`, ' # (destroy = false is set in the configuration)']
    default:
      out.push(item.movedFrom ? `${item.movedFrom} has moved to ${a}` : item.importing ? `${a} will be imported` : a)
  }
  if (item.movedFrom && item.action !== 'noop') out.push(`(moved from ${item.movedFrom})`)
  if (item.importing && item.action !== 'noop') out.push(`(imported from "${item.importing}")`)
  return out.map((l) => `  # ${l}`)
}

function bodyLines(item: PlanItem): string[] {
  const changes = item.changes
  if (item.action === 'create') return body(6, changes.map((c) => ({ name: c.name, op: '+', after: c.after, sensitive: c.sensitive })))
  if (item.action === 'destroy') return body(6, changes.filter((c) => hasVal(c.before)).map((c) => ({ name: c.name, op: '-', before: c.before, sensitive: c.sensitive })))
  const changed = new Set(changes.map((c) => c.name))
  const fields: Field[] = [
    ...changes.map((c): Field => ({ name: c.name, op: '~', before: c.before, after: c.after, sensitive: c.sensitive, forces: c.forcesReplacement, set: specOf(item.type, c.name)?.set === true })),
    ...Object.entries(item.unchanged ?? {})
      .filter(([n, v]) => !changed.has(n) && hasVal(v))
      .map(([n, v]): Field => ({ name: n, op: ' ', before: v, after: v, show: item.importing !== undefined, sensitive: specOf(item.type, n)?.sensitive === true })),
  ]
  return body(6, fields)
}

export function resourceBlock(item: PlanItem): string {
  const open = `resource "${item.type}" "${item.name}" {`
  const header = headerLines(item)
  const resourceRow =
    item.action === 'forget'
      ? row(0, ' .', open)
      : item.action === 'replace' ? (item.createBeforeDestroy ? row(0, '+/-', open) : row(0, '-/+', open)) : row(2, item.action === 'create' ? '+' : item.action === 'update' ? '~' : item.action === 'destroy' ? '-' : ' ', open)
  return [...header, resourceRow, ...bodyLines(item), row(2, ' ', '}')].join('\n')
}

const APPLY_OUTPUTS = 'You can apply this plan to save these new output values to the Terraform state, without changing any real infrastructure.'
function wrap(text: string, width: number): string[] {
  const out: string[] = ['']
  for (const w of text.split(' ')) {
    const last = out[out.length - 1]
    if (last && last.length + 1 + w.length > width) out.push(w)
    else out[out.length - 1] = last ? `${last} ${w}` : w
  }
  return out
}
const RULE = '─'.repeat(77)
const symbolOf = (a: string) => (a === 'create' ? '+' : a === 'update' ? '~' : a === 'destroy' ? '-' : '')

function driftBlock(r: PlanResult, d: PlanResult['drift'][number]): string {
  const { type = '', name = '' } = parseResAddr(d.address) ?? {}
  const open = `resource "${type}" "${name}" {`
  const secret = (n: string) => specOf(type, n)?.sensitive === true
  if (d.kind === 'deleted') {
    const use = d.relevant ?? 'all'
    const fields = Object.entries(d.before ?? {})
      .filter(([, v]) => v !== null)
      .map(([n, v]): Field =>
        use === 'all' || use.includes(n) ? { name: n, op: '-', before: v, sensitive: secret(n) } : { name: n, op: ' ', before: v, after: v, sensitive: secret(n) },
      )
    return [`  # ${d.address} has been deleted`, row(2, '-', open), ...body(6, fields), row(2, ' ', '}')].join('\n')
  }
  const attrs = findInstance(r.refreshed, d.address)?.instance.attributes ?? {}
  const changed = new Set(d.changes.map((c) => c.name))
  const fields: Field[] = [
    ...d.changes.map((c): Field => ({ name: c.name, op: '~', before: c.before, after: c.after, sensitive: secret(c.name), set: specOf(type, c.name)?.set === true })),
    ...Object.entries(attrs)
      .filter(([n, v]) => v !== null && !changed.has(n))
      .map(([n, v]): Field => ({ name: n, op: ' ', before: v, after: v, sensitive: secret(n) })),
  ]
  return [`  # ${d.address} has changed`, row(2, '~', open), ...body(6, fields), row(2, ' ', '}')].join('\n')
}

function outputChanges(r: PlanResult): string[] {
  // A targeted plan leaves the outputs outside its targets alone.
  const before = r.targetOutputs ? Object.fromEntries(Object.entries(r.refreshed.outputs).filter(([n]) => r.targetOutputs!.includes(n))) : r.refreshed.outputs
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
  // Names pad to the longest output, changed or not.
  const w = [...r.outputs.map((o) => o.name), ...Object.keys(before)].reduce((m, n) => Math.max(m, n.length), 0)
  return rows.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)).flatMap((x) => x.text(w))
}

// Anything for a plan to show: a visible item or an output change.
export const hasChanges = (r: PlanResult): boolean => r.items.some((i) => i.action !== 'noop' || i.movedFrom || i.importing) || outputChanges(r).length > 0

const boxed = (list: PlanResult['diagnostics'], sources: Record<string, string>) => list.map((d) => formatDiagnostic(d, sources[d.file] ?? ''))
// A failed plan's warnings and errors, boxed.
export const renderPlanErrors = (r: PlanResult, sources: Record<string, string> = {}): string => [...boxed(r.warnings, sources), ...boxed(r.diagnostics, sources)].join('\n')

// A plan that failed with a configuration error renders only its errors. A
// partial plan (prevent_destroy) renders what was planned; its errors come
// from renderPlanErrors.
export function renderPlan(r: PlanResult, sources: Record<string, string> = {}): string {
  if (r.diagnostics.length && !r.partial) return renderPlanErrors(r, sources)

  const out: string[] = []
  const visible = r.items.filter((i) => i.action !== 'noop' || i.movedFrom || i.importing)
  const outputs = outputChanges(r)
  // Drift is only worth a note when something else is going to happen (imports and forgets don't count).
  const acting = visible.filter((i) => i.action !== 'forget' && !(i.action === 'noop' && i.importing !== undefined))
  if (r.driftShown.length && (acting.length || outputs.length)) {
    out.push(
      [
        'Note: Objects have changed outside of Terraform',
        '',
        'Terraform detected the following changes made outside of Terraform since the',
        'last "terraform apply" which may have affected this plan:',
        '',
        r.driftShown.map((d) => driftBlock(r, d)).join('\n\n'),
        '',
        '',
        'Unless you have made equivalent changes to your configuration, or ignored the',
        'relevant attributes using ignore_changes, the following plan may include',
        'actions to undo or respond to these changes.',
        '',
        RULE,
      ].join('\n'),
    )
  }

  if (!hasChanges(r)) {
    out.push('No changes. Your infrastructure matches the configuration.\n\nTerraform has compared your real infrastructure against your configuration\nand found no differences, so no changes are needed.')
  } else {
    const legend: string[] = []
    const used = new Set(visible.map((i) => (i.action === 'replace' ? (i.createBeforeDestroy ? '+/-' : '-/+') : symbolOf(i.action))))
    if (used.has('+')) legend.push('  + create')
    if (used.has('~')) legend.push('  ~ update in-place')
    if (used.has('-')) legend.push('  - destroy')
    if (used.has('-/+')) legend.push('-/+ destroy and then create replacement')
    if (used.has('+/-')) legend.push('+/- create replacement and then destroy')
    const head = legend.length || visible.some((i) => i.action === 'forget') ? ['Terraform used the selected providers to generate the following execution', 'plan. Resource actions are indicated with the following symbols:', ...legend, ''] : []
    const intro = r.partial ? 'Terraform planned the following actions, but then encountered a problem:' : 'Terraform will perform the following actions:'
    const parts = visible.length ? [...head, intro, '', visible.map(resourceBlock).join('\n\n')] : []
    if (visible.length) {
      const s = r.summary
      parts.push('', `Plan: ${r.imported > 0 ? `${r.imported} to import, ` : ''}${s.add} to add, ${s.change} to change, ${s.destroy} to destroy.`)
    }
    if (outputs.length) parts.push(...(visible.length ? [''] : []), 'Changes to Outputs:', ...outputs)
    if (!visible.length) parts.push('', ...wrap(APPLY_OUTPUTS, 78))
    out.push(parts.join('\n'))
  }
  // Diagnostics print right after the plan, and back to back (views.View.Diagnostics adds no separators).
  const text = out.join('\n\n')
  return r.warnings.length && !r.partial ? `${text}\n${boxed(r.warnings, sources).join('\n')}` : text
}
