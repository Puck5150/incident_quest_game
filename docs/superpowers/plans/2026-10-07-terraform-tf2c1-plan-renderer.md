# Terraform TF2c-1: the plan renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a `PlanResult` into the text `terraform plan` prints: the symbol legend, `# addr will be created` headers, aligned `+ ~ - -/+` attribute lines with `(known after apply)`, `(sensitive value)` and `# forces replacement`, hidden-attribute counts, the drift note, the `Plan: X to add, Y to change, Z to destroy.` summary, output changes, "No changes", and boxed errors and warnings. This is what players read to diagnose, so exact layout matters more than anything else in the simulator.

**Architecture:** `render-value.ts` renders values and value differences (maps, lists, nested blocks) with the CLI's indentation rules. `render.ts` renders one resource's block (`resourceBlock`) and the whole plan (`renderPlan`). The planner gains the few facts the renderer needs (unchanged attributes, why an instance is destroyed, what a deleted resource held). No UI, no shell wiring (TF2c-2).

**Tech Stack:** TypeScript (strict), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("Plan algorithm" step 6, "Errors and honesty"). TF1 to TF2b-3b are complete. Out of scope here: colour, `terraform show` of saved plans, `-json`, `-destroy` plans, the `<=` data-read symbol, multi-line string values (heredoc style), `-target`/`-refresh-only` messages (TF2b-3c).

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, `import type` for types, `.ts` import extensions.
- No new npm dependencies.
- Tests live in `tests/*.test.ts` (vitest); `src/` is type-checked by `npx tsc -b`.
- Own-property discipline: never use `in` or `obj[userKey] = ...` on objects keyed by user-supplied names (attribute names, tags, map keys); use `Object.hasOwn`, `Object.fromEntries`, `Map`.
- Layout rules (all rendering follows these): a *row* is `' '.repeat(col) + symbol + ' ' + text` (blank symbol = a space); resource comment headers sit at column 2, the resource line's symbol at column 2 (`-/+` and `+/-` at column 0), attribute symbols at column 6, nested entries 4 columns deeper than their parent, a closing `}`/`]` has no symbol and its text lines up with the parent's text (2 columns right of the parent's symbol column), `=` signs align within each block or map, map keys are quoted, nested-block attributes are not.
- Output never ends with a trailing newline and uses `\n`.
- Layout details not verified against real Terraform output are logged in `CONTENT_TODO.md` (Task 4).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Alignment: attribute names pad to the longest name in the block, map keys to the longest quoted key in the map, and a block of one attribute has no extra padding (Task 2 and 3 tests).
2. `null → value` is `+`, `value → null` is `- … -> null`, anything else `~ a -> b`; unknown values render `(known after apply)` and sensitive ones `(sensitive value)` on both sides (Task 2 and 3 tests).
3. A replacement shows `# forces replacement` on the attribute that forces it and `(known after apply)` for what is recomputed, with the right header for each reason (Task 3 tests).
4. Lists of objects render as repeated nested blocks, and a changed block shows only changed attributes plus a hidden count (Task 2 test).
5. The legend lists only the symbols the plan uses; the summary counts replacements in both add and destroy; "No changes" and drift wording differ with and without drift (Task 4 tests).

---

### Task 1: Planner facts for the renderer

**Files:**
- Modify: `src/game/terraform/plan.ts`
- Modify: `src/game/terraform/refresh.ts`
- Modify: `tests/terraform-plan.test.ts`, `tests/terraform-state.test.ts` (update and append)

**Interfaces:**
- Produces:
  - `PlanItem.unchanged?: Record<string, Value>` — for `noop`, `update` and `replace` items that had a prior object: the prior's non-null attributes that are **not** in `changes` (includes `id`).
  - `PlanItem.destroyReason?: 'not-in-config' | 'count-index' | 'for-each-key'` — on `destroy` items: `count-index` when the resource is still declared and the instance key is a number, `for-each-key` when still declared and the key is a string, otherwise `not-in-config`.
  - `Drift.before?: Record<string, Value>` — on `kind: 'deleted'`: the attributes the object had in state.

- [ ] **Step 1: Write the failing tests**

In `tests/terraform-state.test.ts`, the refresh tests that assert a deleted drift currently expect `{ address: 'aws_vpc.main', kind: 'deleted', changes: [] }`. Update every such expectation to also include `before` (the instance's state attributes: for the sample VPC `{ id: 'vpc-1', cidr_block: '10.0.0.0/16', tags: { Name: 'main' } }`). Likewise update the plan test `'plans a create for something deleted outside Terraform'` in `tests/terraform-plan.test.ts` to expect `before: VPC`.

Append to `tests/terraform-plan.test.ts`:

```ts
describe('planConfig: facts for the renderer', () => {
  it('records the unchanged non-null attributes of an updated instance', () => {
    const r = plan('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  enable_dns_hostnames = true\n}', { state: stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }) })
    const item = r.items[0]
    expect(item.action).toBe('update')
    expect(item.unchanged).toEqual({ id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, default_security_group_id: 'sg-1' })
  })

  it('has no unchanged facts for a create or a destroy', () => {
    expect(plan(NETWORK('10.0.0.0/16')).items.every((i) => i.unchanged === undefined)).toBe(true)
    expect(plan('# none\n', { state: stateOf({ type: 'aws_vpc', name: 'old', attrs: VPC }) }).items[0].unchanged).toBeUndefined()
  })

  it('says why an instance is destroyed', () => {
    const gone = plan('# none\n', { state: stateOf({ type: 'aws_vpc', name: 'old', attrs: VPC }) })
    expect(gone.items[0].destroyReason).toBe('not-in-config')
    const buckets = stateOf(...[0, 1, 2].map((n) => ({ type: 'aws_s3_bucket', name: 'b', key: n, attrs: BUCKET(n) })))
    const counted = plan('resource "aws_s3_bucket" "b" {\n  count = 2\n  bucket = "logs-${count.index}"\n}', { state: buckets })
    expect(counted.items.find((i) => i.action === 'destroy')).toMatchObject({ address: 'aws_s3_bucket.b[2]', destroyReason: 'count-index' })
    const keyed = stateOf(...['a', 'b'].map((k) => ({ type: 'aws_s3_bucket', name: 'b', key: k, attrs: { id: `b-${k}`, arn: `arn:b-${k}`, bucket: `b-${k}`, force_destroy: false } })))
    const fe = plan('resource "aws_s3_bucket" "b" {\n  for_each = toset(["a"])\n  bucket = "b-${each.key}"\n}', { state: keyed })
    expect(fe.items.find((i) => i.action === 'destroy')).toMatchObject({ address: 'aws_s3_bucket.b["b"]', destroyReason: 'for-each-key' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/terraform-plan.test.ts tests/terraform-state.test.ts`
Expected: FAIL (no `unchanged`, no `destroyReason`, deleted drift has no `before`).

- [ ] **Step 3: Write the implementation**

In `src/game/terraform/refresh.ts`: add `before?: Record<string, Value>` to `interface Drift`, and where a deleted instance is pushed (`drift.push({ address, kind: 'deleted', changes: [] })`) add `before: structuredClone(inst.attributes)`.

In `src/game/terraform/plan.ts`:

1. Add to `PlanItem`:

```ts
  unchanged?: Record<string, Value>
  destroyReason?: 'not-in-config' | 'count-index' | 'for-each-key'
```

2. In `planResource`, where the item is pushed (`result.items.push({ address, type, name, key, action: p.action, ... })`), compute before the push:

```ts
      const changed = new Set(p.changes.map((c) => c.name))
      const unchanged = prior ? Object.fromEntries(Object.entries(prior).filter(([n, v]) => v !== null && !changed.has(n))) : undefined
```

and add `...(unchanged ? { unchanged } : {}),` to the pushed object.

3. In the orphan-destroy loop, in the object pushed for `action: 'destroy'`, add:

```ts
        destroyReason: !g.nodes.has(`${r.type}.${r.name}`) ? 'not-in-config' : typeof inst.index_key === 'number' ? 'count-index' : typeof inst.index_key === 'string' ? 'for-each-key' : 'not-in-config',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/terraform-plan.test.ts tests/terraform-state.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/plan.ts src/game/terraform/refresh.ts tests/terraform-plan.test.ts tests/terraform-state.test.ts
git commit -m "feat: plan items carry unchanged attributes and destroy reasons for the renderer (TF2c-1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Value and difference rendering

**Files:**
- Create: `src/game/terraform/render-value.ts`
- Test: `tests/terraform-render-value.test.ts`

**Interfaces:**
- Consumes: `equal`, `isUnknown`, `Value` from `./eval.ts`.
- Produces:
  - `row(col: number, sym: string, text: string): string`
  - `scalar(v: Value | undefined): string` — `"str"` (JSON-quoted), numbers, booleans, `null`, `(known after apply)`; empty list `[]`, empty map `{}`; a non-empty collection falls back to compact JSON
  - `lines(col, sym, name: string | null, width: number, v: Value): string[]` — render a whole value with one symbol: `name = value`; scalars on one row; non-empty lists as `[` … `]` with one element per row ending in `,`; non-empty maps as `{` … `}` with sorted quoted keys aligned; a non-empty list whose elements are all non-empty objects renders as repeated nested blocks `name {` … `}` with unquoted, aligned attribute names (null attributes omitted). `name === null` renders a list element (no `name =`, trailing `,` added by the caller of list rendering).
  - `diffLines(col, name: string, width: number, before: Value | undefined, after: Value, forces = false): string[]` — render `name` going from `before` to `after`: before null/undefined → `+` with the full value; after null → `-` with the full value and ` -> null` appended to the last row (no arrow for removed blocks); both maps → `~ name = {` with only added/removed/changed keys and `# (N unchanged element(s) hidden)`; both lists → `~ name = [` with an LCS diff (`+`/`-` elements, kept runs collapsed into `# (N unchanged element(s) hidden)`); block lists → per-index blocks (`+ name {` for added, `- name {` for removed, `~ name {` with only changed attributes and `# (N unchanged attribute(s) hidden)` for changed, and `# (N unchanged block(s) hidden)` for equal ones); otherwise `~ name = a -> b`. `forces` appends ` # forces replacement` to the last row.

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-render-value.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { UNKNOWN } from '../src/game/terraform/eval.ts'
import { diffLines, lines, row, scalar } from '../src/game/terraform/render-value.ts'

describe('scalar and row', () => {
  it('formats scalars and empty collections', () => {
    expect([scalar('a"b'), scalar(5), scalar(true), scalar(null), scalar(undefined), scalar(UNKNOWN), scalar([]), scalar({})]).toEqual(['"a\\"b"', '5', 'true', 'null', 'null', '(known after apply)', '[]', '{}'])
  })
  it('puts the symbol at the column and the text two columns after it', () => {
    expect(row(6, '+', 'a = 1')).toBe('      + a = 1')
    expect(row(6, ' ', '}')).toBe('        }')
  })
})

describe('lines', () => {
  it('renders scalars on one row', () => {
    expect(lines(6, '+', 'ami', 0, 'ami-1')).toEqual(['      + ami = "ami-1"'])
    expect(lines(6, '+', 'arn', 0, UNKNOWN)).toEqual(['      + arn = (known after apply)'])
    expect(lines(6, '+', 'x', 0, [])).toEqual(['      + x = []'])
  })

  it('pads the name to the width given', () => {
    expect(lines(6, '+', 'ami', 5, 'a')).toEqual(['      + ami   = "a"'])
  })

  it('renders a map with sorted, quoted, aligned keys', () => {
    expect(lines(6, '+', 'tags', 0, { Name: 'x', Env: 'prod' })).toEqual([
      '      + tags = {',
      '          + "Env"  = "prod"',
      '          + "Name" = "x"',
      '        }',
    ])
  })

  it('renders a list with one element per row', () => {
    expect(lines(6, '+', 'cidr_blocks', 0, ['10.0.0.0/8', '10.1.0.0/16'])).toEqual([
      '      + cidr_blocks = [',
      '          + "10.0.0.0/8",',
      '          + "10.1.0.0/16",',
      '        ]',
    ])
  })

  it('renders a list of objects as repeated nested blocks with unquoted aligned attributes, omitting nulls', () => {
    expect(lines(6, '+', 'ingress', 0, [{ from_port: 22, to_port: 22, note: null }, { from_port: 80, to_port: 80 }])).toEqual([
      '      + ingress {',
      '          + from_port = 22',
      '          + to_port   = 22',
      '        }',
      '      + ingress {',
      '          + from_port = 80',
      '          + to_port   = 80',
      '        }',
    ])
  })

  it('nests maps inside blocks', () => {
    expect(lines(6, '-', 'rule', 0, [{ tags: { a: '1' } }])).toEqual(['      - rule {', '          - tags = {', '              - "a" = "1"', '            }', '        }'])
  })
})

describe('diffLines: scalars and additions/removals', () => {
  it('shows a changed scalar, and an unknown replacement value', () => {
    expect(diffLines(6, 'ami', 0, 'ami-1', 'ami-2')).toEqual(['      ~ ami = "ami-1" -> "ami-2"'])
    expect(diffLines(6, 'vpc_id', 0, 'vpc-1', UNKNOWN)).toEqual(['      ~ vpc_id = "vpc-1" -> (known after apply)'])
  })

  it('marks forced replacement on the last row', () => {
    expect(diffLines(6, 'ami', 0, 'a', 'b', true)).toEqual(['      ~ ami = "a" -> "b" # forces replacement'])
    expect(diffLines(6, 'tags', 0, undefined, { A: '1' }, true).at(-1)).toBe('        } # forces replacement')
  })

  it('shows null to value as an addition and value to null as a removal', () => {
    expect(diffLines(6, 'tags', 0, undefined, { Name: 'x' })).toEqual(['      + tags = {', '          + "Name" = "x"', '        }'])
    expect(diffLines(6, 'tags', 0, null, 'x')).toEqual(['      + tags = "x"'])
    expect(diffLines(6, 'ami', 0, 'ami-1', null)).toEqual(['      - ami = "ami-1" -> null'])
    expect(diffLines(6, 'tags', 0, { Name: 'x' }, null)).toEqual(['      - tags = {', '          - "Name" = "x"', '        } -> null'])
  })
})

describe('diffLines: maps', () => {
  it('shows only added, removed and changed keys, with a hidden count', () => {
    expect(diffLines(6, 'tags', 0, { Name: 'main' }, { Name: 'main', Owner: 'ops' })).toEqual([
      '      ~ tags = {',
      '          + "Owner" = "ops"',
      '            # (1 unchanged element hidden)',
      '        }',
    ])
    expect(diffLines(6, 'tags', 0, { A: '1', B: '2', C: '3' }, { A: '1', C: 'x' })).toEqual([
      '      ~ tags = {',
      '          - "B" = "2"',
      '          ~ "C" = "3" -> "x"',
      '            # (1 unchanged element hidden)',
      '        }',
    ])
  })

  it('pluralises the hidden count and aligns shown keys', () => {
    const out = diffLines(6, 'tags', 0, { A: '1', B: '2', C: '3' }, { A: '1', B: '2', C: '3', Long: 'x' })
    expect(out[1]).toBe('          + "Long" = "x"')
    expect(out[2]).toBe('            # (3 unchanged elements hidden)')
  })
})

describe('diffLines: lists', () => {
  it('diffs lists element-wise, collapsing the unchanged run', () => {
    expect(diffLines(6, 'xs', 0, ['a', 'b'], ['a', 'c'])).toEqual([
      '      ~ xs = [',
      '            # (1 unchanged element hidden)',
      '          - "b",',
      '          + "c",',
      '        ]',
    ])
  })
})

describe('diffLines: nested blocks', () => {
  const a = [{ from_port: 22, to_port: 22 }, { from_port: 80, to_port: 80 }]
  it('shows only the changed attribute of a changed block and counts unchanged blocks', () => {
    const b = [{ from_port: 22, to_port: 22 }, { from_port: 80, to_port: 8080 }]
    expect(diffLines(6, 'ingress', 0, a, b)).toEqual([
      '      ~ ingress {',
      '          ~ to_port = 80 -> 8080',
      '            # (1 unchanged attribute hidden)',
      '        }',
      '        # (1 unchanged block hidden)',
    ])
  })

  it('adds and removes whole blocks by position', () => {
    expect(diffLines(6, 'ingress', 0, [a[0]], a)).toEqual(['      + ingress {', '          + from_port = 80', '          + to_port   = 80', '        }', '        # (1 unchanged block hidden)'])
    expect(diffLines(6, 'ingress', 0, a, [a[0]])).toEqual(['      - ingress {', '          - from_port = 80', '          - to_port   = 80', '        }', '        # (1 unchanged block hidden)'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-render-value.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/render-value.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/render-value.ts`:

```ts
// Rendering values and value differences the way `terraform plan` lays them
// out: a row is `col` spaces, a symbol, a space, then text; nested entries sit
// four columns deeper than their parent; a closing bracket has no symbol.
import { equal, isUnknown, type Value } from './eval.ts'

type Obj = { [key: string]: Value }
const isObj = (v: Value | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !isUnknown(v as Value)
const isBlockList = (v: Value | undefined): v is Obj[] => Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && Object.keys(x).length > 0)
const unchangedText = (n: number, what: string) => `# (${n} unchanged ${what}${n === 1 ? '' : 's'} hidden)`
const sorted = (keys: Iterable<string>) => [...keys].sort()

export const row = (col: number, sym: string, text: string) => `${' '.repeat(col)}${sym} ${text}`

export function scalar(v: Value | undefined): string {
  if (v === undefined || v === null) return 'null'
  if (isUnknown(v)) return '(known after apply)'
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return v.length ? JSON.stringify(v) : '[]'
  if (typeof v === 'object') return Object.keys(v).length ? JSON.stringify(v) : '{}'
  return String(v)
}

function blockLines(col: number, sym: string, name: string, o: Obj): string[] {
  const keys = sorted(Object.keys(o)).filter((k) => o[k] !== null)
  const w = Math.max(0, ...keys.map((k) => k.length))
  return [row(col, sym, `${name} {`), ...keys.flatMap((k) => lines(col + 4, sym, k, w, o[k])), row(col, ' ', '}')]
}

// `name = value` (or a bare list element when name is null) with one symbol throughout.
export function lines(col: number, sym: string, name: string | null, width: number, v: Value, tail = ''): string[] {
  const head = name === null ? '' : `${name.padEnd(width)} = `
  if (name !== null && isBlockList(v)) return v.flatMap((o) => blockLines(col, sym, name, o))
  if (Array.isArray(v) && v.length) {
    return [row(col, sym, `${head}[`), ...v.flatMap((x) => lines(col + 4, sym, null, 0, x, ',')), row(col, ' ', `]${tail}`)]
  }
  if (isObj(v) && Object.keys(v).length) {
    const keys = sorted(Object.keys(v))
    const w = Math.max(...keys.map((k) => JSON.stringify(k).length))
    return [row(col, sym, `${head}{`), ...keys.flatMap((k) => lines(col + 4, sym, JSON.stringify(k), w, v[k])), row(col, ' ', `}${tail}`)]
  }
  return [row(col, sym, `${head}${scalar(v)}${tail}`)]
}

function mapDiff(col: number, head: string, b: Obj, a: Obj): string[] {
  const keys = sorted(new Set([...Object.keys(b), ...Object.keys(a)]))
  const same = (k: string) => Object.hasOwn(b, k) && Object.hasOwn(a, k) && equal(b[k], a[k])
  const shown = keys.filter((k) => !same(k))
  const w = Math.max(0, ...shown.map((k) => JSON.stringify(k).length))
  const body = shown.flatMap((k) => {
    const kt = JSON.stringify(k)
    if (!Object.hasOwn(b, k)) return lines(col + 4, '+', kt, w, a[k])
    if (!Object.hasOwn(a, k)) return lines(col + 4, '-', kt, w, b[k])
    return diffCore(col + 4, kt, w, b[k], a[k])
  })
  const hidden = keys.length - shown.length
  return [row(col, '~', `${head}{`), ...body, ...(hidden ? [row(col + 4, ' ', unchangedText(hidden, 'element'))] : []), row(col, ' ', '}')]
}

function listDiff(col: number, head: string, b: Value[], a: Value[]): string[] {
  const m = b.length
  const n = a.length
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = equal(b[i], a[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: string[] = []
  let kept = 0
  const flush = () => {
    if (kept) out.push(row(col + 4, ' ', unchangedText(kept, 'element')))
    kept = 0
  }
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && equal(b[i], a[j])) {
      kept++
      i++
      j++
    } else if (j >= n || (i < m && dp[i + 1][j] >= dp[i][j + 1])) {
      flush()
      out.push(...lines(col + 4, '-', null, 0, b[i], ','))
      i++
    } else {
      flush()
      out.push(...lines(col + 4, '+', null, 0, a[j], ','))
      j++
    }
  }
  flush()
  return [row(col, '~', `${head}[`), ...out, row(col, ' ', ']')]
}

function blockChange(col: number, name: string, b: Obj, a: Obj): string[] {
  const keys = sorted(new Set([...Object.keys(b), ...Object.keys(a)])).filter((k) => b[k] != null || a[k] != null)
  const same = (k: string) => equal(b[k] ?? null, a[k] ?? null)
  const shown = keys.filter((k) => !same(k))
  const w = Math.max(0, ...shown.map((k) => k.length))
  const hidden = keys.length - shown.length
  return [
    row(col, '~', `${name} {`),
    ...shown.flatMap((k) => diffCore(col + 4, k, w, b[k] ?? null, a[k] ?? null)),
    ...(hidden ? [row(col + 4, ' ', unchangedText(hidden, 'attribute'))] : []),
    row(col, ' ', '}'),
  ]
}

function blockDiff(col: number, name: string, b: Obj[], a: Obj[]): string[] {
  const out: string[] = []
  let hidden = 0
  for (let i = 0; i < Math.max(b.length, a.length); i++) {
    if (i >= b.length) out.push(...blockLines(col, '+', name, a[i]))
    else if (i >= a.length) out.push(...blockLines(col, '-', name, b[i]))
    else if (equal(b[i], a[i])) hidden++
    else out.push(...blockChange(col, name, b[i], a[i]))
  }
  if (hidden) out.push(row(col, ' ', unchangedText(hidden, 'block')))
  return out
}

function diffCore(col: number, name: string, width: number, b: Value | undefined, a: Value): string[] {
  const head = `${name.padEnd(width)} = `
  if (b === undefined || b === null) return lines(col, '+', name, width, a)
  if (a === null) {
    const out = lines(col, '-', name, width, b)
    if (!isBlockList(b)) out[out.length - 1] += ' -> null'
    return out
  }
  if (isObj(b) && isObj(a)) return mapDiff(col, head, b, a)
  if (Array.isArray(b) && Array.isArray(a)) return isBlockList(b) || isBlockList(a) ? blockDiff(col, name, b as Obj[], a as Obj[]) : listDiff(col, head, b, a)
  return [row(col, '~', `${head}${scalar(b)} -> ${scalar(a)}`)]
}

export function diffLines(col: number, name: string, width: number, before: Value | undefined, after: Value, forces = false): string[] {
  const out = diffCore(col, name, width, before, after)
  if (forces && out.length) out[out.length - 1] += ' # forces replacement'
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-render-value.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent. If an expected string in the tests disagrees with the layout rules in Global Constraints, decide whether the code or the fixture is wrong, fix that, and say why in the report; never edit an expectation just to get green.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/render-value.ts tests/terraform-render-value.test.ts
git commit -m "feat: render values and value diffs in Terraform plan layout (TF2c-1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Rendering one resource

**Files:**
- Create: `src/game/terraform/render.ts` (this task adds `resourceBlock`; Task 4 adds `renderPlan` to the same file)
- Test: `tests/terraform-render.test.ts`

**Interfaces:**
- Consumes: `PlanItem` (`./plan.ts`); `diffLines`, `lines`, `row`, `scalar` (`./render-value.ts`); `UNKNOWN`, `Value` (`./eval.ts`).
- Produces: `resourceBlock(item: PlanItem): string` — the comment header lines, the resource line, the attribute lines and the closing brace for one plan item. Rules:
  - Header (`  # …`, column 2): create → `ADDR will be created`; update → `ADDR will be updated in-place`; replace → `ADDR must be replaced`, or by `reason`: `tainted` → `ADDR is tainted, so must be replaced`, `requested` → `ADDR will be replaced, as requested`, `triggered` → `ADDR will be replaced due to changes in replace_triggered_by`; destroy → `ADDR will be destroyed` followed by `  # (because …)` from `destroyReason` (`not-in-config` → `TYPE.NAME is not in configuration`; `count-index` → `index [KEY] is out of range for count`; `for-each-key` → `key ["KEY"] is not in for_each map`); forget → `ADDR will no longer be managed by Terraform, but will not be destroyed` followed by `  # (destroy = false is set in the configuration)`; noop with `movedFrom` → `OLD has moved to ADDR`; noop with `importing` → `ADDR will be imported`. For non-noop items with `movedFrom`, add `  # (moved from OLD)`; with `importing`, add `  # (imported from "ID")`.
  - Resource line: `+`/`~`/`-` at column 2, `-/+` at column 0 for replace (`+/-` if `createBeforeDestroy`), a blank symbol for noop (moved/imported) and forget; text `resource "TYPE" "NAME" {`. A `forget` item is a single row ending in `{}` with no body or closing row.
  - Attribute rows (column 6, names padded to the longest shown name): create → every change as `+ name = value`; destroy → every non-null change as `- name = value -> null`; update/replace/noop → the changed attributes via `diffLines` (with `forces` from `forcesReplacement`), merged alphabetically with an `id = …` context row when `item.unchanged` has an `id` and `id` is not itself changed, then `# (N unchanged attribute(s) hidden)` for the remaining `unchanged` entries (omitted when 0). A sensitive change renders as `(sensitive value)` for both sides (`~ name = (sensitive value)`; destroy: `- name = (sensitive value) -> null`; create: `+ name = (sensitive value)`).
  - Closing row: `    }` (column 2, blank symbol).

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-render.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { UNKNOWN } from '../src/game/terraform/eval.ts'
import type { PlanItem } from '../src/game/terraform/plan.ts'
import { resourceBlock } from '../src/game/terraform/render.ts'

const ch = (name: string, before: unknown, after: unknown, extra: { forcesReplacement?: boolean; sensitive?: boolean } = {}) =>
  ({ name, before, after, forcesReplacement: false, sensitive: false, ...extra }) as PlanItem['changes'][number]
const item = (o: Partial<PlanItem> & Pick<PlanItem, 'action'>): PlanItem => ({ address: 'aws_instance.web', type: 'aws_instance', name: 'web', changes: [], ...o })
const text = (...ls: string[]) => ls.join('\n')

describe('resourceBlock: create', () => {
  it('renders aligned additions with unknown values and maps', () => {
    const out = resourceBlock(item({ action: 'create', changes: [ch('ami', undefined, 'ami-1'), ch('arn', undefined, UNKNOWN), ch('tags', undefined, { Name: 'web' })] }))
    expect(out).toBe(
      text(
        '  # aws_instance.web will be created',
        '  + resource "aws_instance" "web" {',
        '      + ami  = "ami-1"',
        '      + arn  = (known after apply)',
        '      + tags = {',
        '          + "Name" = "web"',
        '        }',
        '    }',
      ),
    )
  })

  it('hides sensitive values', () => {
    const out = resourceBlock(item({ action: 'create', changes: [ch('password', undefined, 'hunter2', { sensitive: true })] }))
    expect(out).toContain('      + password = (sensitive value)')
    expect(out).not.toContain('hunter2')
  })
})

describe('resourceBlock: update and replace', () => {
  it('shows changes, the id as context, and a hidden count', () => {
    const out = resourceBlock(item({ action: 'update', changes: [ch('instance_type', 't3.micro', 't3.small')], unchanged: { id: 'i-1', ami: 'ami-1', arn: 'arn:i-1' } }))
    expect(out).toBe(
      text(
        '  # aws_instance.web will be updated in-place',
        '  ~ resource "aws_instance" "web" {',
        '        id            = "i-1"',
        '      ~ instance_type = "t3.micro" -> "t3.small"',
        '        # (2 unchanged attributes hidden)',
        '    }',
      ),
    )
  })

  it('shows a replacement with the forcing attribute and recomputed values', () => {
    const out = resourceBlock(
      item({ action: 'replace', changes: [ch('ami', 'ami-1', 'ami-2', { forcesReplacement: true }), ch('id', 'i-1', UNKNOWN)], unchanged: { instance_type: 't3.micro' } }),
    )
    expect(out).toBe(
      text(
        '  # aws_instance.web must be replaced',
        '-/+ resource "aws_instance" "web" {',
        '      ~ ami = "ami-1" -> "ami-2" # forces replacement',
        '      ~ id  = "i-1" -> (known after apply)',
        '        # (1 unchanged attribute hidden)',
        '    }',
      ),
    )
  })

  it('uses +/- for create_before_destroy and the right header for each reason', () => {
    const base = { action: 'replace' as const, changes: [ch('id', 'i-1', UNKNOWN)] }
    expect(resourceBlock(item({ ...base, createBeforeDestroy: true }))).toContain('+/- resource "aws_instance" "web" {')
    expect(resourceBlock(item({ ...base, reason: 'tainted' }))).toContain('  # aws_instance.web is tainted, so must be replaced')
    expect(resourceBlock(item({ ...base, reason: 'requested' }))).toContain('  # aws_instance.web will be replaced, as requested')
    expect(resourceBlock(item({ ...base, reason: 'triggered', triggeredBy: ['aws_vpc.main'] }))).toContain('  # aws_instance.web will be replaced due to changes in replace_triggered_by')
  })

  it('hides sensitive changes on both sides', () => {
    const out = resourceBlock(item({ action: 'update', changes: [ch('password', 'old', 'new', { sensitive: true })], unchanged: {} }))
    expect(out).toContain('      ~ password = (sensitive value)')
    expect(out).not.toContain('old')
  })

  it('renders a changed nested block list', () => {
    const out = resourceBlock(
      item({ action: 'update', address: 'aws_security_group.web', type: 'aws_security_group', name: 'web', changes: [ch('ingress', [{ from_port: 22, to_port: 22 }], [{ from_port: 22, to_port: 2222 }])], unchanged: { id: 'sg-1' } }),
    )
    expect(out).toBe(
      text(
        '  # aws_security_group.web will be updated in-place',
        '  ~ resource "aws_security_group" "web" {',
        '        id      = "sg-1"',
        '      ~ ingress {',
        '          ~ to_port = 22 -> 2222',
        '            # (1 unchanged attribute hidden)',
        '        }',
        '    }',
      ),
    )
  })
})

describe('resourceBlock: destroy, move, import, forget', () => {
  const gone = [ch('ami', 'ami-1', null), ch('id', 'i-1', null), ch('tags', null, null)]

  it('renders a destroy with its reason', () => {
    expect(resourceBlock(item({ action: 'destroy', address: 'aws_instance.old', name: 'old', changes: gone, destroyReason: 'not-in-config' }))).toBe(
      text(
        '  # aws_instance.old will be destroyed',
        '  # (because aws_instance.old is not in configuration)',
        '  - resource "aws_instance" "old" {',
        '      - ami = "ami-1" -> null',
        '      - id  = "i-1" -> null',
        '    }',
      ),
    )
  })

  it('explains count and for_each destroys', () => {
    const b = { action: 'destroy' as const, type: 'aws_s3_bucket', name: 'b', changes: [ch('id', 'x', null)] }
    expect(resourceBlock(item({ ...b, address: 'aws_s3_bucket.b[2]', key: 2, destroyReason: 'count-index' }))).toContain('  # (because index [2] is out of range for count)')
    expect(resourceBlock(item({ ...b, address: 'aws_s3_bucket.b["c"]', key: 'c', destroyReason: 'for-each-key' }))).toContain('  # (because key ["c"] is not in for_each map)')
  })

  it('renders a pure move', () => {
    expect(resourceBlock(item({ action: 'noop', address: 'aws_db_instance.primary', type: 'aws_db_instance', name: 'primary', movedFrom: 'aws_db_instance.orders', unchanged: { id: 'db-1', engine: 'postgres' } }))).toBe(
      text(
        '  # aws_db_instance.orders has moved to aws_db_instance.primary',
        '    resource "aws_db_instance" "primary" {',
        '        id = "db-1"',
        '        # (1 unchanged attribute hidden)',
        '    }',
      ),
    )
  })

  it('renders an import, and notes the import and the move on changed items', () => {
    expect(resourceBlock(item({ action: 'noop', address: 'aws_s3_bucket.b', type: 'aws_s3_bucket', name: 'b', importing: 'legacy', unchanged: { id: 'legacy' } }))).toContain('  # aws_s3_bucket.b will be imported')
    const upd = resourceBlock(item({ action: 'update', importing: 'legacy', movedFrom: 'aws_instance.old', changes: [ch('a', 1, 2)], unchanged: {} }))
    expect(upd).toContain('  # (moved from aws_instance.old)')
    expect(upd).toContain('  # (imported from "legacy")')
  })

  it('renders forget as a single resource row', () => {
    expect(resourceBlock(item({ action: 'forget', address: 'aws_vpc.old', type: 'aws_vpc', name: 'old' }))).toBe(
      text('  # aws_vpc.old will no longer be managed by Terraform, but will not be destroyed', '  # (destroy = false is set in the configuration)', '    resource "aws_vpc" "old" {}'),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-render.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/render.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/render.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-render.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/render.ts tests/terraform-render.test.ts
git commit -m "feat: render a single plan item in Terraform layout (TF2c-1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The whole plan

**Files:**
- Modify: `src/game/terraform/render.ts` (append `renderPlan`)
- Modify: `tests/terraform-render.test.ts` (append)
- Modify: `CONTENT_TODO.md` (append a section)

**Interfaces:**
- Consumes: `PlanResult` (`./plan.ts`), `findInstance` (`./state.ts`), `formatDiagnostic` (`./diag.ts`), `resourceBlock` and `lines`/`diffLines`/`row`.
- Produces: `renderPlan(r: PlanResult, sources?: Record<string, string>): string`. Layout, in order:
  1. If `r.diagnostics` is non-empty: every warning then every error as `formatDiagnostic(d, sources[d.file] ?? '')`, joined by a blank line. Nothing else.
  2. The **drift note**, if `r.drift` is non-empty: `Note: Objects have changed outside of Terraform`, blank line, the two-line explanation `Terraform detected the following changes made outside of Terraform since the\nlast "terraform apply" which may have affected this plan:`, blank line, one block per drifted object (`  # ADDR has changed` + `  ~ resource "T" "N" {` with the changed attributes via `diffLines`, the `id` as context when the refreshed state has one, and a hidden-attribute count; `  # ADDR has been deleted` + `  - resource "T" "N" {` listing `Drift.before` as `- name = value` rows, for a deleted object), a blank line between blocks, then a blank line and `Unless you have made equivalent changes to your configuration, or ignored the\nrelevant attributes using ignore_changes, the following plan may include\nactions to undo or respond to these changes.`, a blank line, a row of 77 `─` characters, and a blank line.
  3. If no item has a visible action (`create`/`update`/`replace`/`destroy`/`forget`, a move, or an import) and outputs are unchanged: `No changes. Your infrastructure matches the configuration.` + blank + `Terraform has compared your real infrastructure against your configuration\nand found no differences, so no changes are needed.` — or, if there was drift, `No changes. Your infrastructure still matches the configuration.` + blank + `Terraform has checked that the real remote objects still match the result of your most recent changes, and found no differences.`
  4. Otherwise: the legend (`Terraform used the selected providers to generate the following execution\nplan. Resource actions are indicated with the following symbols:` then only the used symbols in this order: `  + create`, `  ~ update in-place`, `  - destroy`, `-/+ destroy and then create replacement`, `+/- create replacement and then destroy`; omitted entirely if the plan only has moves/imports/forgets), a blank line, `Terraform will perform the following actions:`, a blank line, the resource blocks (visible items only, in item order) separated by blank lines, a blank line, and `Plan: [N to import, ]A to add, C to change, D to destroy.` (the import part only when `r.imported > 0`).
  5. If outputs changed (compared with `r.refreshed.outputs`): a blank line, `Changes to Outputs:`, then `  + name = value` for new, `  ~ name = old -> new` for changed, `  - name = old -> null` for removed outputs, names padded; sensitive outputs print `(sensitive value)`.
  6. Warnings, each as a boxed diagnostic after a blank line.

- [ ] **Step 1: Write the failing test**

Append to `tests/terraform-render.test.ts` (adding imports `renderPlan` from `../src/game/terraform/render.ts` and `type PlanResult` from `../src/game/terraform/plan.ts`, `emptyState` from `../src/game/terraform/state.ts`):

```ts
const result = (o: Partial<PlanResult> = {}): PlanResult => ({
  diagnostics: [],
  warnings: [],
  drift: [],
  items: [],
  outputs: [],
  imported: 0,
  refreshed: emptyState(),
  summary: { add: 0, change: 0, destroy: 0 },
  ...o,
})

describe('renderPlan', () => {
  it('renders a create and a destroy with the legend, blocks and summary', () => {
    const r = result({
      items: [
        item({ action: 'create', address: 'aws_instance.new', name: 'new', changes: [ch('ami', undefined, 'ami-1')] }),
        item({ action: 'destroy', address: 'aws_instance.old', name: 'old', changes: [ch('ami', 'ami-0', null)], destroyReason: 'not-in-config' }),
      ],
      summary: { add: 1, change: 0, destroy: 1 },
    })
    expect(renderPlan(r)).toBe(
      text(
        'Terraform used the selected providers to generate the following execution',
        'plan. Resource actions are indicated with the following symbols:',
        '  + create',
        '  - destroy',
        '',
        'Terraform will perform the following actions:',
        '',
        '  # aws_instance.new will be created',
        '  + resource "aws_instance" "new" {',
        '      + ami = "ami-1"',
        '    }',
        '',
        '  # aws_instance.old will be destroyed',
        '  # (because aws_instance.old is not in configuration)',
        '  - resource "aws_instance" "old" {',
        '      - ami = "ami-0" -> null',
        '    }',
        '',
        'Plan: 1 to add, 0 to change, 1 to destroy.',
      ),
    )
  })

  it('lists the replace symbols, and only the ones used', () => {
    const r = result({ items: [item({ action: 'replace', changes: [ch('id', 'i-1', UNKNOWN)] })], summary: { add: 1, change: 0, destroy: 1 } })
    const out = renderPlan(r)
    expect(out).toContain('plan. Resource actions are indicated with the following symbols:\n-/+ destroy and then create replacement\n')
    expect(out).not.toContain('  + create')
    expect(renderPlan(result({ items: [item({ action: 'replace', createBeforeDestroy: true, changes: [ch('id', 'i-1', UNKNOWN)] })] }))).toContain('+/- create replacement and then destroy')
  })

  it('counts imports in the summary and leaves out the legend for a moves-only plan', () => {
    const moved = item({ action: 'noop', address: 'aws_db_instance.primary', type: 'aws_db_instance', name: 'primary', movedFrom: 'aws_db_instance.orders', unchanged: { id: 'db-1' } })
    const out = renderPlan(result({ items: [moved] }))
    expect(out.startsWith('Terraform will perform the following actions:\n\n  # aws_db_instance.orders has moved to aws_db_instance.primary')).toBe(true)
    expect(out.endsWith('Plan: 0 to add, 0 to change, 0 to destroy.')).toBe(true)
    const imp = item({ action: 'noop', importing: 'legacy', unchanged: { id: 'legacy' } })
    expect(renderPlan(result({ items: [imp], imported: 1 }))).toContain('Plan: 1 to import, 0 to add, 0 to change, 0 to destroy.')
  })

  it('says there are no changes, with different wording after drift', () => {
    expect(renderPlan(result({ items: [item({ action: 'noop', unchanged: { id: 'i-1' } })] }))).toBe(
      text('No changes. Your infrastructure matches the configuration.', '', 'Terraform has compared your real infrastructure against your configuration', 'and found no differences, so no changes are needed.'),
    )
    const drifted = renderPlan(result({ drift: [{ address: 'aws_vpc.main', kind: 'changed', changes: [{ name: 'tags', before: { A: '1' }, after: { A: '2' } }] }], refreshed: stateWith('aws_vpc', 'main', { id: 'vpc-1', tags: { A: '2' }, cidr_block: 'x' }) }))
    expect(drifted).toContain('No changes. Your infrastructure still matches the configuration.')
    expect(drifted).toContain('Note: Objects have changed outside of Terraform')
  })

  it('renders drift above the plan, for a changed and a deleted object', () => {
    const r = result({
      drift: [
        { address: 'aws_vpc.main', kind: 'changed', changes: [{ name: 'tags', before: { Name: 'main' }, after: { Name: 'main', Owner: 'ops' } }] },
        { address: 'aws_subnet.gone', kind: 'deleted', changes: [], before: { id: 'subnet-1', cidr_block: '10.0.1.0/24' } },
      ],
      refreshed: stateWith('aws_vpc', 'main', { id: 'vpc-1', tags: { Name: 'main', Owner: 'ops' }, cidr_block: '10.0.0.0/16' }),
      items: [item({ action: 'create', address: 'aws_subnet.gone', type: 'aws_subnet', name: 'gone', changes: [ch('cidr_block', undefined, '10.0.1.0/24')] })],
      summary: { add: 1, change: 0, destroy: 0 },
    })
    expect(renderPlan(r).split('\nTerraform used the selected providers')[0]).toBe(
      text(
        'Note: Objects have changed outside of Terraform',
        '',
        'Terraform detected the following changes made outside of Terraform since the',
        'last "terraform apply" which may have affected this plan:',
        '',
        '  # aws_vpc.main has changed',
        '  ~ resource "aws_vpc" "main" {',
        '        id   = "vpc-1"',
        '      ~ tags = {',
        '          + "Owner" = "ops"',
        '            # (1 unchanged element hidden)',
        '        }',
        '        # (1 unchanged attribute hidden)',
        '    }',
        '',
        '  # aws_subnet.gone has been deleted',
        '  - resource "aws_subnet" "gone" {',
        '      - cidr_block = "10.0.1.0/24" -> null',
        '      - id         = "subnet-1" -> null',
        '    }',
        '',
        'Unless you have made equivalent changes to your configuration, or ignored the',
        'relevant attributes using ignore_changes, the following plan may include',
        'actions to undo or respond to these changes.',
        '',
        '─'.repeat(77),
        '',
      ),
    )
  })

  it('shows output changes against the outputs already in state', () => {
    const refreshed = emptyState()
    refreshed.outputs = { name: { value: 'old' }, same: { value: 1 }, gone: { value: 'x' } }
    const r = result({
      items: [item({ action: 'create', changes: [ch('ami', undefined, 'a')] })],
      outputs: [
        { name: 'id', value: UNKNOWN, sensitive: false },
        { name: 'name', value: 'new', sensitive: false },
        { name: 'same', value: 1, sensitive: false },
        { name: 'secret', value: 'hunter2', sensitive: true },
      ],
      refreshed,
      summary: { add: 1, change: 0, destroy: 0 },
    })
    const out = renderPlan(r)
    expect(out.split('Plan: 1 to add, 0 to change, 0 to destroy.\n\n')[1]).toBe(
      text('Changes to Outputs:', '  - gone   = "x" -> null', '  + id     = (known after apply)', '  ~ name   = "old" -> "new"', '  + secret = (sensitive value)'),
    )
  })

  it('prints errors only, with the source line, and appends warnings after a plan', () => {
    const err = { severity: 'error' as const, summary: 'Bad', detail: 'short', file: 'main.tf', line: 2, col: 1, context: 'resource "a" "b"' }
    const out = renderPlan(result({ diagnostics: [err] }), { 'main.tf': 'x\n  oops\n' })
    expect(out).toBe(text('╷', '│ Error: Bad', '│ ', '│   on main.tf line 2, in resource "a" "b":', '│    2:   oops', '│ ', '│ short', '╵'))
    const warn = { severity: 'warning' as const, summary: 'Careful', detail: '', file: '', line: 0, col: 0 }
    const withWarning = renderPlan(result({ items: [item({ action: 'create', changes: [ch('a', undefined, 1)] })], summary: { add: 1, change: 0, destroy: 0 }, warnings: [warn] }))
    expect(withWarning.endsWith('\n\n╷\n│ Warning: Careful\n╵')).toBe(true)
  })
})
```

Also add this helper near the top of the file's helpers:

```ts
import type { State } from '../src/game/terraform/state.ts'
const stateWith = (type: string, name: string, attributes: Record<string, unknown>): State => {
  const s = emptyState()
  s.resources.push({ mode: 'managed', type, name, provider: 'p', instances: [{ attributes: attributes as never }] })
  return s
}
```

(Place the `import type { State }` with the other imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-render.test.ts`
Expected: FAIL ("renderPlan is not exported").

- [ ] **Step 3: Write the implementation**

In `src/game/terraform/render.ts` add the imports `import { formatDiagnostic } from './diag.ts'`, `import { equal, type Value } from './eval.ts'`, `import { findInstance } from './state.ts'`, `import type { PlanResult } from './plan.ts'` (merge with the existing `PlanItem` type import), and append:

```ts
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
```

Note the final `join`: the drift note already ends with a blank line after the rule; plan sections and warnings are separated by a single blank line. If this join logic produces an extra or missing blank line against the tests above, adjust the joiner (build the final string from an explicit list of sections and separators) rather than the tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-render.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent. Fix code or fixtures per the Task 2 rule, recording each decision.

- [ ] **Step 5: Append to `CONTENT_TODO.md`, run the full check, commit**

Append (read the tail first; blank line before the section):

```markdown

## terraform simulator (plan renderer, TF2c-1)
Layout reproduced from memory of Terraform 1.x CLI output; check each against a real `terraform plan`.
- [ ] Legend wording and symbols (`+ create`, `~ update in-place`, `- destroy`, `-/+ destroy and then create replacement`, `+/- create replacement and then destroy`); omitted entirely for a moves-only plan.
- [ ] Comment headers: `will be created`, `will be updated in-place`, `must be replaced`, `is tainted, so must be replaced`, `will be replaced, as requested`, `will be replaced due to changes in replace_triggered_by`, `will be destroyed` with `(because … is not in configuration | index […] is out of range for count | key […] is not in for_each map)`, `has moved to`, `will be imported`, and the forget wording.
- [ ] Which unchanged attributes are shown as context in an update (this renders only `id`; real Terraform also shows some nested containers and names) and how hidden attributes are counted (here: non-null attributes of the prior object).
- [ ] The forget block (a single `resource "t" "n" {}` row with no symbol) is a guess.
- [ ] Block-list attributes (`ingress`, …) are rendered as nested blocks by position; real Terraform matches blocks by schema (set-typed blocks have no order) and prints them with its own diff algorithm.
- [ ] Map and list diff layout (`# (N unchanged elements hidden)`, `-> null` after a removed map, `# forces replacement` placement) and the `Plan: N to import, …` summary format.
- [ ] Drift note text and the 77-character rule; the "No changes. Your infrastructure still matches the configuration." variant after drift.
- [ ] Output-change block (`Changes to Outputs:`) and its alignment; real Terraform also prints an `apply` hint when only outputs change.
- [ ] Not rendered: multi-line string values, `<=` data reads, `-target` and `-refresh-only` banners, colour.
```

Run: `npm test 2>&1 | tail -8 && npm run lint 2>&1 | tail -3 && npx tsc -b`
Expected: all test files pass, lint clean, `tsc` silent.

```bash
git add src/game/terraform/render.ts tests/terraform-render.test.ts CONTENT_TODO.md
git commit -m "feat: render a whole plan: legend, drift, summary, outputs, diagnostics (TF2c-1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done)

- **Spec coverage:** "Plan algorithm" step 6 (render in the real CLI format including `(known after apply)`, `(sensitive value)`, hidden attribute counts, the `Plan:` summary) is covered; "Errors and honesty" boxed diagnostics reuse `formatDiagnostic`. Not here: the `terraform` command itself and the scenario block (TF2c-2).
- **Placeholders:** none. **Type consistency:** `PlanItem.unchanged`, `destroyReason`, `Drift.before`, `resourceBlock`, `renderPlan`, `row`, `scalar`, `lines`, `diffLines` use the same names and signatures across tasks and tests.
- **Fixtures traced by hand:** Task 2/3 expected strings were derived from the layout rules in Global Constraints (symbol column 6 for attributes; map entries at 10; closing text at 8; blocks' attributes unquoted; `=` aligned to the longest shown name). The Task 4 drift fixture's alignment (`id` and `tags` padded to the width of the changed attribute names plus `id`) was derived the same way.
- **Known fragility:** Task 4's final `join`/`replace` that normalises blank lines is the most likely place for a small mismatch; the task says to restructure the joiner, not the tests, if it disagrees.
