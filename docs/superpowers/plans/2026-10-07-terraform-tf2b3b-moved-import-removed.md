# Terraform TF2b-3b: `moved`, `import` and `removed` blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the plan walker honor the three blocks that change *what state means*: `moved` (rename or re-key resources without destroying them), `import` (bring an existing cloud object under management), and `removed` (stop managing a resource without destroying it). These are the fixes for the classic "no-op refactor wants to delete the database", "resource already exists" and "I want Terraform to forget this" situations.

**Architecture:** `addresses.ts` parses resource addresses out of expressions. `moves.ts` reads `moved` blocks and applies them to a `State` (chains, keyed and whole-resource moves, collisions, cycles). `declarations.ts` reads `removed` and `import` blocks. `plan.ts` applies moves to the refreshed state before planning, turns an `import` into a prior object read from the simulated cloud, and plans `removed` resources as `forget` instead of `destroy`. The graph gains `blocks` and treats an import `id` expression's references as dependencies of its target resource.

**Tech Stack:** TypeScript (strict), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("Plan algorithm" step 3, "Errors and honesty"). TF1, TF2a, TF2b-1, TF2b-2 and TF2b-3a are complete. Out of scope here (TF2b-3c): `-target`, `-refresh-only`, attribute- and instance-level `replace_triggered_by`, modules, `dynamic` blocks, the `terraform import` / `terraform state mv` / `state rm` commands (TF3).

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, `import type` for types, `.ts` import extensions.
- No new npm dependencies.
- Tests live in `tests/*.test.ts` (vitest); `src/` is type-checked by `npx tsc -b`.
- Own-property discipline: never use `in` or `obj[userKey] = ...` on objects keyed by user-supplied names.
- A configuration with any *error* produces diagnostics and **no plan items**; warnings never block a plan.
- Unsupported constructs give an honest diagnostic, never invented behavior. Error wording follows real Terraform where known; unverified wording is logged in `CONTENT_TODO.md` (Task 4).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A `moved` block turns "destroy the old address, create the new one" into a no-op that records `movedFrom`, for renames, `count`⇄`for_each` re-keying, and chains (`a→b`, `b→c`); the same configuration *without* the block still shows the destroy-and-create (Task 4 tests).
2. `moved` never touches data sources, never moves onto an address that is already occupied (error, not silent overwrite), and reports a cycle instead of hanging (Task 2 tests).
3. `import` only applies to something that is not already in state, reads the object from the simulated cloud, shows a diff against the configuration, and fails with the real errors when the id does not exist or the target is not configured (Task 4 tests).
4. An `import` id that uses a variable or local is evaluated after that variable or local (graph dependency) (Task 1 and 4 tests).
5. `removed` with `destroy = false` plans `forget` (no destroy count, no `prevent_destroy` check), with `destroy = true` or no lifecycle plans `destroy`, and a still-declared resource is an error (Task 4 tests).

---

### Task 1: Addresses, and the graph's `blocks` and import dependencies

**Files:**
- Create: `src/game/terraform/addresses.ts`
- Modify: `src/game/terraform/graph.ts`
- Test: `tests/terraform-addresses.test.ts`, and append to `tests/terraform-graph.test.ts`

**Interfaces:**
- Produces (`addresses.ts`): `interface Address { type: string; name: string; key?: string | number }`; `parseAddress(e: Expr): Address | undefined` — accepts `type.name`, `type.name[0]`, `type.name["k"]`; returns `undefined` for anything else (other shapes, and references rooted at `var`, `local`, `module`, `data`, `each`, `count`, `path`, `terraform`, `self`).
- Produces (`graph.ts`): `Graph.blocks: Block[]` (every parsed top-level block, in file order); an `import` block's `id` references become dependencies of the resource named by its `to`.

- [ ] **Step 1: Write the failing tests**

Create `tests/terraform-addresses.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseAddress } from '../src/game/terraform/addresses.ts'
import { parseHcl } from '../src/game/terraform/parse.ts'

const addr = (src: string) => {
  const r = parseHcl('main.tf', `locals {\n  v = ${src}\n}`)
  if (r.diagnostics.length) throw new Error(r.diagnostics[0].summary)
  return parseAddress(r.blocks[0].attrs[0].value)
}

describe('parseAddress', () => {
  it('reads a resource, a counted instance and a keyed instance', () => {
    expect(addr('aws_vpc.main')).toEqual({ type: 'aws_vpc', name: 'main' })
    expect(addr('aws_subnet.s[0]')).toEqual({ type: 'aws_subnet', name: 's', key: 0 })
    expect(addr('aws_s3_bucket.b["logs"]')).toEqual({ type: 'aws_s3_bucket', name: 'b', key: 'logs' })
  })

  it('rejects everything else', () => {
    for (const s of ['aws_vpc', 'aws_vpc.main.id', 'var.x', 'local.x', 'module.m', 'data.aws_ami.x', 'each.key', 'count.index', '"aws_vpc.main"', '1', 'aws_vpc.main[var.k]', 'aws_vpc.main[0][1]', 'aws_vpc.main[true]']) {
      expect(addr(s), s).toBeUndefined()
    }
  })
})
```

Append to `tests/terraform-graph.test.ts`:

```ts
describe('graph: blocks and import dependencies', () => {
  it('exposes every parsed top-level block', () => {
    const r = g('resource "aws_vpc" "a" {}\nmoved {\n  from = aws_vpc.old\n  to   = aws_vpc.a\n}\n')
    expect(r.blocks.map((b) => b.type)).toEqual(['resource', 'moved'])
  })

  it('makes the target resource depend on what an import id references, and does not treat moved/import addresses as references', () => {
    const r = g('variable "name" {\n  default = "x"\n}\nresource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\nimport {\n  to = aws_s3_bucket.b\n  id = var.name\n}\nmoved {\n  from = aws_s3_bucket.gone\n  to   = aws_s3_bucket.b\n}\n')
    expect(r.diagnostics).toEqual([])
    expect(r.nodes.get('aws_s3_bucket.b')!.deps).toEqual(['var.name'])
    expect(r.order).toEqual(['var.name', 'aws_s3_bucket.b'])
  })

  it('reports an undeclared variable used by an import id', () => {
    const r = g('resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\nimport {\n  to = aws_s3_bucket.b\n  id = var.nope\n}\n')
    expect(r.diagnostics[0].summary).toBe('Reference to undeclared input variable')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/terraform-addresses.test.ts tests/terraform-graph.test.ts`
