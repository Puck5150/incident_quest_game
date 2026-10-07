# Terraform TF2b-3a: forced replacement and lifecycle effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plan walker honor the lifecycle settings that decide whether something is destroyed: forced replacement (a tainted instance, `-replace=ADDR`, and `replace_triggered_by`), `prevent_destroy` (the real "Instance cannot be destroyed" error), and `create_before_destroy` (recorded on the plan item for the renderer). Warnings become a second kind of diagnostic.

**Architecture:** `diffInstance` gains a `force` flag that turns any existing instance into a replacement. `plan.ts` decides per instance whether to force one (tainted state, a `-replace` request, or a changed resource named in `replace_triggered_by`), records why on the plan item, and after all instances (including destroys) are planned checks `prevent_destroy`. `Diagnostic.severity` becomes `'error' | 'warning'` so an unmatched `-replace` is a warning that does not stop the plan.

**Tech Stack:** TypeScript (strict), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("Plan algorithm" step 5, "Apply", "Errors and honesty"). TF1, TF2a, TF2b-1 and TF2b-2 are complete (`planConfig` in `src/game/terraform/plan.ts`). Out of scope here (TF2b-3b): `moved`, `import`, `removed`, `-target`, `-refresh-only`, attribute-level `replace_triggered_by` references, modules, `dynamic` blocks.

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, `import type` for types, `.ts` import extensions.
- No new npm dependencies.
- Tests live in `tests/*.test.ts` (vitest); `src/` is type-checked by `npx tsc -b`.
- Own-property discipline: never use `in` or `obj[userKey] = ...` on objects keyed by user-supplied names.
- A configuration with any *error* produces diagnostics and **no plan items**; warnings never block a plan.
- Error wording follows real Terraform where known; wording not verified against the docs is logged in `CONTENT_TODO.md` (Task 4).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A forced replacement (tainted, `-replace`, triggered) of an instance that does not exist yet stays a plain create, with no reason recorded (Task 3 tests).
2. A `-replace` address that matches nothing is a **warning**, the plan is otherwise unchanged, and the exit decision is the caller's (Task 3 test).
3. `replace_triggered_by` fires on an update or replacement of the referenced resource, never on a create or a no-op (Task 3 tests).
4. `prevent_destroy` blocks destroys and replacements (including `count` shrinking), with the real error and no plan items, and stops applying once the resource block is removed from the configuration (Task 4 tests).
5. A forced replacement keeps the prior values of `ignore_changes` attributes, like a natural one (Task 1 test).

---

### Task 1: `diffInstance` can force a replacement

**Files:**
- Modify: `src/game/terraform/resources.ts` (the `diffInstance` signature and its tail)
- Modify: `tests/terraform-resources.test.ts` (append)

**Interfaces:**
- Produces: `diffInstance(schema, config, prior, ignore = [], force = false): InstancePlan`. With `force` true and a `prior`, the result is `action: 'replace'` even when no attribute changed; `changes` then lists only the attributes the replacement recomputes (`id`, `arn`, other provider-set values become `(known after apply)`); `planned` is a new object like a natural replacement. With no `prior`, `force` is ignored and the action is `create`.

- [ ] **Step 1: Write the failing test**

Append to `tests/terraform-resources.test.ts`:

```ts
describe('diffInstance: forced replacement', () => {
  const inst = schemaFor('aws_instance')!
  const prior = { id: 'i-1', arn: 'arn:i-1', ami: 'ami-1', instance_type: 't3.micro', private_ip: '10.0.1.5', tags: { Name: 'web' } }
  const cfg = { ami: 'ami-1', instance_type: 't3.micro', tags: { Name: 'web' } }

  it('replaces an unchanged instance when forced, recomputing what the provider sets', () => {
    const p = diffInstance(inst, cfg, prior, [], true)
    expect(p.action).toBe('replace')
    const byName = Object.fromEntries(p.changes.map((c) => [c.name, c]))
    expect(byName.id).toMatchObject({ before: 'i-1', after: UNKNOWN, forcesReplacement: false })
    expect(byName.private_ip).toMatchObject({ before: '10.0.1.5', after: UNKNOWN })
    expect(byName.instance_type).toBeUndefined()
    expect(p.planned).toMatchObject({ id: UNKNOWN, ami: 'ami-1', instance_type: 't3.micro', tags: { Name: 'web' } })
  })

  it('is not forced when force is false, and ignores force for something that does not exist yet', () => {
    expect(diffInstance(inst, cfg, prior, [], false).action).toBe('noop')
    expect(diffInstance(inst, cfg, undefined, [], true).action).toBe('create')
  })

  it('keeps the prior values of ignored attributes on a forced replacement', () => {
    const p = diffInstance(inst, { ...cfg, tags: { Name: 'changed' } }, prior, ['tags'], true)
    expect(p.action).toBe('replace')
    expect(p.planned.tags).toEqual({ Name: 'web' })
    expect(p.changes.some((c) => c.name === 'tags')).toBe(false)
  })

  it('still reports the changed attributes when a forced replacement also has real changes', () => {
    const p = diffInstance(inst, { ...cfg, instance_type: 't3.small' }, prior, [], true)
    expect(p.action).toBe('replace')
    expect(p.changes.find((c) => c.name === 'instance_type')).toMatchObject({ before: 't3.micro', after: 't3.small' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-resources.test.ts`
Expected: FAIL (the forced cases return `noop`/`update`).

- [ ] **Step 3: Write the implementation**

In `src/game/terraform/resources.ts`:

1. Add a fifth parameter to `diffInstance`:

```ts
export function diffInstance(
  schema: ResourceSchema,
  config: Record<string, Value>,
  prior: Record<string, Value> | undefined,
  ignore: string[] | 'all' = [],
  force = false, // replace an existing instance even if nothing changed (tainted, -replace, replace_triggered_by)
): InstancePlan {
```

2. Change the two decisions near the end of the function (currently `if (!changes.length) return { action: 'noop', ...}` and `if (changes.some((c) => c.forcesReplacement)) {`) to:

```ts
  if (!changes.length && !force) return { action: 'noop', changes, planned: Object.fromEntries(next) }
  if (force || changes.some((c) => c.forcesReplacement)) {
```

Everything inside that block (the `kept` ignored attributes, `fresh()`, `recomputed`) stays as it is.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-resources.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/resources.ts tests/terraform-resources.test.ts
git commit -m "feat: diffInstance can force a replacement (TF2b-3a)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Warnings as a kind of diagnostic

**Files:**
- Modify: `src/game/terraform/types.ts` (`Diagnostic.severity`)
- Modify: `src/game/terraform/diag.ts` (`formatDiagnostic`)
- Modify: `tests/terraform-diag.test.ts` (append)

**Interfaces:**
- Produces: `Diagnostic.severity: 'error' | 'warning'`; `formatDiagnostic` prints `Warning: ...` for a warning and `Error: ...` otherwise.

- [ ] **Step 1: Write the failing test**

Append to `tests/terraform-diag.test.ts` (inside the existing `describe('formatDiagnostic', ...)` block or as a new `it` in a new `describe`):

```ts
describe('formatDiagnostic: warnings', () => {
  it('labels a warning as Warning', () => {
    const out = formatDiagnostic({ severity: 'warning', summary: 'Careful', detail: 'short detail', file: '', line: 0, col: 0 })
    expect(out).toBe(['╷', '│ Warning: Careful', '│ ', '│ short detail', '╵'].join('\n'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-diag.test.ts`
Expected: FAIL (it prints `Error: Careful`, and the `'warning'` literal is a type error in `src/` if you run `tsc`).

- [ ] **Step 3: Write the implementation**

In `src/game/terraform/types.ts` change `severity: 'error'` in `interface Diagnostic` to:

```ts
  severity: 'error' | 'warning'
```

In `src/game/terraform/diag.ts` change the first line pushed in `formatDiagnostic` from `` `│ Error: ${d.summary}` `` to:

```ts
`│ ${d.severity === 'warning' ? 'Warning' : 'Error'}: ${d.summary}`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-diag.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent (every existing construction site uses the literal `'error'`, which still fits the wider type).

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/types.ts src/game/terraform/diag.ts tests/terraform-diag.test.ts
git commit -m "feat: warning diagnostics (TF2b-3a)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Forced replacement in the plan: tainted, `-replace`, `replace_triggered_by`

**Files:**
- Modify: `src/game/terraform/plan.ts`
- Modify: `tests/terraform-plan.test.ts` (update helpers, append tests)

**Interfaces:**
- Consumes: `diffInstance(..., force)` (Task 1), `Diagnostic` warnings (Task 2), `lifecycleOf(...).lifecycle.replaceTriggeredBy` (existing: resource addresses such as `aws_vpc.main`).
- Produces, in `plan.ts`:
  - `PlanInput.replace?: string[]` (instance addresses from `-replace=ADDR`)
  - `PlanItem.reason?: 'tainted' | 'requested' | 'triggered'` and `PlanItem.triggeredBy?: string[]` (resource addresses, only with `reason: 'triggered'`)
  - `PlanResult.warnings: Diagnostic[]`
  - Behavior: an existing instance that is tainted in state (`status: 'tainted'`), named in `replace`, or whose resource lists a resource in `replace_triggered_by` that this plan updates or replaces, becomes a `replace` item with the reason. If the resource would be replaced anyway because of its changes, the item carries no reason unless it is tainted. A forced replacement of an instance with no prior state stays a `create` with no reason. A `replace` address that matches no planned instance yields a warning `Incompletely-matched force-replace resource instance` and does not change the plan.

- [ ] **Step 1: Update the test helpers and write the failing tests**

In `tests/terraform-plan.test.ts`, replace the `Seed` type, `stateOf` and `plan` helpers with these versions (the rest of the file keeps working):

```ts
type Seed = { type: string; name: string; key?: string | number; attrs: Record<string, Value>; mode?: 'managed' | 'data'; status?: 'tainted' }
const stateOf = (...seeds: Seed[]): State => {
  const s = emptyState()
  for (const x of seeds) {
    const mode = x.mode ?? 'managed'
    let r = s.resources.find((r) => r.mode === mode && r.type === x.type && r.name === x.name)
    if (!r) {
      r = { mode, type: x.type, name: x.name, provider: AWS, instances: [] }
      s.resources.push(r)
    }
    r.instances.push({ ...(x.key === undefined ? {} : { index_key: x.key }), ...(x.status ? { status: x.status } : {}), attributes: x.attrs })
  }
  return s
}
```

```ts
const plan = (tf: string, o: { state?: State; reality?: Reality; vars?: Record<string, Value>; replace?: string[] } = {}): PlanResult => {
  const state = o.state ?? emptyState()
  return planConfig({ files: [{ name: 'main.tf', text: tf }], state, reality: o.reality ?? cloudOf(state), vars: o.vars ?? {}, ...(o.replace ? { replace: o.replace } : {}) })
}
```

Append:

```ts
const INSTANCE = { id: 'i-1', arn: 'arn:i-1', ami: 'ami-1', instance_type: 't3.micro' }
const WEB = 'resource "aws_instance" "web" {\n  ami           = "ami-1"\n  instance_type = "t3.micro"\n}\n'
const webState = (status?: 'tainted') => stateOf({ type: 'aws_instance', name: 'web', attrs: INSTANCE, ...(status ? { status } : {}) })

