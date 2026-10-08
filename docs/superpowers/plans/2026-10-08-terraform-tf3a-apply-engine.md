# Terraform TF3a: the apply engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute a plan against the simulated cloud: create, update, replace, destroy, forget and import resources in a dependency-correct order, generate the values only the provider knows (ids, ARNs, endpoints), mutate state and cloud, fail the way real clouds fail (already exists, dependency violations, scripted faults), keep going with independent resources after a failure, and leave exactly the half-applied world a real failed `terraform apply` leaves. No CLI, no prompt, no rendering: those are TF3b.

**Architecture:** `executeApply` repeats "plan, pick the next ready step, execute it, adopt the result" until nothing more can run. Re-planning after every step is what makes dependents see real values and lets a replacement fall out as a destroy followed by a create. `provider.ts` holds the simulated provider's knowledge (ids, ARNs, computed values, durations, already-exists and dependency-violation errors). The planner gains the facts apply needs (post-move state, dependency lists, source positions). Diagnostics learn the `with ADDRESS,` line that provider errors carry.

**Tech Stack:** TypeScript (strict), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("Apply", "Fixes and scoring"). TF1 to TF2c-3 are complete. Out of scope here (TF3b/c): the `apply`/`destroy` commands and their output, the confirmation prompt, saved plans, scenario-authored faults in the schema, state locks, `import`/`state mv|rm`/`taint` commands, workspaces, `create_before_destroy` ordering (replacements are destroy-then-create), `-target`.

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, `import type` for types, `.ts` import extensions.
- No new npm dependencies; no randomness and no clock: every id, ARN, request id and duration is a deterministic function of its inputs, so a replayed command history rebuilds the same world.
- Own-property discipline: never use `in` or `obj[userKey] = ...` on objects keyed by user-supplied names.
- Apply never mutates its inputs (`structuredClone` what it changes) and never throws on player input; failures are diagnostics.
- Provider error texts not verified against the real AWS provider are logged in `CONTENT_TODO.md` (Task 3).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Replacing a resource whose dependents also replace destroys the dependents first and creates the dependency first: `subnet delete, vpc delete, vpc create, subnet create`, and the new subnet's `vpc_id` is the NEW vpc's id (Task 3 test).
2. A failure stops only what depends on it: an independent resource in the same apply still completes; the failed resource's dependents are not attempted; state and cloud hold exactly what completed (Task 3 tests).
3. Destroying something another cloud object still references fails with `DependencyViolation` and the dependency's own destroy is then not attempted (Task 3 test); creating something that already exists in the cloud fails with the type's already-exists error and changes nothing (Task 3 test).
4. Apply is deterministic and idempotent: the same inputs give the same ids, and applying again after a clean apply does nothing (Task 3 tests).
5. A drifted cloud is brought back to the configuration, and the refresh is persisted to state first (Task 3 test).

---

### Task 1: What the planner and diagnostics must expose for apply

**Files:**
- Modify: `src/game/terraform/plan.ts`, `src/game/terraform/state.ts`, `src/game/terraform/types.ts`, `src/game/terraform/diag.ts`, `src/game/terraform/lab.ts`
- Test: `tests/terraform-plan.test.ts` (append), `tests/terraform-state.test.ts` (append), `tests/terraform-diag.test.ts` (append), `tests/terraform-lab.test.ts` (append)

**Interfaces (produces):**
- `StateInstance.dependencies?: string[]` — resource addresses (`aws_vpc.main`, without instance keys) this instance depends on; `stateJson` writes it after `sensitive_attributes` when non-empty.
- `PlanResult.baseState: State` — the state planning worked from: refreshed, with `moved` blocks applied (equal to `refreshed` when there are no moves, and also set on early error returns).
- `PlanItem.dependsOn: string[]` — resource addresses (without keys) this item's resource depends on: for configured resources the configuration's references, followed through locals/outputs/variables/data sources down to resources (sorted, unique, excluding itself); for destroys of resources that are no longer configured, the instance's `dependencies` (or `[]`).
- `PlanItem.block?: { file: string; line: number; col: number }` — where the resource is declared (absent for items with no configuration).
- `Diagnostic.address?: string`; `formatDiagnostic` prints `│   with ADDRESS,` as the first location line when it is set (before `on …` if there is one; alone if there is no file).
- `labFromScenario`: each managed state instance gets `dependencies` computed from the starting state: the resource addresses of other managed instances whose `id` appears as a string value anywhere in its attributes (nested arrays/objects included), sorted, unique, excluding itself; omitted when empty.

- [ ] **Step 1: Write the failing tests**

Append to `tests/terraform-plan.test.ts` (uses the existing helpers `plan`, `stateOf`, `NETWORK`, `VPC`, `SUBNET`):

```ts
describe('planConfig: facts for apply', () => {
  it('exposes the state it planned from, with moves applied', () => {
    const state = stateOf({ type: 'aws_db_instance', name: 'orders', attrs: { id: 'db-1', arn: 'a', identifier: 'orders-prod', engine: 'postgres', instance_class: 'db.r6g.large', storage_encrypted: false } })
    const tf = 'resource "aws_db_instance" "primary" {\n  identifier = "orders-prod"\n  engine = "postgres"\n  instance_class = "db.r6g.large"\n  storage_encrypted = false\n}\nmoved {\n  from = aws_db_instance.orders\n  to   = aws_db_instance.primary\n}\n'
    const r = plan(tf, { state })
    expect(r.baseState.resources.map((x) => x.name)).toEqual(['primary'])
    expect(r.refreshed.resources.map((x) => x.name)).toEqual(['orders'])
    expect(plan('# nothing\n').baseState.resources).toEqual([])
    expect(plan('resource "aws_vpc" "a" {\n  cidr_block\n}\n').baseState).toBeDefined()
  })

  it('lists the resources an item depends on, through locals and variables', () => {
    const tf = 'locals {\n  vpc = aws_vpc.main.id\n}\nvariable "cidr" {\n  default = "10.0.1.0/24"\n}\nresource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\nresource "aws_subnet" "a" {\n  vpc_id     = local.vpc\n  cidr_block = var.cidr\n}\n'
    const r = plan(tf)
    expect(r.items.find((i) => i.address === 'aws_subnet.a')!.dependsOn).toEqual(['aws_vpc.main'])
    expect(r.items.find((i) => i.address === 'aws_vpc.main')!.dependsOn).toEqual([])
  })

  it('takes the dependencies of an orphan destroy from state, and records where a resource is declared', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_subnet', name: 'a', attrs: SUBNET })
    state.resources[1].instances[0].dependencies = ['aws_vpc.main']
    const r = plan('# none\n', { state })
    expect(r.items.find((i) => i.address === 'aws_subnet.a')).toMatchObject({ action: 'destroy', dependsOn: ['aws_vpc.main'] })
    expect(r.items.find((i) => i.address === 'aws_subnet.a')!.block).toBeUndefined()
    const c = plan(NETWORK('10.0.0.0/16'))
    expect(c.items.find((i) => i.address === 'aws_vpc.main')!.block).toEqual({ file: 'main.tf', line: 2, col: 1 })
  })
})
```

