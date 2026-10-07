# Terraform TF2b-1: resource schemas, instance diff, state and refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The pure building blocks of a Terraform plan: a library of resource-type schemas (which attributes force replacement, which are computed, which are secret), a function that diffs one resource instance's configuration against its prior state into create / update / replace / no-op with per-attribute changes, the tfstate data model, and refresh (state vs the simulated cloud, producing drift).

**Architecture:** `resources.ts` holds the schema table and `diffInstance`. `state.ts` holds the tfstate v4 shapes, addresses and JSON rendering. `refresh.ts` compares state with `Reality` (a flat map of what exists in the simulated cloud). All three are pure functions over `Value` from the evaluator; none touch the shell or UI. TF2b-2 (the plan walker) composes them with the graph and evaluator.

**Tech Stack:** TypeScript (strict), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("Three worlds", "Plan algorithm" steps 1 and 4, "Resource schemas"). TF1 (parser, graph) and TF2a (`eval.ts`, `functions.ts`) are complete; this plan uses `Value`, `UNKNOWN`, `isUnknown`, `hasUnknown`, `equal` from `./eval.ts`.

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, `import type` for types, `.ts` import extensions.
- No new npm dependencies.
- Tests live in `tests/*.test.ts` (vitest); `src/` is type-checked by `npx tsc -b`.
- Own-property discipline: never use `in` or `obj[userKey] = ...` on objects keyed by user-supplied names (attribute names, tags, state keys). Use `Object.hasOwn`, `Object.fromEntries`, `Map`, or `Object.defineProperty`. An attribute named `__proto__` is legal HCL and must not pollute prototypes.
- A resource type not in the library is reported honestly (Task 1's `unsupportedType`), never silently treated as known.
- Facts about which attributes force replacement come from the provider documentation; entries not yet checked are logged in `CONTENT_TODO.md` (Task 1).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A value that is unknown at plan time (for example a `vpc_id` that comes from a resource being replaced) must produce a change, and if the attribute forces replacement, a replacement (Task 2 test).
2. `ignore_changes` (by name or `all`) suppresses changes for those attributes only, and never suppresses the create of a missing resource (Task 2 test).
3. An attribute the provider fills in (computed, not configured) must not show as a change when it is omitted from configuration (Task 2 test).
4. Removing a configured attribute (`tags` deleted from the file) is a change to `null`, not a no-op (Task 2 test).
5. Refresh must not mutate the input state, and a resource deleted in the cloud must disappear from the refreshed state while still being reported as drift (Task 3 tests).

---

### Task 1: Resource schema library

**Files:**
- Create: `src/game/terraform/resources.ts`
- Test: `tests/terraform-resources.test.ts`
- Modify: `CONTENT_TODO.md` (append a section)

**Interfaces:**
- Consumes: `Value` from `./eval.ts`.
- Produces:
  - `interface AttrSpec { forceNew?: boolean; computed?: boolean; sensitive?: boolean; readOnly?: boolean; default?: Value }` (`readOnly`: the provider sets it, never configurable, such as `id`/`arn`; `computed`: configurable but filled in by the provider when omitted)
  - `interface ResourceSchema { provider: string; attrs: Record<string, AttrSpec> }`
  - `SCHEMAS: Record<string, ResourceSchema>`, `schemaFor(type: string): ResourceSchema | undefined`, `unsupportedType(type: string): { summary: string; detail: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-resources.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SCHEMAS, schemaFor, unsupportedType } from '../src/game/terraform/resources.ts'

describe('resource schemas', () => {
  it('knows the AWS types the incidents use', () => {
    for (const t of ['aws_vpc', 'aws_subnet', 'aws_security_group', 'aws_instance', 'aws_db_instance', 'aws_s3_bucket', 'aws_sqs_queue', 'aws_iam_role', 'aws_ecs_service', 'aws_cloudwatch_log_group']) {
      expect(schemaFor(t), t).toBeDefined()
    }
  })

  it('marks the attributes that force replacement', () => {
    expect(schemaFor('aws_db_instance')!.attrs.storage_encrypted.forceNew).toBe(true)
    expect(schemaFor('aws_db_instance')!.attrs.instance_class.forceNew).toBeFalsy()
    expect(schemaFor('aws_s3_bucket')!.attrs.bucket.forceNew).toBe(true)
    expect(schemaFor('aws_subnet')!.attrs.vpc_id.forceNew).toBe(true)
    expect(schemaFor('aws_instance')!.attrs.instance_type.forceNew).toBeFalsy()
  })

  it('gives every schema a read-only id and arn, and marks secrets', () => {
    for (const [t, s] of Object.entries(SCHEMAS)) {
      expect(s.attrs.id?.readOnly, `${t}.id`).toBe(true)
      expect(s.attrs.arn?.readOnly, `${t}.arn`).toBe(true)
    }
    expect(schemaFor('aws_db_instance')!.attrs.password.sensitive).toBe(true)
  })

  it('does not find inherited names, and reports an unmodeled type honestly', () => {
    expect(schemaFor('constructor')).toBeUndefined()
    expect(schemaFor('aws_nope')).toBeUndefined()
    expect(unsupportedType('aws_nope')).toEqual({
      summary: 'Invalid resource type',
      detail: 'The provider hashicorp/aws does not support resource type "aws_nope". (This lab only models some resource types.)',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-resources.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/resources.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/resources.ts`:

```ts
// What the simulated providers know about each resource type: which
// attributes the provider computes, which are secret, and which force the
// resource to be destroyed and re-created when they change ("forces
// replacement" in a plan). Types not listed here are not modeled.
import type { Value } from './eval.ts'

export interface AttrSpec {
  forceNew?: boolean // changing it replaces the resource
  computed?: boolean // configurable, but the provider fills it in when omitted
  sensitive?: boolean // printed as (sensitive value)
  readOnly?: boolean // set by the provider only (id, arn); never configurable
  default?: Value // the provider's default when the configuration omits it
}
export interface ResourceSchema {
  provider: string
  attrs: Record<string, AttrSpec>
}

const AWS = 'registry.terraform.io/hashicorp/aws'
const RO: AttrSpec = { readOnly: true }
const NEW: AttrSpec = { forceNew: true }
const NEWC: AttrSpec = { forceNew: true, computed: true }
const aws = (attrs: Record<string, AttrSpec>): ResourceSchema => ({ provider: AWS, attrs: { id: RO, arn: RO, ...attrs } })

export const SCHEMAS: Record<string, ResourceSchema> = {
  aws_vpc: aws({
    cidr_block: NEWC,
    enable_dns_support: { default: true },
    enable_dns_hostnames: { default: false },
    tags: {},
    tags_all: RO,
    default_security_group_id: RO,
  }),
  aws_subnet: aws({ vpc_id: NEW, cidr_block: NEWC, availability_zone: NEWC, map_public_ip_on_launch: { default: false }, tags: {}, tags_all: RO }),
  aws_security_group: aws({
    name: NEWC,
    name_prefix: NEWC,
    description: { forceNew: true, default: 'Managed by Terraform' },
    vpc_id: NEWC,
    ingress: { computed: true },
    egress: { computed: true },
    tags: {},
    tags_all: RO,
  }),
  aws_instance: aws({
    ami: NEW,
    instance_type: {},
    subnet_id: NEWC,
    availability_zone: NEWC,
    key_name: NEWC,
    user_data: {},
    tags: {},
    tags_all: RO,
    private_ip: RO,
    public_ip: RO,
  }),
  aws_db_instance: aws({
    identifier: NEWC,
    engine: NEW,
    engine_version: { computed: true },
    instance_class: {},
    allocated_storage: { computed: true },
    storage_encrypted: { forceNew: true, computed: true },
    kms_key_id: NEWC,
    db_name: NEWC,
    username: NEWC,
    password: { sensitive: true },
    multi_az: { computed: true },
    skip_final_snapshot: { default: false },
    endpoint: RO,
  }),
  aws_s3_bucket: aws({ bucket: NEWC, force_destroy: { default: false }, tags: {}, tags_all: RO, bucket_domain_name: RO }),
  aws_sqs_queue: aws({
    name: NEWC,
    fifo_queue: { forceNew: true, default: false },
    visibility_timeout_seconds: { default: 30 },
    message_retention_seconds: { default: 345600 },
    tags: {},
    tags_all: RO,
    url: RO,
  }),
  aws_iam_role: aws({ name: NEWC, path: { forceNew: true, default: '/' }, assume_role_policy: {}, tags: {}, tags_all: RO }),
  aws_ecs_service: aws({ name: NEW, cluster: NEWC, task_definition: {}, desired_count: { default: 0 }, tags: {}, tags_all: RO }),
  aws_cloudwatch_log_group: aws({ name: NEWC, retention_in_days: { default: 0 }, tags: {}, tags_all: RO }),
}

export function schemaFor(type: string): ResourceSchema | undefined {
  return Object.hasOwn(SCHEMAS, type) ? SCHEMAS[type] : undefined
}

// The error for a resource type the lab doesn't model.
export function unsupportedType(type: string): { summary: string; detail: string } {
  const provider = type.split('_')[0]
  return {
    summary: 'Invalid resource type',
    detail: `The provider hashicorp/${provider} does not support resource type "${type}". (This lab only models some resource types.)`,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-resources.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent.

- [ ] **Step 5: Append to `CONTENT_TODO.md` and commit**

Append (read the file tail first; keep a blank line before the new section):

```markdown

## terraform simulator (resource schemas, TF2b-1)
Which attributes force replacement, which are computed, and the defaults are from experience with the AWS provider; check each against the provider docs ("Forces new resource" notes) before relying on it in an incident.
- [ ] aws_vpc: `cidr_block` forces replacement; `enable_dns_support` default true, `enable_dns_hostnames` default false.
- [ ] aws_subnet: `vpc_id`, `cidr_block`, `availability_zone` force replacement.
- [ ] aws_security_group: `name`, `name_prefix`, `description`, `vpc_id` force replacement; description default "Managed by Terraform".
- [ ] aws_instance: `ami`, `subnet_id`, `availability_zone`, `key_name` force replacement (subnet_id may be updatable in newer provider versions); `instance_type` and `user_data` update in place.
- [ ] aws_db_instance: `identifier`, `engine`, `storage_encrypted`, `kms_key_id`, `db_name`, `username` force replacement; `instance_class`, `allocated_storage`, `multi_az` update in place.
- [ ] aws_s3_bucket (`bucket`), aws_sqs_queue (`name`, `fifo_queue`; defaults 30 s visibility, 345600 s retention), aws_iam_role (`name`, `path`), aws_ecs_service (`name`, `cluster`), aws_cloudwatch_log_group (`name`).
- [ ] The "Invalid resource type" detail: real Terraform prints only the first sentence; the second is a lab note.
```

```bash
git add src/game/terraform/resources.ts tests/terraform-resources.test.ts CONTENT_TODO.md
git commit -m "feat: Terraform resource schema library (TF2b-1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Instance diff

**Files:**
- Modify: `src/game/terraform/resources.ts` (append `diffInstance` and its types)
- Modify: `tests/terraform-resources.test.ts` (append)

**Interfaces:**
- Consumes: `AttrSpec`, `ResourceSchema` (Task 1); `equal`, `hasUnknown`, `UNKNOWN`, `Value` from `./eval.ts`.
- Produces:
  - `type Action = 'create' | 'update' | 'replace' | 'noop'`
  - `interface AttrChange { name: string; before: Value | undefined; after: Value; forcesReplacement: boolean; sensitive: boolean }`
  - `interface InstancePlan { action: Action; changes: AttrChange[]; planned: Record<string, Value> }` (`planned`: the attributes after apply, `UNKNOWN` where only apply can say; `changes` sorted by attribute name)
  - `diffInstance(schema: ResourceSchema, config: Record<string, Value>, prior: Record<string, Value> | undefined, ignore?: string[] | 'all'): InstancePlan`

- [ ] **Step 1: Write the failing test**

Append to `tests/terraform-resources.test.ts` (and add `diffInstance` and `UNKNOWN` to the imports at the top: `import { diffInstance, SCHEMAS, schemaFor, unsupportedType } from ...` and `import { UNKNOWN, type Value } from '../src/game/terraform/eval.ts'`):

```ts
const vpc = schemaFor('aws_vpc')!
const VPC_PRIOR = {
  id: 'vpc-1',
  arn: 'arn:aws:ec2:us-east-1:111111111111:vpc/vpc-1',
  cidr_block: '10.0.0.0/16',
  enable_dns_support: true,
  enable_dns_hostnames: false,
  tags: { Name: 'main' },
  tags_all: { Name: 'main' },
  default_security_group_id: 'sg-1',
}

describe('diffInstance', () => {
  it('creates, with defaults filled in and provider-set values unknown', () => {
    const p = diffInstance(vpc, { cidr_block: '10.0.0.0/16', tags: { Name: 'main' } }, undefined)
    expect(p.action).toBe('create')
    expect(p.changes.map((c) => c.name)).toEqual(['arn', 'cidr_block', 'default_security_group_id', 'enable_dns_hostnames', 'enable_dns_support', 'id', 'tags', 'tags_all'])
    expect(p.planned).toMatchObject({ id: UNKNOWN, arn: UNKNOWN, cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, tags: { Name: 'main' } })
    expect(p.changes.every((c) => c.before === undefined && !c.forcesReplacement)).toBe(true)
  })

  it('is a no-op when configuration matches state, and ignores what the provider fills in', () => {
    const p = diffInstance(vpc, { cidr_block: '10.0.0.0/16', tags: { Name: 'main' } }, VPC_PRIOR)
    expect(p).toMatchObject({ action: 'noop', changes: [] })
    expect(p.planned).toEqual(VPC_PRIOR)
  })

  it('updates in place when a non-forcing attribute changes, keeping computed values', () => {
    const inst = schemaFor('aws_instance')!
    const prior = { id: 'i-1', arn: 'arn:i-1', ami: 'ami-1', instance_type: 't3.micro', private_ip: '10.0.1.5', availability_zone: 'us-east-1a' }
    const p = diffInstance(inst, { ami: 'ami-1', instance_type: 't3.small' }, prior)
    expect(p.action).toBe('update')
    expect(p.changes).toEqual([{ name: 'instance_type', before: 't3.micro', after: 't3.small', forcesReplacement: false, sensitive: false }])
    expect(p.planned).toMatchObject({ id: 'i-1', instance_type: 't3.small', private_ip: '10.0.1.5' })
  })

  it('replaces when a forcing attribute changes, and shows what will be recomputed', () => {
    const db = schemaFor('aws_db_instance')!
    const prior = { id: 'db-1', arn: 'arn:db-1', identifier: 'orders-prod', engine: 'postgres', instance_class: 'db.r6g.large', storage_encrypted: false, endpoint: 'orders.example:5432' }
    const p = diffInstance(db, { identifier: 'orders-prod', engine: 'postgres', instance_class: 'db.r6g.large', storage_encrypted: true }, prior)
    expect(p.action).toBe('replace')
    const byName = Object.fromEntries(p.changes.map((c) => [c.name, c]))
    expect(byName.storage_encrypted).toMatchObject({ before: false, after: true, forcesReplacement: true })
    expect(byName.id).toMatchObject({ before: 'db-1', after: UNKNOWN, forcesReplacement: false })
    expect(byName.endpoint).toMatchObject({ before: 'orders.example:5432', after: UNKNOWN })
    expect(p.planned).toMatchObject({ id: UNKNOWN, identifier: 'orders-prod', storage_encrypted: true })
  })

  it('treats an unknown configured value as a change, and a replacement if the attribute forces one', () => {
    const subnet = schemaFor('aws_subnet')!
    const prior = { id: 'subnet-1', arn: 'arn:s', vpc_id: 'vpc-1', cidr_block: '10.0.1.0/24', availability_zone: 'us-east-1a' }
    const p = diffInstance(subnet, { vpc_id: UNKNOWN, cidr_block: '10.0.1.0/24' }, prior)
    expect(p.action).toBe('replace')
    expect(p.changes.find((c) => c.name === 'vpc_id')).toMatchObject({ before: 'vpc-1', after: UNKNOWN, forcesReplacement: true })
  })

  it('turns a removed attribute into a change to null', () => {
    const p = diffInstance(vpc, { cidr_block: '10.0.0.0/16' }, VPC_PRIOR)
    expect(p.action).toBe('update')
    expect(p.changes).toEqual([{ name: 'tags', before: { Name: 'main' }, after: null, forcesReplacement: false, sensitive: false }])
  })

  it('applies provider defaults when an attribute is omitted', () => {
    const q = schemaFor('aws_sqs_queue')!
    const prior = { id: 'q-1', arn: 'arn:q', name: 'jobs', fifo_queue: false, visibility_timeout_seconds: 30, message_retention_seconds: 345600 }
    expect(diffInstance(q, { name: 'jobs' }, prior).action).toBe('noop')
    const p = diffInstance(q, { name: 'jobs', visibility_timeout_seconds: 60 }, prior)
    expect(p).toMatchObject({ action: 'update', changes: [{ name: 'visibility_timeout_seconds', before: 30, after: 60 }] })
  })

  it('suppresses changes to ignored attributes only, by name or all', () => {
    const inst = schemaFor('aws_instance')!
    const prior = { id: 'i-1', arn: 'a', ami: 'ami-1', instance_type: 't3.micro' }
    const cfg = { ami: 'ami-2', instance_type: 't3.small' }
    const partly = diffInstance(inst, cfg, prior, ['instance_type'])
    expect(partly.action).toBe('replace')
    expect(partly.changes.map((c) => c.name)).toContain('ami')
    expect(partly.changes.map((c) => c.name)).not.toContain('instance_type')
    expect(diffInstance(inst, { ami: 'ami-1', instance_type: 't3.small' }, prior, ['instance_type']).action).toBe('noop')
    expect(diffInstance(inst, cfg, prior, 'all').action).toBe('noop')
  })

  it('still creates a missing resource whatever is ignored', () => {
    expect(diffInstance(vpc, { cidr_block: '10.0.0.0/16' }, undefined, 'all').action).toBe('create')
  })

  it('marks sensitive attributes and passes unmodeled attributes through unforced', () => {
    const db = schemaFor('aws_db_instance')!
    const prior = { id: 'db-1', arn: 'a', identifier: 'x', engine: 'postgres', password: 'old' }
    const p = diffInstance(db, { identifier: 'x', engine: 'postgres', password: 'new', future_flag: true }, prior)
    expect(p.action).toBe('update')
    expect(p.changes.find((c) => c.name === 'password')).toMatchObject({ sensitive: true })
    expect(p.changes.find((c) => c.name === 'future_flag')).toMatchObject({ before: undefined, after: true, forcesReplacement: false })
  })

  it('survives an attribute named __proto__ without touching prototypes', () => {
    const cfg = Object.defineProperty({ cidr_block: '10.0.0.0/16' }, '__proto__', { value: 1, enumerable: true, configurable: true, writable: true })
    const p = diffInstance(vpc, cfg, undefined)
    expect(Object.getPrototypeOf(p.planned)).toBe(Object.prototype)
    expect(Object.keys(p.planned)).toContain('__proto__')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-resources.test.ts`
Expected: FAIL ("diffInstance is not a function" or an import error).

- [ ] **Step 3: Write the implementation**

In `src/game/terraform/resources.ts`, change the import line to `import { equal, hasUnknown, UNKNOWN, type Value } from './eval.ts'` and append:

```ts
export type Action = 'create' | 'update' | 'replace' | 'noop'
export interface AttrChange {
  name: string
  before: Value | undefined
  after: Value
  forcesReplacement: boolean
  sensitive: boolean
}
export interface InstancePlan {
  action: Action
  changes: AttrChange[] // sorted by attribute name, like a plan prints them
  planned: Record<string, Value> // the attributes after apply; UNKNOWN where only apply can say
}

const byName = (a: AttrChange, b: AttrChange) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

// Diff one resource instance's configuration against what state holds.
// `config` holds the evaluated arguments (null means "unset"); `prior` is the
// instance's attributes in state (undefined if it doesn't exist yet).
export function diffInstance(
  schema: ResourceSchema,
  config: Record<string, Value>,
  prior: Record<string, Value> | undefined,
  ignore: string[] | 'all' = [],
): InstancePlan {
  const ignored = (n: string) => ignore === 'all' || ignore.includes(n)
  const specOf = (n: string): AttrSpec => (Object.hasOwn(schema.attrs, n) ? schema.attrs[n] : {})
  // What the configuration asks for, with the provider's default if omitted.
  const desired = (n: string): Value | undefined => {
    const spec = specOf(n)
    if (spec.readOnly) return undefined
    if (Object.hasOwn(config, n) && config[n] !== null) return config[n]
    return spec.default
  }
  const names = [...new Set([...Object.keys(schema.attrs), ...Object.keys(config)])].sort()
  const change = (name: string, before: Value | undefined, after: Value, forcesReplacement = false): AttrChange => ({
    name,
    before,
    after,
    forcesReplacement,
    sensitive: !!specOf(name).sensitive,
  })

  // The attributes of a brand-new object.
  const fresh = (): Record<string, Value> => {
    const entries: [string, Value][] = []
    for (const n of names) {
      const spec = specOf(n)
      const d = desired(n)
      if (spec.readOnly) entries.push([n, UNKNOWN])
      else if (d !== undefined) entries.push([n, d])
      else if (spec.computed) entries.push([n, UNKNOWN])
    }
    return Object.fromEntries(entries)
  }

  if (!prior) {
    const planned = fresh()
    return { action: 'create', planned, changes: Object.entries(planned).map(([n, after]) => change(n, undefined, after)) }
  }

  const next = new Map(Object.entries(prior))
  const changes: AttrChange[] = []
  for (const n of names) {
    const spec = specOf(n)
    if (spec.readOnly || ignored(n)) continue
    const before = Object.hasOwn(prior, n) ? prior[n] : undefined
    let d = desired(n)
    if (d === undefined) {
      if (spec.computed) continue // the provider keeps its own value
      if (before === undefined || before === null) continue
      d = null // removed from the configuration
    }
    if (!hasUnknown(d) && equal(before ?? null, d)) continue
    changes.push(change(n, before, d, !!spec.forceNew))
    next.set(n, d)
  }

  if (!changes.length) return { action: 'noop', changes, planned: Object.fromEntries(next) }
  if (changes.some((c) => c.forcesReplacement)) {
    const planned = fresh()
    // What the new object will get from the provider instead of the old one.
    const recomputed = Object.entries(planned)
      .filter(([n, v]) => v === UNKNOWN && !changes.some((c) => c.name === n))
      .map(([n]) => change(n, Object.hasOwn(prior, n) ? prior[n] : undefined, UNKNOWN))
    return { action: 'replace', planned, changes: [...changes, ...recomputed].sort(byName) }
  }
  return { action: 'update', changes, planned: Object.fromEntries(next) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-resources.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent. If the "recomputed" expectation for `endpoint` fails because `endpoint` is `readOnly` and `fresh()` marks it UNKNOWN, that is the intended behavior: check the test's `prior` includes `endpoint`.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/resources.ts tests/terraform-resources.test.ts
git commit -m "feat: per-instance Terraform diff: create, update, replace, no-op (TF2b-1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: State model and refresh

**Files:**
- Create: `src/game/terraform/state.ts`
- Create: `src/game/terraform/refresh.ts`
- Test: `tests/terraform-state.test.ts`

**Interfaces:**
- Consumes: `Value`, `equal`, `hasUnknown` from `./eval.ts`.
- Produces (`state.ts`):
  - `interface StateInstance { index_key?: string | number; attributes: Record<string, Value>; status?: 'tainted' }`
  - `interface StateResource { mode: 'managed' | 'data'; type: string; name: string; provider: string; instances: StateInstance[] }` (`provider` is the tfstate string `provider["registry.terraform.io/hashicorp/aws"]`)
  - `interface State { version: 4; terraform_version: string; serial: number; lineage: string; outputs: Record<string, { value: Value; sensitive?: boolean }>; resources: StateResource[] }`
  - `emptyState(terraformVersion?: string, lineage?: string): State`
  - `instanceAddress(r: Pick<StateResource, 'mode' | 'type' | 'name'>, key?: string | number): string` (`aws_vpc.main`, `aws_s3_bucket.b["a"]`, `aws_subnet.s[0]`, `data.aws_ami.x`)
  - `listAddresses(state: State): string[]` (sorted, like `terraform state list`)
  - `findInstance(state: State, address: string): { resource: StateResource; instance: StateInstance } | undefined`
  - `stateJson(state: State): string` (tfstate-shaped JSON, 2-space indent, attribute keys sorted; throws if an unknown value is present)
- Produces (`refresh.ts`):
  - `type Reality = Record<string, Record<string, Value>>` keyed by `realityKey(type, id)`; `realityKey(type: string, id: string): string` returns `"<type>:<id>"`
  - `interface Drift { address: string; kind: 'deleted' | 'changed'; changes: { name: string; before: Value; after: Value }[] }`
  - `refresh(state: State, reality: Reality): { state: State; drift: Drift[] }` (does not mutate its input)

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { UNKNOWN, type Value } from '../src/game/terraform/eval.ts'
import { emptyState, findInstance, instanceAddress, listAddresses, stateJson, type State } from '../src/game/terraform/state.ts'
import { realityKey, refresh } from '../src/game/terraform/refresh.ts'

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]'
const sample = (): State => ({
  ...emptyState(),
  serial: 7,
  resources: [
    { mode: 'managed', type: 'aws_vpc', name: 'main', provider: AWS, instances: [{ attributes: { id: 'vpc-1', cidr_block: '10.0.0.0/16', tags: { Name: 'main' } } }] },
    {
      mode: 'managed',
      type: 'aws_s3_bucket',
      name: 'b',
      provider: AWS,
      instances: [
        { index_key: 'b', attributes: { id: 'bkt-b', bucket: 'bkt-b' } },
        { index_key: 'a', attributes: { id: 'bkt-a', bucket: 'bkt-a' } },
      ],
    },
    { mode: 'managed', type: 'aws_subnet', name: 's', provider: AWS, instances: [{ index_key: 0, attributes: { id: 'subnet-0', vpc_id: 'vpc-1' } }] },
    { mode: 'data', type: 'aws_ami', name: 'x', provider: AWS, instances: [{ attributes: { id: 'ami-1' } }] },
  ],
})

describe('state model', () => {
  it('builds addresses for single, counted, keyed and data instances', () => {
    expect(instanceAddress({ mode: 'managed', type: 'aws_vpc', name: 'main' })).toBe('aws_vpc.main')
    expect(instanceAddress({ mode: 'managed', type: 'aws_subnet', name: 's' }, 0)).toBe('aws_subnet.s[0]')
    expect(instanceAddress({ mode: 'managed', type: 'aws_s3_bucket', name: 'b' }, 'a')).toBe('aws_s3_bucket.b["a"]')
    expect(instanceAddress({ mode: 'data', type: 'aws_ami', name: 'x' })).toBe('data.aws_ami.x')
  })

  it('lists addresses sorted, and finds an instance by address', () => {
    expect(listAddresses(sample())).toEqual(['aws_s3_bucket.b["a"]', 'aws_s3_bucket.b["b"]', 'aws_subnet.s[0]', 'aws_vpc.main', 'data.aws_ami.x'])
    expect(findInstance(sample(), 'aws_vpc.main')!.instance.attributes.id).toBe('vpc-1')
    expect(findInstance(sample(), 'aws_s3_bucket.b["a"]')!.instance.attributes.id).toBe('bkt-a')
    expect(findInstance(sample(), 'aws_vpc.nope')).toBeUndefined()
  })

  it('renders tfstate-shaped JSON with sorted attributes, and refuses unknown values', () => {
    const json = JSON.parse(stateJson(sample()))
    expect(json).toMatchObject({ version: 4, serial: 7, terraform_version: '1.9.8' })
    expect(json.resources[0]).toMatchObject({ mode: 'managed', type: 'aws_vpc', name: 'main', provider: AWS })
    expect(json.resources[0].instances[0]).toMatchObject({ schema_version: 0, sensitive_attributes: [] })
    expect(Object.keys(json.resources[0].instances[0].attributes)).toEqual(['cidr_block', 'id', 'tags'])
    expect(stateJson(sample())).toContain('\n  "version": 4,')
    const bad = sample()
    bad.resources[0].instances[0].attributes.id = UNKNOWN
    expect(() => stateJson(bad)).toThrow(/unknown/i)
  })
})

describe('refresh', () => {
  const vpcKey = realityKey('aws_vpc', 'vpc-1')
  // A cloud that matches the sample state exactly (every managed instance exists).
  const cloud = (vpc: Record<string, Value> = { id: 'vpc-1', cidr_block: '10.0.0.0/16', tags: { Name: 'main' } }) => ({
    [vpcKey]: vpc,
    [realityKey('aws_s3_bucket', 'bkt-a')]: { id: 'bkt-a', bucket: 'bkt-a' },
    [realityKey('aws_s3_bucket', 'bkt-b')]: { id: 'bkt-b', bucket: 'bkt-b' },
    [realityKey('aws_subnet', 'subnet-0')]: { id: 'subnet-0', vpc_id: 'vpc-1' },
  })

  it('reports no drift when the cloud matches state', () => {
    expect(refresh(sample(), cloud()).drift).toEqual([])
  })

  it('reports an attribute changed outside Terraform and updates the refreshed state, without mutating the input', () => {
    const before = sample()
    const r = refresh(before, cloud({ id: 'vpc-1', cidr_block: '10.0.0.0/16', tags: { Name: 'main', Owner: 'ops' } }))
    expect(r.drift).toEqual([{ address: 'aws_vpc.main', kind: 'changed', changes: [{ name: 'tags', before: { Name: 'main' }, after: { Name: 'main', Owner: 'ops' } }] }])
    expect(findInstance(r.state, 'aws_vpc.main')!.instance.attributes.tags).toEqual({ Name: 'main', Owner: 'ops' })
    expect(before).toEqual(sample())
  })

  it('drops a resource deleted in the cloud from the refreshed state and reports it', () => {
    const r = refresh(sample(), {})
    const d = r.drift.find((x) => x.address === 'aws_vpc.main')!
    expect(d).toEqual({ address: 'aws_vpc.main', kind: 'deleted', changes: [] })
    expect(findInstance(r.state, 'aws_vpc.main')).toBeUndefined()
    expect(r.state.resources.some((x) => x.type === 'aws_vpc')).toBe(false)
  })

  it('leaves data sources alone and keeps state attributes the cloud does not report', () => {
    const r = refresh(sample(), { [vpcKey]: { id: 'vpc-1' } })
    expect(findInstance(r.state, 'data.aws_ami.x')).toBeDefined()
    expect(findInstance(r.state, 'aws_vpc.main')!.instance.attributes.cidr_block).toBe('10.0.0.0/16')
    expect(r.drift.find((x) => x.address === 'data.aws_ami.x')).toBeUndefined()
  })

  it('does not report drift for a resource whose other instances survive', () => {
    const r = refresh(sample(), { [vpcKey]: { id: 'vpc-1' }, [realityKey('aws_s3_bucket', 'bkt-a')]: { id: 'bkt-a' } })
    expect(r.drift.filter((d) => d.kind === 'deleted').map((d) => d.address).sort()).toEqual(['aws_s3_bucket.b["b"]', 'aws_subnet.s[0]'])
    expect(findInstance(r.state, 'aws_s3_bucket.b["a"]')).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-state.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/state.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/state.ts`:

```ts
// Terraform's recorded view of the world: the tfstate (version 4) shape, the
// addresses of its resources, and its JSON rendering for `terraform state pull`
// and `cat terraform.tfstate`.
import { hasUnknown, type Value } from './eval.ts'

export interface StateInstance {
  index_key?: string | number
  attributes: Record<string, Value>
  status?: 'tainted'
}
export interface StateResource {
  mode: 'managed' | 'data'
  type: string
  name: string
  provider: string // provider["registry.terraform.io/hashicorp/aws"]
  instances: StateInstance[]
}
export interface State {
  version: 4
  terraform_version: string
  serial: number
  lineage: string
  outputs: Record<string, { value: Value; sensitive?: boolean }>
  resources: StateResource[]
}

export const emptyState = (terraformVersion = '1.9.8', lineage = '00000000-0000-4000-8000-000000000000'): State => ({
  version: 4,
  terraform_version: terraformVersion,
  serial: 0,
  lineage,
  outputs: {},
  resources: [],
})

export function instanceAddress(r: Pick<StateResource, 'mode' | 'type' | 'name'>, key?: string | number): string {
  const base = `${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}`
  if (key === undefined) return base
  return typeof key === 'number' ? `${base}[${key}]` : `${base}[${JSON.stringify(key)}]`
}

export function listAddresses(state: State): string[] {
  return state.resources.flatMap((r) => r.instances.map((i) => instanceAddress(r, i.index_key))).sort()
}

export function findInstance(state: State, address: string): { resource: StateResource; instance: StateInstance } | undefined {
  for (const resource of state.resources) {
    for (const instance of resource.instances) {
      if (instanceAddress(resource, instance.index_key) === address) return { resource, instance }
    }
  }
  return undefined
}

const sortedAttributes = (attrs: Record<string, Value>): Record<string, Value> =>
  Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

export function stateJson(state: State): string {
  const doc = {
    version: state.version,
    terraform_version: state.terraform_version,
    serial: state.serial,
    lineage: state.lineage,
    outputs: state.outputs,
    resources: state.resources.map((r) => ({
      mode: r.mode,
      type: r.type,
      name: r.name,
      provider: r.provider,
      instances: r.instances.map((i) => {
        if (hasUnknown(i.attributes)) throw new Error(`cannot write ${instanceAddress(r, i.index_key)} to state: it holds an unknown value`)
        return {
          ...(i.index_key === undefined ? {} : { index_key: i.index_key }),
          ...(i.status ? { status: i.status } : {}),
          schema_version: 0,
          attributes: sortedAttributes(i.attributes),
          sensitive_attributes: [],
        }
      }),
    })),
    check_results: null,
  }
  return JSON.stringify(doc, null, 2)
}
```

Create `src/game/terraform/refresh.ts`:

```ts
// Refresh: compare what state says with what is actually in the simulated
// cloud ("reality"), the first step of a plan. Differences are drift: someone
// changed or deleted something outside Terraform.
import { equal, type Value } from './eval.ts'
import { instanceAddress, type State, type StateInstance, type StateResource } from './state.ts'

// What exists in the cloud, keyed by realityKey(type, id).
export type Reality = Record<string, Record<string, Value>>
export const realityKey = (type: string, id: string) => `${type}:${id}`

export interface Drift {
  address: string
  kind: 'deleted' | 'changed'
  changes: { name: string; before: Value; after: Value }[]
}

export function refresh(state: State, reality: Reality): { state: State; drift: Drift[] } {
  const drift: Drift[] = []
  const resources: StateResource[] = []
  for (const r of state.resources) {
    if (r.mode === 'data') {
      resources.push(structuredClone(r))
      continue
    }
    const instances: StateInstance[] = []
    for (const inst of r.instances) {
      const address = instanceAddress(r, inst.index_key)
      const id = inst.attributes.id
      const now = typeof id === 'string' && Object.hasOwn(reality, realityKey(r.type, id)) ? reality[realityKey(r.type, id)] : undefined
      if (typeof id !== 'string') {
        instances.push(structuredClone(inst))
        continue
      }
      if (!now) {
        drift.push({ address, kind: 'deleted', changes: [] })
        continue
      }
      const changes: Drift['changes'] = []
      const attributes = new Map(Object.entries(structuredClone(inst.attributes)))
      for (const [name, after] of Object.entries(now)) {
        const before = Object.hasOwn(inst.attributes, name) ? inst.attributes[name] : null
        if (!equal(before, after)) changes.push({ name, before, after })
        attributes.set(name, structuredClone(after))
      }
      if (changes.length) drift.push({ address, kind: 'changed', changes })
      instances.push({ ...structuredClone(inst), attributes: Object.fromEntries(attributes) })
    }
    if (instances.length) resources.push({ ...structuredClone(r), instances })
  }
  return { state: { ...structuredClone(state), resources }, drift }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-state.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent. Note `structuredClone` on a state holding the `UNKNOWN` frozen sentinel preserves values but not identity; refresh runs on stored state, which never holds unknowns, so this is safe.

- [ ] **Step 5: Run the full check, then commit**

Run: `npm test 2>&1 | tail -8 && npm run lint 2>&1 | tail -3 && npx tsc -b`
Expected: all files pass, lint clean, `tsc` silent.

```bash
git add src/game/terraform/state.ts src/game/terraform/refresh.ts tests/terraform-state.test.ts
git commit -m "feat: tfstate model, addresses and refresh with drift (TF2b-1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done)

- **Spec coverage:** "Three worlds" (state shape, reality map), plan steps 1 (refresh) and 4 (diff by attribute with `forces_replacement`, create/update/replace) and "Resource schemas" (`forces_replacement`, `computed`, `sensitive`, defaults, unsupported-type error) are covered. Not here by design: evaluation of `count`/`for_each`/variables/locals, `moved`/`import`/`removed`, `prevent_destroy`, destroy of resources removed from config, ordering by graph, rendering, CLI (TF2b-2, TF2c).
- **Placeholders:** none. **Type consistency:** `AttrSpec`, `ResourceSchema`, `Action`, `AttrChange`, `InstancePlan` (Tasks 1-2); `State`, `StateResource`, `StateInstance`, `Reality`, `Drift` (Task 3) are used with the same names in tests and implementations.
- **Review Focus:** all five lines have tests (unknown/forcing: Task 2; ignore: Task 2; computed omitted: Task 2 "no-op" test; removed attribute: Task 2; refresh purity and deletion: Task 3).
- **Known limits, left for TF2b-2:** destroy actions (resource in state, absent from configuration) are the walker's job, since they need the graph; `diffInstance` never returns `'destroy'`.