Expected: FAIL (`addresses.ts` missing; `r.blocks` undefined).

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/addresses.ts`:

```ts
// Resource addresses as written in moved / removed / import blocks.
import type { Expr } from './types.ts'

export interface Address {
  type: string
  name: string
  key?: string | number
}

const NOT_RESOURCES = new Set(['var', 'local', 'module', 'data', 'each', 'count', 'path', 'terraform', 'self'])

// aws_vpc.main, aws_subnet.s[0], aws_s3_bucket.b["k"]; anything else is not an address.
export function parseAddress(e: Expr): Address | undefined {
  const isResource = (p: string[]) => p.length === 2 && !NOT_RESOURCES.has(p[0])
  if (e.kind === 'ref') return isResource(e.path) ? { type: e.path[0], name: e.path[1] } : undefined
  if (e.kind === 'idx' && e.base.kind === 'ref' && isResource(e.base.path) && e.index.kind === 'lit' && (typeof e.index.value === 'string' || typeof e.index.value === 'number')) {
    return { type: e.base.path[0], name: e.base.path[1], key: e.index.value }
  }
  return undefined
}
```

In `src/game/terraform/graph.ts`:

1. `import { parseAddress } from './addresses.ts'` at the top.
2. Add `blocks: Block[]` to `interface Graph` (comment: every parsed top-level block, in file order).
3. In `buildGraph`, after the loop that creates nodes (the `for (const b of blocks)` loop that calls `put(...)`) and before the loop that resolves references into dependencies, add:

```ts
  // An import block's id may use variables and locals, so its target resource depends on them.
  for (const b of blocks) {
    if (b.type !== 'import') continue
    const to = b.attrs.find((a) => a.name === 'to')
    const id = b.attrs.find((a) => a.name === 'id')
    const addr = to && parseAddress(to.value)
    const node = addr && nodes.get(`${addr.type}.${addr.name}`)
    if (node && id) exprRefs(id.value, node.refs)
  }