describe('planConfig: forced replacement', () => {
  it('replaces a tainted instance even though nothing changed, and says why', () => {
    const r = plan(WEB, { state: webState('tainted') })
    expect(r.items).toMatchObject([{ address: 'aws_instance.web', action: 'replace', reason: 'tainted' }])
    expect(r.items[0].changes.find((c) => c.name === 'id')).toMatchObject({ before: 'i-1', after: UNKNOWN })
    expect(r.summary).toEqual({ add: 1, change: 0, destroy: 1 })
  })

  it('leaves an untainted, unchanged instance alone', () => {
    expect(plan(WEB, { state: webState() }).items).toMatchObject([{ action: 'noop' }])
  })

  it('replaces exactly the instances named by -replace, with reason requested', () => {
    const state = stateOf(...[0, 1, 2].map((n) => ({ type: 'aws_s3_bucket', name: 'b', key: n, attrs: BUCKET(n) })))
    const tf = 'resource "aws_s3_bucket" "b" {\n  count  = 3\n  bucket = "logs-${count.index}"\n}'
    const r = plan(tf, { state, replace: ['aws_s3_bucket.b[1]'] })
    expect(r.items.map((i) => `${i.action} ${i.address}`)).toEqual(['noop aws_s3_bucket.b[0]', 'replace aws_s3_bucket.b[1]', 'noop aws_s3_bucket.b[2]'])
    expect(r.items[1].reason).toBe('requested')
    expect(r.warnings).toEqual([])
  })

  it('records no reason when the instance would be replaced anyway', () => {
    const tf = 'resource "aws_instance" "web" {\n  ami           = "ami-2"\n  instance_type = "t3.micro"\n}\n'
    const r = plan(tf, { state: webState(), replace: ['aws_instance.web'] })
    expect(r.items[0].action).toBe('replace')
    expect(r.items[0].reason).toBeUndefined()
  })

  it('keeps a forced replacement of something that does not exist a plain create', () => {
    const r = plan(WEB, { replace: ['aws_instance.web'] })
    expect(r.items).toMatchObject([{ action: 'create' }])
    expect(r.items[0].reason).toBeUndefined()
    expect(r.warnings).toEqual([])
  })

  it('warns about a -replace address that matches nothing, without changing the plan', () => {
    const r = plan(WEB, { state: webState(), replace: ['aws_instance.nope'] })
    expect(r.diagnostics).toEqual([])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatchObject({ severity: 'warning', summary: 'Incompletely-matched force-replace resource instance' })
    expect(r.warnings[0].detail).toContain('aws_instance.nope')
    expect(r.items).toMatchObject([{ action: 'noop' }])
  })
})

