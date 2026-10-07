// What a resource block says: its evaluated arguments (nested blocks become
// lists of objects, like the provider sees them) and its lifecycle settings.
import { evalExpr, EvalError, type Scope, type Value } from './eval.ts'
import type { Block, Expr, Pos } from './types.ts'

type Failure = { ok: false; summary: string; detail: string; pos: Pos }
export type Arguments = { ok: true; args: Record<string, Value> } | Failure

const META = new Set(['count', 'for_each', 'depends_on', 'provider'])
const SKIPPED_BLOCKS = new Set(['lifecycle', 'provisioner', 'connection', 'timeouts'])

class Located extends Error {
  failure: Failure
  constructor(pos: Pos, summary: string, detail: string) {
    super(summary)
    this.failure = { ok: false, summary, detail, pos }
  }
}

function body(block: Block, scope: Scope, top: boolean): Record<string, Value> {
  const entries: [string, Value][] = []
  for (const a of block.attrs) {
    if (top && META.has(a.name)) continue
    try {
      entries.push([a.name, evalExpr(a.value, scope)])
    } catch (e) {
      if (e instanceof EvalError) throw new Located(a.pos, e.summary, e.detail)
      throw e
    }
  }
  const nested = new Map<string, Value[]>()
  for (const b of block.blocks) {
    if (top && SKIPPED_BLOCKS.has(b.type)) continue
    if (b.type === 'dynamic') throw new Located(b.pos, 'Unsupported dynamic block', 'Dynamic blocks are not supported by this lab yet.')
    nested.set(b.type, [...(nested.get(b.type) ?? []), body(b, scope, false)])
  }
  return Object.fromEntries([...entries, ...nested])
}

export function resourceArguments(block: Block, scope: Scope): Arguments {
  try {
    return { ok: true, args: body(block, scope, true) }
  } catch (e) {
    if (e instanceof Located) return e.failure
    throw e
  }
}

export interface Lifecycle {
  ignoreChanges: string[] | 'all'
  preventDestroy: boolean
  createBeforeDestroy: boolean
  replaceTriggeredBy: string[]
}
export type LifecycleResult = { ok: true; lifecycle: Lifecycle } | Failure

// The attribute a reference names: tags, tags["Name"] and tags.Name all mean tags.
function rootName(e: Expr): string | undefined {
  if (e.kind === 'ref') return e.path[0]
  if (e.kind === 'attr' || e.kind === 'idx') return rootName(e.base)
  if (e.kind === 'lit' && typeof e.value === 'string') return e.value
  return undefined
}

export function lifecycleOf(block: Block): LifecycleResult {
  const blocks = block.blocks.filter((b) => b.type === 'lifecycle')
  const lifecycle: Lifecycle = { ignoreChanges: [], preventDestroy: false, createBeforeDestroy: false, replaceTriggeredBy: [] }
  if (blocks.length > 1) {
    return { ok: false, summary: 'Duplicate lifecycle block', detail: 'Only one lifecycle block is allowed per resource.', pos: blocks[1].pos }
  }
  const nested = blocks[0]?.blocks[0]
  if (nested) return { ok: false, summary: 'Unsupported block type', detail: `Blocks of type "${nested.type}" are not supported by this lab yet.`, pos: nested.pos }
  for (const a of blocks[0]?.attrs ?? []) {
    const fail = (summary: string, detail: string): LifecycleResult => ({ ok: false, summary, detail, pos: a.pos })
    switch (a.name) {
      case 'ignore_changes': {
        const items = a.value.kind === 'list' ? a.value.items : [a.value]
        const names = items.map(rootName)
        if (names.some((n) => n === undefined)) return fail('Invalid ignore_changes argument', 'ignore_changes must be a list of attribute names, or the keyword all.')
        lifecycle.ignoreChanges = names.includes('all') ? 'all' : (names as string[])
        break
      }
      case 'prevent_destroy':
      case 'create_before_destroy': {
        if (a.value.kind !== 'lit') return fail('Variables not allowed', 'Variables may not be used here.')
        if (typeof a.value.value !== 'boolean') return fail('Unsuitable value type', 'Unsuitable value: a bool is required.')
        if (a.name === 'prevent_destroy') lifecycle.preventDestroy = a.value.value
        else lifecycle.createBeforeDestroy = a.value.value
        break
      }
      case 'replace_triggered_by': {
        const items = a.value.kind === 'list' ? a.value.items : [a.value]
        lifecycle.replaceTriggeredBy = items.flatMap((i) => {
          let e = i
          while (e.kind === 'attr' || e.kind === 'idx') e = e.base
          return e.kind === 'ref' ? [e.path.slice(0, 2).join('.')] : []
        })
        break
      }
      default:
        return fail('Unsupported argument', `An argument named "${a.name}" is not expected here.`)
    }
  }
  return { ok: true, lifecycle }
}