```

4. Include `blocks` in both `return` statements of `buildGraph` (`return { nodes, order: [], blocks, diagnostics }` and `return { nodes, order, blocks, diagnostics }`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/terraform-addresses.test.ts tests/terraform-graph.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/addresses.ts src/game/terraform/graph.ts tests/terraform-addresses.test.ts tests/terraform-graph.test.ts
git commit -m "feat: resource address parsing; graph exposes blocks and import dependencies (TF2b-3b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `moved` blocks

**Files:**
- Create: `src/game/terraform/moves.ts`
- Test: `tests/terraform-moves.test.ts`

**Interfaces:**
- Consumes: `Address`, `parseAddress` (Task 1); `instanceAddress`, `State`, `StateResource` (`./state.ts`); `Block`, `Diagnostic`, `Pos` (`./types.ts`).
- Produces:
  - `interface Move { from: Address; to: Address; file: string; pos: Pos }`
  - `movesOf(blocks: Block[]): { moves: Move[]; diagnostics: Diagnostic[] }` — errors: `Missing required argument` (no `from`/`to`), `Invalid "from" address` / `Invalid "to" address`, `Resource type mismatch` (different resource types)
  - `applyMoves(state: State, moves: Move[]): { state: State; moved: Map<string, string>; diagnostics: Diagnostic[] }` — returns a new state (the input is not mutated); `moved` maps each moved instance's **new** address to its **old** one; data sources never move; chains are followed; a destination that is already occupied (or two sources landing on one address) gives `Cannot move to existing object`; a cycle gives `Cycle in move statements`.
  - Matching rules: a move with no `from` key matches every instance of that resource, and keeps each instance's key unless `to` has a key (then the lone unkeyed instance takes the `to` key); a move with a `from` key matches only that key and gives the instance the `to` key (or no key).

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-moves.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseHcl } from '../src/game/terraform/parse.ts'
import { applyMoves, movesOf } from '../src/game/terraform/moves.ts'
import { emptyState, listAddresses, type State } from '../src/game/terraform/state.ts'

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]'
const moves = (hcl: string) => {
  const r = parseHcl('main.tf', hcl)
  if (r.diagnostics.length) throw new Error(r.diagnostics[0].summary)
  return movesOf(r.blocks)
}
const MV = (from: string, to: string) => `moved {\n  from = ${from}\n  to   = ${to}\n}\n`
const stateWith = (...res: { type: string; name: string; keys?: (string | number)[]; mode?: 'managed' | 'data' }[]): State => {
  const s = emptyState()
  for (const r of res) {
    s.resources.push({
      mode: r.mode ?? 'managed',
      type: r.type,
      name: r.name,
      provider: AWS,
      instances: (r.keys ?? [undefined]).map((k) => ({ ...(k === undefined ? {} : { index_key: k }), attributes: { id: `${r.name}-${k ?? 'x'}` } })),
    })
  }
  return s
}
const run = (hcl: string, state: State) => applyMoves(state, moves(hcl).moves)

describe('movesOf', () => {
  it('reads from and to addresses', () => {
    const r = moves(MV('aws_db_instance.orders', 'aws_db_instance.primary') + MV('aws_s3_bucket.b[0]', 'aws_s3_bucket.b["a"]'))
    expect(r.diagnostics).toEqual([])
    expect(r.moves.map((m) => [m.from, m.to])).toEqual([
      [{ type: 'aws_db_instance', name: 'orders' }, { type: 'aws_db_instance', name: 'primary' }],
      [{ type: 'aws_s3_bucket', name: 'b', key: 0 }, { type: 'aws_s3_bucket', name: 'b', key: 'a' }],
    ])
  })

  it('reports missing arguments, bad addresses and a type mismatch', () => {
    expect(moves('moved {\n  from = aws_vpc.a\n}\n').diagnostics[0]).toMatchObject({ summary: 'Missing required argument', detail: 'The argument "to" is required, but no definition was found.' })
    expect(moves(MV('aws_vpc.a.id', 'aws_vpc.b')).diagnostics[0].summary).toBe('Invalid "from" address')
    expect(moves(MV('aws_vpc.a', 'var.x')).diagnostics[0].summary).toBe('Invalid "to" address')
    expect(moves(MV('aws_vpc.a', 'aws_subnet.b')).diagnostics[0]).toMatchObject({ summary: 'Resource type mismatch', file: 'main.tf', line: 1 })
    expect(moves(MV('aws_vpc.a', 'aws_subnet.b')).moves).toEqual([])
  })
})

describe('applyMoves', () => {
  it('renames a resource, keeping instance keys, and reports old addresses', () => {
    const r = run(MV('aws_s3_bucket.old', 'aws_s3_bucket.new'), stateWith({ type: 'aws_s3_bucket', name: 'old', keys: ['a', 'b'] }, { type: 'aws_vpc', name: 'v' }))
    expect(r.diagnostics).toEqual([])
    expect(listAddresses(r.state)).toEqual(['aws_s3_bucket.new["a"]', 'aws_s3_bucket.new["b"]', 'aws_vpc.v'])
    expect(Object.fromEntries(r.moved)).toEqual({ 'aws_s3_bucket.new["a"]': 'aws_s3_bucket.old["a"]', 'aws_s3_bucket.new["b"]': 'aws_s3_bucket.old["b"]' })
  })

  it('re-keys single instances: count index to for_each key, and a lone instance to [0]', () => {
    const r = run(MV('aws_s3_bucket.b[0]', 'aws_s3_bucket.b["a"]') + MV('aws_s3_bucket.b[1]', 'aws_s3_bucket.b["b"]'), stateWith({ type: 'aws_s3_bucket', name: 'b', keys: [0, 1] }))
    expect(listAddresses(r.state)).toEqual(['aws_s3_bucket.b["a"]', 'aws_s3_bucket.b["b"]'])
    const one = run(MV('aws_vpc.v', 'aws_vpc.v[0]'), stateWith({ type: 'aws_vpc', name: 'v' }))
    expect(listAddresses(one.state)).toEqual(['aws_vpc.v[0]'])
    expect(one.moved.get('aws_vpc.v[0]')).toBe('aws_vpc.v')
  })

  it('follows chains, so a to b and b to c ends at c', () => {
    const r = run(MV('aws_vpc.a', 'aws_vpc.b') + MV('aws_vpc.b', 'aws_vpc.c'), stateWith({ type: 'aws_vpc', name: 'a' }))
    expect(listAddresses(r.state)).toEqual(['aws_vpc.c'])
    expect(r.moved.get('aws_vpc.c')).toBe('aws_vpc.a')
  })

  it('does nothing when nothing matches, never touches data sources, and does not mutate the input', () => {
    const s = stateWith({ type: 'aws_vpc', name: 'a' }, { type: 'aws_ami', name: 'a', mode: 'data' })
    const copy = structuredClone(s)
    const r = run(MV('aws_vpc.zzz', 'aws_vpc.b') + MV('aws_ami.a', 'aws_ami.b'), s)
    expect(r.diagnostics).toEqual([])
    expect(r.moved.size).toBe(0)
    expect(listAddresses(r.state)).toEqual(['aws_vpc.a', 'data.aws_ami.a'])
    expect(s).toEqual(copy)
  })

  it('refuses to move onto an occupied address', () => {
    const r = run(MV('aws_vpc.a', 'aws_vpc.b'), stateWith({ type: 'aws_vpc', name: 'a' }, { type: 'aws_vpc', name: 'b' }))
    expect(r.diagnostics[0]).toMatchObject({ severity: 'error', summary: 'Cannot move to existing object' })
    expect(r.diagnostics[0].detail).toContain('aws_vpc.b')
  })

  it('reports a cycle instead of looping', () => {
    const r = run(MV('aws_vpc.a', 'aws_vpc.b') + MV('aws_vpc.b', 'aws_vpc.a'), stateWith({ type: 'aws_vpc', name: 'a' }))
    expect(r.diagnostics.map((d) => d.summary)).toContain('Cycle in move statements')
  })

  it('does not move an instance of a whole-resource move when both addresses are keyed', () => {
    const r = run(MV('aws_s3_bucket.old', 'aws_s3_bucket.new["x"]'), stateWith({ type: 'aws_s3_bucket', name: 'old', keys: ['a'] }))
    expect(listAddresses(r.state)).toEqual(['aws_s3_bucket.old["a"]'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-moves.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/moves.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/moves.ts`:

```ts
// `moved` blocks: the statement that an object at one address in state is
// really the object at another, so changing a name or a key is not a destroy.
import { parseAddress, type Address } from './addresses.ts'
import { instanceAddress, type State, type StateInstance, type StateResource } from './state.ts'
import type { Block, Diagnostic, Pos } from './types.ts'

export interface Move {
  from: Address
  to: Address
  file: string
  pos: Pos
}

const fmt = (a: Address) => instanceAddress({ mode: 'managed', type: a.type, name: a.name }, a.key)
const diag = (file: string, pos: Pos, summary: string, detail: string): Diagnostic => ({ severity: 'error', summary, detail, file, line: pos.line, col: pos.col })

export function movesOf(blocks: Block[]): { moves: Move[]; diagnostics: Diagnostic[] } {
  const moves: Move[] = []
  const diagnostics: Diagnostic[] = []
  for (const b of blocks) {
    if (b.type !== 'moved') continue
    const get = (name: 'from' | 'to'): Address | undefined => {
      const a = b.attrs.find((x) => x.name === name)
      if (!a) {
        diagnostics.push(diag(b.file, b.pos, 'Missing required argument', `The argument "${name}" is required, but no definition was found.`))
        return undefined
      }
      const addr = parseAddress(a.value)
      if (!addr) diagnostics.push(diag(b.file, a.pos, `Invalid "${name}" address`, 'Moved block addresses must be resource instance addresses such as aws_instance.web or aws_instance.web[0].'))
      return addr
    }
    const from = get('from')
    const to = get('to')
    if (!from || !to) continue
    if (from.type !== to.type) {
      diagnostics.push(diag(b.file, b.pos, 'Resource type mismatch', `This statement declares a move from ${fmt(from)} to ${fmt(to)}, which is a resource of a different type.`))
      continue
    }
    moves.push({ from, to, file: b.file, pos: b.pos })
  }
  return { moves, diagnostics }
}

// Where an object at `a` goes under the first matching move, if any.
function step(moves: Move[], a: Address): Address | undefined {
  for (const m of moves) {
    if (m.from.type !== a.type || m.from.name !== a.name) continue
    if (m.from.key === undefined) {
      // Whole-resource move: instances keep their keys, unless the target is keyed and this is the lone unkeyed instance.
      if (a.key === undefined || m.to.key === undefined) return { type: m.to.type, name: m.to.name, key: a.key ?? m.to.key }
      continue
    }
    if (m.from.key === a.key) return { type: m.to.type, name: m.to.name, key: m.to.key }
  }
  return undefined
}

export function applyMoves(state: State, moves: Move[]): { state: State; moved: Map<string, string>; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const none = { file: '', pos: { line: 0, col: 0 } }
  const final = (start: Address): Address => {
    const seen = new Set<string>([fmt(start)])
    let cur = start
    for (;;) {
      const next = step(moves, cur)
      if (!next) return cur
      const k = fmt(next)
      if (seen.has(k)) {
        diagnostics.push(diag(none.file, none.pos, 'Cycle in move statements', `Terraform found a cycle among the move statements involving ${fmt(start)}.`))
        return start
      }
      seen.add(k)
      cur = next
    }
  }

  const groups = new Map<string, StateResource>()
  const placed = new Map<string, string>()
  const moved = new Map<string, string>()
  for (const r of state.resources) {
    for (const inst of r.instances) {
      const oldAddr = instanceAddress(r, inst.index_key)
      const dest = r.mode === 'data' ? { type: r.type, name: r.name, key: inst.index_key } : final({ type: r.type, name: r.name, key: inst.index_key })
      const newAddr = instanceAddress({ mode: r.mode, type: dest.type, name: dest.name }, dest.key)
      if (placed.has(newAddr)) {
        // Name the object that is moving, whichever of the two was seen first.
        const mover = newAddr !== oldAddr ? oldAddr : placed.get(newAddr)
        diagnostics.push(diag(none.file, none.pos, 'Cannot move to existing object', `Cannot move ${mover} to ${newAddr}: an object already exists at that address in the state.`))
        continue
      }
      placed.set(newAddr, oldAddr)
      if (newAddr !== oldAddr) moved.set(newAddr, oldAddr)
      const gk = `${r.mode}:${dest.type}.${dest.name}`
      let group = groups.get(gk)
      if (!group) {
        group = { mode: r.mode, type: dest.type, name: dest.name, provider: r.provider, instances: [] }
        groups.set(gk, group)
      }
      const copy: StateInstance = structuredClone(inst)
      if (dest.key === undefined) delete copy.index_key
      else copy.index_key = dest.key
      group.instances.push(copy)
    }
  }
  return { state: { ...structuredClone(state), resources: [...groups.values()] }, moved, diagnostics }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-moves.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/moves.ts tests/terraform-moves.test.ts
git commit -m "feat: moved blocks: parse and apply to state (TF2b-3b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `removed` and `import` declarations

**Files:**
- Create: `src/game/terraform/declarations.ts`
- Test: `tests/terraform-declarations.test.ts`

**Interfaces:**
- Consumes: `Address`, `parseAddress` (Task 1); `Block`, `Diagnostic`, `Expr`, `Pos` (`./types.ts`).
- Produces:
  - `interface Removal { from: Address; destroy: boolean; file: string; pos: Pos }`; `removedOf(blocks): { removals: Removal[]; diagnostics: Diagnostic[] }` — `from` must be a whole-resource address (no key); `lifecycle { destroy = <bool literal> }` (default `true`); errors: `Missing required argument`, `Invalid "from" address`, `Variables not allowed` / `Unsuitable value type` (as in `lifecycleOf`), `Unsupported argument` for any other `lifecycle` argument
  - `interface ImportDecl { to: Address; id: Expr; idPos: Pos; file: string; pos: Pos }`; `importsOf(blocks): { imports: ImportDecl[]; diagnostics: Diagnostic[] }` — errors: `Missing required argument` (`to`, `id`), `Invalid "to" address`

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-declarations.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { importsOf, removedOf } from '../src/game/terraform/declarations.ts'
import { parseHcl } from '../src/game/terraform/parse.ts'

const blocks = (hcl: string) => {
  const r = parseHcl('main.tf', hcl)
  if (r.diagnostics.length) throw new Error(r.diagnostics[0].summary)
  return r.blocks
}

describe('removedOf', () => {
  it('defaults to destroying, and reads lifecycle destroy = false', () => {
    const r = removedOf(blocks('removed {\n  from = aws_vpc.a\n}\nremoved {\n  from = aws_vpc.b\n  lifecycle {\n    destroy = false\n  }\n}\n'))
    expect(r.diagnostics).toEqual([])
    expect(r.removals.map((x) => [x.from, x.destroy])).toEqual([
      [{ type: 'aws_vpc', name: 'a' }, true],
      [{ type: 'aws_vpc', name: 'b' }, false],
    ])
    expect(r.removals[0]).toMatchObject({ file: 'main.tf', pos: { line: 1 } })
  })

  it('reports a missing or keyed from, a non-literal destroy, and unknown lifecycle arguments', () => {
    expect(removedOf(blocks('removed {\n}\n')).diagnostics[0]).toMatchObject({ summary: 'Missing required argument', detail: 'The argument "from" is required, but no definition was found.' })
    expect(removedOf(blocks('removed {\n  from = aws_vpc.a[0]\n}\n')).diagnostics[0].summary).toBe('Invalid "from" address')
    expect(removedOf(blocks('removed {\n  from = aws_vpc.a\n  lifecycle {\n    destroy = var.x\n  }\n}\n')).diagnostics[0].summary).toBe('Variables not allowed')
    expect(removedOf(blocks('removed {\n  from = aws_vpc.a\n  lifecycle {\n    destroy = "no"\n  }\n}\n')).diagnostics[0].summary).toBe('Unsuitable value type')
    expect(removedOf(blocks('removed {\n  from = aws_vpc.a\n  lifecycle {\n    nope = true\n  }\n}\n')).diagnostics[0]).toMatchObject({ summary: 'Unsupported argument', detail: 'An argument named "nope" is not expected here.' })
  })
})

describe('importsOf', () => {
  it('reads the target address and the id expression, with positions', () => {
    const r = importsOf(blocks('import {\n  to = aws_s3_bucket.b["x"]\n  id = "legacy-${var.env}"\n}\n'))
    expect(r.diagnostics).toEqual([])
    expect(r.imports).toHaveLength(1)
    expect(r.imports[0]).toMatchObject({ to: { type: 'aws_s3_bucket', name: 'b', key: 'x' }, file: 'main.tf', pos: { line: 1 }, idPos: { line: 3 } })
    expect(r.imports[0].id.kind).toBe('tmpl')
  })

  it('reports missing arguments and a bad target', () => {
    expect(importsOf(blocks('import {\n  to = aws_vpc.a\n}\n')).diagnostics[0]).toMatchObject({ summary: 'Missing required argument', detail: 'The argument "id" is required, but no definition was found.' })
    expect(importsOf(blocks('import {\n  id = "x"\n}\n')).diagnostics[0].detail).toContain('"to"')
    expect(importsOf(blocks('import {\n  to = var.x\n  id = "x"\n}\n')).diagnostics[0].summary).toBe('Invalid "to" address')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-declarations.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/declarations.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/declarations.ts`:

```ts
// `removed` and `import` blocks: statements about state rather than resources.
import { parseAddress, type Address } from './addresses.ts'
import type { Block, Diagnostic, Expr, Pos } from './types.ts'

const diag = (file: string, pos: Pos, summary: string, detail: string): Diagnostic => ({ severity: 'error', summary, detail, file, line: pos.line, col: pos.col })
const missing = (b: Block, name: string) => diag(b.file, b.pos, 'Missing required argument', `The argument "${name}" is required, but no definition was found.`)

export interface Removal {
  from: Address
  destroy: boolean
  file: string
  pos: Pos
}

export function removedOf(blocks: Block[]): { removals: Removal[]; diagnostics: Diagnostic[] } {
  const removals: Removal[] = []
  const diagnostics: Diagnostic[] = []
  for (const b of blocks) {
    if (b.type !== 'removed') continue
    const fromAttr = b.attrs.find((a) => a.name === 'from')
    if (!fromAttr) {
      diagnostics.push(missing(b, 'from'))
      continue
    }
    const from = parseAddress(fromAttr.value)
    if (!from || from.key !== undefined) {
      diagnostics.push(diag(b.file, fromAttr.pos, 'Invalid "from" address', 'Removed block addresses must be resource addresses such as aws_instance.web.'))
      continue
    }
    let destroy = true
    let bad = false
    for (const a of b.blocks.find((x) => x.type === 'lifecycle')?.attrs ?? []) {
      if (a.name !== 'destroy') {
        diagnostics.push(diag(b.file, a.pos, 'Unsupported argument', `An argument named "${a.name}" is not expected here.`))
        bad = true
      } else if (a.value.kind !== 'lit') {
        diagnostics.push(diag(b.file, a.pos, 'Variables not allowed', 'Variables may not be used here.'))
        bad = true
      } else if (typeof a.value.value !== 'boolean') {
        diagnostics.push(diag(b.file, a.pos, 'Unsuitable value type', 'Unsuitable value: a bool is required.'))
        bad = true
      } else destroy = a.value.value
    }
    if (!bad) removals.push({ from, destroy, file: b.file, pos: b.pos })
  }
  return { removals, diagnostics }
}

export interface ImportDecl {
  to: Address
  id: Expr
  idPos: Pos
  file: string
  pos: Pos
}

export function importsOf(blocks: Block[]): { imports: ImportDecl[]; diagnostics: Diagnostic[] } {
  const imports: ImportDecl[] = []
  const diagnostics: Diagnostic[] = []
  for (const b of blocks) {
    if (b.type !== 'import') continue
    const toAttr = b.attrs.find((a) => a.name === 'to')
    const idAttr = b.attrs.find((a) => a.name === 'id')
    if (!toAttr) diagnostics.push(missing(b, 'to'))
    if (!idAttr) diagnostics.push(missing(b, 'id'))
    if (!toAttr || !idAttr) continue
    const to = parseAddress(toAttr.value)
    if (!to) {
      diagnostics.push(diag(b.file, toAttr.pos, 'Invalid "to" address', 'Import block addresses must be resource instance addresses such as aws_instance.web or aws_instance.web[0].'))
      continue
    }
    imports.push({ to, id: idAttr.value, idPos: idAttr.pos, file: b.file, pos: b.pos })
  }
  return { imports, diagnostics }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-declarations.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/declarations.ts tests/terraform-declarations.test.ts
git commit -m "feat: removed and import block declarations (TF2b-3b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Plan integration

**Files:**
- Modify: `src/game/terraform/plan.ts`
- Modify: `tests/terraform-plan.test.ts` (append)
- Modify: `CONTENT_TODO.md` (append a section)

**Interfaces:**
- Consumes: Tasks 1–3 (`g.blocks`, `movesOf`/`applyMoves`, `removedOf`, `importsOf`), `realityKey` (`./refresh.ts`).
- Produces, in `plan.ts`:
  - `PlanItem.action` widens to `Action | 'destroy' | 'forget'`; `PlanItem.importing?: string` (the id the object was imported by); `PlanItem.movedFrom` (existing) is now also set by explicit `moved` blocks; `PlanResult.imported: number`.
  - `moved`: applied to the refreshed state before planning (`result.refreshed` stays the pre-move state). A `moved` whose `from` resource is still declared in the configuration is a warning `Moved object still exists`; problems from `movesOf`/`applyMoves` are errors.
  - `import`: an `import` whose target instance is **not in state** reads the object from `input.reality` (key `realityKey(type, id)`), uses it as the prior (so the item shows the diff against configuration) and sets `importing`. Errors: `Configuration for import target does not exist` (the `to` resource is not declared), `Cannot import non-existent remote object` (no such id in reality). An import for an instance already in state is ignored.
  - `removed`: a state instance of a resource with a `removed` block is planned as `action: 'forget'` (empty `changes`) when `destroy = false`, otherwise as a normal `destroy`. `Removed resource still exists` is an error if the resource is still declared.

- [ ] **Step 1: Write the failing tests**

Append to `tests/terraform-plan.test.ts`:

```ts
const DB_ATTRS = { id: 'db-1', arn: 'arn:db-1', identifier: 'orders-prod', engine: 'postgres', instance_class: 'db.r6g.large', storage_encrypted: false }
const DB_BLOCK = (name: string) => `resource "aws_db_instance" "${name}" {\n  identifier        = "orders-prod"\n  engine            = "postgres"\n  instance_class    = "db.r6g.large"\n  storage_encrypted = false\n}\n`
const ordersState = () => stateOf({ type: 'aws_db_instance', name: 'orders', attrs: DB_ATTRS })