Append to `tests/terraform-state.test.ts`:

```ts
describe('state dependencies in JSON', () => {
  it('writes dependencies after sensitive_attributes only when present', () => {
    const s = emptyState()
    s.resources.push({ mode: 'managed', type: 'aws_subnet', name: 's', provider: 'p', instances: [{ attributes: { id: 'subnet-1' }, dependencies: ['aws_vpc.main'] }, { index_key: 1, attributes: { id: 'subnet-2' } }] })
    const inst = JSON.parse(stateJson(s)).resources[0].instances
    expect(inst[0]).toMatchObject({ dependencies: ['aws_vpc.main'] })
    expect(Object.keys(inst[0])).toEqual(['schema_version', 'attributes', 'sensitive_attributes', 'dependencies'])
    expect(inst[1].dependencies).toBeUndefined()
  })
})
```

Append to `tests/terraform-diag.test.ts`:

```ts
describe('formatDiagnostic: address', () => {
  it('prints the with-line before the location', () => {
    const out = formatDiagnostic({ severity: 'error', summary: 'creating X', detail: '', file: 'main.tf', line: 2, col: 1, context: 'resource "a" "b"', address: 'a.b' }, 'x\nresource "a" "b" {\n')
    expect(out).toBe(['╷', '│ Error: creating X', '│ ', '│   with a.b,', '│   on main.tf line 2, in resource "a" "b":', '│    2: resource "a" "b" {', '╵'].join('\n'))
  })
  it('prints only the with-line when there is no source', () => {
    expect(formatDiagnostic({ severity: 'error', summary: 'destroying X', detail: '', file: '', line: 0, col: 0, address: 'a.old' })).toBe(['╷', '│ Error: destroying X', '│ ', '│   with a.old,', '╵'].join('\n'))
  })
})
```

Append to `tests/terraform-lab.test.ts`:

```ts
describe('labFromScenario: dependencies', () => {
  it('derives dependencies from ids found in attributes', () => {
    const lab = labFromScenario(
      { files: [FILE], state: [VPC, { type: 'aws_subnet', name: 's', attrs: { id: 'subnet-1', vpc_id: 'vpc-1', nested: { ids: ['x', 'subnet-9'] } } }, { type: 'aws_instance', name: 'i', attrs: { id: 'i-1', subnet_id: 'subnet-1', vpc_ids: [{ v: 'vpc-1' }] } }] } as TerraformBlock,
      '/w',
      '/h',
    )
    const deps = Object.fromEntries(lab.state.resources.map((r) => [`${r.type}.${r.name}`, r.instances[0].dependencies]))
    expect(deps).toEqual({ 'aws_vpc.main': undefined, 'aws_subnet.s': ['aws_vpc.main'], 'aws_instance.i': ['aws_subnet.s', 'aws_vpc.main'] })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/terraform-plan.test.ts tests/terraform-state.test.ts tests/terraform-diag.test.ts tests/terraform-lab.test.ts`
Expected: FAIL (new fields do not exist).

- [ ] **Step 3: Write the implementation**

1. `state.ts`: add `dependencies?: string[]` to `StateInstance`; in `stateJson`'s instance object add, after `sensitive_attributes: []`, `...(i.dependencies?.length ? { dependencies: [...i.dependencies] } : {})`.
2. `types.ts`: add `address?: string` to `Diagnostic`.
3. `diag.ts` `formatDiagnostic`: location block: `if (d.address || (d.file && d.line))` push `'│ '`, then `│   with ${d.address},` if set, then (if `d.file && d.line`) the existing `on …` line and source line. Keep the old output byte-identical when `address` is unset.
4. `plan.ts`:
   - `PlanResult.baseState: State`; initialise it to `refreshed` in the `result` literal and set `result.baseState = base` right after `const base = applied.state`.
   - `PlanItem.dependsOn: string[]` and `PlanItem.block?: { file: string; line: number; col: number }`.
   - helper `resourceDeps(node: GNode): string[]` — DFS over `node.deps` through the graph `g.nodes`; collect addresses whose node `kind === 'resource'` (stop descending at resources), traverse `local`, `output`, `variable`, `data`, `module` nodes; return sorted unique, excluding `node.address`. Use it in `planResource` for `dependsOn`, and set `block: { file: node.file, line: b.pos.line, col: b.pos.col }` on every item pushed there.
   - orphan destroy items: `dependsOn: inst.dependencies ?? []`; no `block`.
