// `terraform plan` output. resourceBlock renders one plan item; renderPlan
// (added in the next task) renders the whole plan.
import { diffLines, lines, row, scalar } from './render-value.ts'
import type { PlanItem } from './plan.ts'

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