describe('planConfig: moved blocks', () => {
  it('shows the destroy-and-create trap without a moved block, and a no-op with one', () => {
    const trap = plan(DB_BLOCK('primary'), { state: ordersState() })
    expect(actions(trap)).toEqual(['destroy aws_db_instance.orders', 'create aws_db_instance.primary'])
    const fixed = plan(DB_BLOCK('primary') + 'moved {\n  from = aws_db_instance.orders\n  to   = aws_db_instance.primary\n}\n', { state: ordersState() })
    expect(fixed.diagnostics).toEqual([])
    expect(fixed.items).toMatchObject([{ address: 'aws_db_instance.primary', action: 'noop', movedFrom: 'aws_db_instance.orders' }])
    expect(fixed.summary).toEqual({ add: 0, change: 0, destroy: 0 })
    expect(fixed.refreshed.resources[0].name).toBe('orders')
  })

  it('re-keys count indexes to for_each keys without destroying', () => {
    const state = stateOf(
      { type: 'aws_s3_bucket', name: 'b', key: 0, attrs: { id: 'b-a', arn: 'arn:b-a', bucket: 'b-a', force_destroy: false } },
      { type: 'aws_s3_bucket', name: 'b', key: 1, attrs: { id: 'b-b', arn: 'arn:b-b', bucket: 'b-b', force_destroy: false } },
    )
    const tf =
      'resource "aws_s3_bucket" "b" {\n  for_each = toset(["a", "b"])\n  bucket   = "b-${each.key}"\n}\n' +
      'moved {\n  from = aws_s3_bucket.b[0]\n  to   = aws_s3_bucket.b["a"]\n}\nmoved {\n  from = aws_s3_bucket.b[1]\n  to   = aws_s3_bucket.b["b"]\n}\n'
    const r = plan(tf, { state })
    expect(r.diagnostics).toEqual([])
    expect(r.items.map((i) => [i.address, i.action, i.movedFrom])).toEqual([
      ['aws_s3_bucket.b["a"]', 'noop', 'aws_s3_bucket.b[0]'],
      ['aws_s3_bucket.b["b"]', 'noop', 'aws_s3_bucket.b[1]'],
    ])
  })

  it('still diffs a moved resource against its new configuration', () => {
    const tf = DB_BLOCK('primary').replace('storage_encrypted = false', 'storage_encrypted = true') + 'moved {\n  from = aws_db_instance.orders\n  to   = aws_db_instance.primary\n}\n'
    expect(plan(tf, { state: ordersState() }).items).toMatchObject([{ address: 'aws_db_instance.primary', action: 'replace', movedFrom: 'aws_db_instance.orders' }])
  })

  it('warns, and carries on, when the old address is still declared', () => {
    const r = plan(DB_BLOCK('orders') + DB_BLOCK('primary') + 'moved {\n  from = aws_db_instance.orders\n  to   = aws_db_instance.primary\n}\n', { state: ordersState() })
    expect(r.diagnostics).toEqual([])
    expect(r.warnings.map((w) => w.summary)).toEqual(['Moved object still exists'])
    expect(r.items.map((i) => `${i.action} ${i.address}`)).toEqual(['create aws_db_instance.orders', 'noop aws_db_instance.primary'])
  })

  it('stops with an error for a type mismatch or a move onto an occupied address', () => {
    const mismatch = plan(DB_BLOCK('primary') + 'moved {\n  from = aws_db_instance.orders\n  to   = aws_vpc.main\n}\n', { state: ordersState() })
    expect(mismatch.diagnostics[0].summary).toBe('Resource type mismatch')
    expect(mismatch.items).toEqual([])
    const both = stateOf({ type: 'aws_db_instance', name: 'orders', attrs: DB_ATTRS }, { type: 'aws_db_instance', name: 'primary', attrs: { ...DB_ATTRS, id: 'db-2' } })
    const clash = plan(DB_BLOCK('primary') + 'moved {\n  from = aws_db_instance.orders\n  to   = aws_db_instance.primary\n}\n', { state: both })
    expect(clash.diagnostics[0].summary).toBe('Cannot move to existing object')
    expect(clash.items).toEqual([])
  })
})