5. `lab.ts`: after building `state` (before `reality`), derive `dependencies` as described: collect each managed instance's id; for each instance, deep-scan its attribute values (strings, arrays, objects) for strings equal to another managed instance's id, map ids to `type.name`, sort/unique, exclude its own resource, assign when non-empty.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/terraform-plan.test.ts tests/terraform-state.test.ts tests/terraform-diag.test.ts tests/terraform-lab.test.ts && npm test 2>&1 | grep -E "Test Files|Tests " && npx tsc -b`
Expected: PASS; `tsc` silent. Existing tests that compare whole plan items with `toEqual` may need the new fields added: update them (new fields are expected).

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform tests
git commit -m "feat: plan exposes base state, dependencies and positions for apply; with-address diagnostics (TF3a)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The simulated provider

**Files:**
- Create: `src/game/terraform/provider.ts`
- Test: `tests/terraform-provider.test.ts`

**Interfaces (produces):**
- `hex(seed: string, len: number): string` — deterministic lowercase hex of exactly `len` characters (FNV-1a based, extended by rounds).
- `requestId(seed: string): string` — uuid-shaped (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) from `hex`.
- `formatDuration(seconds: number): string` — `7s`, `1m5s`, `4m12s` (no zero-minute prefix, `1m0s` for 60).
- `seconds(type: string, op: 'create' | 'update' | 'delete'): number` — per-type fixed durations (below); `2`/`1`/`1` for unknown types.
- `fillOnCreate(type: string, address: string, planned: Record<string, Value>, seed: string): Record<string, Value>` — returns a new object where `id` and `arn` are generated by type, computed attributes that are `UNKNOWN` or absent get the type's defaults, and every remaining `UNKNOWN` becomes `null`.
- `fillOnUpdate(prior: Record<string, Value>, next: Record<string, Value>): Record<string, Value>` — any `UNKNOWN` in `next` takes the prior value, else `null`.
- `alreadyExists(type: string, attrs: Record<string, Value>, reality: Reality, seed: string): string | undefined` — for types with a natural, cloud-unique name, the provider's error text when `reality` already holds an object of that type with that name.
- `referencedBy(reality: Reality, type: string, id: string): { type: string; id: string } | undefined` — the first other cloud object (by sorted key) whose attributes contain a string equal to `id` anywhere (deep).
- `dependencyViolation(type: string, id: string, seed: string): string` — the provider's refusal text for deleting something that is still referenced.

Per-type data (account `123456789012`, region `us-east-1`):

| type | `id` | `arn` | extra defaults on create | seconds create/update/delete |
|---|---|---|---|---|
| aws_vpc | `vpc-0` + hex(8) | `arn:aws:ec2:us-east-1:123456789012:vpc/ID` | `default_security_group_id: sg-0` + hex(8) | 1/1/1 |
| aws_subnet | `subnet-0` + hex(8) | `arn:aws:ec2:us-east-1:123456789012:subnet/ID` | `availability_zone: us-east-1a` | 1/1/1 |
| aws_security_group | `sg-0` + hex(8) | `arn:aws:ec2:us-east-1:123456789012:security-group/ID` | `name: terraform-` + hex(20), `ingress: []`, `egress: []` | 2/2/1 |
| aws_instance | `i-0` + hex(16) | `arn:aws:ec2:us-east-1:123456789012:instance/ID` | `availability_zone: us-east-1a`, `private_ip: 10.0.` + (n1 % 256) + `.` + (n2 % 256) where n1/n2 are 8-bit values from hex(4) | 13/5/33 |
| aws_db_instance | the `identifier` | `arn:aws:rds:us-east-1:123456789012:db:IDENTIFIER` | `endpoint: IDENTIFIER.c` + hex(10) + `.us-east-1.rds.amazonaws.com:5432`, `engine_version: 15.4`, `allocated_storage: 20`, `multi_az: false` | 130/100/180 |
| aws_s3_bucket | the `bucket` | `arn:aws:s3:::BUCKET` | `bucket_domain_name: BUCKET.s3.amazonaws.com` | 1/1/1 |
| aws_sqs_queue | `https://sqs.us-east-1.amazonaws.com/123456789012/NAME` | `arn:aws:sqs:us-east-1:123456789012:NAME` | `url:` same as id | 1/1/1 |
| aws_iam_role | the `name` | `arn:aws:iam::123456789012:role` + (path with trailing `/`, default `/`) + NAME | — | 1/1/1 |
| aws_ecs_service | the `arn` | `arn:aws:ecs:us-east-1:123456789012:service/CLUSTER/NAME` | — | 13/2/10 |
| aws_cloudwatch_log_group | the `name` | `arn:aws:logs:us-east-1:123456789012:log-group:NAME` | — | 1/1/1 |

Unknown types: `id` = `<prefix>-0` + hex(8) where prefix is the type with its first segment (`aws_`) removed, underscores to dashes; no `arn` unless the planned object already has one; no defaults.

`alreadyExists` messages (RID = `requestId(seed)`):
- `aws_s3_bucket` (natural key `bucket`): `creating S3 Bucket (NAME): operation error S3: CreateBucket, https response error StatusCode: 409, RequestID: RID, BucketAlreadyOwnedByYou: Your previous request to create the named bucket succeeded and you already own it.`
- `aws_iam_role` (`name`): `creating IAM Role (NAME): operation error IAM: CreateRole, https response error StatusCode: 409, RequestID: RID, EntityAlreadyExists: Role with name NAME already exists.`
- `aws_cloudwatch_log_group` (`name`): `creating CloudWatch Logs Log Group (NAME): operation error CloudWatch Logs: CreateLogGroup, https response error StatusCode: 400, RequestID: RID, ResourceAlreadyExistsException: The specified log group already exists`
- `aws_sqs_queue` (`name`): `creating SQS Queue (NAME): QueueNameExists: A queue already exists with the same name and a different value for attribute VisibilityTimeout`
- `aws_db_instance` (`identifier`): `creating RDS DB Instance (NAME): operation error RDS: CreateDBInstance, https response error StatusCode: 400, RequestID: RID, DBInstanceAlreadyExists: DB instance already exists`
The existence check looks for a reality object of the same type whose `id` equals the natural key value (for `aws_sqs_queue` whose id is a URL, compare `name` attributes too).

`dependencyViolation` messages:
- `aws_vpc`: `deleting EC2 VPC (ID): operation error EC2: DeleteVpc, https response error StatusCode: 400, RequestID: RID, api error DependencyViolation: The vpc 'ID' has dependencies and cannot be deleted.`
- `aws_subnet`: `deleting EC2 Subnet (ID): operation error EC2: DeleteSubnet, https response error StatusCode: 400, RequestID: RID, api error DependencyViolation: The subnet 'ID' has dependencies and cannot be deleted.`
- `aws_security_group`: `deleting Security Group (ID): DependencyViolation: resource ID has a dependent object`
- any other type: `deleting TYPE (ID): DependencyViolation: the object has dependencies and cannot be deleted`

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { UNKNOWN } from '../src/game/terraform/eval.ts'
import { alreadyExists, dependencyViolation, fillOnCreate, fillOnUpdate, formatDuration, hex, referencedBy, requestId, seconds } from '../src/game/terraform/provider.ts'
import { realityKey, type Reality } from '../src/game/terraform/refresh.ts'

