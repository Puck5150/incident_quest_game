# Terraform TF2c-2: the scenario block, the `terraform` command and the shell wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an incident declare a Terraform world (configuration files, starting state, the simulated cloud) and let the player work in it with real commands: `terraform init`, `validate`, `plan`, `show`, `state list|show|pull`, `output`, `workspace show|list`, `version`, with the plan printed in real CLI format. The player edits the real `.tf` files in the terminal editor, and the next `terraform plan` reflects the edit. Writing commands (`apply`, `import`, `taint`, `state mv|rm`, `workspace new`, locks) answer honestly that they are not simulated yet (TF3).

**Architecture:** An optional `terraform:` block in the scenario schema describes files, state, cloud, variables and evidence rules. `lab.ts` turns it into the engine's `State`/`Reality` and absolute file paths. `views.ts` formats state and outputs the way `terraform state show` / `output` print them. `cli.ts` implements the subcommands over an abstract context (list files, read, write, env), calling `planConfig` and `renderPlan`. `IncidentShell` mounts the files on the simulated disk, routes the `terraform` command to the CLI with the real filesystem as context, and reports evidence the output earns through a small `evidence:TAG` token in the shell-ran events.

**Tech Stack:** TypeScript (strict), zod (schema), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("Incident authoring", "Fixes and scoring" evidence). TF1 to TF2c-1 are complete. Out of scope here: writing commands (TF3), `done_when` fix predicates (TF3), `-target`/`-refresh-only`/`-destroy` plans, `fmt`, modules, remote-state backends and locks, multi-stage `terraform` blocks (top-level only), a playable incident (TF2c-3).

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, `import type` for types, `.ts` import extensions.
- No new npm dependencies.
- Tests live in `tests/*.test.ts` (vitest); `src/` is type-checked by `npx tsc -b`. After changing `src/schema/`, run `npm run schemas` and commit the regenerated `schemas/*.json` (a test fails otherwise).
- Own-property discipline: never use `in` or `obj[userKey] = ...` on objects keyed by user-supplied names.
- The CLI never throws on player input: every failure is a located diagnostic or an honest message with a non-zero exit code. Errors go to `stderr`, normal output to `stdout`.
- Text not verified against real Terraform output is logged in `CONTENT_TODO.md` (Task 4).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A scenario's Terraform block is validated at build time: unknown resource types, a state or cloud object without a string `id`, a cloud patch or delete that points at nothing, and evidence tags that collide or are unusable fail `npm test` with the field path (Task 1 tests).
2. The cloud defaults to "exactly what state says", so an incident only describes the *differences* (drift, deletions, unmanaged objects) (Task 1 tests).
3. The player's edits are what the CLI plans: it reads the files from the working directory every time, in the directory the player is in, and an uninitialised directory or a directory without configuration fails or warns the way real Terraform does (Task 3 and 4 tests).
4. Variables follow Terraform's precedence (scenario/`TF_VAR_*` env, `terraform.tfvars`, `*.auto.tfvars`, `-var-file`, `-var`), and a bad tfvars file is a located error (Task 3 tests).
5. Evidence from simulated output reaches scoring: `evidence:TAG` tokens count as evidence, are not listed as commands in the breakdown, and `key_evidence` validation accepts tags that come from the Terraform block (Task 4 tests).
6. `terraform` is listed by `help` for such incidents, and typing `terraform apply` etc. gives the honest not-simulated message with exit code 1 (Task 3 and 4 tests).

---

### Task 1: The scenario block and the lab

**Files:**
- Modify: `src/schema/scenario.ts`
- Create: `src/game/terraform/lab.ts`
- Test: `tests/terraform-lab.test.ts`
- Regenerate: `schemas/incident.json` (`npm run schemas`)

**Interfaces:**
- Produces (`scenario.ts`): `TerraformSchema`, the optional top-level field `terraform` on `ScenarioSchema`, and `type TerraformBlock = z.infer<typeof TerraformSchema>`:
  - `dir?: string` (working directory; relative to the prompt's directory or absolute; default the prompt's directory)
  - `version?: string` (`/^\d+\.\d+\.\d+$/`, default `1.9.8`)
  - `initialized?: boolean` (default `true`: the lock file exists)
  - `files: { path: string; content: string }[]` (min 1; paths relative to `dir`, no leading `/`, no `..`)
  - `vars?: Record<string, json>` (like `TF_VAR_name`)
  - `state?: { type, name, key?: string|int, mode?: 'managed'|'data', status?: 'tainted', attrs: Record<string,json> }[]`
  - `outputs?: Record<string, { value: json; sensitive?: boolean }>`
  - `cloud?: { patch?: { type, id, set: Record<string,json> }[]; delete?: { type, id }[]; add?: { type, attrs: Record<string,json> }[] }`
  - `evidence?: { evidence: id; command: 'plan'|'validate'|'init'|'show'|'output'|'version'|'state list'|'state show'|'state pull'|'workspace show'|'workspace list'; contains: string }[]`
  - Cross-field checks (in `superRefine`): `terraform` requires `terminal`; every state `type` is a resource type the lab models (`schemaFor`) for `mode: 'managed'` entries; every managed state instance and every `cloud.add` has a string `attrs.id`; a `cloud.patch`/`cloud.delete` `(type,id)` must exist in state or `cloud.add`; state instances are unique by (mode,type,name,key); `evidence` tags are unique; the tags in `terraform.evidence` count as findable evidence in the existing "key evidence must be findable" checks (they are visible before any fix).
- Produces (`lab.ts`):
  - `interface Lab { dir: string; version: string; initialized: boolean; files: { path: string; content: string }[]; hasState: boolean; state: State; reality: Reality; vars: Record<string, Value>; evidence: TerraformBlock['evidence'] }`
  - `labFromScenario(tf: TerraformBlock, startDir: string, home: string): Lab` — `dir` resolved (absolute stays; `~/` expands to `home`; relative joins `startDir`), `files[].path` made absolute under `dir`; `state` built as tfstate (`serial: 12`, lineage `00000000-0000-4000-8000-000000000001`, `terraform_version: tf.version`) with each resource's `provider` set to `provider["<schemaFor(type)?.provider ?? registry.terraform.io/hashicorp/<prefix>>"]`; `outputs` copied; `reality` = every managed state instance keyed `realityKey(type, id)` with its attributes, then `cloud.patch` (shallow merge of `set` into the object found by type+id), `cloud.delete` (remove), `cloud.add` (attrs keyed by their `id`); `hasState` is `tf.state !== undefined`.

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-lab.test.ts`:

```ts
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { ScenarioSchema, type TerraformBlock } from '../src/schema/scenario.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import { realityKey } from '../src/game/terraform/refresh.ts'
import { listAddresses } from '../src/game/terraform/state.ts'

