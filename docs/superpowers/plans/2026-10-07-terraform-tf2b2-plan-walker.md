# Terraform TF2b-2: the plan walker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a configuration (HCL files), the state, the simulated cloud and the variable values into a plan: which resource instances are created, updated, replaced or destroyed, what the drift was, what the outputs will be, or the configuration errors that stop a plan.

**Architecture:** Three small units feed the walker. `expand.ts` decides which instances a resource has (`count` / `for_each`). `arguments.ts` evaluates a resource's arguments and nested blocks and reads its `lifecycle` block. `plan.ts` refreshes state, walks the TF1 graph in dependency order, evaluates each node with the TF2a evaluator, diffs each instance with `diffInstance`, feeds each resource's *planned* values to the resources that depend on it (so a replaced resource's `id` is unknown to its dependents and they replace too), and finally plans destroys for instances no longer in the configuration.

**Tech Stack:** TypeScript (strict), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("Plan algorithm", "Errors and honesty"). TF1 (`graph.ts`, `parse.ts`), TF2a (`eval.ts`, `functions.ts`) and TF2b-1 (`resources.ts`, `state.ts`, `refresh.ts`) are complete. Out of scope here (TF2b-3): `moved`, `import`, `removed`, `prevent_destroy` enforcement, `create_before_destroy` ordering, `replace_triggered_by`, `-target`, `-replace`, tainted instances, `-refresh-only`, modules, `dynamic` blocks.

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, `import type` for types, `.ts` import extensions.
- No new npm dependencies.
- Tests live in `tests/*.test.ts` (vitest); `src/` is type-checked by `npx tsc -b`.
- Own-property discipline: never use `in` or `obj[userKey] = ...` on objects keyed by user-supplied names; use `Object.hasOwn`, `Object.fromEntries`, `Map`, `Object.defineProperty`.
- A configuration with any error produces diagnostics and **no plan items** (never a half-plan).
- Unsupported constructs (modules, `dynamic` blocks, unmodeled resource types) give an honest `Unsupported`/`Invalid resource type` diagnostic, never invented behavior.
- Error wording follows real Terraform where known; unverified wording is logged in `CONTENT_TODO.md` (Task 3).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A resource being created or replaced has unknown computed values, so a dependent whose forcing attribute references them is replaced too (the cascade), while a dependent of an unchanged resource sees the real values (Task 3 tests).
2. Lowering `count`, or removing a `for_each` key, destroys exactly the removed instances, not their siblings (Task 3 tests).
3. An unknown `count` or `for_each` produces the real error, not a guess; `for_each` over a set containing an unknown is the same error (Task 1 and 3 tests).
4. Referencing a counted or `for_each` resource without an instance key is the real "Missing resource instance key" error (Task 3 test).
5. Any configuration error means no plan items at all, even if other resources are fine (Task 3 test).
6. `ignore_changes` names parse in every common spelling: bare names, quoted strings, `tags["Name"]`, `all`, `[all]` (Task 2 tests).

---

### Task 1: Instance expansion (`count` / `for_each`)

**Files:**
- Create: `src/game/terraform/expand.ts`
- Test: `tests/terraform-expand.test.ts`

**Interfaces:**
- Consumes: `evalExpr`, `EvalError`, `isUnknown`, `Scope`, `Value` from `./eval.ts`; `Block`, `Pos` from `./types.ts`.
- Produces:
  - `type Key = string | number | undefined` (`undefined` = the single instance)
  - `type Expansion = { ok: true; kind: 'single' | 'count' | 'for_each'; keys: Key[]; each(key: string): { key: Value; value: Value } } | { ok: false; summary: string; detail: string; pos: Pos }`
  - `expandInstances(block: Block, scope: Scope): Expansion` (`for_each` keys are sorted; a list is accepted as a set of strings, since the lab represents sets as lists)

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-expand.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { EvalError, UNKNOWN, type Scope, type Value } from '../src/game/terraform/eval.ts'
import { expandInstances } from '../src/game/terraform/expand.ts'
import { parseHcl } from '../src/game/terraform/parse.ts'

// Expand the first resource in `body`, with `var.*` resolved from `vars`.
const expand = (body: string, vars: Record<string, Value> = {}) => {
  const r = parseHcl('main.tf', `resource "aws_s3_bucket" "b" {\n${body}\n}`)
  if (r.diagnostics.length) throw new Error(r.diagnostics[0].summary)
  const scope: Scope = {
    ref(path) {
      if (path[0] === 'var' && Object.hasOwn(vars, path[1])) return vars[path[1]]
      throw new EvalError('Reference to undeclared value', path.join('.'))
    },
  }
  return expandInstances(r.blocks[0], scope)
}
const bad = (body: string, vars: Record<string, Value> = {}) => {
  const e = expand(body, vars)
  if (e.ok) throw new Error('expected an error')
  return e
}

describe('expandInstances', () => {
  it('gives a single instance when neither count nor for_each is set', () => {
    expect(expand('  bucket = "x"')).toMatchObject({ ok: true, kind: 'single', keys: [undefined] })
  })

  it('expands count into indexes, including zero', () => {
    expect(expand('  count = 3')).toMatchObject({ ok: true, kind: 'count', keys: [0, 1, 2] })
    expect(expand('  count = var.n', { n: 0 })).toMatchObject({ kind: 'count', keys: [] })
  })

  it('rejects an unknown, null, negative, fractional or non-number count', () => {
    expect(bad('  count = var.n', { n: UNKNOWN })).toMatchObject({ summary: 'Invalid count argument', detail: expect.stringContaining('cannot be determined until apply') })
    expect(bad('  count = null').summary).toBe('Invalid count argument')
    expect(bad('  count = -1').detail).toContain('greater than or equal to zero')
    expect(bad('  count = 1.5').detail).toContain('whole number')
    expect(bad('  count = "many"').detail).toContain('number required')
  })

  it('expands a for_each map into sorted keys with key and value', () => {
    const e = expand('  for_each = { b = "2", a = "1" }')
    expect(e).toMatchObject({ ok: true, kind: 'for_each', keys: ['a', 'b'] })
    if (e.ok) expect(e.each('b')).toEqual({ key: 'b', value: '2' })
  })

  it('expands a for_each set of strings into sorted unique keys, value equal to key', () => {
    const e = expand('  for_each = toset(["b", "a", "b"])')
    expect(e).toMatchObject({ ok: true, kind: 'for_each', keys: ['a', 'b'] })
    if (e.ok) expect(e.each('a')).toEqual({ key: 'a', value: 'a' })
  })

  it('rejects an unknown for_each, or a set holding an unknown', () => {
    const first = bad('  for_each = var.m', { m: UNKNOWN })
    expect(first.summary).toBe('Invalid for_each argument')
    expect(first.detail).toContain('cannot be determined until apply')
    expect(bad('  for_each = var.m', { m: ['a', UNKNOWN] }).summary).toBe('Invalid for_each argument')
  })

  it('rejects for_each over numbers, strings, null, or a set of non-strings', () => {
    expect(bad('  for_each = 3').detail).toContain('must be a map, or set of strings')
    expect(bad('  for_each = "abc"').detail).toContain('must be a map, or set of strings')
    expect(bad('  for_each = null').summary).toBe('Invalid for_each argument')
    expect(bad('  for_each = [1, 2]').detail).toContain('set containing type number')
  })

  it('rejects count together with for_each, and reports evaluation errors at the argument', () => {
    expect(bad('  count = 1\n  for_each = ["a"]').summary).toBe('Invalid combination of "count" and "for_each"')
    const e = bad('  count = var.missing')
    expect(e).toMatchObject({ summary: 'Reference to undeclared value', pos: { line: 2 } })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-expand.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/expand.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/expand.ts`:

```ts
// Which instances a resource has: one, `count` of them, or one per
// `for_each` key. Both meta-arguments must be known at plan time.
import { evalExpr, EvalError, isUnknown, type Scope, type Value } from './eval.ts'
import type { Block, Pos } from './types.ts'

export type Key = string | number | undefined
export type Expansion =
  | { ok: true; kind: 'single' | 'count' | 'for_each'; keys: Key[]; each(key: string): { key: Value; value: Value } }
  | { ok: false; summary: string; detail: string; pos: Pos }

const bad = (pos: Pos, summary: string, detail: string): Expansion => ({ ok: false, summary, detail, pos })
const typeName = (v: Value) => (v === null ? 'null' : Array.isArray(v) ? 'tuple' : typeof v === 'object' ? 'object' : typeof v)

const COUNT_UNKNOWN =
  'The "count" value depends on resource attributes that cannot be determined until apply, so Terraform cannot predict how many instances will be created. To work around this, use the -target argument to first apply only the resources that the count depends on.'
const FOR_EACH_UNKNOWN =
  'The "for_each" map includes keys derived from resource attributes that cannot be determined until apply, and so Terraform cannot determine the full set of keys that will identify the instances of this resource.\n\nWhen working with unknown values in for_each, it\'s better to define the map keys statically in your configuration and place apply-time results only in the map values.\n\nAlternatively, you could use the -target argument to first apply only the resources that the for_each value depends on.'

export function expandInstances(block: Block, scope: Scope): Expansion {
  const count = block.attrs.find((a) => a.name === 'count')
  const forEach = block.attrs.find((a) => a.name === 'for_each')
  const noEach = (key: string) => ({ key, value: key })
  if (count && forEach) {
    return bad(forEach.pos, 'Invalid combination of "count" and "for_each"', 'The "count" and "for_each" meta-arguments are mutually exclusive, only one should be used to be explicit about the number of resources to be created.')
  }
  if (!count && !forEach) return { ok: true, kind: 'single', keys: [undefined], each: noEach }

  const attr = (count ?? forEach)!
  let v: Value
  try {
    v = evalExpr(attr.value, scope)
  } catch (e) {
    if (e instanceof EvalError) return bad(attr.pos, e.summary, e.detail)
    throw e
  }

  if (count) {
    const unsuitable = (why: string) => bad(count.pos, 'Invalid count argument', `The given "count" argument value is unsuitable: ${why}.`)
    if (isUnknown(v)) return bad(count.pos, 'Invalid count argument', COUNT_UNKNOWN)
    if (typeof v !== 'number') return unsuitable(v === null ? 'the given value is null' : 'number required')
    if (!Number.isInteger(v)) return unsuitable('must be a whole number')
    if (v < 0) return unsuitable('must be greater than or equal to zero')
    return { ok: true, kind: 'count', keys: Array.from({ length: v }, (_, i) => i), each: noEach }
  }

  const unsuitable = (why: string) => bad(forEach!.pos, 'Invalid for_each argument', `The given "for_each" argument value is unsuitable: ${why}.`)
  if (isUnknown(v)) return bad(forEach!.pos, 'Invalid for_each argument', FOR_EACH_UNKNOWN)
  if (Array.isArray(v)) {
    if (v.some(isUnknown)) return bad(forEach!.pos, 'Invalid for_each argument', FOR_EACH_UNKNOWN)
    const wrong = v.find((x) => typeof x !== 'string')
    if (wrong !== undefined) return unsuitable(`"for_each" supports maps and sets of strings, but you have provided a set containing type ${typeName(wrong)}`)
    const keys = [...new Set(v as string[])].sort()
    return { ok: true, kind: 'for_each', keys, each: noEach }
  }
  if (typeof v === 'object' && v !== null) {
    const map = v as { [key: string]: Value }
    return { ok: true, kind: 'for_each', keys: Object.keys(map).sort(), each: (key) => ({ key, value: Object.hasOwn(map, key) ? map[key] : null }) }
  }
  return unsuitable(`the "for_each" argument must be a map, or set of strings, and you have provided a value of type ${typeName(v)}`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-expand.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/expand.ts tests/terraform-expand.test.ts
git commit -m "feat: count/for_each instance expansion (TF2b-2)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Resource arguments and `lifecycle`

**Files:**
- Create: `src/game/terraform/arguments.ts`
- Test: `tests/terraform-arguments.test.ts`

**Interfaces:**
- Consumes: `evalExpr`, `EvalError`, `Scope`, `Value` from `./eval.ts`; `Block`, `Expr`, `Pos` from `./types.ts`.
- Produces:
  - `type Arguments = { ok: true; args: Record<string, Value> } | { ok: false; summary: string; detail: string; pos: Pos }`
  - `resourceArguments(block: Block, scope: Scope): Arguments` (evaluates every argument except the meta-arguments `count`, `for_each`, `depends_on`, `provider`; nested blocks become lists of objects keyed by block type; `lifecycle`, `provisioner`, `connection` and `timeouts` blocks are skipped; a `dynamic` block is reported as unsupported; an evaluation error carries the argument's position)
  - `interface Lifecycle { ignoreChanges: string[] | 'all'; preventDestroy: boolean; createBeforeDestroy: boolean; replaceTriggeredBy: string[] }`
  - `type LifecycleResult = { ok: true; lifecycle: Lifecycle } | { ok: false; summary: string; detail: string; pos: Pos }`
  - `lifecycleOf(block: Block): LifecycleResult`

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-arguments.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { lifecycleOf, resourceArguments } from '../src/game/terraform/arguments.ts'
import { EvalError, type Scope, type Value } from '../src/game/terraform/eval.ts'
import { parseHcl } from '../src/game/terraform/parse.ts'

const block = (body: string) => {
  const r = parseHcl('main.tf', `resource "aws_security_group" "web" {\n${body}\n}`)
  if (r.diagnostics.length) throw new Error(r.diagnostics[0].summary)
  return r.blocks[0]
}
const scope = (vars: Record<string, Value> = {}): Scope => ({
  ref(path) {
    if (path[0] === 'var' && Object.hasOwn(vars, path[1])) return vars[path[1]]
    if (path[0] === 'each') return { key: 'k', value: 'v' }
    throw new EvalError('Reference to undeclared value', path.join('.'))
  },
})

describe('resourceArguments', () => {
  it('evaluates arguments and skips meta-arguments and lifecycle', () => {
    const r = resourceArguments(block('  name = "web-${var.env}"\n  count = 2\n  depends_on = [x.y]\n  provider = aws.west\n  lifecycle {\n    prevent_destroy = true\n  }'), scope({ env: 'prod' }))
    expect(r).toEqual({ ok: true, args: { name: 'web-prod' } })
  })

  it('turns nested blocks into lists of objects, in order, including blocks inside blocks', () => {
    const r = resourceArguments(block('  ingress {\n    from_port = 22\n    cidr_blocks = ["10.0.0.0/8"]\n  }\n  ingress {\n    from_port = 80\n    rule {\n      note = "web"\n    }\n  }'), scope())
    expect(r).toEqual({
      ok: true,
      args: {
        ingress: [
          { from_port: 22, cidr_blocks: ['10.0.0.0/8'] },
          { from_port: 80, rule: [{ note: 'web' }] },
        ],
      },
    })
  })

  it('reports a dynamic block as unsupported', () => {
    const r = resourceArguments(block('  dynamic "ingress" {\n    for_each = []\n  }'), scope())
    expect(r).toMatchObject({ ok: false, summary: 'Unsupported dynamic block', pos: { line: 2 } })
  })

  it('reports an evaluation error at the argument that caused it', () => {
    const r = resourceArguments(block('  name = "ok"\n  vpc_id = var.nope'), scope())
    expect(r).toMatchObject({ ok: false, summary: 'Reference to undeclared value', pos: { line: 3 } })
  })

  it('keeps an attribute named __proto__ as an ordinary key', () => {
    const r = resourceArguments(block('  __proto__ = 1'), scope())
    expect(r.ok && Object.keys(r.args)).toEqual(['__proto__'])
    expect(r.ok && Object.getPrototypeOf(r.args)).toBe(Object.prototype)
  })
})

describe('lifecycleOf', () => {
  const lc = (body: string) => lifecycleOf(block(`  lifecycle {\n${body}\n  }`))

  it('has defaults when there is no lifecycle block', () => {
    expect(lifecycleOf(block('  name = "x"'))).toEqual({ ok: true, lifecycle: { ignoreChanges: [], preventDestroy: false, createBeforeDestroy: false, replaceTriggeredBy: [] } })
  })

  it('reads ignore_changes in every common spelling', () => {
    const names = (src: string) => {
      const r = lc(`    ignore_changes = ${src}`)
      return r.ok ? r.lifecycle.ignoreChanges : r
    }
    expect(names('[tags, desired_count]')).toEqual(['tags', 'desired_count'])
    expect(names('["tags"]')).toEqual(['tags'])
    expect(names('[tags["Name"], user_data]')).toEqual(['tags', 'user_data'])
    expect(names('all')).toBe('all')
    expect(names('[all]')).toBe('all')
    expect(names('["all"]')).toBe('all')
  })

  it('reads prevent_destroy, create_before_destroy and replace_triggered_by', () => {
    const r = lc('    prevent_destroy = true\n    create_before_destroy = true\n    replace_triggered_by = [aws_vpc.main, aws_subnet.a.id]')
    expect(r).toMatchObject({ ok: true, lifecycle: { preventDestroy: true, createBeforeDestroy: true, replaceTriggeredBy: ['aws_vpc.main', 'aws_subnet.a'] } })
  })

  it('rejects a variable in prevent_destroy, a bad ignore_changes, an unknown argument, or two lifecycle blocks', () => {
    expect(lc('    prevent_destroy = var.x')).toMatchObject({ ok: false, summary: 'Variables not allowed' })
    expect(lc('    ignore_changes = 5')).toMatchObject({ ok: false, summary: 'Invalid ignore_changes argument' })
    expect(lc('    nope = 1')).toMatchObject({ ok: false, summary: 'Unsupported argument', detail: 'An argument named "nope" is not expected here.' })
    expect(lifecycleOf(block('  lifecycle {\n  }\n  lifecycle {\n  }'))).toMatchObject({ ok: false, summary: 'Duplicate lifecycle block' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-arguments.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/arguments.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/arguments.ts`:

```ts
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
        if (a.value.kind !== 'lit' || typeof a.value.value !== 'boolean') return fail('Variables not allowed', 'Variables may not be used here.')
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-arguments.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent. (`replace_triggered_by` of `aws_subnet.a.id` parses to `ref` path `[aws_subnet, a, id]`; the first two segments are the address.)

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/arguments.ts tests/terraform-arguments.test.ts
git commit -m "feat: resource arguments, nested blocks and lifecycle settings (TF2b-2)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The plan walker

**Files:**
- Create: `src/game/terraform/plan.ts`
- Test: `tests/terraform-plan.test.ts`
- Modify: `CONTENT_TODO.md` (append a section)

**Interfaces:**
- Consumes: `buildGraph`, `GNode` (`./graph.ts`); `evalExpr`, `EvalError`, `isUnknown`, `UNKNOWN`, `Scope`, `Value` (`./eval.ts`); `expandInstances`, `Key` (`./expand.ts`); `lifecycleOf`, `resourceArguments` (`./arguments.ts`); `diffInstance`, `schemaFor`, `unsupportedType`, `Action`, `AttrChange`, `ResourceSchema` (`./resources.ts`); `refresh`, `Drift`, `Reality` (`./refresh.ts`); `findInstance`, `instanceAddress`, `State` (`./state.ts`); `Diagnostic`, `Pos` (`./types.ts`).
- Produces:
  - `interface PlanInput { files: { name: string; text: string }[]; state: State; reality: Reality; vars: Record<string, Value>; workspace?: string; refresh?: boolean }`
  - `interface PlanItem { address: string; type: string; name: string; key?: string | number; action: Action | 'destroy'; changes: AttrChange[] }` (items include `noop`s; sorted by address)
  - `interface PlanOutput { name: string; value: Value; sensitive: boolean }` (sorted by name)
  - `interface PlanResult { diagnostics: Diagnostic[]; drift: Drift[]; items: PlanItem[]; outputs: PlanOutput[]; refreshed: State; summary: { add: number; change: number; destroy: number } }` (a replace counts in both `add` and `destroy`; if `diagnostics` is non-empty, `items` and `outputs` are empty)
  - `planConfig(input: PlanInput): PlanResult`

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { UNKNOWN, type Value } from '../src/game/terraform/eval.ts'
import { planConfig, type PlanResult } from '../src/game/terraform/plan.ts'
import { realityKey, type Reality } from '../src/game/terraform/refresh.ts'
import { emptyState, type State } from '../src/game/terraform/state.ts'

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]'
type Seed = { type: string; name: string; key?: string | number; attrs: Record<string, Value>; mode?: 'managed' | 'data' }
const stateOf = (...seeds: Seed[]): State => {
  const s = emptyState()
  for (const x of seeds) {
    const mode = x.mode ?? 'managed'
    let r = s.resources.find((r) => r.mode === mode && r.type === x.type && r.name === x.name)
    if (!r) {
      r = { mode, type: x.type, name: x.name, provider: AWS, instances: [] }
      s.resources.push(r)
    }
    r.instances.push({ ...(x.key === undefined ? {} : { index_key: x.key }), attributes: x.attrs })
  }
  return s
}
// A cloud that matches the state exactly.
const cloudOf = (state: State): Reality =>
  Object.fromEntries(state.resources.filter((r) => r.mode === 'managed').flatMap((r) => r.instances.map((i) => [realityKey(r.type, i.attributes.id as string), i.attributes] as const)))

const plan = (tf: string, o: { state?: State; reality?: Reality; vars?: Record<string, Value> } = {}): PlanResult => {
  const state = o.state ?? emptyState()
  return planConfig({ files: [{ name: 'main.tf', text: tf }], state, reality: o.reality ?? cloudOf(state), vars: o.vars ?? {} })
}
const actions = (r: PlanResult) => r.items.filter((i) => i.action !== 'noop').map((i) => `${i.action} ${i.address}`)

const VPC = { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1' }
const SUBNET = { id: 'subnet-1', arn: 'arn:subnet-1', vpc_id: 'vpc-1', cidr_block: '10.0.1.0/24', availability_zone: 'us-east-1a', map_public_ip_on_launch: false }
const NETWORK = (cidr: string) => `
resource "aws_vpc" "main" {
  cidr_block = "${cidr}"
}
resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}
`
const BUCKET = (n: number) => ({ id: `logs-${n}`, arn: `arn:logs-${n}`, bucket: `logs-${n}`, force_destroy: false })

describe('planConfig: single resources and dependencies', () => {
  it('creates everything from an empty state, with dependents seeing unknown ids', () => {
    const r = plan(NETWORK('10.0.0.0/16'))
    expect(r.diagnostics).toEqual([])
    expect(actions(r)).toEqual(['create aws_subnet.a', 'create aws_vpc.main'])
    expect(r.items[0].changes.find((c) => c.name === 'vpc_id')).toMatchObject({ before: undefined, after: UNKNOWN })
    expect(r.summary).toEqual({ add: 2, change: 0, destroy: 0 })
  })

  it('plans no changes when state matches, and dependents see the real ids', () => {
    const r = plan(NETWORK('10.0.0.0/16'), { state: stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_subnet', name: 'a', attrs: SUBNET }) })
    expect(r.diagnostics).toEqual([])
    expect(r.items.map((i) => i.action)).toEqual(['noop', 'noop'])
    expect(r.summary).toEqual({ add: 0, change: 0, destroy: 0 })
  })

  it('cascades a replacement to dependents whose forcing attribute references the replaced resource', () => {
    const r = plan(NETWORK('10.1.0.0/16'), { state: stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_subnet', name: 'a', attrs: SUBNET }) })
    expect(actions(r)).toEqual(['replace aws_subnet.a', 'replace aws_vpc.main'])
    expect(r.items[0].changes.find((c) => c.name === 'vpc_id')).toMatchObject({ before: 'vpc-1', after: UNKNOWN, forcesReplacement: true })
    expect(r.summary).toEqual({ add: 2, change: 0, destroy: 2 })
  })

  it('updates in place when a non-forcing attribute changes', () => {
    const r = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  enable_dns_hostnames = true\n}', { state: stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }) })
    expect(actions(r)).toEqual(['update aws_vpc.main'])
    expect(r.summary).toEqual({ add: 0, change: 1, destroy: 0 })
  })

  it('shows drift and plans to put the resource back as configured', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: { ...VPC, tags: { Name: 'main' } } })
    const reality = cloudOf(state)
    reality[realityKey('aws_vpc', 'vpc-1')] = { ...VPC, tags: { Name: 'main', Owner: 'ops' } }
    const r = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  tags = { Name = "main" }\n}', { state, reality })
    expect(r.drift).toEqual([{ address: 'aws_vpc.main', kind: 'changed', changes: [{ name: 'tags', before: { Name: 'main' }, after: { Name: 'main', Owner: 'ops' } }] }])
    expect(r.items[0]).toMatchObject({ action: 'update', changes: [{ name: 'tags', before: { Name: 'main', Owner: 'ops' }, after: { Name: 'main' } }] })
  })

  it('plans a create for something deleted outside Terraform', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC })
    const r = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}', { state, reality: {} })
    expect(r.drift).toEqual([{ address: 'aws_vpc.main', kind: 'deleted', changes: [] }])
    expect(actions(r)).toEqual(['create aws_vpc.main'])
  })

  it('destroys what is in state but no longer in the configuration', () => {
    const r = plan('# nothing here\n', { state: stateOf({ type: 'aws_vpc', name: 'old', attrs: VPC }) })
    expect(r.items).toMatchObject([{ address: 'aws_vpc.old', action: 'destroy' }])
    expect(r.items[0].changes.find((c) => c.name === 'cidr_block')).toMatchObject({ before: '10.0.0.0/16', after: null })
    expect(r.summary).toEqual({ add: 0, change: 0, destroy: 1 })
  })

  it('honours ignore_changes, and shows the change without it', () => {
    const tf = (lc: string) => `resource "aws_ecs_service" "web" {\n  name = "web"\n  cluster = "prod"\n  task_definition = "web:1"\n  desired_count = 2\n${lc}}`
    const state = stateOf({ type: 'aws_ecs_service', name: 'web', attrs: { id: 'svc-1', arn: 'arn:svc-1', name: 'web', cluster: 'prod', task_definition: 'web:1', desired_count: 5 } })
    expect(actions(plan(tf('  lifecycle {\n    ignore_changes = [desired_count]\n  }\n'), { state }))).toEqual([])
    expect(plan(tf(''), { state }).items[0]).toMatchObject({ action: 'update', changes: [{ name: 'desired_count', before: 5, after: 2 }] })
  })

  it('compares nested blocks as lists of objects', () => {
    const tf = (to: number) => `resource "aws_security_group" "web" {\n  name = "web"\n  description = "Managed by Terraform"\n  vpc_id = "vpc-1"\n  ingress {\n    from_port = 22\n    to_port = ${to}\n  }\n}`
    const state = stateOf({ type: 'aws_security_group', name: 'web', attrs: { id: 'sg-1', arn: 'a', name: 'web', description: 'Managed by Terraform', vpc_id: 'vpc-1', ingress: [{ from_port: 22, to_port: 22 }] } })
    expect(actions(plan(tf(22), { state }))).toEqual([])
    expect(plan(tf(2222), { state }).items[0]).toMatchObject({ action: 'update', changes: [{ name: 'ingress', after: [{ from_port: 22, to_port: 2222 }] }] })
  })
})

describe('planConfig: count and for_each', () => {
  const COUNTED = 'variable "n" {\n  default = 3\n}\nresource "aws_s3_bucket" "b" {\n  count  = var.n\n  bucket = "logs-${count.index}"\n}\n'

  it('creates count instances with count.index available', () => {
    const r = plan(COUNTED)
    expect(actions(r)).toEqual(['create aws_s3_bucket.b[0]', 'create aws_s3_bucket.b[1]', 'create aws_s3_bucket.b[2]'])
    expect(r.items[1].changes.find((c) => c.name === 'bucket')).toMatchObject({ after: 'logs-1' })
  })

  it('destroys exactly the removed instances when count goes down', () => {
    const state = stateOf(...[0, 1, 2].map((n) => ({ type: 'aws_s3_bucket', name: 'b', key: n, attrs: BUCKET(n) })))
    const r = plan(COUNTED, { state, vars: { n: 2 } })
    expect(actions(r)).toEqual(['destroy aws_s3_bucket.b[2]'])
    expect(r.items.filter((i) => i.action === 'noop').map((i) => i.address)).toEqual(['aws_s3_bucket.b[0]', 'aws_s3_bucket.b[1]'])
  })

  it('creates one instance per for_each key and destroys a removed key', () => {
    const tf = 'resource "aws_s3_bucket" "b" {\n  for_each = toset(["a", "b"])\n  bucket   = "b-${each.key}"\n}'
    expect(actions(plan(tf))).toEqual(['create aws_s3_bucket.b["a"]', 'create aws_s3_bucket.b["b"]'])
    const state = stateOf(...['a', 'b', 'c'].map((k) => ({ type: 'aws_s3_bucket', name: 'b', key: k, attrs: { id: `b-${k}`, arn: `arn:b-${k}`, bucket: `b-${k}`, force_destroy: false } })))
    expect(actions(plan(tf, { state }))).toEqual(['destroy aws_s3_bucket.b["c"]'])
  })

  it('gives each for_each map entry its value', () => {
    const tf = 'resource "aws_s3_bucket" "b" {\n  for_each = { x = "one", y = "two" }\n  bucket   = "v-${each.value}"\n}'
    const r = plan(tf)
    expect(r.items.map((i) => [i.address, i.changes.find((c) => c.name === 'bucket')!.after])).toEqual([
      ['aws_s3_bucket.b["x"]', 'v-one'],
      ['aws_s3_bucket.b["y"]', 'v-two'],
    ])
  })

  it('refuses an unknown for_each or count with the real error, and plans nothing', () => {
    const fe = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\nresource "aws_subnet" "s" {\n  for_each = toset([aws_vpc.main.id])\n  vpc_id = each.key\n  cidr_block = "10.0.1.0/24"\n}')
    expect(fe.diagnostics[0]).toMatchObject({ summary: 'Invalid for_each argument', file: 'main.tf', line: 5, context: 'resource "aws_subnet" "s"' })
    expect(fe.items).toEqual([])
    const ct = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\nresource "aws_subnet" "s" {\n  count = length(aws_vpc.main.id)\n  cidr_block = "10.0.1.0/24"\n}')
    expect(ct.diagnostics[0].summary).toBe('Invalid count argument')
  })

  it('requires an instance key to reference a counted resource', () => {
    const tf = COUNTED + 'resource "aws_sqs_queue" "q" {\n  name = aws_s3_bucket.b.bucket\n}'
    const r = plan(tf)
    expect(r.diagnostics[0]).toMatchObject({ summary: 'Missing resource instance key' })
    expect(r.diagnostics[0].detail).toContain('aws_s3_bucket.b[count.index]')
    const ok = plan(COUNTED + 'resource "aws_sqs_queue" "q" {\n  name = aws_s3_bucket.b[1].bucket\n}')
    expect(ok.diagnostics).toEqual([])
    expect(ok.items.find((i) => i.address === 'aws_sqs_queue.q')!.changes.find((c) => c.name === 'name')).toMatchObject({ after: 'logs-1' })
  })
})

describe('planConfig: variables, locals, outputs, data', () => {
  const TF = 'variable "env" {}\nlocals {\n  name = "app-${var.env}"\n}\nresource "aws_s3_bucket" "b" {\n  bucket = local.name\n}\noutput "id" {\n  value = aws_s3_bucket.b.id\n}\noutput "bucket" {\n  value = aws_s3_bucket.b.bucket\n}\noutput "secret" {\n  value = local.name\n  sensitive = true\n}\n'

  it('evaluates locals and outputs, with computed values unknown, sorted by name', () => {
    const r = plan(TF, { vars: { env: 'prod' } })
    expect(r.diagnostics).toEqual([])
    expect(r.outputs).toEqual([
      { name: 'bucket', value: 'app-prod', sensitive: false },
      { name: 'id', value: UNKNOWN, sensitive: false },
      { name: 'secret', value: 'app-prod', sensitive: true },
    ])
  })

  it('reports a missing required variable, and prefers a supplied value over the default', () => {
    const r = plan(TF)
    expect(r.diagnostics[0]).toMatchObject({ summary: 'No value for required variable', context: 'variable "env"', line: 1 })
    expect(r.diagnostics[0].detail).toContain('The root module input variable "env" is not set')
    const d = 'variable "cidr" {\n  default = "10.0.0.0/16"\n}\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}'
    expect(plan(d).items[0].changes.find((c) => c.name === 'cidr_block')).toMatchObject({ after: '10.0.0.0/16' })
    expect(plan(d, { vars: { cidr: '10.9.0.0/16' } }).items[0].changes.find((c) => c.name === 'cidr_block')).toMatchObject({ after: '10.9.0.0/16' })
  })

  it('reads a data source from state, and treats an unread one as unknown', () => {
    const tf = 'data "aws_ami" "x" {}\nresource "aws_instance" "i" {\n  ami = data.aws_ami.x.id\n  instance_type = "t3.micro"\n}'
    const read = plan(tf, { state: stateOf({ mode: 'data', type: 'aws_ami', name: 'x', attrs: { id: 'ami-1' } }) })
    expect(read.items.find((i) => i.address === 'aws_instance.i')!.changes.find((c) => c.name === 'ami')).toMatchObject({ after: 'ami-1' })
    expect(plan(tf).items.find((i) => i.address === 'aws_instance.i')!.changes.find((c) => c.name === 'ami')).toMatchObject({ after: UNKNOWN })
  })
})

describe('planConfig: errors', () => {
  it('reports an unmodeled resource type, a module, a dynamic block and a bad attribute reference, and plans nothing', () => {
    const r = plan('resource "aws_nope" "x" {}\nmodule "m" {\n  source = "./m"\n}\nresource "aws_security_group" "g" {\n  dynamic "ingress" {\n    for_each = []\n  }\n}\nresource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\nresource "aws_subnet" "s" {\n  vpc_id = aws_vpc.v.nope\n  cidr_block = "10.0.1.0/24"\n}')
    expect(r.diagnostics.map((d) => d.summary).sort()).toEqual(['Invalid resource type', 'Unsupported attribute', 'Unsupported dynamic block', 'Unsupported module'])
    expect(r.items).toEqual([])
    expect(r.outputs).toEqual([])
  })

  it('reports parse and graph errors without planning', () => {
    expect(plan('resource "aws_vpc" "main" {\n  cidr_block\n}').diagnostics[0].summary).toBe('Argument or block definition required')
    expect(plan('resource "aws_vpc" "a" {\n  cidr_block = aws_vpc.nope.id\n}').diagnostics[0].summary).toBe('Reference to undeclared resource')
  })

  it('does not touch the caller\'s state', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC })
    const copy = structuredClone(state)
    plan(NETWORK('10.1.0.0/16'), { state })
    expect(state).toEqual(copy)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-plan.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/plan.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/plan.ts`:

```ts
// The plan: refresh state against the cloud, walk the configuration in
// dependency order, plan each resource instance from its evaluated arguments
// and the planned values of what it depends on, then plan destroys for
// instances that are no longer configured. Any configuration error stops the
// plan: nothing is half-planned.
import { lifecycleOf, resourceArguments } from './arguments.ts'
import { evalExpr, EvalError, isUnknown, UNKNOWN, type Scope, type Value } from './eval.ts'
import { expandInstances, type Key } from './expand.ts'
import { buildGraph, type GNode } from './graph.ts'
import { refresh as refreshState, type Drift, type Reality } from './refresh.ts'
import { diffInstance, schemaFor, unsupportedType, type Action, type AttrChange, type ResourceSchema } from './resources.ts'
import { findInstance, instanceAddress, type State } from './state.ts'
import type { Diagnostic, Pos } from './types.ts'

export interface PlanInput {
  files: { name: string; text: string }[]
  state: State
  reality: Reality
  vars: Record<string, Value>
  workspace?: string
  refresh?: boolean
}
export interface PlanItem {
  address: string
  type: string
  name: string
  key?: string | number
  action: Action | 'destroy'
  changes: AttrChange[]
}
export interface PlanOutput {
  name: string
  value: Value
  sensitive: boolean
}
export interface PlanResult {
  diagnostics: Diagnostic[]
  drift: Drift[]
  items: PlanItem[]
  outputs: PlanOutput[]
  refreshed: State
  summary: { add: number; change: number; destroy: number }
}

const byAddress = (a: PlanItem, b: PlanItem) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

// Follow attribute names into a value, as `a.b.c` does.
function walk(v: Value, names: string[]): Value {
  let cur = v
  for (const n of names) {
    if (isUnknown(cur)) return UNKNOWN
    if (typeof cur === 'object' && cur !== null && !Array.isArray(cur) && Object.hasOwn(cur, n)) cur = cur[n]
    else throw new EvalError('Unsupported attribute', `This object has no argument, nested block, or exported attribute named "${n}".`)
  }
  return cur
}

// Every attribute the schema knows is present on a planned object (null if
// nothing sets it), so references to it resolve instead of failing.
const complete = (planned: Record<string, Value>, schema: ResourceSchema): Record<string, Value> =>
  Object.fromEntries([...Object.keys(schema.attrs).map((n): [string, Value] => [n, null]), ...Object.entries(planned)])

export function planConfig(input: PlanInput): PlanResult {
  const g = buildGraph(input.files)
  const { state: refreshed, drift } = input.refresh === false ? { state: input.state, drift: [] as Drift[] } : refreshState(input.state, input.reality)
  const result: PlanResult = { diagnostics: [...g.diagnostics], drift, items: [], outputs: [], refreshed, summary: { add: 0, change: 0, destroy: 0 } }
  if (g.diagnostics.length) return result

  const errors = result.diagnostics
  const values = new Map<string, Value>()
  const shapes = new Map<string, 'count' | 'for_each'>()
  const val = (k: string): Value => (values.has(k) ? values.get(k)! : UNKNOWN)
  const fail = (file: string, pos: Pos, summary: string, detail: string, context?: string) =>
    errors.push({ severity: 'error', summary, detail, file, line: pos.line, col: pos.col, context })
  const evalAt = (node: GNode, pos: Pos, fn: () => Value, context?: string): Value => {
    try {
      return fn()
    } catch (e) {
      if (!(e instanceof EvalError)) throw e
      fail(node.file, pos, e.summary, e.detail, context)
      return UNKNOWN
    }
  }

  const scopeFor = (ctx: { each?: { key: Value; value: Value }; count?: number }): Scope => ({
    ref(path) {
      const [root, a, b] = path
      switch (root) {
        case 'each':
          if (!ctx.each) throw new EvalError('Reference to "each" in context without for_each', 'The "each" object can be used only in "resource" blocks, and only when the "for_each" argument is set.')
          return walk({ key: ctx.each.key, value: ctx.each.value }, path.slice(1))
        case 'count':
          if (ctx.count === undefined) throw new EvalError('Reference to "count" in non-counted context', 'The "count" object can only be used in "resource" blocks when the "count" argument is set.')
          return walk({ index: ctx.count }, path.slice(1))
        case 'path':
          return walk({ module: '.', root: '.', cwd: '.' }, path.slice(1))
        case 'terraform':
          return walk({ workspace: input.workspace ?? 'default' }, path.slice(1))
        case 'var':
        case 'local':
          return walk(val(`${root}.${a}`), path.slice(2))
        case 'data':
          return walk(val(`data.${a}.${b}`), path.slice(3))
        case 'module':
          return UNKNOWN
        default: {
          const addr = `${root}.${a}`
          const shape = shapes.get(addr)
          if (shape && path.length > 2) {
            throw new EvalError(
              'Missing resource instance key',
              `Because ${addr} has "${shape}" set, its attributes must be accessed on specific instances.\n\nFor example, to correlate with indices of a referring resource, use:\n    ${addr}[${shape === 'count' ? 'count.index' : 'each.key'}]`,
            )
          }
          return walk(val(addr), path.slice(2))
        }
      }
    },
  })

  const planResource = (node: GNode) => {
    const b = node.block!
    const [type, name] = b.labels
    const context = `resource "${type}" "${name}"`
    values.set(node.address, UNKNOWN)
    const schema = schemaFor(type)
    if (!schema) {
      const u = unsupportedType(type)
      fail(node.file, b.pos, u.summary, u.detail, context)
      return
    }
    const ex = expandInstances(b, scopeFor({}))
    if (!ex.ok) {
      fail(node.file, ex.pos, ex.summary, ex.detail, context)
      return
    }
    const lc = lifecycleOf(b)
    if (!lc.ok) {
      fail(node.file, lc.pos, lc.summary, lc.detail, context)
      return
    }
    if (ex.kind !== 'single') shapes.set(node.address, ex.kind)
    const planned = new Map<Key, Value>()
    let failed = false
    for (const key of ex.keys) {
      const ctx = ex.kind === 'count' ? { count: key as number } : ex.kind === 'for_each' ? { each: ex.each(key as string) } : {}
      const ar = resourceArguments(b, scopeFor(ctx))
      if (!ar.ok) {
        fail(node.file, ar.pos, ar.summary, ar.detail, context)
        failed = true
        continue
      }
      const address = instanceAddress({ mode: 'managed', type, name }, key)
      const prior = findInstance(refreshed, address)?.instance.attributes
      const p = diffInstance(schema, ar.args, prior, lc.lifecycle.ignoreChanges)
      result.items.push({ address, type, name, key, action: p.action, changes: p.changes })
      planned.set(key, complete(p.planned, schema))
    }
    if (failed) return
    values.set(
      node.address,
      ex.kind === 'count' ? ex.keys.map((k) => planned.get(k)!) : ex.kind === 'for_each' ? Object.fromEntries(ex.keys.map((k): [string, Value] => [k as string, planned.get(k)!])) : planned.get(undefined)!,
    )
  }

  for (const addr of g.order) {
    const node = g.nodes.get(addr)!
    const b = node.block
    switch (node.kind) {
      case 'variable': {
        const name = b!.labels[0]
        const context = `variable "${name}"`
        const def = b!.attrs.find((a) => a.name === 'default')
        if (Object.hasOwn(input.vars, name)) values.set(addr, input.vars[name])
        else if (def) values.set(addr, evalAt(node, def.pos, () => evalExpr(def.value, scopeFor({})), context))
        else {
          fail(node.file, node.pos, 'No value for required variable', `The root module input variable "${name}" is not set, and has no default value. Use a -var or -var-file command line argument to provide a value for this variable.`, context)
          values.set(addr, UNKNOWN)
        }
        break
      }
      case 'local':
        values.set(addr, evalAt(node, node.pos, () => evalExpr(node.value!, scopeFor({}))))
        break
      case 'data': {
        const [type, name] = b!.labels
        values.set(addr, refreshed.resources.find((r) => r.mode === 'data' && r.type === type && r.name === name)?.instances[0]?.attributes ?? UNKNOWN)
        break
      }
      case 'module':
        fail(node.file, node.pos, 'Unsupported module', 'Module calls are not supported by this lab yet.', `module "${b!.labels[0]}"`)
        values.set(addr, UNKNOWN)
        break
      case 'output': {
        const value = b!.attrs.find((a) => a.name === 'value')
        const sensitive = b!.attrs.find((a) => a.name === 'sensitive')
        const v = value ? evalAt(node, value.pos, () => evalExpr(value.value, scopeFor({})), `output "${b!.labels[0]}"`) : null
        result.outputs.push({ name: b!.labels[0], value: v, sensitive: sensitive?.value.kind === 'lit' && sensitive.value.value === true })
        break
      }
      case 'resource':
        planResource(node)
        break
    }
  }

  if (errors.length) {
    result.items = []
    result.outputs = []
    return result
  }

  // In state but no longer configured (or a count/for_each instance that went away).
  const planned = new Set(result.items.map((i) => i.address))
  for (const r of refreshed.resources) {
    if (r.mode !== 'managed') continue
    const schema = schemaFor(r.type)
    for (const inst of r.instances) {
      const address = instanceAddress(r, inst.index_key)
      if (planned.has(address)) continue
      result.items.push({
        address,
        type: r.type,
        name: r.name,
        key: inst.index_key,
        action: 'destroy',
        changes: Object.entries(inst.attributes)
          .map(([name, before]) => ({ name, before, after: null, forcesReplacement: false, sensitive: !!(schema && Object.hasOwn(schema.attrs, name) && schema.attrs[name].sensitive) }))
          .sort(byName),
      })
    }
  }
  result.items.sort(byAddress)
  result.outputs.sort(byName)
  for (const i of result.items) {
    if (i.action === 'create' || i.action === 'replace') result.summary.add++
    if (i.action === 'update') result.summary.change++
    if (i.action === 'destroy' || i.action === 'replace') result.summary.destroy++
  }
  return result
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-plan.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent. If a test fails because the walker's behavior is right and the test's fixture is wrong (for example a state fixture missing an attribute the schema defaults), fix the fixture and say so; if the code is wrong, fix the code.

- [ ] **Step 5: Append to `CONTENT_TODO.md`, run the full check, commit**

Append (read the tail first; blank line before the section):

```markdown

## terraform simulator (plan walker, TF2b-2)
- [ ] The `count` / `for_each` unknown-value errors ("Invalid count argument", "Invalid for_each argument") and their long detail text, "Missing resource instance key", "No value for required variable", "Reference to undeclared ...": summaries follow the CLI; detail wording is from memory of the Terraform language docs.
- [ ] A `for_each` over a list is accepted as a set of strings, because the lab represents sets as lists; real Terraform rejects a list ("must be a map, or set of strings, and you have provided a value of type tuple").
- [ ] Data sources are read from the data entries in state (or unknown if absent); real Terraform reads them from the provider during plan.
- [ ] Unsupported on purpose (reported as `Unsupported ...`): modules, `dynamic` blocks, `provisioner`/`connection` behavior, `variable` `validation` and `type` conversion.
- [ ] Nested blocks compare as lists of objects with exactly the attributes written; a state authored with extra provider-set keys in a nested block (for example every field of a security group rule) will show a change.
```

Run: `npm test 2>&1 | tail -8 && npm run lint 2>&1 | tail -3 && npx tsc -b`
Expected: all test files pass, lint clean, `tsc` silent.

```bash
git add src/game/terraform/plan.ts tests/terraform-plan.test.ts CONTENT_TODO.md
git commit -m "feat: Terraform plan walker: variables, locals, count/for_each, drift, destroys (TF2b-2)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done)

- **Spec coverage:** "Plan algorithm" steps 1 (refresh, via `refreshState`), 2 (evaluate config into instances, expanding `count`/`for_each`), 4 (diff by address: create / update / replace / destroy) and 6 (the data a renderer needs: items, changes, drift, outputs, summary) are covered. Step 3 (`moved`/`import`/`removed`) and step 5 (`ignore_changes` is here; `prevent_destroy` enforcement is TF2b-3) are partly deferred as stated at the top. `lifecycleOf` already parses `prevent_destroy`, `create_before_destroy` and `replace_triggered_by` so TF2b-3 only has to act on them.
- **Placeholders:** none. **Type consistency:** `Key`, `Expansion` (Task 1), `Arguments`, `Lifecycle`, `LifecycleResult` (Task 2), `PlanInput`, `PlanItem`, `PlanOutput`, `PlanResult` (Task 3) use the same names in tests and implementations; `diffInstance(schema, args, prior, ignore)` matches its TF2b-1 signature.
- **Review Focus:** all six lines have tests (cascade and real-id dependents: Task 3 first three tests; count/for_each destroys: Task 3; unknown count/for_each: Tasks 1 and 3; missing instance key: Task 3; no items on any error: Task 3 "plans nothing" assertions; ignore_changes spellings: Task 2).
- **Fixtures traced by hand:** the VPC/subnet/bucket/ecs/security-group state fixtures omit empty `tags`/`tags_all` on purpose (a prior `{}` against an omitted attribute would read as a removal); they include every attribute whose schema default differs from absent only where TF2b-1's default fallback makes the absence harmless.