describe('deterministic helpers', () => {
  it('hex is stable, the right length, and varies with the seed', () => {
    expect(hex('a', 8)).toBe(hex('a', 8))
    expect(hex('a', 8)).toMatch(/^[0-9a-f]{8}$/)
    expect(hex('a', 20)).toMatch(/^[0-9a-f]{20}$/)
    expect(hex('a', 8)).not.toBe(hex('b', 8))
    expect(hex('a', 20).startsWith(hex('a', 8))).toBe(true)
  })
  it('request ids look like uuids', () => {
    expect(requestId('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
  it('formats durations like Terraform', () => {
    expect([formatDuration(0), formatDuration(7), formatDuration(60), formatDuration(65), formatDuration(252)]).toEqual(['0s', '7s', '1m0s', '1m5s', '4m12s'])
  })
  it('knows how long things take', () => {
    expect([seconds('aws_vpc', 'create'), seconds('aws_instance', 'delete'), seconds('aws_db_instance', 'create'), seconds('aws_nope', 'create'), seconds('aws_nope', 'update')]).toEqual([1, 33, 130, 2, 1])
  })
})

describe('fillOnCreate', () => {
  it('generates ids and arns by type', () => {
    const vpc = fillOnCreate('aws_vpc', 'aws_vpc.main', { id: UNKNOWN, arn: UNKNOWN, cidr_block: '10.0.0.0/16', default_security_group_id: UNKNOWN, tags_all: UNKNOWN }, 's1')
    expect(vpc.id).toMatch(/^vpc-0[0-9a-f]{8}$/)
    expect(vpc.arn).toBe(`arn:aws:ec2:us-east-1:123456789012:vpc/${vpc.id}`)
    expect(vpc.default_security_group_id).toMatch(/^sg-0[0-9a-f]{8}$/)
    expect(vpc.cidr_block).toBe('10.0.0.0/16')
    expect(vpc.tags_all).toBeNull()
  })

  it('uses natural names for ids where the provider does', () => {
    const db = fillOnCreate('aws_db_instance', 'aws_db_instance.o', { id: UNKNOWN, arn: UNKNOWN, identifier: 'orders-db', endpoint: UNKNOWN, engine_version: UNKNOWN, multi_az: true }, 's')
    expect(db).toMatchObject({ id: 'orders-db', arn: 'arn:aws:rds:us-east-1:123456789012:db:orders-db', engine_version: '15.4', allocated_storage: 20, multi_az: true })
    expect(db.endpoint).toMatch(/^orders-db\.c[0-9a-f]{10}\.us-east-1\.rds\.amazonaws\.com:5432$/)
    expect(fillOnCreate('aws_s3_bucket', 'a.b', { id: UNKNOWN, arn: UNKNOWN, bucket: 'logs' }, 's')).toMatchObject({ id: 'logs', arn: 'arn:aws:s3:::logs', bucket_domain_name: 'logs.s3.amazonaws.com' })
    expect(fillOnCreate('aws_sqs_queue', 'a.b', { id: UNKNOWN, arn: UNKNOWN, name: 'jobs' }, 's')).toMatchObject({ id: 'https://sqs.us-east-1.amazonaws.com/123456789012/jobs', url: 'https://sqs.us-east-1.amazonaws.com/123456789012/jobs', arn: 'arn:aws:sqs:us-east-1:123456789012:jobs' })
    expect(fillOnCreate('aws_iam_role', 'a.b', { id: UNKNOWN, arn: UNKNOWN, name: 'app', path: '/svc/' }, 's').arn).toBe('arn:aws:iam::123456789012:role/svc/app')
    expect(fillOnCreate('aws_iam_role', 'a.b', { id: UNKNOWN, arn: UNKNOWN, name: 'app' }, 's').arn).toBe('arn:aws:iam::123456789012:role/app')
    expect(fillOnCreate('aws_ecs_service', 'a.b', { id: UNKNOWN, arn: UNKNOWN, name: 'web', cluster: 'prod' }, 's')).toMatchObject({ id: 'arn:aws:ecs:us-east-1:123456789012:service/prod/web' })
  })

  it('does not overwrite configured values, is deterministic, and varies by address and seed', () => {
    const a = fillOnCreate('aws_instance', 'aws_instance.w', { id: UNKNOWN, arn: UNKNOWN, ami: 'ami-1', private_ip: UNKNOWN, availability_zone: 'us-east-1b' }, 's1')
    expect(a.availability_zone).toBe('us-east-1b')
    expect(a.private_ip).toMatch(/^10\.0\.\d{1,3}\.\d{1,3}$/)
    expect(fillOnCreate('aws_instance', 'aws_instance.w', { id: UNKNOWN, arn: UNKNOWN }, 's1').id).toBe(fillOnCreate('aws_instance', 'aws_instance.w', { id: UNKNOWN, arn: UNKNOWN }, 's1').id)
    expect(fillOnCreate('aws_instance', 'aws_instance.w', { id: UNKNOWN, arn: UNKNOWN }, 's2').id).not.toBe(fillOnCreate('aws_instance', 'aws_instance.w', { id: UNKNOWN, arn: UNKNOWN }, 's1').id)
    expect(fillOnCreate('aws_instance', 'aws_instance.x', { id: UNKNOWN, arn: UNKNOWN }, 's1').id).not.toBe(fillOnCreate('aws_instance', 'aws_instance.w', { id: UNKNOWN, arn: UNKNOWN }, 's1').id)
  })

  it('handles unknown types and does not mutate its input', () => {
    const input = { id: UNKNOWN, thing: UNKNOWN, keep: 1 }
    const out = fillOnCreate('aws_new_thing', 'aws_new_thing.t', input, 's')
    expect(out.id).toMatch(/^new-thing-0[0-9a-f]{8}$/)
    expect(out).toMatchObject({ thing: null, keep: 1 })
    expect(input.id).toBe(UNKNOWN)
  })
})

describe('fillOnUpdate', () => {
  it('keeps prior values for attributes that are unknown after the update', () => {
    expect(fillOnUpdate({ id: 'i-1', ip: '10.0.0.5' }, { id: 'i-1', ip: UNKNOWN, extra: UNKNOWN, t: 'x' })).toEqual({ id: 'i-1', ip: '10.0.0.5', extra: null, t: 'x' })
  })
})

describe('alreadyExists', () => {
  const reality: Reality = {
    [realityKey('aws_s3_bucket', 'legacy')]: { id: 'legacy', bucket: 'legacy' },
    [realityKey('aws_iam_role', 'app')]: { id: 'app', name: 'app' },
    [realityKey('aws_sqs_queue', 'https://q/jobs')]: { id: 'https://q/jobs', name: 'jobs' },
  }
  it('returns the provider error when the natural name is taken', () => {
    expect(alreadyExists('aws_s3_bucket', { bucket: 'legacy' }, reality, 's')).toMatch(/^creating S3 Bucket \(legacy\): operation error S3: CreateBucket, https response error StatusCode: 409, RequestID: [0-9a-f-]{36}, BucketAlreadyOwnedByYou: /)
    expect(alreadyExists('aws_iam_role', { name: 'app' }, reality, 's')).toContain('EntityAlreadyExists: Role with name app already exists.')
    expect(alreadyExists('aws_sqs_queue', { name: 'jobs' }, reality, 's')).toContain('creating SQS Queue (jobs): QueueNameExists')
  })
  it('is undefined when the name is free or the type has no natural key', () => {
    expect(alreadyExists('aws_s3_bucket', { bucket: 'fresh' }, reality, 's')).toBeUndefined()
    expect(alreadyExists('aws_vpc', { cidr_block: 'x' }, reality, 's')).toBeUndefined()
    expect(alreadyExists('aws_s3_bucket', {}, reality, 's')).toBeUndefined()
  })
})

describe('referencedBy and dependencyViolation', () => {
  const reality: Reality = {
    [realityKey('aws_vpc', 'vpc-1')]: { id: 'vpc-1' },
    [realityKey('aws_subnet', 'subnet-1')]: { id: 'subnet-1', vpc_id: 'vpc-1' },
    [realityKey('aws_instance', 'i-1')]: { id: 'i-1', nics: [{ subnet: 'subnet-1' }] },
  }
  it('finds the first object that mentions the id, ignoring the object itself', () => {
    expect(referencedBy(reality, 'aws_vpc', 'vpc-1')).toEqual({ type: 'aws_subnet', id: 'subnet-1' })
    expect(referencedBy(reality, 'aws_subnet', 'subnet-1')).toEqual({ type: 'aws_instance', id: 'i-1' })
    expect(referencedBy(reality, 'aws_instance', 'i-1')).toBeUndefined()
  })
  it('words the refusal per type', () => {
    expect(dependencyViolation('aws_vpc', 'vpc-1', 's')).toMatch(/^deleting EC2 VPC \(vpc-1\): operation error EC2: DeleteVpc, https response error StatusCode: 400, RequestID: [0-9a-f-]{36}, api error DependencyViolation: The vpc 'vpc-1' has dependencies and cannot be deleted\.$/)
    expect(dependencyViolation('aws_subnet', 'subnet-1', 's')).toContain("The subnet 'subnet-1' has dependencies and cannot be deleted.")
    expect(dependencyViolation('aws_security_group', 'sg-1', 's')).toBe('deleting Security Group (sg-1): DependencyViolation: resource sg-1 has a dependent object')
    expect(dependencyViolation('aws_other', 'x-1', 's')).toBe('deleting aws_other (x-1): DependencyViolation: the object has dependencies and cannot be deleted')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-provider.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/provider.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/provider.ts` implementing the interfaces and tables above. Structure: a `TYPES: Record<string, TypeInfo>` table (own-key lookup through `Object.hasOwn`) with `id`, `arn?`, `defaults?`, `natural?` (`{ key: string; error(name, rid): string }`), `seconds`; `hex` is FNV-1a (`h ^= charCode; h = Math.imul(h, 0x01000193) >>> 0`, offset basis `0x811c9dc5`) over `${seed}#${round}`, concatenating 8-hex-digit rounds until `len`; `requestId` slices `hex(seed,32)` as 8-4-4-4-12; `referencedBy` iterates `Object.keys(reality).sort()` and deep-scans values; `fillOnCreate` builds the output with `Object.fromEntries`/`Map` (never `out[k] =` on user keys). The `seed` argument to `fillOnCreate` is combined with the address: `hex(`${address}:${seed}`, n)`; use different salts per attribute (`:vpc`, `:sg`, `:name`, `:ip`…) so the generated pieces differ.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-provider.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/provider.ts tests/terraform-provider.test.ts
git commit -m "feat: simulated provider: ids, arns, durations, already-exists and dependency errors (TF3a)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `executeApply`

**Files:**
- Create: `src/game/terraform/apply.ts`
- Test: `tests/terraform-apply.test.ts`
- Modify: `CONTENT_TODO.md` (append)

**Interfaces (produces):**

```ts
export interface Fault {
  at: string // an instance address (aws_subnet.a, aws_s3_bucket.b["x"]) or a resource address (aws_subnet.a)
  on: 'create' | 'update' | 'delete'
  error: string // the provider's complete error text, shown as the Error summary
  times?: number // fail this many times, then succeed (default: always)
  if?: { attr: string; equals: Value } // only when the new object's attribute has this value (create/update)
  until_actions?: string[] // inactive once all of these actions are taken
}
export interface ApplyContext {
  faults: Fault[]
  taken: Set<string> // actions the player has taken
  attempts: Map<number, number> // fault index -> times it has fired (persisted by the caller across runs)
  seed: string // salt for generated ids; the caller passes the state serial, e.g. String(state.serial)
}
export interface ApplyStep { address: string; op: 'create' | 'update' | 'delete' | 'forget' | 'import'; id?: string; seconds: number; ok: boolean }
export interface ApplyResult {
  plan: PlanResult // the first plan (refresh included)
  steps: ApplyStep[] // in execution order, failed attempts included (ok: false)
  errors: Diagnostic[] // provider errors with address, file, line, context
  state: State
  reality: Reality
  counts: { imported: number; added: number; changed: number; destroyed: number }
}
export function executeApply(input: PlanInput, ctx: ApplyContext): ApplyResult
```

Behavior:
- Loop (guard 2000): `plan = planConfig({ ...input, state, reality, refresh: first ? input.refresh : false })`; if `plan.diagnostics` is non-empty, stop and return them as `errors` with no further steps (counts 0, state/reality unchanged except the first plan's refresh adoption not applied); otherwise `state = clone(plan.baseState)`; pick the next ready item (below); stop when none.
- Pending items: `create`, `update`, `replace`, `destroy`, `forget`, and any item with `importing`. Resource address `res(i) = `${i.type}.${i.name}``.
- Order: (1) a destroy-phase item (`destroy` or `replace`) is ready when its resource has not failed and no OTHER pending destroy-phase item lists `res(i)` in its `dependsOn`; (2) then `forget` and `import` items; (3) then a `create`/`update` item whose resource has not failed, none of whose `dependsOn` resources has failed, and none of whose `dependsOn` resources has another pending item. Take the first ready item in item order each iteration.
- Executing (`seed` for generated values is `${ctx.seed}:${steps.length}`):
  - **delete** (for `destroy` and `replace`): the object is in state at `i.address`; first the fault check, then `referencedBy(reality, type, id)` → on a hit fail with `dependencyViolation(...)`; on success remove the instance (drop empty resources) from state and the object from reality (`realityKey(type, id)`); `seconds(type,'delete')`; `counts.destroyed++`.
  - **create**: attributes = the item's `changes` as `{ name: after }`; `fillOnCreate(...)`; then `alreadyExists(type, attrs, reality, seed)` → fail; then the fault check; success: add the instance to state (new resource entries use `provider["<schemaFor(type)?.provider ?? registry.terraform.io/hashicorp/<prefix>>"]`, `index_key = i.key`, `dependencies = i.dependsOn` when non-empty) and the attributes to reality; `counts.added++`.
  - **update**: next = prior attributes with each change applied (`after === null` stores `null`), `fillOnUpdate(prior, next)`; fault check; success: replace the instance attributes in state and the object in reality (`id` unchanged); `counts.changed++`.
  - **forget**: remove the instance from state only (no step failure possible); step `forget`.
  - **import**: add the instance to state with `structuredClone` of the cloud object (`input.reality[realityKey(type, importing)]`); step `import`; `counts.imported++`.
  - A failure appends `{ address, op, seconds, ok: false }` to `steps`, appends the diagnostic `{ severity: 'error', summary: <error text>, detail: '', address: i.address, file/line/col from i.block, context: 'resource "T" "N"' }`, and marks `res(i)` failed (later items depending on it are never attempted). A fault matches when `fault.at` equals the instance address or the resource address, `fault.on` equals the op, its `until_actions` are not all taken, its `if` (checked against the new attributes) holds, and `attempts.get(index) ?? 0 < (times ?? Infinity)`; firing increments `attempts`. Faults are checked after `alreadyExists`/`dependencyViolation`? No: faults are checked FIRST (a scripted fault wins), then the generic cloud errors.
- After the loop: if `errors` is empty, run one more `planConfig` (refresh false) and set `state.outputs` to the plan's outputs whose values contain no unknowns (`{ value, sensitive }` when sensitive), dropping outputs that are no longer configured; if there were steps, `state.serial++`. Never mutate `input`.

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-apply.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { executeApply, type ApplyContext, type Fault } from '../src/game/terraform/apply.ts'
import { UNKNOWN, type Value } from '../src/game/terraform/eval.ts'
import { planConfig } from '../src/game/terraform/plan.ts'
import { realityKey, type Reality } from '../src/game/terraform/refresh.ts'
import { emptyState, findInstance, listAddresses, type State } from '../src/game/terraform/state.ts'

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]'
type Seed = { type: string; name: string; key?: string | number; attrs: Record<string, Value>; deps?: string[] }
const stateOf = (...seeds: Seed[]): State => {
  const s = emptyState()
  for (const x of seeds) {
    let r = s.resources.find((r) => r.type === x.type && r.name === x.name)
    if (!r) {
      r = { mode: 'managed', type: x.type, name: x.name, provider: AWS, instances: [] }
      s.resources.push(r)
    }
    r.instances.push({ ...(x.key === undefined ? {} : { index_key: x.key }), attributes: x.attrs, ...(x.deps ? { dependencies: x.deps } : {}) })
  }
  return s
}
const cloudOf = (state: State): Reality =>
  Object.fromEntries(state.resources.flatMap((r) => r.instances.map((i) => [realityKey(r.type, i.attributes.id as string), structuredClone(i.attributes)] as const)))
const ctx = (o: Partial<ApplyContext> = {}): ApplyContext => ({ faults: [], taken: new Set(), attempts: new Map(), seed: '1', ...o })
const run = (tf: string, o: { state?: State; reality?: Reality; vars?: Record<string, Value>; ctx?: Partial<ApplyContext> } = {}) => {
  const state = o.state ?? emptyState()
  return executeApply({ files: [{ name: 'main.tf', text: tf }], state, reality: o.reality ?? cloudOf(state), vars: o.vars ?? {} }, ctx(o.ctx))
}
const ops = (r: { steps: { op: string; address: string; ok: boolean }[] }) => r.steps.map((s) => `${s.ok ? '' : '!'}${s.op} ${s.address}`)

const NETWORK = (cidr: string) => `
resource "aws_vpc" "main" {
  cidr_block = "${cidr}"
}
resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}
`
const VPC = { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1' }
const SUBNET = { id: 'subnet-1', arn: 'arn:subnet-1', vpc_id: 'vpc-1', cidr_block: '10.0.1.0/24', availability_zone: 'us-east-1a', map_public_ip_on_launch: false }
const both = () => stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_subnet', name: 'a', attrs: SUBNET, deps: ['aws_vpc.main'] })

describe('executeApply: create', () => {
  it('creates in dependency order, with real values flowing to dependents', () => {
    const r = run(NETWORK('10.0.0.0/16'))
    expect(r.errors).toEqual([])
    expect(ops(r)).toEqual(['create aws_vpc.main', 'create aws_subnet.a'])
    expect(r.counts).toEqual({ imported: 0, added: 2, changed: 0, destroyed: 0 })
    const vpc = findInstance(r.state, 'aws_vpc.main')!.instance
    const subnet = findInstance(r.state, 'aws_subnet.a')!.instance
    expect(vpc.attributes.id).toMatch(/^vpc-0[0-9a-f]{8}$/)
    expect(subnet.attributes.vpc_id).toBe(vpc.attributes.id)
    expect(subnet.dependencies).toEqual(['aws_vpc.main'])
    expect(r.reality[realityKey('aws_subnet', subnet.attributes.id as string)]).toEqual(subnet.attributes)
    expect(r.state.serial).toBe(1)
    expect(r.steps.map((s) => s.seconds)).toEqual([1, 1])
    expect(r.steps[0].id).toBe(vpc.attributes.id)
  })

  it('is deterministic, and applying again after a clean apply does nothing', () => {
    const a = run(NETWORK('10.0.0.0/16'))
    expect(run(NETWORK('10.0.0.0/16')).state).toEqual(a.state)
    const again = executeApply({ files: [{ name: 'main.tf', text: NETWORK('10.0.0.0/16') }], state: a.state, reality: a.reality, vars: {} }, ctx())
    expect(again.steps).toEqual([])
    expect(again.counts).toEqual({ imported: 0, added: 0, changed: 0, destroyed: 0 })
    expect(again.state.serial).toBe(a.state.serial)
  })

  it('does not mutate its inputs', () => {
    const state = both()
    const reality = cloudOf(state)
    const copy = structuredClone([state, reality])
    run(NETWORK('10.9.0.0/16'), { state, reality })
    expect([state, reality]).toEqual(copy)
  })

  it('fills outputs from real values after a clean apply', () => {
    const r = run(NETWORK('10.0.0.0/16') + 'output "subnet" {\n  value = aws_subnet.a.id\n}\noutput "secret" {\n  value = "x"\n  sensitive = true\n}\n')
    expect(r.state.outputs.subnet.value).toBe(findInstance(r.state, 'aws_subnet.a')!.instance.attributes.id)
    expect(r.state.outputs.secret).toEqual({ value: 'x', sensitive: true })
  })
})

describe('executeApply: update, replace, destroy', () => {
  it('updates in place', () => {
    const r = run('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  enable_dns_hostnames = true\n}\n', { state: stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }) })
    expect(ops(r)).toEqual(['update aws_vpc.main'])
    expect(r.counts).toEqual({ imported: 0, added: 0, changed: 1, destroyed: 0 })
    expect(findInstance(r.state, 'aws_vpc.main')!.instance.attributes).toMatchObject({ id: 'vpc-1', enable_dns_hostnames: true })
    expect(r.reality[realityKey('aws_vpc', 'vpc-1')]).toMatchObject({ enable_dns_hostnames: true })
  })

  it('replaces a resource and its dependents in the right order, wiring the new ids', () => {
    const r = run(NETWORK('10.1.0.0/16'), { state: both() })
    expect(r.errors).toEqual([])
    expect(ops(r)).toEqual(['delete aws_subnet.a', 'delete aws_vpc.main', 'create aws_vpc.main', 'create aws_subnet.a'])
    expect(r.counts).toEqual({ imported: 0, added: 2, changed: 0, destroyed: 2 })
    const vpc = findInstance(r.state, 'aws_vpc.main')!.instance.attributes
    expect(vpc.id).not.toBe('vpc-1')
    expect(vpc.cidr_block).toBe('10.1.0.0/16')
    expect(findInstance(r.state, 'aws_subnet.a')!.instance.attributes.vpc_id).toBe(vpc.id)
    expect(Object.keys(r.reality).sort()).toEqual([realityKey('aws_subnet', findInstance(r.state, 'aws_subnet.a')!.instance.attributes.id as string), realityKey('aws_vpc', vpc.id as string)].sort())
  })

  it('destroys what is no longer configured, dependents first (from state dependencies)', () => {
    const r = run('# none\n', { state: both() })
    expect(ops(r)).toEqual(['delete aws_subnet.a', 'delete aws_vpc.main'])
    expect(r.state.resources).toEqual([])
    expect(r.reality).toEqual({})
    expect(r.counts.destroyed).toBe(2)
  })

  it('forgets without touching the cloud, and applies moved blocks', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'old', attrs: VPC })
    const forgot = run('removed {\n  from = aws_vpc.old\n  lifecycle {\n    destroy = false\n  }\n}\n', { state })
    expect(ops(forgot)).toEqual(['forget aws_vpc.old'])
    expect(forgot.state.resources).toEqual([])
    expect(forgot.reality[realityKey('aws_vpc', 'vpc-1')]).toBeDefined()
    const moved = run('resource "aws_vpc" "new" {\n  cidr_block = "10.0.0.0/16"\n}\nmoved {\n  from = aws_vpc.old\n  to   = aws_vpc.new\n}\n', { state })
    expect(listAddresses(moved.state)).toEqual(['aws_vpc.new'])
    expect(moved.steps).toEqual([])
  })

  it('brings a drifted cloud back to the configuration, persisting the refresh first', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: { ...VPC, tags: { Name: 'main' }, tags_all: { Name: 'main' } } })
    const reality = cloudOf(state)
    reality[realityKey('aws_vpc', 'vpc-1')] = { ...VPC, tags: { Name: 'main', Owner: 'ops' }, tags_all: { Name: 'main', Owner: 'ops' } }
    const r = run('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  tags = { Name = "main" }\n}\n', { state, reality })
    expect(ops(r)).toEqual(['update aws_vpc.main'])
    expect(r.reality[realityKey('aws_vpc', 'vpc-1')]).toMatchObject({ tags: { Name: 'main' } })
    expect(r.plan.drift).toHaveLength(1)
  })
})

describe('executeApply: failures', () => {
  it('stops at a dependency violation and does not attempt what depends on the failure', () => {
    const state = both()
    const reality = cloudOf(state)
    reality[realityKey('aws_network_interface', 'eni-1')] = { id: 'eni-1', subnet_id: 'subnet-1' }
    const r = run('# none\n', { state, reality })
    expect(ops(r)).toEqual(['!delete aws_subnet.a'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ severity: 'error', address: 'aws_subnet.a' })
    expect(r.errors[0].summary).toContain("api error DependencyViolation: The subnet 'subnet-1' has dependencies and cannot be deleted.")
    expect(listAddresses(r.state)).toEqual(['aws_subnet.a', 'aws_vpc.main'])
    expect(Object.keys(r.reality)).toHaveLength(3)
    expect(r.counts.destroyed).toBe(0)
  })

  it('fails to create something that already exists, changing nothing', () => {
    const tf = 'resource "aws_s3_bucket" "b" {\n  bucket = "legacy"\n}\n'
    const reality: Reality = { [realityKey('aws_s3_bucket', 'legacy')]: { id: 'legacy', arn: 'arn:aws:s3:::legacy', bucket: 'legacy' } }
    const r = run(tf, { reality })
    expect(ops(r)).toEqual(['!create aws_s3_bucket.b'])
    expect(r.errors[0].summary).toMatch(/^creating S3 Bucket \(legacy\):.*BucketAlreadyOwnedByYou/)
    expect(r.errors[0]).toMatchObject({ file: 'main.tf', line: 1, context: 'resource "aws_s3_bucket" "b"', address: 'aws_s3_bucket.b' })
    expect(r.state.resources).toEqual([])
    expect(r.reality).toEqual(reality)
  })

  it('imports the existing object instead, and the next apply is clean', () => {
    const tf = 'resource "aws_s3_bucket" "b" {\n  bucket = "legacy"\n}\nimport {\n  to = aws_s3_bucket.b\n  id = "legacy"\n}\n'
    const reality: Reality = { [realityKey('aws_s3_bucket', 'legacy')]: { id: 'legacy', arn: 'arn:aws:s3:::legacy', bucket: 'legacy', force_destroy: false } }
    const r = run(tf, { reality })
    expect(r.errors).toEqual([])
    expect(ops(r)).toEqual(['import aws_s3_bucket.b'])
    expect(r.counts).toEqual({ imported: 1, added: 0, changed: 0, destroyed: 0 })
    expect(findInstance(r.state, 'aws_s3_bucket.b')!.instance.attributes.id).toBe('legacy')
    const again = executeApply({ files: [{ name: 'main.tf', text: tf }], state: r.state, reality: r.reality, vars: {} }, ctx())
    expect(again.steps).toEqual([])
  })

  it('keeps going with independent resources after one fails, and leaves a half-applied world', () => {
    const tf = NETWORK('10.0.0.0/16') + 'resource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n'
    const faults: Fault[] = [{ at: 'aws_vpc.main', on: 'create', error: 'creating EC2 VPC: operation error EC2: CreateVpc, https response error StatusCode: 400, api error VpcLimitExceeded: The maximum number of VPCs has been reached.' }]
    const r = run(tf, { ctx: { faults } })
    expect(ops(r)).toEqual(['!create aws_vpc.main', 'create aws_s3_bucket.logs'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].summary).toContain('VpcLimitExceeded')
    expect(listAddresses(r.state)).toEqual(['aws_s3_bucket.logs'])
    expect(r.counts.added).toBe(1)
    expect(r.state.outputs).toEqual({})
  })

  it('applies partway: the dependency succeeds and the dependent fails', () => {
    const faults: Fault[] = [{ at: 'aws_subnet.a', on: 'create', error: "creating EC2 Subnet: api error InvalidSubnet.Conflict: The CIDR '10.0.1.0/24' conflicts with another subnet" }]
    const r = run(NETWORK('10.0.0.0/16'), { ctx: { faults } })
    expect(ops(r)).toEqual(['create aws_vpc.main', '!create aws_subnet.a'])
    expect(listAddresses(r.state)).toEqual(['aws_vpc.main'])
    const next = executeApply({ files: [{ name: 'main.tf', text: NETWORK('10.0.0.0/16') }], state: r.state, reality: r.reality, vars: {} }, ctx())
    expect(ops(next)).toEqual(['create aws_subnet.a'])
  })
})

describe('executeApply: scripted faults', () => {
  const create = 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n'
  const err = 'creating S3 Bucket (x): AccessDenied'

  it('fires a limited number of times across runs, with the attempts persisted by the caller', () => {
    const c = ctx({ faults: [{ at: 'aws_s3_bucket.b', on: 'create', error: err, times: 1 }] })
    const first = executeApply({ files: [{ name: 'main.tf', text: create }], state: emptyState(), reality: {}, vars: {} }, c)
    expect(ops(first)).toEqual(['!create aws_s3_bucket.b'])
    expect(c.attempts.get(0)).toBe(1)
    const second = executeApply({ files: [{ name: 'main.tf', text: create }], state: first.state, reality: first.reality, vars: {} }, c)
    expect(ops(second)).toEqual(['create aws_s3_bucket.b'])
  })

  it('is conditional on an attribute value and on actions taken', () => {
    const big = 'resource "aws_instance" "w" {\n  ami = "ami-1"\n  instance_type = "m5.24xlarge"\n}\n'
    const small = big.replace('m5.24xlarge', 't3.micro')
    const fault: Fault = { at: 'aws_instance.w', on: 'create', error: 'creating EC2 Instance: InsufficientInstanceCapacity', if: { attr: 'instance_type', equals: 'm5.24xlarge' } }
    expect(ops(run(big, { ctx: { faults: [fault] } }))).toEqual(['!create aws_instance.w'])
    expect(ops(run(small, { ctx: { faults: [fault] } }))).toEqual(['create aws_instance.w'])
    const gated: Fault = { at: 'aws_instance.w', on: 'create', error: 'creating EC2 Instance: UnauthorizedOperation', until_actions: ['attach-policy'] }
    expect(ops(run(small, { ctx: { faults: [gated] } }))).toEqual(['!create aws_instance.w'])
    expect(ops(run(small, { ctx: { faults: [gated], taken: new Set(['attach-policy']) } }))).toEqual(['create aws_instance.w'])
  })

  it('matches instance addresses and resource addresses, and the operation', () => {
    const many = 'resource "aws_s3_bucket" "b" {\n  for_each = toset(["a", "b"])\n  bucket = "bk-${each.key}"\n}\n'
    expect(ops(run(many, { ctx: { faults: [{ at: 'aws_s3_bucket.b["b"]', on: 'create', error: 'boom' }] } }))).toEqual(['create aws_s3_bucket.b["a"]', '!create aws_s3_bucket.b["b"]'])
    expect(ops(run(many, { ctx: { faults: [{ at: 'aws_s3_bucket.b', on: 'create', error: 'boom' }] } }))).toEqual(['!create aws_s3_bucket.b["a"]', '!create aws_s3_bucket.b["b"]'])
    expect(ops(run(many, { ctx: { faults: [{ at: 'aws_s3_bucket.b', on: 'delete', error: 'boom' }] } }))).toEqual(['create aws_s3_bucket.b["a"]', 'create aws_s3_bucket.b["b"]'])
  })

  it('reports configuration errors without executing anything', () => {
    const r = run('resource "aws_vpc" "main" {\n  cidr_block\n}\n')
    expect(r.steps).toEqual([])
    expect(r.errors[0].summary).toBe('Argument or block definition required')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-apply.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/apply.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/apply.ts` following the Behavior section: the types above; a private `pickNext(pending, failed)` implementing the three-tier readiness rules; a private `execute(...)` with one branch per op; helpers `res(item)`, `removeInstance(state, address)`, `addInstance(state, item, attrs)`. Use `structuredClone` for every state/reality change; build objects with `Object.fromEntries`/`Map`. Faults are checked before the generic cloud errors. After the loop run the output pass.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-apply.test.ts && npm test 2>&1 | grep -E "Test Files|Tests " && npm run lint 2>&1 | tail -15 && npx tsc -b`
Expected: PASS; lint clean; `tsc` silent. Where a test fixture disagrees with the behavior spec, decide whether the code or the fixture is wrong and record why; never weaken an assertion to get green.

- [ ] **Step 5: Append to `CONTENT_TODO.md`, commit**

Append (read the tail first; blank line before the section):

```markdown

## terraform simulator (apply engine, TF3a)
- [ ] Provider error texts (`BucketAlreadyOwnedByYou`, `EntityAlreadyExists`, `ResourceAlreadyExistsException`, `QueueNameExists`, `DBInstanceAlreadyExists`, `DependencyViolation` for VPC/subnet/security group): shaped like the AWS SDK v2 errors the provider wraps, with invented request ids; confirm each against real provider output.
- [ ] Generated ids and ARNs per resource type (formats, `aws_db_instance.id` = identifier, `aws_sqs_queue.id` = URL, `aws_ecs_service.id` = ARN) and the defaults filled on create (engine_version 15.4, allocated_storage 20, availability_zone us-east-1a, private_ip 10.0.x.y): from memory of the provider.
- [ ] Durations per type (create/update/delete seconds) are plausible, not measured.
- [ ] Replacements are always destroy-then-create; `create_before_destroy` ordering (two objects at one address, "deposed" objects) is not modeled.
- [ ] A failed create after a successful destroy leaves the resource missing from state, as real Terraform does; there is no rollback.
- [ ] Apply treats the first dependency violation as final (no retries); real providers retry some eventual-consistency errors for minutes before failing.
- [ ] State `dependencies` for the starting state are derived from ids found in attributes; real state records the configuration's references.
```

```bash
git add src/game/terraform/apply.ts tests/terraform-apply.test.ts CONTENT_TODO.md
git commit -m "feat: executeApply: ordered execution, provider errors, faults, partial failure (TF3a)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done)

- **Spec coverage:** "Apply" (graph-ordered execution, partial failure leaving real state, scripted faults, lock held during apply is TF3c) and the data apply needs from the planner are covered; the CLI is TF3b.
- **Placeholders:** none. **Type consistency:** `Fault`, `ApplyContext`, `ApplyStep`, `ApplyResult`, `PlanItem.dependsOn/block`, `PlanResult.baseState`, `StateInstance.dependencies`, `Diagnostic.address` and the provider function names match across tasks and tests.
- **Review Focus:** all five lines have tests (ordering and wiring: Task 3 replace test; partial failure and independence: Task 3 failures; dependency violation / already exists: Task 3; determinism and idempotency: Task 3; drift persistence: Task 3).
- **Hand-traced fixtures:** the replace cascade order follows from the readiness rules (destroy-phase: `subnet` is ready first because no other pending destroy-phase item lists `aws_subnet.a` in `dependsOn`, then `vpc`; after both are gone the next plan has two `create` items and `subnet` waits for `vpc`); the partial-failure test relies on `bucket` not depending on the VPC.