describe('planConfig: replace_triggered_by', () => {
  const TF = (dns: boolean, cidr = '10.0.0.0/16') =>
    `resource "aws_vpc" "main" {\n  cidr_block = "${cidr}"\n  enable_dns_hostnames = ${dns}\n}\nresource "aws_instance" "web" {\n  ami           = "ami-1"\n  instance_type = "t3.micro"\n  lifecycle {\n    replace_triggered_by = [aws_vpc.main]\n  }\n}\n`
  const both = () => stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_instance', name: 'web', attrs: INSTANCE })
  const instanceOf = (r: PlanResult) => r.items.find((i) => i.address === 'aws_instance.web')!

  it('does nothing while the referenced resource is unchanged', () => {
    expect(instanceOf(plan(TF(false), { state: both() })).action).toBe('noop')
  })

  it('replaces when the referenced resource is updated, and says what triggered it', () => {
    const r = plan(TF(true), { state: both() })
    expect(r.items.find((i) => i.address === 'aws_vpc.main')!.action).toBe('update')
    expect(instanceOf(r)).toMatchObject({ action: 'replace', reason: 'triggered', triggeredBy: ['aws_vpc.main'] })
  })

  it('replaces when the referenced resource is replaced', () => {
    expect(instanceOf(plan(TF(false, '10.9.0.0/16'), { state: both() }))).toMatchObject({ action: 'replace', reason: 'triggered' })
  })

  it('does not trigger when the referenced resource is only being created', () => {
    const r = plan(TF(false), { state: webState() })
    expect(r.items.find((i) => i.address === 'aws_vpc.main')!.action).toBe('create')
    expect(instanceOf(r).action).toBe('noop')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-plan.test.ts`
Expected: FAIL (`r.warnings` is undefined, no forced replacements).

- [ ] **Step 3: Write the implementation**

In `src/game/terraform/plan.ts`:

1. Types: add `replace?: string[]` to `PlanInput`; add `reason?: 'tainted' | 'requested' | 'triggered'` and `triggeredBy?: string[]` to `PlanItem`; add `warnings: Diagnostic[]` to `PlanResult`, and `warnings: []` to the initial `result` object in `planConfig`.

2. Next to `const consumed = new Set<string>()`, add:

```ts
  // Which actions each resource's instances ended up with, for replace_triggered_by.
  const touched = new Map<string, Set<string>>()
```

3. Replace the part of the instance loop in `planResource` from `const address = ...` through `planned.set(key, complete(p.planned, schema))` with:

```ts
      const address = instanceAddress({ mode: 'managed', type, name }, key)
      let priorInst = findInstance(refreshed, address)?.instance
      let movedFrom: string | undefined
      // Adding or removing `count = 1` moves the lone instance between `x` and `x[0]` (Terraform 1.1+).
      if (!priorInst && ex.kind !== 'for_each' && (key === 0 || key === undefined)) {
        const old = instanceAddress({ mode: 'managed', type, name }, key === 0 ? undefined : 0)
        const found = findInstance(refreshed, old)
        if (found) {
          priorInst = found.instance
          movedFrom = old
          consumed.add(old)
        }
      }
      const prior = priorInst?.attributes
      // Why an existing instance might be replaced even though its arguments did not force it.
      const triggers = prior ? lc.lifecycle.replaceTriggeredBy.filter((a) => touched.get(a)?.has('update') || touched.get(a)?.has('replace')) : []
      const forced = !prior ? undefined : priorInst?.status === 'tainted' ? 'tainted' : input.replace?.includes(address) ? 'requested' : triggers.length ? 'triggered' : undefined
      let p = diffInstance(schema, ar.args, prior, lc.lifecycle.ignoreChanges)
      let reason: PlanItem['reason'] = priorInst?.status === 'tainted' ? 'tainted' : undefined
      if (forced && p.action !== 'replace') {
        p = diffInstance(schema, ar.args, prior, lc.lifecycle.ignoreChanges, true)
        reason = forced
      }
      result.items.push({
        address,
        type,
        name,
        key,
        action: p.action,
        changes: p.changes,
        ...(movedFrom ? { movedFrom } : {}),
        ...(reason ? { reason } : {}),
        ...(reason === 'triggered' ? { triggeredBy: triggers } : {}),
      })
      const seen = touched.get(`${type}.${name}`) ?? new Set<string>()
      touched.set(`${type}.${name}`, seen.add(p.action))
      planned.set(key, complete(p.planned, schema))
```

4. After the orphan-destroy loop and before `result.items.sort(byInstance)`, add the warning for `-replace` addresses that matched nothing:

```ts
  const known = new Set(result.items.map((i) => i.address))
  for (const a of input.replace ?? []) {
    if (known.has(a)) continue
    result.warnings.push({
      severity: 'warning',
      summary: 'Incompletely-matched force-replace resource instance',
      detail: `Your force-replace request for ${a} doesn't match any resource instance in the plan, so it has no effect.`,
      file: '',
      line: 0,
      col: 0,
    })
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-plan.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent. (A resource listed in `replace_triggered_by` is planned first because the graph treats those references as dependencies.)

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/plan.ts tests/terraform-plan.test.ts
git commit -m "feat: tainted, -replace and replace_triggered_by force replacements (TF2b-3a)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `prevent_destroy` and `create_before_destroy`

**Files:**
- Modify: `src/game/terraform/plan.ts`
- Modify: `tests/terraform-plan.test.ts` (append)
- Modify: `CONTENT_TODO.md` (append a section)

**Interfaces:**
- Produces: `PlanItem.createBeforeDestroy?: boolean` (true on a `replace` item whose resource sets `lifecycle { create_before_destroy = true }`); error `Instance cannot be destroyed` for any `destroy` or `replace` item whose resource block sets `prevent_destroy = true`, located at the resource block with context `resource "T" "N"`. A resource removed from the configuration has no block, so its orphan destroys are not protected. When this error occurs the result has no items and no outputs, like any other error.

- [ ] **Step 1: Write the failing test**

Append to `tests/terraform-plan.test.ts`:

```ts
describe('planConfig: prevent_destroy and create_before_destroy', () => {
  const DB = (encrypted: boolean, cls = 'db.r6g.large', protect = true) =>
    `resource "aws_db_instance" "orders" {\n  identifier        = "orders-prod"\n  engine            = "postgres"\n  instance_class    = "${cls}"\n  storage_encrypted = ${encrypted}\n${protect ? '  lifecycle {\n    prevent_destroy = true\n  }\n' : ''}}\n`
  const dbState = () => stateOf({ type: 'aws_db_instance', name: 'orders', attrs: { id: 'db-1', arn: 'arn:db-1', identifier: 'orders-prod', engine: 'postgres', instance_class: 'db.r6g.large', storage_encrypted: false } })

  it('stops a plan that would replace a protected resource, with the real error', () => {
    const r = plan(DB(true), { state: dbState() })
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]).toMatchObject({ summary: 'Instance cannot be destroyed', file: 'main.tf', line: 1, context: 'resource "aws_db_instance" "orders"' })
    expect(r.diagnostics[0].detail).toContain('Resource aws_db_instance.orders has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed.')
    expect(r.diagnostics[0].detail).toContain('reduce the scope of the plan using the -target option')
    expect(r.items).toEqual([])
  })

  it('allows plans that do not destroy it: no change, or an in-place update', () => {
    expect(plan(DB(false), { state: dbState() }).diagnostics).toEqual([])
    const r = plan(DB(false, 'db.r6g.xlarge'), { state: dbState() })
    expect(r.diagnostics).toEqual([])
    expect(r.items[0].action).toBe('update')
  })

  it('does not protect once the resource block is removed from the configuration', () => {
    const r = plan('# removed\n', { state: dbState() })
    expect(r.diagnostics).toEqual([])
    expect(r.items).toMatchObject([{ address: 'aws_db_instance.orders', action: 'destroy' }])
  })

  it('protects instances that a smaller count would destroy', () => {
    const state = stateOf(...[0, 1, 2].map((n) => ({ type: 'aws_s3_bucket', name: 'b', key: n, attrs: BUCKET(n) })))
    const tf = (n: number) => `resource "aws_s3_bucket" "b" {\n  count  = ${n}\n  bucket = "logs-\${count.index}"\n  lifecycle {\n    prevent_destroy = true\n  }\n}`
    expect(plan(tf(3), { state }).diagnostics).toEqual([])
    const r = plan(tf(2), { state })
    expect(r.diagnostics[0]).toMatchObject({ summary: 'Instance cannot be destroyed' })
    expect(r.diagnostics[0].detail).toContain('Resource aws_s3_bucket.b[2] has lifecycle.prevent_destroy set')
  })

  it('protects a protected resource from -replace and from a tainted state', () => {
    const tf = 'resource "aws_instance" "web" {\n  ami = "ami-1"\n  instance_type = "t3.micro"\n  lifecycle {\n    prevent_destroy = true\n  }\n}'
    expect(plan(tf, { state: webState(), replace: ['aws_instance.web'] }).diagnostics[0].summary).toBe('Instance cannot be destroyed')
    expect(plan(tf, { state: webState('tainted') }).diagnostics[0].summary).toBe('Instance cannot be destroyed')
  })

  it('records create_before_destroy on a replacement only', () => {
    const tf = (cbd: boolean, ami: string) => `resource "aws_instance" "web" {\n  ami = "${ami}"\n  instance_type = "t3.micro"\n  lifecycle {\n    create_before_destroy = ${cbd}\n  }\n}`
    expect(plan(tf(true, 'ami-2'), { state: webState() }).items[0]).toMatchObject({ action: 'replace', createBeforeDestroy: true })
    expect(plan(tf(false, 'ami-2'), { state: webState() }).items[0].createBeforeDestroy).toBeUndefined()
    expect(plan(tf(true, 'ami-1'), { state: webState() }).items[0].createBeforeDestroy).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-plan.test.ts`
Expected: FAIL on the new tests (no `Instance cannot be destroyed`, no `createBeforeDestroy`).

- [ ] **Step 3: Write the implementation**

In `src/game/terraform/plan.ts`:

1. Add `createBeforeDestroy?: boolean` to `PlanItem`.

2. Next to `const touched = ...`, add:

```ts
  // Resources that set prevent_destroy, by type.name, with where to point an error.
  const protectedBy = new Map<string, { file: string; pos: Pos; context: string }>()
```

3. In `planResource`, right after the line `if (ex.kind !== 'single') shapes.set(node.address, ex.kind)`... (or any point after `lc` is known and before the instance loop), add:

```ts
    if (lc.lifecycle.preventDestroy) protectedBy.set(`${type}.${name}`, { file: node.file, pos: b.pos, context })
```

and in the `result.items.push({...})` object literal inside the instance loop add one more spread line:

```ts
        ...(p.action === 'replace' && lc.lifecycle.createBeforeDestroy ? { createBeforeDestroy: true } : {}),
```

4. After the orphan-destroy loop (and after the `-replace` warning loop from Task 3), and before `result.items.sort(byInstance)`, add:

```ts
  for (const i of result.items) {
    const guard = protectedBy.get(`${i.type}.${i.name}`)
    if (guard && (i.action === 'destroy' || i.action === 'replace')) {
      fail(
        guard.file,
        guard.pos,
        'Instance cannot be destroyed',
        `Resource ${i.address} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.`,
        guard.context,
      )
    }
  }
  if (errors.length) {
    result.items = []
    result.outputs = []
    return result
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-plan.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent.

- [ ] **Step 5: Append to `CONTENT_TODO.md`, run the full check, commit**

Append (read the tail first; blank line before the section):

```markdown

## terraform simulator (lifecycle effects, TF2b-3a)
- [ ] "Instance cannot be destroyed" wording (summary and detail, `Resource ADDRESS has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. ...`): from memory of the CLI; confirm the exact text and that real Terraform names the instance address (with the `[key]`) here.
- [ ] "Incompletely-matched force-replace resource instance" (a `-replace` address that matches nothing): summary from memory, the detail text is paraphrased; confirm whether real Terraform reports this as a warning or an error.
- [ ] `replace_triggered_by` is modeled at resource level only: any update or replacement of any instance of the referenced resource triggers it. Real Terraform also triggers on changes to a specific referenced attribute (`aws_vpc.main.id`) and only for that attribute.
- [ ] A tainted instance is always reported as `reason: 'tainted'`, even if its arguments would have replaced it anyway; check what the real plan prints in that case.
- [ ] `create_before_destroy` is only recorded on the plan item (for the renderer); the ordering effect on apply belongs to TF3.
```

Run: `npm test 2>&1 | tail -8 && npm run lint 2>&1 | tail -3 && npx tsc -b`
Expected: all test files pass, lint clean, `tsc` silent.

```bash
git add src/game/terraform/plan.ts tests/terraform-plan.test.ts CONTENT_TODO.md
git commit -m "feat: prevent_destroy errors and create_before_destroy on plan items (TF2b-3a)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done)

- **Spec coverage:** "Plan algorithm" step 5 (`ignore_changes` already done in TF2b-2; `prevent_destroy` now enforced with the real error) and the forced-replacement family (taint, `-replace`, `replace_triggered_by`) are covered. `create_before_destroy` is recorded for TF2c and enforced as ordering in TF3. `moved`/`import`/`removed`/`-target`/`-refresh-only` are TF2b-3b.
- **Placeholders:** none. **Type consistency:** `PlanItem.reason`, `triggeredBy`, `createBeforeDestroy`, `PlanInput.replace`, `PlanResult.warnings` and `diffInstance(..., force)` use the same names in code and tests. Task 3's replacement of the instance loop reproduces the existing implicit-move block from TF2b-2 unchanged (only `findInstance(...)?.instance` is kept as an object so `status` can be read).
- **Review Focus:** all five lines have tests (forced create / warning / trigger rules: Task 3; `prevent_destroy` incl. count shrink and removed block: Task 4; ignored attributes on forced replace: Task 1).
- **Fixtures traced by hand:** `INSTANCE`/`WEB` plan as `noop` (defaults and computed attributes absent from state are fine after the TF2b-1 default fallback); `DB` state with `storage_encrypted: false` against `true` forces a replacement; the `[key]` in the detail for the counted bucket comes from `i.address` (`aws_s3_bucket.b[2]`).