const base = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@'))!
const withTf = (tf: unknown) => ScenarioSchema.safeParse({ ...structuredClone(base), terraform: tf })
const issues = (tf: unknown) => {
  const r = withTf(tf)
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}
const VPC = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', cidr_block: '10.0.0.0/16' } }
const FILE = { path: 'main.tf', content: 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n' }

describe('the terraform block in the scenario schema', () => {
  it('accepts a minimal block and a full one', () => {
    expect(issues({ files: [FILE] })).toEqual([])
    expect(
      issues({
        dir: '~/infra',
        version: '1.9.8',
        initialized: false,
        files: [FILE],
        vars: { region: 'us-east-1' },
        state: [VPC, { mode: 'data', type: 'aws_ami', name: 'x', attrs: { id: 'ami-1' } }],
        outputs: { id: { value: 'vpc-1' } },
        cloud: { patch: [{ type: 'aws_vpc', id: 'vpc-1', set: { tags: { Owner: 'ops' } } }], add: [{ type: 'aws_s3_bucket', attrs: { id: 'legacy', bucket: 'legacy' } }] },
        evidence: [{ evidence: 'plan-forces', command: 'plan', contains: 'forces replacement' }],
      }),
    ).toEqual([])
  })

  it('rejects unknown fields, an unsafe file path and an empty file list', () => {
    expect(issues({ files: [FILE], bogus: 1 })).not.toEqual([])
    expect(issues({ files: [{ path: '/etc/main.tf', content: '' }] }).join()).toMatch(/relative/)
    expect(issues({ files: [{ path: '../main.tf', content: '' }] }).join()).toMatch(/relative/)
    expect(issues({ files: [] })).not.toEqual([])
  })

  it('checks state, cloud and evidence across fields', () => {
    expect(issues({ files: [FILE], state: [{ type: 'aws_nope', name: 'x', attrs: { id: 'x' } }] }).join()).toMatch(/aws_nope/)
    expect(issues({ files: [FILE], state: [{ type: 'aws_vpc', name: 'main', attrs: { cidr_block: 'x' } }] }).join()).toMatch(/id/)
    expect(issues({ files: [FILE], state: [VPC, VPC] }).join()).toMatch(/duplicate/)
    expect(issues({ files: [FILE], state: [VPC], cloud: { delete: [{ type: 'aws_vpc', id: 'vpc-9' }] } }).join()).toMatch(/vpc-9/)
    expect(issues({ files: [FILE], cloud: { add: [{ type: 'aws_s3_bucket', attrs: { bucket: 'x' } }] } }).join()).toMatch(/id/)
    expect(issues({ files: [FILE], evidence: [{ evidence: 'a', command: 'plan', contains: 'x' }, { evidence: 'a', command: 'show', contains: 'y' }] }).join()).toMatch(/duplicate/)
  })

  it('needs a terminal', () => {
    const r = ScenarioSchema.safeParse({ ...structuredClone(base), terminal: undefined, terraform: { files: [FILE] } })
    expect(r.success).toBe(false)
  })
})

describe('labFromScenario', () => {
  const tf = (o: Partial<TerraformBlock> = {}): TerraformBlock => ({ files: [FILE], ...o }) as TerraformBlock

  it('resolves the directory and puts files under it', () => {
    const lab = labFromScenario(tf({ dir: '~/infra' }), '/home/you/work', '/home/you')
    expect(lab.dir).toBe('/home/you/infra')
    expect(lab.files).toEqual([{ path: '/home/you/infra/main.tf', content: FILE.content }])
    expect(labFromScenario(tf(), '/home/you/work', '/home/you').dir).toBe('/home/you/work')
    expect(labFromScenario(tf({ dir: '/srv/tf' }), '/home/you/work', '/home/you').dir).toBe('/srv/tf')
    expect(labFromScenario(tf({ dir: 'sub' }), '/home/you/work', '/home/you').dir).toBe('/home/you/work/sub')
  })

  it('has sensible defaults', () => {
    const lab = labFromScenario(tf(), '/w', '/h')
    expect(lab).toMatchObject({ version: '1.9.8', initialized: true, hasState: false, vars: {} })
    expect(lab.state.resources).toEqual([])
    expect(labFromScenario(tf({ initialized: false, version: '1.5.7', state: [] }), '/w', '/h')).toMatchObject({ initialized: false, version: '1.5.7', hasState: true })
  })

  it('builds state with providers, keys, taint and data sources', () => {
    const lab = labFromScenario(
      tf({
        state: [
          VPC,
          { type: 'aws_s3_bucket', name: 'b', key: 'a', attrs: { id: 'b-a', bucket: 'b-a' } },
          { type: 'aws_s3_bucket', name: 'b', key: 'b', status: 'tainted', attrs: { id: 'b-b', bucket: 'b-b' } },
          { mode: 'data', type: 'aws_ami', name: 'x', attrs: { id: 'ami-1' } },
        ],
        outputs: { id: { value: 'vpc-1' }, secret: { value: 'x', sensitive: true } },
      }),
      '/w',
      '/h',
    )
    expect(listAddresses(lab.state)).toEqual(['aws_s3_bucket.b["a"]', 'aws_s3_bucket.b["b"]', 'aws_vpc.main', 'data.aws_ami.x'])
    expect(lab.state.resources[0].provider).toBe('provider["registry.terraform.io/hashicorp/aws"]')
    expect(lab.state.resources.find((r) => r.name === 'b')!.instances[1].status).toBe('tainted')
    expect(lab.state.outputs).toEqual({ id: { value: 'vpc-1' }, secret: { value: 'x', sensitive: true } })
    expect(lab.state).toMatchObject({ version: 4, serial: 12, terraform_version: '1.9.8' })
  })

  it('makes the cloud match state, then applies patch, delete and add', () => {
    const plain = labFromScenario(tf({ state: [VPC] }), '/w', '/h')
    expect(plain.reality).toEqual({ [realityKey('aws_vpc', 'vpc-1')]: { id: 'vpc-1', cidr_block: '10.0.0.0/16' } })
    const lab = labFromScenario(
      tf({
        state: [VPC, { type: 'aws_subnet', name: 's', attrs: { id: 'subnet-1', vpc_id: 'vpc-1' } }],
        cloud: {
          patch: [{ type: 'aws_vpc', id: 'vpc-1', set: { tags: { Owner: 'ops' } } }],
          delete: [{ type: 'aws_subnet', id: 'subnet-1' }],
          add: [{ type: 'aws_s3_bucket', attrs: { id: 'legacy', bucket: 'legacy' } }],
        },
      }),
      '/w',
      '/h',
    )
    expect(lab.reality).toEqual({
      [realityKey('aws_vpc', 'vpc-1')]: { id: 'vpc-1', cidr_block: '10.0.0.0/16', tags: { Owner: 'ops' } },
      [realityKey('aws_s3_bucket', 'legacy')]: { id: 'legacy', bucket: 'legacy' },
    })
    expect(lab.state.resources.map((r) => r.name)).toEqual(['main', 's'])
  })

  it('does not alias the scenario data', () => {
    const block = tf({ state: [VPC] })
    const lab = labFromScenario(block, '/w', '/h')
    ;(lab.state.resources[0].instances[0].attributes as Record<string, unknown>).cidr_block = 'changed'
    expect(block.state![0].attrs.cidr_block).toBe('10.0.0.0/16')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-lab.test.ts`
Expected: FAIL (no `terraform` field, no `lab.ts`).

- [ ] **Step 3: Write the implementation**

In `src/schema/scenario.ts`, above `ScenarioSchema`, add (importing `schemaFor` from `'../game/terraform/resources.ts'`):

```ts
// A Terraform world (docs/superpowers/plans/2026-10-07-terraform-tf2c2-cli-and-shell.md): the
// files on disk, what state holds, and what the simulated cloud holds. The
// cloud defaults to exactly what state says; `cloud` lists only the differences.
const json = z.json()
const TfAttrs = z.record(z.string(), json)
export const TerraformSchema = z.strictObject({
  dir: z.string().min(1).optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must look like 1.9.8').optional(),
  initialized: z.boolean().optional(),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'must be a relative path under the working directory'),
        content: z.string(),
      }),
    )
    .min(1),
  vars: TfAttrs.optional(),
  state: z
    .array(
      z.strictObject({
        type: z.string().min(1),
        name: z.string().min(1),
        key: z.union([z.string(), z.int()]).optional(),
        mode: z.enum(['managed', 'data']).optional(),
        status: z.literal('tainted').optional(),
        attrs: TfAttrs,
      }),
    )
    .optional(),
  outputs: z.record(z.string(), z.strictObject({ value: json, sensitive: z.boolean().optional() })).optional(),
  cloud: z
    .strictObject({
      patch: z.array(z.strictObject({ type: z.string().min(1), id: z.string().min(1), set: TfAttrs })).optional(),
      delete: z.array(z.strictObject({ type: z.string().min(1), id: z.string().min(1) })).optional(),
      add: z.array(z.strictObject({ type: z.string().min(1), attrs: TfAttrs })).optional(),
    })
    .optional(),
  evidence: z
    .array(
      z.strictObject({
        evidence: id,
        command: z.enum(['plan', 'validate', 'init', 'show', 'output', 'version', 'state list', 'state show', 'state pull', 'workspace show', 'workspace list']),
        contains: z.string().min(1),
      }),
    )
    .optional(),
})
export type TerraformBlock = z.infer<typeof TerraformSchema>
```

Add `terraform: TerraformSchema.optional(),` to the top-level fields of `ScenarioSchema` (next to `terminal`), and in the `superRefine` add the cross-field checks listed in the Interfaces section. Messages: `"terraform needs a terminal to type into"` (path `['terraform']`), `` `"${type}" is not a resource type the Terraform lab models` `` (path `['terraform','state',i,'type']`), `` `needs a string id attribute` `` (path `['terraform','state',i,'attrs']` / `['terraform','cloud','add',i,'attrs']`), `` `duplicate state entry ${type}.${name}[key]` ``, `` `no object with id "${id}" in state or cloud.add` `` (patch/delete), `` `duplicate terraform evidence tag "${tag}"` ``. Add the Terraform evidence tags to both the `evidence` and `beforeFix` sets used by the "key evidence must be findable" check (they are always visible before any fix). Then run `npm run schemas` and stage the regenerated `schemas/incident.json`.

Create `src/game/terraform/lab.ts`:

```ts
// A scenario's Terraform world, turned into the engine's State and Reality.
import type { TerraformBlock } from '../../schema/scenario.ts'
import type { Value } from './eval.ts'
import { realityKey, type Reality } from './refresh.ts'
import { schemaFor } from './resources.ts'
import { emptyState, type State, type StateResource } from './state.ts'

export interface Lab {
  dir: string
  version: string
  initialized: boolean
  files: { path: string; content: string }[]
  hasState: boolean
  state: State
  reality: Reality
  vars: Record<string, Value>
  evidence: NonNullable<TerraformBlock['evidence']>
}

const join = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b.replace(/^\.?\//, '')}`

export function labFromScenario(tf: TerraformBlock, startDir: string, home: string): Lab {
  const dir = !tf.dir ? startDir : tf.dir.startsWith('/') ? tf.dir : tf.dir.startsWith('~/') ? join(home, tf.dir.slice(2)) : join(startDir, tf.dir)
  const version = tf.version ?? '1.9.8'
  const state = { ...emptyState(version, '00000000-0000-4000-8000-000000000001'), serial: 12 }
  for (const s of tf.state ?? []) {
    const mode = s.mode ?? 'managed'
    let r = state.resources.find((x) => x.mode === mode && x.type === s.type && x.name === s.name)
    if (!r) {
      const source = schemaFor(s.type)?.provider ?? `registry.terraform.io/hashicorp/${s.type.split('_')[0]}`
      r = { mode, type: s.type, name: s.name, provider: `provider["${source}"]`, instances: [] } satisfies StateResource
      state.resources.push(r)
    }
    r.instances.push({
      ...(s.key === undefined ? {} : { index_key: s.key }),
      ...(s.status ? { status: s.status } : {}),
      attributes: structuredClone(s.attrs) as Record<string, Value>,
    })
  }
  state.outputs = structuredClone(tf.outputs ?? {}) as State['outputs']

  const reality: Reality = {}
  for (const r of state.resources) {
    if (r.mode !== 'managed') continue
    for (const i of r.instances) reality[realityKey(r.type, i.attributes.id as string)] = structuredClone(i.attributes)
  }
  for (const p of tf.cloud?.patch ?? []) {
    const key = realityKey(p.type, p.id)
    if (Object.hasOwn(reality, key)) reality[key] = { ...reality[key], ...(structuredClone(p.set) as Record<string, Value>) }
  }
  for (const d of tf.cloud?.delete ?? []) delete reality[realityKey(d.type, d.id)]
  for (const a of tf.cloud?.add ?? []) reality[realityKey(a.type, a.attrs.id as string)] = structuredClone(a.attrs) as Record<string, Value>

  return {
    dir,
    version,
    initialized: tf.initialized ?? true,
    files: tf.files.map((f) => ({ path: join(dir, f.path), content: f.content })),
    hasState: tf.state !== undefined,
    state,
    reality,
    vars: structuredClone(tf.vars ?? {}) as Record<string, Value>,
    evidence: tf.evidence ?? [],
  }
}
```

(`cloud.patch` of an object that came from `cloud.add` is handled by applying `add` before `patch` if needed: if your test run shows a patch for an added object is ignored, apply `add` first, then `patch`, then `delete`; the schema check allows patch/delete to target `cloud.add` objects.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-lab.test.ts && npm run schemas && npx tsc -b`
Expected: PASS; schemas regenerate; `tsc` silent. Also run `npx vitest run tests/schemas.test.ts` (the committed JSON Schema must match).

- [ ] **Step 5: Commit**

```bash
git add src/schema/scenario.ts src/game/terraform/lab.ts tests/terraform-lab.test.ts schemas/incident.json
git commit -m "feat: scenario terraform block and the lab it builds (TF2c-2)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: How state and outputs print

**Files:**
- Create: `src/game/terraform/views.ts`
- Test: `tests/terraform-views.test.ts`

**Interfaces:**
- Consumes: `State`, `StateInstance`, `StateResource`, `instanceAddress` (`./state.ts`); `Value`, `isUnknown`.
- Produces:
  - `stateShow(r: StateResource, inst: StateInstance, sensitive?: (attr: string) => boolean): string` — the `terraform state show` block: `# ADDR:` (`# ADDR: (tainted)` for a tainted instance), `resource "T" "N" {` (or `data "T" "N" {`), attributes at 4 spaces, sorted, `=` aligned to the longest name, null attributes omitted, a sensitive attribute printed as `(sensitive value)`, maps with quoted aligned keys indented 4 deeper, lists one element per row ending `,`, objects inside lists as `{ … },` with unquoted aligned names, closing `}`.
  - `showState(state: State, sensitive?: (type: string, attr: string) => boolean): string` — `terraform show` for a state: every instance's block (sorted by address) separated by a blank line; `The state file is empty. No resources are represented.` when there are none.
  - `outputsText(outputs: State['outputs'], name?: string, mode?: 'hcl' | 'raw' | 'json'): { stdout: string; stderr: string; exitCode: number }` — all outputs as `name = value` (sorted; a sensitive one prints `<sensitive>`; maps/lists multi-line like attributes at column 0); a named output prints its value (`"str"` quoted by default, raw string with `-raw`, `JSON.stringify(v, null, 2)` with `-json`; sensitive values print for a named output); no outputs: exit 0 with the `Warning: No outputs found` box; a missing name: exit 1 with `Error: Output "NAME" not found` box.

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-views.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { emptyState, type State, type StateResource } from '../src/game/terraform/state.ts'
import { outputsText, showState, stateShow } from '../src/game/terraform/views.ts'

const res = (type: string, name: string, attrs: Record<string, unknown>, o: { key?: string | number; mode?: 'managed' | 'data'; status?: 'tainted' } = {}): StateResource => ({
  mode: o.mode ?? 'managed',
  type,
  name,
  provider: 'p',
  instances: [{ ...(o.key === undefined ? {} : { index_key: o.key }), ...(o.status ? { status: o.status } : {}), attributes: attrs as never }],
})
const text = (...ls: string[]) => ls.join('\n')

describe('stateShow', () => {
  it('prints aligned sorted attributes, maps, and omits nulls', () => {
    const r = res('aws_vpc', 'main', { id: 'vpc-1', cidr_block: '10.0.0.0/16', tags: { Name: 'main', Env: 'prod' }, kms: null, count: 3, ok: true })
    expect(stateShow(r, r.instances[0])).toBe(
      text(
        '# aws_vpc.main:',
        'resource "aws_vpc" "main" {',
        '    cidr_block = "10.0.0.0/16"',
        '    count      = 3',
        '    id         = "vpc-1"',
        '    ok         = true',
        '    tags       = {',
        '        "Env"  = "prod"',
        '        "Name" = "main"',
        '    }',
        '}',
      ),
    )
  })

  it('prints lists, objects inside lists, empty collections and keyed/tainted/data headers', () => {
    const r = res('aws_security_group', 'web', { id: 'sg-1', ids: [], ingress: [{ from_port: 22, to_port: 22, cidr_blocks: ['10.0.0.0/8'] }], names: ['a', 'b'] }, { key: 'x', status: 'tainted' })
    expect(stateShow(r, r.instances[0])).toBe(
      text(
        '# aws_security_group.web["x"]: (tainted)',
        'resource "aws_security_group" "web" {',
        '    id      = "sg-1"',
        '    ids     = []',
        '    ingress = [',
        '        {',
        '            cidr_blocks = [',
        '                "10.0.0.0/8",',
        '            ]',
        '            from_port   = 22',
        '            to_port     = 22',
        '        },',
        '    ]',
        '    names   = [',
        '        "a",',
        '        "b",',
        '    ]',
        '}',
      ),
    )
    const d = res('aws_ami', 'x', { id: 'ami-1' }, { mode: 'data' })
    expect(stateShow(d, d.instances[0]).split('\n').slice(0, 2)).toEqual(['# data.aws_ami.x:', 'data "aws_ami" "x" {'])
  })

  it('masks sensitive attributes', () => {
    const r = res('aws_db_instance', 'd', { id: 'db-1', password: 'hunter2' })
    const out = stateShow(r, r.instances[0], (a) => a === 'password')
    expect(out).toContain('    password = (sensitive value)')
    expect(out).not.toContain('hunter2')
  })
})

describe('showState', () => {
  it('prints every instance sorted by address, or says the state is empty', () => {
    const s: State = { ...emptyState(), resources: [res('aws_vpc', 'b', { id: '2' }), res('aws_vpc', 'a', { id: '1' })] }
    const out = showState(s)
    expect(out.indexOf('# aws_vpc.a:')).toBeLessThan(out.indexOf('# aws_vpc.b:'))
    expect(out).toContain('}\n\n# aws_vpc.b:')
    expect(showState(emptyState())).toBe('The state file is empty. No resources are represented.')
  })
})

describe('outputsText', () => {
  const outs = { b: { value: { k: 'v' } }, a: { value: 'x' }, pw: { value: 'secret', sensitive: true }, n: { value: 3 } }

  it('lists all outputs sorted, hiding sensitive ones', () => {
    expect(outputsText(outs)).toEqual({
      stdout: text('a = "x"', 'b = {', '    "k" = "v"', '}', 'n = 3', 'pw = <sensitive>'),
      stderr: '',
      exitCode: 0,
    })
  })

  it('prints one output in hcl, raw and json forms, including a sensitive one', () => {
    expect(outputsText(outs, 'a').stdout).toBe('"x"')
    expect(outputsText(outs, 'a', 'raw').stdout).toBe('x')
    expect(outputsText(outs, 'b', 'json').stdout).toBe('{\n  "k": "v"\n}')
    expect(outputsText(outs, 'pw').stdout).toBe('"secret"')
    expect(outputsText(outs, 'b').stdout).toBe(text('{', '    "k" = "v"', '}'))
  })

  it('warns when there are no outputs and errors for a missing name', () => {
    const none = outputsText({})
    expect(none.exitCode).toBe(0)
    expect(none.stderr).toContain('Warning: No outputs found')
    const missing = outputsText(outs, 'zzz')
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('Error: Output "zzz" not found')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-views.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/views.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/views.ts`:

```ts
// How `terraform state show`, `show` and `output` print values: attributes at
// four spaces, `=` aligned, maps with quoted keys, lists one element per row.
import { formatDiagnostic } from './diag.ts'
import { isUnknown, type Value } from './eval.ts'
import { instanceAddress, type State, type StateInstance, type StateResource } from './state.ts'

type Obj = { [key: string]: Value }
const isObj = (v: Value): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !isUnknown(v)
const sp = (n: number) => ' '.repeat(n)

function scalar(v: Value): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[]'
  if (isObj(v)) return '{}'
  return String(v)
}

function entry(col: number, name: string, width: number, v: Value, masked = false): string[] {
  const head = `${sp(col)}${name.padEnd(width)} = `
  if (masked) return [`${head}(sensitive value)`]
  if (Array.isArray(v) && v.length) return [`${head}[`, ...v.flatMap((x) => element(col + 4, x)), `${sp(col)}]`]
  if (isObj(v) && Object.keys(v).length) return [`${head}{`, ...body(v, col + 4, true), `${sp(col)}}`]
  return [`${head}${scalar(v)}`]
}

function element(col: number, x: Value): string[] {
  if (isObj(x) && Object.keys(x).length) return [`${sp(col)}{`, ...body(x, col + 4, false), `${sp(col)}},`]
  if (Array.isArray(x) && x.length) return [`${sp(col)}[`, ...x.flatMap((y) => element(col + 4, y)), `${sp(col)}],`]
  return [`${sp(col)}${scalar(x)},`]
}

function body(o: Obj, col: number, quote: boolean, masked: (k: string) => boolean = () => false): string[] {
  const keys = Object.keys(o).filter((k) => o[k] !== null).sort()
  const label = (k: string) => (quote ? JSON.stringify(k) : k)
  const w = Math.max(0, ...keys.map((k) => label(k).length))
  return keys.flatMap((k) => entry(col, label(k), w, o[k], masked(k)))
}

export function stateShow(r: StateResource, inst: StateInstance, sensitive: (attr: string) => boolean = () => false): string {
  const addr = instanceAddress(r, inst.index_key)
  const open = r.mode === 'data' ? `data "${r.type}" "${r.name}" {` : `resource "${r.type}" "${r.name}" {`
  return [`# ${addr}:${inst.status === 'tainted' ? ' (tainted)' : ''}`, open, ...body(inst.attributes, 4, false, sensitive), '}'].join('\n')
}

export function showState(state: State, sensitive: (type: string, attr: string) => boolean = () => false): string {
  const blocks = state.resources
    .flatMap((r) => r.instances.map((i) => ({ addr: instanceAddress(r, i.index_key), text: stateShow(r, i, (a) => sensitive(r.type, a)) })))
    .sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
  return blocks.length ? blocks.map((b) => b.text).join('\n\n') : 'The state file is empty. No resources are represented.'
}

function valueText(v: Value): string {
  if (Array.isArray(v) && v.length) return ['[', ...v.flatMap((x) => element(4, x)), ']'].join('\n')
  if (isObj(v) && Object.keys(v).length) return ['{', ...body(v, 4, true), '}'].join('\n')
  return scalar(v)
}

export function outputsText(outputs: State['outputs'], name?: string, mode: 'hcl' | 'raw' | 'json' = 'hcl'): { stdout: string; stderr: string; exitCode: number } {
  const names = Object.keys(outputs).sort()
  const box = (severity: 'error' | 'warning', summary: string, detail: string) => formatDiagnostic({ severity, summary, detail, file: '', line: 0, col: 0 })
  if (name !== undefined) {
    if (!Object.hasOwn(outputs, name)) {
      return { stdout: '', stderr: box('error', `Output "${name}" not found`, 'The output variable requested could not be found in the state file. If you recently added this to your configuration, be sure to run `terraform apply`, since the state won\'t be updated with new output variables until that command is run.'), exitCode: 1 }
    }
    const v = outputs[name].value
    const out = mode === 'json' ? JSON.stringify(v, null, 2) : mode === 'raw' ? (typeof v === 'string' ? v : String(JSON.stringify(v))) : valueText(v)
    return { stdout: out, stderr: '', exitCode: 0 }
  }
  if (!names.length) {
    return {
      stdout: '',
      stderr: box('warning', 'No outputs found', 'The state file either has no outputs defined, or all the defined outputs are empty. Please define an output in your configuration with the `output` keyword and run `terraform refresh` for it to become available. If you are using interpolation, please verify the interpolated value is not empty. You can use the `terraform console` command to assist.'),
      exitCode: 0,
    }
  }
  const out = names.flatMap((n) => (outputs[n].sensitive ? [`${n} = <sensitive>`] : entry(0, n, n.length, outputs[n].value)))
  return { stdout: out.join('\n'), stderr: '', exitCode: 0 }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-views.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent. If an expected string disagrees with the alignment rule (names padded to the longest name at that level; inside list-element objects the names are unquoted), decide whether code or string is wrong and say which in the report.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/views.ts tests/terraform-views.test.ts
git commit -m "feat: terraform state show, show and output formatting (TF2c-2)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The `terraform` command

**Files:**
- Create: `src/game/terraform/cli.ts`
- Test: `tests/terraform-cli.test.ts`

**Interfaces:**
- Consumes: `Lab` (Task 1), `stateShow`/`showState`/`outputsText` (Task 2), `planConfig`/`PlanResult` (`./plan.ts`), `renderPlan` (`./render.ts`), `formatDiagnostic`, `buildGraph`, `schemaFor`, `parseHcl`, `evalExpr`, `listAddresses`/`findInstance`/`stateJson`/`instanceAddress` (`./state.ts`).
- Produces:
  - `interface CliContext { lab: Lab; cwd: string; listFiles(dir: string): Promise<{ name: string; text: string }[]>; readFile(path: string): Promise<string | undefined>; write(dir: string, name: string, text: string): Promise<void>; env: Record<string, string> }`
  - `interface CliResult { stdout: string; stderr: string; exitCode: number; evidence: string[] }`
  - `runTerraform(args: string[], ctx: CliContext): Promise<CliResult>`
- Behavior (all text as below; wording not verified against real Terraform is logged in Task 4):
  - **Global:** `-chdir=DIR` (first argument) changes the working directory (resolved against `cwd`); `-version`/`--version`/`version`; `-help`/`--help`/`help`/no arguments print the usage text; an unknown subcommand prints `Terraform has no command named "X".\n\nTo see all of Terraform's top-level commands, run:\n  terraform -help` to stderr with exit 1.
  - **`version`:** `Terraform vV\non linux_amd64`, plus `+ provider registry.terraform.io/hashicorp/aws v5.67.0` (providers of the configuration's resource types) when the lock file exists.
  - **Working directory files:** `*.tf` are the configuration; `terraform.tfvars`, `*.auto.tfvars` (alphabetical) and `-var-file` give variables; `.terraform.lock.hcl` present means initialised.
  - **`init`:** prints the real init transcript (`Initializing the backend...`, `Initializing provider plugins...`, `- Finding …`/`- Installing …`/`- Installed … (signed by HashiCorp)` per provider, the lock-file paragraph only if it is created, `Terraform has been successfully initialized!` and the closing paragraphs) and writes `.terraform.lock.hcl` into the working directory if absent. With no `.tf` files: the `Warning: No configuration files` box and still succeeds (real init does).
  - **`validate`:** parses the files and builds the graph; syntax, reference and cycle errors, unknown resource types (`Invalid resource type`) and unsupported constructs are printed as boxed errors on stderr with exit 1; success prints `Success! The configuration is valid.\n` (stdout, exit 0). Needs initialisation like plan (same error). No configuration files: the warning box on stderr and `Success! The configuration is valid, but there were some validation warnings as shown above.`
  - **`plan`:** flags `-var NAME=VALUE` / `-var=NAME=VALUE`, `-var-file=F` / `-var-file F`, `-replace=ADDR` (repeatable), `-refresh=false`, `-detailed-exitcode`, and accepted-but-ignored `-no-color`, `-input=false`, `-lock=false`, `-lock-timeout=…`, `-parallelism=N`, `-compact-warnings`; `-out=F` prints, after the plan, `Saved the plan to: F\n\nTo perform exactly these actions, run the following command to apply:\n    terraform apply "F"` (the file is not written yet); `-target`, `-refresh-only`, `-destroy` print the honest not-simulated message (exit 1). Variable precedence, lowest to highest: `lab.vars`, `TF_VAR_name` env, `terraform.tfvars`, `*.auto.tfvars`, `-var-file`/`-var` in command-line order; `-var` values are strings; tfvars files are `name = literal` HCL (a bad file gives a located `Failed to read variables file`-style error `Invalid tfvars` hmm see below). Not initialised and the configuration has resources: stderr box `Error: Inconsistent dependency lock file` listing `- provider registry.terraform.io/hashicorp/aws: required by this configuration but no version is selected` and `To make the initial dependency selections that will initialize the dependency lock file, run:\n  terraform init`, exit 1. No `.tf` files: the `Warning: No configuration files` box (about planning without a configuration marking everything for destruction), then the plan of an empty configuration. Otherwise prints one `ADDR: Refreshing state... [id=ID]` line per managed state instance (address order; data sources `data.X: Reading...` then `data.X: Read complete after 0s [id=ID]`), a blank line, then `renderPlan(result, sources)`; when the plan has visible changes and `-out` was not given it appends the 77-character rule, a blank line and `Note: You didn't use the -out option to save this plan, so Terraform can't\nguarantee to take exactly these actions if you run "terraform apply" now.`. Errors go to stderr (exit 1); warnings stay in the rendered text. Exit code 2 with `-detailed-exitcode` and changes.
  - **`show`:** `showState(lab.state)`. **`state list [ADDR…]`:** the sorted instance addresses, filtered by prefix when addresses are given (a resource address matches all its instances); with `!lab.hasState`, stderr `No state file was found!\n\nState management commands require a state file. Run this command in a directory where Terraform has been run or use the -state flag to point the command to a specific state location.` exit 1. **`state show ADDR`:** `stateShow` for the instance, with attributes the schema marks sensitive masked; unknown address: boxed `No instance found for the given address!` error with the "This command requires that the address references one specific instance…" detail, exit 1. **`state pull`:** `stateJson(lab.state)`. **`output [-raw|-json] [NAME]`:** `outputsText`. **`workspace show`:** `default`; **`workspace list`:** `* default\n`.
  - **Everything else a real Terraform has** (`apply`, `destroy`, `import`, `taint`, `untaint`, `refresh`, `force-unlock`, `console`, `fmt`, `get`, `graph`, `login`, `logout`, `metadata`, `providers`, `test`, `state mv|rm|replace-provider`, `workspace new|select|delete`): stderr box `Error: Not available in this lab yet` with detail `"terraform SUBCOMMAND" is not simulated yet in this lab. You can still read the configuration, plan and state with: init, validate, plan, show, state list, state show, state pull, output, workspace show, workspace list, version.`, exit 1.
  - **Evidence:** after any subcommand, for each `lab.evidence` entry whose `command` equals the subcommand (`plan`, `state list`, …) and whose `contains` appears in `stdout + stderr`, add `evidence:TAG` to the result's `evidence`.

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-cli.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import type { TerraformBlock } from '../src/schema/scenario.ts'

const VPC_TF = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const VPC = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1' } }

// An in-memory directory standing in for the simulated disk.
function world(tf: Partial<TerraformBlock> = {}, o: { files?: Record<string, string>; cwd?: string; env?: Record<string, string>; skipLock?: boolean } = {}) {
  const lab = labFromScenario({ files: [{ path: 'main.tf', content: VPC_TF }], state: [VPC], ...tf } as TerraformBlock, '/home/you/infra', '/home/you')
  const disk: Record<string, string> = {}
  for (const f of lab.files) disk[f.path] = f.content
  if (lab.initialized && !o.skipLock) disk['/home/you/infra/.terraform.lock.hcl'] = '# lock\n'
  Object.assign(disk, o.files ?? {})
  const ctx: CliContext = {
    lab,
    cwd: o.cwd ?? '/home/you/infra',
    env: o.env ?? {},
    listFiles: async (dir) => Object.entries(disk).filter(([p]) => p.slice(0, p.lastIndexOf('/')) === dir).map(([p, text]) => ({ name: p.slice(p.lastIndexOf('/') + 1), text })),
    readFile: async (p) => disk[p],
    write: async (dir, name, text) => void (disk[`${dir}/${name}`] = text),
  }
  return { ctx, disk, run: (...args: string[]) => runTerraform(args, ctx) }
}

describe('terraform: basics', () => {
  it('prints the version, with providers once initialised', async () => {
    expect((await world().run('version')).stdout).toBe('Terraform v1.9.8\non linux_amd64\n+ provider registry.terraform.io/hashicorp/aws v5.67.0')
    expect((await world({}, { skipLock: true }).run('-version')).stdout).toBe('Terraform v1.9.8\non linux_amd64')
  })

  it('prints usage with no arguments and for -help, and rejects an unknown command', async () => {
    const usage = (await world().run()).stdout
    expect(usage).toContain('Usage: terraform [global options] <subcommand> [args]')
    expect(usage).toContain('  plan          Show changes required by the current configuration')
    expect((await world().run('-help')).stdout).toBe(usage)
    const bad = await world().run('frobnicate')
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toBe('Terraform has no command named "frobnicate".\n\nTo see all of Terraform\'s top-level commands, run:\n  terraform -help')
  })

  it('answers the commands that need a later milestone honestly', async () => {
    for (const args of [['apply'], ['destroy'], ['import', 'a.b', 'x'], ['taint', 'a.b'], ['state', 'rm', 'a.b'], ['workspace', 'new', 'x']]) {
      const r = await world().run(...args)
      expect(r.exitCode, args.join(' ')).toBe(1)
      expect(r.stderr).toContain('Error: Not available in this lab yet')
    }
    expect((await world().run('apply')).stderr).toContain('"terraform apply" is not simulated yet')
  })

  it('honours -chdir', async () => {
    const w = world({}, { cwd: '/home/you' })
    expect((await w.run('plan')).stderr + (await w.run('plan')).stdout).toContain('No configuration files')
    expect((await w.run('-chdir=infra', 'plan')).stdout).toContain('No changes.')
  })
})

describe('terraform init and validate', () => {
  it('initialises, writing the lock file, and is quieter the second time', async () => {
    const w = world({ initialized: false }, { skipLock: true })
    const first = await w.run('init')
    expect(first.exitCode).toBe(0)
    expect(first.stdout).toContain('Initializing the backend...')
    expect(first.stdout).toContain('- Installing hashicorp/aws v5.67.0...')
    expect(first.stdout).toContain('Terraform has created a lock file .terraform.lock.hcl')
    expect(first.stdout).toContain('Terraform has been successfully initialized!')
    expect(w.disk['/home/you/infra/.terraform.lock.hcl']).toContain('provider "registry.terraform.io/hashicorp/aws"')
    const second = await w.run('init')
    expect(second.stdout).toContain('- Reusing previous version of hashicorp/aws from the dependency lock file')
    expect(second.stdout).not.toContain('has created a lock file')
  })

  it('validates a good configuration and reports bad ones', async () => {
    expect((await world().run('validate')).stdout).toBe('Success! The configuration is valid.\n')
    const syntax = await world({ files: [{ path: 'main.tf', content: 'resource "aws_vpc" "main" {\n  cidr_block\n}\n' }] }).run('validate')
    expect(syntax.exitCode).toBe(1)
    expect(syntax.stderr).toContain('Error: Argument or block definition required')
    expect(syntax.stderr).toContain('on main.tf line 2')
    const unknown = await world({ files: [{ path: 'main.tf', content: 'resource "aws_nope" "x" {}\n' }] }).run('validate')
    expect(unknown.stderr).toContain('Error: Invalid resource type')
    const ref = await world({ files: [{ path: 'main.tf', content: 'resource "aws_subnet" "s" {\n  vpc_id = aws_vpc.nope.id\n}\n' }] }).run('validate')
    expect(ref.stderr).toContain('Reference to undeclared resource')
  })

  it('needs initialisation to validate or plan', async () => {
    const w = world({ initialized: false }, { skipLock: true })
    for (const sub of ['validate', 'plan']) {
      const r = await w.run(sub)
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain('Error: Inconsistent dependency lock file')
      expect(r.stderr).toContain('provider registry.terraform.io/hashicorp/aws: required by this configuration but no version is selected')
      expect(r.stderr).toContain('terraform init')
    }
  })
})

describe('terraform plan', () => {
  it('prints refresh lines, then no changes', async () => {
    const r = await world().run('plan')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe(
      ['aws_vpc.main: Refreshing state... [id=vpc-1]', '', 'No changes. Your infrastructure matches the configuration.', '', 'Terraform has compared your real infrastructure against your configuration', 'and found no differences, so no changes are needed.'].join('\n'),
    )
  })

  it('plans the edit the player made, with the -out note when not saving', async () => {
    const w = world({}, { files: { '/home/you/infra/main.tf': 'resource "aws_vpc" "main" {\n  cidr_block = "10.1.0.0/16"\n}\n' } })
    const r = await w.run('plan')
    expect(r.stdout).toContain('# aws_vpc.main must be replaced')
    expect(r.stdout).toContain('~ cidr_block                 = "10.0.0.0/16" -> "10.1.0.0/16" # forces replacement'.replace(/ {17}=/, ' ='))
    expect(r.stdout).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
    expect(r.stdout.endsWith('Note: You didn\'t use the -out option to save this plan, so Terraform can\'t\nguarantee to take exactly these actions if you run "terraform apply" now.')).toBe(true)
    expect(r.stdout).toContain('─'.repeat(77))
    const saved = await w.run('plan', '-out=tfplan')
    expect(saved.stdout).toContain('Saved the plan to: tfplan')
    expect(saved.stdout).not.toContain("You didn't use the -out option")
    expect((await w.run('plan', '-detailed-exitcode')).exitCode).toBe(2)
  })

  it('prints configuration errors to stderr with exit 1 and no refresh lines', async () => {
    const r = await world({}, { files: { '/home/you/infra/main.tf': 'resource "aws_vpc" "main" {\n  cidr_block\n}\n' } }).run('plan')
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('Error: Argument or block definition required')
  })

  it('applies variables in Terraform precedence', async () => {
    const tf = 'variable "cidr" {\n  default = "10.0.0.0/16"\n}\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}\n'
    const w = (extra: Record<string, string>, tfv: Partial<TerraformBlock> = {}, env: Record<string, string> = {}) =>
      world({ files: [{ path: 'main.tf', content: tf }], ...tfv }, { files: extra, env })
    const out = async (r: Promise<{ stdout: string }>) => (await r).stdout
    const dir = '/home/you/infra'
    // The plan prints `cidr_block = "old" -> "new"`, so the winning value is the one after the arrow.
    expect(await out(w({}).run('plan'))).not.toContain('->')
    expect(await out(w({}, { vars: { cidr: '10.2.0.0/16' } }).run('plan'))).toContain('-> "10.2.0.0/16"')
    expect(await out(w({}, { vars: { cidr: '10.2.0.0/16' } }, { TF_VAR_cidr: '10.3.0.0/16' }).run('plan'))).toContain('-> "10.3.0.0/16"')
    expect(await out(w({ [`${dir}/terraform.tfvars`]: 'cidr = "10.4.0.0/16"\n' }, {}, { TF_VAR_cidr: '10.3.0.0/16' }).run('plan'))).toContain('-> "10.4.0.0/16"')
    expect(await out(w({ [`${dir}/terraform.tfvars`]: 'cidr = "10.4.0.0/16"\n', [`${dir}/z.auto.tfvars`]: 'cidr = "10.5.0.0/16"\n' }).run('plan'))).toContain('-> "10.5.0.0/16"')
    expect(await out(w({ [`${dir}/prod.tfvars`]: 'cidr = "10.6.0.0/16"\n', [`${dir}/z.auto.tfvars`]: 'cidr = "10.5.0.0/16"\n' }).run('plan', '-var-file=prod.tfvars'))).toContain('-> "10.6.0.0/16"')
    expect(await out(w({ [`${dir}/prod.tfvars`]: 'cidr = "10.6.0.0/16"\n' }).run('plan', '-var-file=prod.tfvars', '-var', 'cidr=10.7.0.0/16'))).toContain('-> "10.7.0.0/16"')
    expect(await out(w({}).run('plan', '-var=cidr=10.8.0.0/16'))).toContain('-> "10.8.0.0/16"')
  })

  it('reports a bad tfvars file, a missing var file and an unsupported option', async () => {
    const dir = '/home/you/infra'
    const bad = await world({}, { files: { [`${dir}/terraform.tfvars`]: 'cidr = \n' } }).run('plan')
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toContain('terraform.tfvars')
    const missing = await world().run('plan', '-var-file=nope.tfvars')
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('nope.tfvars')
    for (const flag of ['-target=aws_vpc.main', '-refresh-only', '-destroy']) {
      const r = await world().run('plan', flag)
      expect(r.exitCode, flag).toBe(1)
      expect(r.stderr).toContain('Not available in this lab yet')
    }
  })

  it('passes -replace and -refresh=false through to the planner', async () => {
    const r = await world().run('plan', '-replace=aws_vpc.main')
    expect(r.stdout).toContain('# aws_vpc.main will be replaced, as requested')
    expect((await world().run('plan', '-refresh=false')).stdout).not.toContain('Refreshing state')
  })

  it('with no configuration warns the way Terraform does and then plans destroying everything', async () => {
    const w = world({}, { cwd: '/home/you' })
    const r = await w.run('plan')
    expect(r.stdout + r.stderr).toContain('Warning: No configuration files')
    expect(r.stdout + r.stderr).toContain('Planning without a configuration would mark everything for destruction')
  })

  it('shows drift only when the plan uses it, and reads data sources', async () => {
    const tf = 'data "aws_ami" "x" {}\nresource "aws_instance" "i" {\n  ami = data.aws_ami.x.id\n  instance_type = "t3.micro"\n}\n'
    const r = await world({ files: [{ path: 'main.tf', content: tf }], state: [{ mode: 'data', type: 'aws_ami', name: 'x', attrs: { id: 'ami-1' } }] }).run('plan')
    expect(r.stdout).toContain('data.aws_ami.x: Reading...')
    expect(r.stdout).toContain('data.aws_ami.x: Read complete after 0s [id=ami-1]')
    expect(r.stdout).toContain('# aws_instance.i will be created')
  })
})

describe('terraform state, show and output', () => {
  const tf = (extra: Partial<TerraformBlock> = {}) => world({ state: [VPC, { type: 'aws_s3_bucket', name: 'b', key: 'a', attrs: { id: 'b-a', bucket: 'b-a' } }], ...extra })

  it('lists, filters and shows state', async () => {
    expect((await tf().run('state', 'list')).stdout).toBe('aws_s3_bucket.b["a"]\naws_vpc.main')
    expect((await tf().run('state', 'list', 'aws_vpc')).stdout).toBe('aws_vpc.main')
    const show = await tf().run('state', 'show', 'aws_vpc.main')
    expect(show.stdout).toContain('# aws_vpc.main:\nresource "aws_vpc" "main" {')
    expect(show.stdout).toContain('    cidr_block                = "10.0.0.0/16"'.replace(/ {16}=/, ' ='))
    expect((await tf().run('state', 'show', 'aws_s3_bucket.b["a"]')).stdout).toContain('# aws_s3_bucket.b["a"]:')
    const missing = await tf().run('state', 'show', 'aws_vpc.nope')
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('Error: No instance found for the given address!')
  })

  it('pulls state as JSON, shows it, and has the default workspace', async () => {
    const pull = JSON.parse((await tf().run('state', 'pull')).stdout)
    expect(pull).toMatchObject({ version: 4, serial: 12, terraform_version: '1.9.8' })
    expect((await tf().run('show')).stdout).toContain('# aws_vpc.main:')
    expect((await tf().run('workspace', 'show')).stdout).toBe('default')
    expect((await tf().run('workspace', 'list')).stdout).toBe('* default\n')
  })

  it('says so when there is no state file at all', async () => {
    const w = world({ state: undefined })
    const r = await w.run('state', 'list')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('No state file was found!')
  })

  it('prints outputs', async () => {
    const w = world({ outputs: { id: { value: 'vpc-1' }, pw: { value: 'x', sensitive: true } } })
    expect((await w.run('output')).stdout).toBe('id = "vpc-1"\npw = <sensitive>')
    expect((await w.run('output', '-raw', 'id')).stdout).toBe('vpc-1')
    expect((await w.run('output', 'nope')).exitCode).toBe(1)
  })
})

describe('terraform: evidence', () => {
  it('awards evidence when the output contains the text', async () => {
    const w = world(
      { evidence: [{ evidence: 'plan-forces', command: 'plan', contains: 'forces replacement' }, { evidence: 'listed', command: 'state list', contains: 'aws_vpc.main' }] },
      { files: { '/home/you/infra/main.tf': 'resource "aws_vpc" "main" {\n  cidr_block = "10.1.0.0/16"\n}\n' } },
    )
    expect((await w.run('plan')).evidence).toEqual(['evidence:plan-forces'])
    expect((await w.run('state', 'list')).evidence).toEqual(['evidence:listed'])
    expect((await w.run('version')).evidence).toEqual([])
  })
})
```

Notes for the implementer on the two fixtures that contain `.replace(/ {N}=/, ' =')`: they exist only to keep the line readable; compute the real alignment from the rule (names padded to the longest *non-null attribute name in the block*, hidden attributes included) and write the exact expected line in the test instead of the `.replace` trick.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-cli.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/cli.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/cli.ts` implementing the behavior above. Structure it as: `runTerraform` (parse `-chdir`, dispatch on the first non-flag argument, add evidence), one small function per subcommand (`cmdVersion`, `cmdInit`, `cmdValidate`, `cmdPlan`, `cmdState`, `cmdShow`, `cmdOutput`, `cmdWorkspace`, `notYet`), and helpers `loadConfig(ctx, dir)` (lists files, returns `{ tf: {name,text}[], tfvars: ..., hasLock }`), `parseVarsFile(name, text)` (wrap the text in `locals {\n…\n}`, `parseHcl`, evaluate each attribute with an empty scope via `evalExpr`; any diagnostic or `EvalError` becomes a located `Invalid` error naming the file; line numbers shift by one, subtract it), `providersOf(files)` (from `buildGraph(files).nodes` resource labels → `schemaFor(type)?.provider`, falling back to `registry.terraform.io/hashicorp/<prefix>`), `box(severity, summary, detail)` using `formatDiagnostic`. Use these exact texts:

- Usage (stdout, exit 0):

```
Usage: terraform [global options] <subcommand> [args]

The available commands for execution are listed below.
The primary workflow commands are given first, followed by
less common or more advanced commands.

Main commands:
  init          Prepare your working directory for other commands
  validate      Check whether the configuration is valid
  plan          Show changes required by the current configuration
  apply         Create or update infrastructure
  destroy       Destroy previously-created infrastructure

All other commands:
  console       Try Terraform expressions at an interactive command prompt
  fmt           Reformat your configuration in the standard style
  force-unlock  Release a stuck lock on the current workspace
  get           Install or upgrade remote Terraform modules
  graph         Generate a Graphviz graph of the steps in an operation
  import        Associate existing infrastructure with a Terraform resource
  login         Obtain and save credentials for a remote host
  logout        Remove locally-stored credentials for a remote host
  metadata      Metadata related commands
  output        Show output values from your root module
  providers     Show the providers required for this configuration
  refresh       Update the state to match remote systems
  show          Show the current state or a saved plan
  state         Advanced state management
  taint         Mark a resource instance as not fully functional
  test          Execute integration tests for Terraform modules
  untaint       Remove the 'tainted' state from a resource instance
  version       Show the current Terraform version
  workspace     Workspace management

Global options (use these before the subcommand, if any):
  -chdir=DIR    Switch to a different working directory before executing the
                given subcommand.
  -help         Show this help output, or the help for a specified subcommand.
  -version      An alias for the "version" subcommand.
```

- init transcript (blank line first, then):

```

Initializing the backend...

Initializing provider plugins...
- Finding latest version of hashicorp/aws...
- Installing hashicorp/aws v5.67.0...
- Installed hashicorp/aws v5.67.0 (signed by HashiCorp)

Terraform has created a lock file .terraform.lock.hcl to record the provider
selections it made above. Include this file in your version control repository
so that Terraform can guarantee to make the same selections by default when
you run "terraform init" in the future.

Terraform has been successfully initialized!

You may now begin working with Terraform. Try running "terraform plan" to see
any changes that are required for your infrastructure. All Terraform commands
should now work.

If you ever set or change modules or backend configuration for Terraform,
rerun this command to reinitialize your working directory. If you forget, other
commands will detect it and remind you to do so if necessary.
```

  (one `- Finding/Installing/Installed` triple per provider; when the lock file already exists replace the Finding line with `- Reusing previous version of hashicorp/aws from the dependency lock file`, the Installing/Installed pair with `- Using previously-installed hashicorp/aws v5.67.0`, and drop the lock-file paragraph.)
- lock file written by init:

```
# This file is maintained automatically by "terraform init".
# Manual edits may be lost in future updates.

provider "registry.terraform.io/hashicorp/aws" {
  version = "5.67.0"
  hashes = [
    "h1:Zq0uB8Zc1nS5eYpR3m7KpTz2W0k6YV3d8J4bN1xQwLs=",
  ]
}
```

- Inconsistent lock file error: summary `Inconsistent dependency lock file`; detail `The following dependency selections recorded in the lock file are inconsistent with the current configuration:\n  - provider registry.terraform.io/hashicorp/aws: required by this configuration but no version is selected\n\nTo make the initial dependency selections that will initialize the dependency lock file, run:\n  terraform init`. (`formatDiagnostic` wraps long lines; keep explicit newlines inside detail by building the box lines yourself if wrapping would break the indented list — add a `preserveLines` option to `formatDiagnostic`/`wrap` that keeps lines that start with two spaces unwrapped and keeps blank lines as paragraph breaks, with a test.)
- No-configuration warning: summary `No configuration files`, detail `Plan requires configuration to be present. Planning without a configuration would mark everything for destruction, which is normally not what is desired. If you would like to destroy everything, run plan with the -destroy option. Otherwise, create a Terraform configuration file (.tf file) and try again.` (use `Validate` instead of `Plan` for validate, `Init` is silent).
- `state show` missing: summary `No instance found for the given address!`, detail `This command requires that the address references one specific instance. To view the available instances, use "terraform state list". Please modify the address to reference a specific instance.`
- Not-yet error: summary `Not available in this lab yet`, detail as in the Behavior section.

The sensitive-attribute lookup for `state show`/`show` is `schemaFor(type)?.attrs[name]?.sensitive === true`. Planning calls `planConfig({ files: tf, state: lab.state, reality: lab.reality, vars, replace, refresh })`, and the rendered text is `renderPlan(result, sources)` where `sources` maps each file name to its text. The refresh lines use `result.refreshed`'s predecessor, i.e. `lab.state` (every managed instance, address order).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-cli.test.ts tests/terraform-diag.test.ts && npx tsc -b`
Expected: PASS; `tsc` silent. Where a test fixture disagrees with the rules above, decide code vs fixture, fix that one and record why; never weaken an assertion just to get green.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/cli.ts src/game/terraform/diag.ts tests/terraform-cli.test.ts tests/terraform-diag.test.ts
git commit -m "feat: the terraform command: init, validate, plan, show, state, output, workspace (TF2c-2)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire it into the shell and the engine

**Files:**
- Modify: `src/game/paths.ts` (files on disk)
- Modify: `src/game/shell.ts` (the command)
- Modify: `src/game/engine.ts` (evidence tokens, `help`, breakdown filter)
- Test: `tests/terraform-shell.test.ts`
- Modify: `CONTENT_TODO.md` (append a section)

**Interfaces:**
- `filesOnDisk(scenario)` (paths.ts) also returns the lab's files (`labFromScenario(scenario.terraform, startDir(scenario), homeOf(scenario)).files`) and, when `initialized` (default), `<dir>/.terraform.lock.hcl` with the lock-file text used by `init` (export that text as `LOCK_FILE` from `cli.ts` and import it here).
- `IncidentShell`: when `scenario.terraform` exists, the `terraform` custom command is `defineCommand('terraform', (args, ctx) => this.terraform(name, args, ctx))` (instead of the scripted-tool command), where `terraform()` builds a `CliContext` over the host's filesystem: `cwd` from the command context, `listFiles(dir)` reads the regular files directly in `dir` (skipping unreadable ones), `readFile(path)`, `write(dir, name, text)` (mkdir -p then write), `env` from the command context's environment, and `lab` is the shell's `Lab` (state and cloud do not change in this milestone). The result's `stdout`/`stderr`/`exitCode` are returned, and each `evidence:TAG` string is added to the shell's `hits` so it is reported in `ShellResult.hits`.
- `engine.ts`: `evidenceSeen` treats a `SHELL_RAN` command that starts with `evidence:` as that evidence tag; `commandsHit` ignores such tokens; the `help` output of `runCommand` additionally lists, when `scenario.terraform` exists, `terraform init`, `terraform validate`, `terraform plan`, `terraform show`, `terraform state list`, `terraform state show ADDRESS`, `terraform output` and `terraform version` (after the scripted commands, before `clear, history`).

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-shell.test.ts`:

```ts
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { evidenceSeen, runCommand, type GameEvent } from '../src/game/engine.ts'
import { filesOnDisk } from '../src/game/paths.ts'
import { IncidentShell } from '../src/game/shell.ts'
import type { Scenario } from '../src/schema/scenario.ts'

const base = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@') && !s.stages)!
const VPC = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1' } }
const scenario = (tf: Record<string, unknown> = {}): Scenario => ({
  ...structuredClone(base),
  terminal: { ...structuredClone(base.terminal!), prompt: 'you@laptop:~/infra$', commands: [{ match: 'echo scripted', output: 'x' }] },
  terraform: { dir: '~/infra', files: [{ path: 'main.tf', content: 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n' }], state: [VPC], ...tf },
}) as Scenario
const run = async (s: Scenario, ...lines: string[]) => {
  const sh = new IncidentShell(s)
  const out = []
  for (const l of lines) out.push(await sh.run(l, s, new Set()))
  return out
}

describe('files on disk', () => {
  it('mounts the terraform files and the lock file', () => {
    const files = filesOnDisk(scenario())
    expect([...files.keys()].filter((p) => p.includes('infra'))).toEqual(expect.arrayContaining(['/home/you/infra/main.tf', '/home/you/infra/.terraform.lock.hcl']))
    expect(filesOnDisk(scenario({ initialized: false })).has('/home/you/infra/.terraform.lock.hcl')).toBe(false)
  })
})

describe('the terraform command in the shell', () => {
  it('runs plan against the files on disk, and sees the player\'s edits', async () => {
    const [before, , after] = await run(scenario(), 'terraform plan', "sed -i 's/10.0.0.0/10.1.0.0/' main.tf", 'terraform plan')
    expect(before.output).toContain('No changes.')
    expect(after.output).toContain('# aws_vpc.main must be replaced')
    expect(after.output).toContain('forces replacement')
  })

  it('works with pipes and redirection like any command', async () => {
    const [grep, count] = await run(scenario(), 'terraform state list | grep -c vpc', 'terraform version > v.txt && cat v.txt | head -1')
    expect(grep.output).toBe('1')
    expect(count.output).toBe('Terraform v1.9.8')
  })

  it('keeps stderr and exit codes for errors', async () => {
    const [r] = await run(scenario(), 'terraform apply')
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain('Not available in this lab yet')
  })

  it('init writes the lock file when it was missing', async () => {
    const [plan, init, lock, again] = await run(scenario({ initialized: false }), 'terraform plan', 'terraform init', 'ls -a', 'terraform plan')
    expect(plan.output).toContain('Inconsistent dependency lock file')
    expect(init.output).toContain('Terraform has been successfully initialized!')
    expect(lock.output).toContain('.terraform.lock.hcl')
    expect(again.output).toContain('No changes.')
  })

  it('reports simulator evidence as hits', async () => {
    const s = scenario({ evidence: [{ evidence: 'listed', command: 'state list', contains: 'aws_vpc.main' }] })
    const [r] = await run(s, 'terraform state list')
    expect(r.hits).toEqual(['evidence:listed'])
  })

  it('leaves incidents without a terraform block on the scripted tool', async () => {
    const plain = { ...structuredClone(base), terraform: undefined } as Scenario
    const sh = new IncidentShell(plain)
    const r = await sh.run('terraform plan', plain, new Set())
    expect(r.output).not.toContain('Refreshing state')
  })
})

describe('engine support', () => {
  it('counts evidence tokens as evidence', () => {
    const s = scenario()
    const log: GameEvent[] = [{ type: 'SHELL_RAN', commands: ['evidence:listed'], at: 0 }]
    expect(evidenceSeen(s, log).has('listed')).toBe(true)
  })

  it('lists the terraform commands in help for such incidents only', () => {
    const help = runCommand(scenario(), 'help', new Set()).output
    for (const c of ['terraform init', 'terraform validate', 'terraform plan', 'terraform show', 'terraform state list', 'terraform state show ADDRESS', 'terraform output', 'terraform version']) expect(help).toContain(`  ${c}`)
    expect(runCommand({ ...scenario(), terraform: undefined } as Scenario, 'help', new Set()).output).not.toContain('terraform plan')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-shell.test.ts`
Expected: FAIL (files not mounted, `terraform` still the scripted tool, no evidence tokens).

- [ ] **Step 3: Write the implementation**

1. `src/game/terraform/cli.ts`: `export const LOCK_FILE = …` (the text `init` writes).
2. `src/game/paths.ts` `filesOnDisk`: after the existing sources, if `scenario.terraform`, add `labFromScenario(scenario.terraform, startDir(scenario), homeOf(scenario)).files` (each `path → content`; do not overwrite an entry already set) and, if `initialized !== false`, `${lab.dir}/.terraform.lock.hcl → LOCK_FILE`.
3. `src/game/shell.ts`: in the constructor build `this.lab = scenario.terraform ? labFromScenario(scenario.terraform, startDir(scenario), homeOf(scenario)) : undefined`. In `makeHost`, filter `terraform` out of the scripted `programs` when `this.lab` exists and add `defineCommand('terraform', (args, ctx) => this.terraform(args, ctx as never))`. Implement `terraform(args, ctx)`: build the `CliContext` (using `ctx.fs.readdir`/`stat`/`readFile`/`writeFile`/`mkdir`, `ctx.cwd`, `ctx.env`), call `runTerraform`, push `r.evidence` into `this.hits`, return `{ stdout, stderr, exitCode }`. The shell's `sync` already writes `filesOnDisk` files once; the lock file and `.tf` files are among them.
4. `src/game/engine.ts`: in `evidenceSeen`'s `SHELL_RAN` loop, `if (c.startsWith('evidence:')) { seen.add(c.slice(9)); return }`; in `commandsHit`, skip commands starting with `evidence:`; in `runCommand`'s `help` branch append the eight terraform lines when `scenario.terraform` exists.
5. `CONTENT_TODO.md`: append a `## terraform simulator (CLI, TF2c-2)` section with unchecked items: init transcript and lock file text (provider version 5.67.0 and the `h1:` hash are invented), usage text, `Inconsistent dependency lock file` and `No configuration files` boxes, `Refreshing state...` / `Reading...` / `Read complete` lines, the `-out` and `-out`-less trailing notes, `state list` ordering and the `No state file was found!` condition, `state show` layout (attributes aligned to the longest name; null attributes omitted; `(tainted)` suffix), `output` list/named formats and the `No outputs found` warning, `workspace list` format, the not-simulated message (to be replaced by TF3), tfvars parsing wraps the file in a `locals` block (error line numbers are shifted by one and corrected), variable type conversion for `-var` values is not done (all strings), `-chdir` and the working-directory rule, and that `terraform` scripted commands are ignored for incidents with a terraform block.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-shell.test.ts && npm test 2>&1 | tail -8 && npm run lint 2>&1 | tail -3 && npx tsc -b`
Expected: all pass, lint clean, `tsc` silent. The existing `tests/terminal-content.test.ts` (scripted commands agree with the real shell) must still pass for every existing incident.

- [ ] **Step 5: Commit**

```bash
git add src/game/paths.ts src/game/shell.ts src/game/engine.ts src/game/terraform/cli.ts tests/terraform-shell.test.ts CONTENT_TODO.md
git commit -m "feat: terraform in the shell: files on disk, the command, evidence tokens, help (TF2c-2)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done)

- **Spec coverage:** "Incident authoring" (`terraform:` block: files, state, reality, env, evidence) and the shell wiring of the `terraform` command are covered; faults/locks/`done_when` and writing commands are TF3, a playable incident is TF2c-3.
- **Placeholders:** none intended. Two fixtures carry a `.replace` trick the implementer is told to replace with the computed exact line; the `-var-file` tfvars error wording ("Invalid …") is specified by behavior (must name the file) rather than exact text on purpose and is logged in CONTENT_TODO.
- **Type consistency:** `TerraformBlock`, `Lab`, `labFromScenario`, `CliContext`, `CliResult`, `runTerraform`, `LOCK_FILE`, `stateShow`/`showState`/`outputsText` use the same names across tasks.
- **Review Focus:** all six lines have tests (schema/lab rules: Task 1; edits seen by the CLI, init/lock/no-config: Tasks 3 and 4; variable precedence: Task 3; evidence tokens: Tasks 3 and 4; help and not-yet message: Tasks 3 and 4).
- **Risk notes:** `formatDiagnostic`'s word wrapping collapses the indented provider list in the lock-file error; Task 3 tells the implementer to add a `preserveLines` option with a test. `z.json()` must exist in the installed zod 4.6 (it does) and `npm run schemas` must still generate a valid JSON Schema from it.