describe('planConfig: removed blocks', () => {
  const state = () => stateOf({ type: 'aws_vpc', name: 'old', attrs: VPC })
  const REMOVED = (lc: string) => `removed {\n  from = aws_vpc.old\n${lc}}\n`

  it('forgets with destroy = false: no destroy, no destroy count', () => {
    const r = plan(REMOVED('  lifecycle {\n    destroy = false\n  }\n'), { state: state() })
    expect(r.items).toMatchObject([{ address: 'aws_vpc.old', action: 'forget', changes: [] }])
    expect(r.summary).toEqual({ add: 0, change: 0, destroy: 0 })
  })

  it('destroys with destroy = true or no lifecycle', () => {
    expect(plan(REMOVED('  lifecycle {\n    destroy = true\n  }\n'), { state: state() }).items[0].action).toBe('destroy')
    expect(plan(REMOVED(''), { state: state() }).items[0].action).toBe('destroy')
  })

  it('is an error while the resource is still declared', () => {
    const r = plan('resource "aws_vpc" "old" {\n  cidr_block = "10.0.0.0/16"\n}\n' + REMOVED(''), { state: state() })
    expect(r.diagnostics[0].summary).toBe('Removed resource still exists')
    expect(r.items).toEqual([])
  })
})

describe('planConfig: import blocks', () => {
  const LEGACY = { id: 'legacy-bucket', arn: 'arn:legacy-bucket', bucket: 'legacy-bucket', force_destroy: false }
  const CLOUD: Reality = { [realityKey('aws_s3_bucket', 'legacy-bucket')]: LEGACY }
  const BUCKET_TF = (extra = '') => `resource "aws_s3_bucket" "b" {\n  bucket = "legacy-bucket"\n${extra}}\n`
  const IMPORT = (id = '"legacy-bucket"', to = 'aws_s3_bucket.b') => `import {\n  to = ${to}\n  id = ${id}\n}\n`

  it('would plan a create without the import block, and an import with it', () => {
    expect(actions(plan(BUCKET_TF(), { reality: CLOUD }))).toEqual(['create aws_s3_bucket.b'])
    const r = plan(BUCKET_TF() + IMPORT(), { reality: CLOUD })
    expect(r.diagnostics).toEqual([])
    expect(r.items).toMatchObject([{ address: 'aws_s3_bucket.b', action: 'noop', importing: 'legacy-bucket' }])
    expect(r.imported).toBe(1)
    expect(r.summary).toEqual({ add: 0, change: 0, destroy: 0 })
  })

  it('shows the difference between the imported object and the configuration', () => {
    const r = plan(BUCKET_TF('  force_destroy = true\n') + IMPORT(), { reality: CLOUD })
    expect(r.items[0]).toMatchObject({ action: 'update', importing: 'legacy-bucket', changes: [{ name: 'force_destroy', before: false, after: true }] })
    expect(r.summary).toEqual({ add: 0, change: 1, destroy: 0 })
  })

  it('evaluates the id after the variable it uses', () => {
    const r = plan('variable "bucket" {\n  default = "legacy-bucket"\n}\n' + BUCKET_TF() + IMPORT('var.bucket'), { reality: CLOUD })
    expect(r.diagnostics).toEqual([])
    expect(r.items[0].importing).toBe('legacy-bucket')
  })

  it('imports a keyed instance', () => {
    const tf = 'resource "aws_s3_bucket" "b" {\n  for_each = toset(["x"])\n  bucket   = "legacy-bucket"\n}\n' + IMPORT('"legacy-bucket"', 'aws_s3_bucket.b["x"]')
    expect(plan(tf, { reality: CLOUD }).items).toMatchObject([{ address: 'aws_s3_bucket.b["x"]', importing: 'legacy-bucket' }])
  })

  it('fails with the real errors when the object does not exist or the target is not configured', () => {
    const none = plan(BUCKET_TF() + IMPORT('"nope"'), { reality: CLOUD })
    expect(none.diagnostics[0]).toMatchObject({ summary: 'Cannot import non-existent remote object' })
    expect(none.diagnostics[0].detail).toContain('import an existing object to "aws_s3_bucket.b"')
    expect(none.items).toEqual([])
    const unconfigured = plan(BUCKET_TF() + IMPORT('"legacy-bucket"', 'aws_s3_bucket.other'), { reality: CLOUD })
    expect(unconfigured.diagnostics[0].summary).toBe('Configuration for import target does not exist')
  })

  it('ignores an import for something already in state', () => {
    const state = stateOf({ type: 'aws_s3_bucket', name: 'b', attrs: LEGACY })
    const r = plan(BUCKET_TF() + IMPORT(), { state, reality: CLOUD })
    expect(r.items).toMatchObject([{ action: 'noop' }])
    expect(r.items[0].importing).toBeUndefined()
    expect(r.imported).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/terraform-plan.test.ts`
Expected: FAIL on the new tests (no moved/removed/import behavior; `r.imported` undefined).

- [ ] **Step 3: Write the implementation**

In `src/game/terraform/plan.ts`:

1. Imports: add `import { importsOf, removedOf } from './declarations.ts'`, `import { applyMoves, movesOf } from './moves.ts'`, and add `realityKey` to the existing `./refresh.ts` import.

2. Types: change `PlanItem.action` to `Action | 'destroy' | 'forget'`; add `importing?: string` to `PlanItem`; add `imported: number` to `PlanResult` and `imported: 0` to the initial `result` object.

3. After the `evalAt` helper definition and before `const scopeFor = ...`, add the declaration handling:

```ts
  // moved / removed / import: statements about state.
  const mv = movesOf(g.blocks)
  const rm = removedOf(g.blocks)
  const im = importsOf(g.blocks)
  errors.push(...mv.diagnostics, ...rm.diagnostics, ...im.diagnostics)
  const declared = (a: { type: string; name: string }) => g.nodes.has(`${a.type}.${a.name}`)
  const show = (a: { type: string; name: string; key?: string | number }) => instanceAddress({ mode: 'managed', type: a.type, name: a.name }, a.key)
  for (const m of mv.moves) {
    if (m.from.key === undefined && declared(m.from)) {
      result.warnings.push({
        severity: 'warning',
        summary: 'Moved object still exists',
        detail: `This statement declares that ${show(m.from)} was moved to ${show(m.to)}, but ${show(m.from)} is still declared in the configuration.`,
        file: m.file,
        line: m.pos.line,
        col: m.pos.col,
      })
    }
  }
  for (const r of rm.removals) {
    if (declared(r.from)) fail(r.file, r.pos, 'Removed resource still exists', `This statement declares that ${show(r.from)} was removed, so it should no longer be declared in the configuration, but the resource is still declared.`)
  }
  for (const i of im.imports) {
    if (!declared(i.to)) fail(i.file, i.pos, 'Configuration for import target does not exist', `The configuration for the given import target ${show(i.to)} does not exist. All target instances must have an associated configuration to be imported.`)
  }
  const applied = applyMoves(refreshed, mv.moves)
  errors.push(...applied.diagnostics)
  if (errors.length) return result
  const base = applied.state // the state planning works from: refreshed, with moves applied
```

4. In `planResource`, inside the instance loop:
   - replace `let priorInst = findInstance(refreshed, address)?.instance` with `let priorInst = findInstance(base, address)?.instance`;
   - replace `let movedFrom: string | undefined` with `let movedFrom: string | undefined = applied.moved.get(address)`;
   - in the implicit `x`⇄`x[0]` move block, replace `findInstance(refreshed, old)` with `findInstance(base, old)`;
   - right after that implicit-move `if` block (before `const prior = priorInst?.attributes`), add the import handling:

```ts
      let importing: string | undefined
      const decl = im.imports.find((d) => d.to.type === type && d.to.name === name && d.to.key === key)
      if (!priorInst && decl) {
        const before = errors.length
        const id = evalAt(node, decl.idPos, () => evalExpr(decl.id, scopeFor(ctx)), 'import')
        const object = errors.length === before && typeof id === 'string' && Object.hasOwn(input.reality, realityKey(type, id)) ? input.reality[realityKey(type, id)] : undefined
        if (!object) {
          if (errors.length === before) {
            fail(
              decl.file,
              decl.pos,
              'Cannot import non-existent remote object',
              `While attempting to import an existing object to "${address}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.`,
              'import',
            )
          }
          failed = true
          continue
        }
        priorInst = { attributes: structuredClone(object) }
        importing = id as string
      }
```

   - in the `result.items.push({...})` object literal add the line `...(importing ? { importing } : {}),`.

5. In the `case 'data'` branch replace `refreshed.resources.find(` with `base.resources.find(`.

6. In the orphan-destroy loop replace `for (const r of refreshed.resources) {` with `for (const r of base.resources) {`, and inside it, right after `if (planned.has(address) || consumed.has(address)) continue`, add:

```ts
      if (rm.removals.some((x) => x.from.type === r.type && x.from.name === r.name && !x.destroy)) {
        result.items.push({ address, type: r.type, name: r.name, key: inst.index_key, action: 'forget', changes: [] })
        continue
      }
```

7. After `result.outputs.sort(byName)`, add `result.imported = result.items.filter((i) => i.importing !== undefined).length`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/terraform-plan.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent. (`PlanItem` objects for `forget` and the existing summary loop need no change: `forget` counts nowhere.)

- [ ] **Step 5: Append to `CONTENT_TODO.md`, run the full check, commit**

Append (read the tail first; blank line before the section):

```markdown

## terraform simulator (moved / import / removed, TF2b-3b)
- [ ] `Moved object still exists` (modeled as a warning), `Resource type mismatch`, `Cannot move to existing object`, `Cycle in move statements`, `Removed resource still exists`: summaries and details from memory of the CLI; confirm wording, and whether "still exists" is a warning or an error in real Terraform.
- [ ] `Configuration for import target does not exist` and `Cannot import non-existent remote object`: recalled closely, still unverified.
- [ ] An `import` is read from the simulated cloud by `type:id`; real providers also accept composite or provider-specific ids (for example `bucket-name` for S3, `cluster/service` for ECS). Each incident that imports must seed `reality` under the id it uses.
- [ ] An `import` block for an instance that is already in state is ignored silently; real Terraform also ignores it only when the ids match.
- [ ] `moved` is applied in the order resolved by following chains per instance; real Terraform validates the whole set of statements (for example conflicting moves from one address) with more specific errors.
- [ ] `removed` only supports whole-resource addresses and `lifecycle { destroy = bool }`; provisioner blocks inside `removed` are not modeled.
```

Run: `npm test 2>&1 | tail -8 && npm run lint 2>&1 | tail -3 && npx tsc -b`
Expected: all test files pass, lint clean, `tsc` silent.

```bash
git add src/game/terraform/plan.ts tests/terraform-plan.test.ts CONTENT_TODO.md
git commit -m "feat: plan applies moved, import and removed blocks (TF2b-3b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done)

- **Spec coverage:** "Plan algorithm" step 3 (`moved`/`import`/`removed`) is covered. The `terraform import`, `state mv` and `state rm` commands that change state directly are TF3.
- **Placeholders:** none. **Type consistency:** `Address`, `Move`, `Removal`, `ImportDecl`, `Graph.blocks`, `PlanItem.importing`, `PlanResult.imported` and the `forget` action use the same names across code and tests. The Task 4 edit instructions name anchors that exist in the current `plan.ts` (`const errors = result.diagnostics` is defined before the insertion point; `ctx` is defined in the loop before the import block).
- **Review Focus:** all five lines have tests (moved trap/rename/re-key/chain: Tasks 2 and 4; data/occupied/cycle: Task 2; import semantics: Task 4; import id ordering: Tasks 1 and 4; removed forget/destroy/error: Task 4).
- **Fixtures traced by hand:** `DB_BLOCK` plans `noop` against `DB_ATTRS` (defaults and computed attributes are absent from state, which the TF2b-1 default fallback treats as equal); the `moved` for_each re-key test relies on `toset(["a","b"])` keys `a`,`b` and bucket names `b-a`, `b-b`; the import tests seed `reality` explicitly because `cloudOf(state)` (the default) is empty for an empty state.
