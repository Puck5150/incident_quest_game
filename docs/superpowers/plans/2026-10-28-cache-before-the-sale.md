# Cache before the sale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in database read-load rule and a `cache` role to the canvas engine, and ship three scored challenges (AWS, Azure, Google Cloud) that teach "the database falls over on sale day, then a cache prevents it", each modelled from its own provider's documentation.

**Architecture:** `CheckSchema` gains an optional `read_load`; `check()` in `src/game/canvas.ts` computes the database's read load from the servers that count and which of them link to a surviving cache part. Scored challenges that do not set `read_load` are untouched. Three single-provider canvas files carry the lesson, one per cloud, because the clouds' documented cache behavior differs.

**Tech Stack:** TypeScript, Zod 4, Vitest, YAML content validated at build time by `vite-plugin-content.ts` (`canvasChecks` runs every reference design and counter-example).

**Spec:** `docs/superpowers/specs/2026-10-28-cache-before-the-sale-design.md`

## Global Constraints

- **Provider docs are the only source of truth** (memory `provider-docs-source-of-truth`). A capability, scope or failure behavior documented for one cloud is never assumed for another. If the docs do not say it, it is not in the content. Facts are written in our own words, never copied; each file's `sources` lists only its own cloud's pages with a `retrieved` date.
- AWS and Google Cloud caches are **zonal**; the Azure cache is **regional** (zone-redundant). These scopes are fixed by the spec.
- Scenario numbers: `read_load: { traffic: 2, hit: 0.9, db_capacity: 1 }`; `capacity: 2` on every check; web server `capacity: 1`; budgets 14 (AWS, Google Cloud) and 12 (Azure). Labelled "(scenario number)" in facts.
- The read-load rule is opt-in. No existing challenge file may change, and every existing test must pass unchanged.
- Validation commands: `npx tsc -b`, `npx oxlint`, `npm test`, `npm run schemas` (then `git status --short` must show only intended files), `npm run check-links` (known pre-existing external failures: `dev.mysql.com` 403, `nftables.org` timeouts; any new failure is yours).
- Shell is zsh on macOS: `rm -f`, `cp -f`; `sed -i ''`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Do not push or open a PR.
- Branch: `cache-before-the-sale` (already created, spec committed).

## Review Focus

Input classes the spec implies that no single task's happy path exercises. Each has a test in the task that owns the code:

1. A cache linked from only some serving servers: only those servers are shielded and the reason names the others (Task 2, `partial links`).
2. A zone no stress test names that holds the only cache: the engine's unnamed-zone fan-out must still catch it (Task 2, `unnamed zone`).
3. A check with `read_load` but no `capacity`: the shared serving-set helper must work without the capacity block (Task 2, every test uses it; `capacity` is absent).
4. No serving server, or no database: no read-load line is added, only the existing reasons (Task 2).
5. A palette item with `cache` plus another role, or `read_load` on a check that lacks `serve` or `write-store`: rejected by the schema (Task 1).
6. A cache part linked only *from* the database or to a server: shields nothing (Task 2, `direction matters`).

---

### Task 1: `cache` role and `read_load` schema

**Files:**
- Modify: `src/schema/constants.ts` (`ROLES`)
- Modify: `src/schema/canvas.ts` (`CheckSchema`, palette refinement)
- Create: `tests/read-load-schema.test.ts`
- Regenerate: `schemas/*.json` via `npm run schemas`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ROLES` includes `'cache'`; `CanvasTest['check']` has optional `read_load?: { traffic: number; hit: number; db_capacity: number }`. Task 2 reads `t.check.read_load` and `has(n, 'cache')`.

- [ ] **Step 1: Write the failing test**

Create `tests/read-load-schema.test.ts`:

```ts
// The opt-in read_load check field and the cache role: what the schema accepts and refuses.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { CanvasChallengeSchema } from '../src/schema/canvas.ts'
import { ROLES } from '../src/schema/constants.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const base = canvases.find((x) => x.id === 'aws-checkout-canvas')!

const withCheck = (check: unknown) => {
  const c = structuredClone(base) as Record<string, unknown> & { stress_tests: { check: unknown }[] }
  c.stress_tests[0].check = check
  return CanvasChallengeSchema.safeParse(c)
}
const both = ['serve', 'write-store']
const rl = { traffic: 2, hit: 0.9, db_capacity: 1 }
const messages = (r: ReturnType<typeof withCheck>) => (r.success ? [] : r.error.issues.map((i) => i.message))

describe('read_load', () => {
  it('cache is a role', () => {
    expect(ROLES).toContain('cache')
  })

  it('is accepted when reach has serve and write-store', () => {
    expect(withCheck({ reach: both, read_load: rl }).success).toBe(true)
  })

  it('is optional: a check without it is unchanged', () => {
    expect(withCheck({ reach: both, capacity: 2 }).success).toBe(true)
  })

  it('is refused when reach lacks serve or write-store', () => {
    expect(messages(withCheck({ reach: ['serve'], read_load: rl }))).toContain('read_load needs both serve and write-store in reach')
    expect(messages(withCheck({ reach: ['write-store'], read_load: rl }))).toContain('read_load needs both serve and write-store in reach')
  })

  it('refuses a hit rate outside (0, 1) and non-positive numbers', () => {
    for (const bad of [{ ...rl, hit: 0 }, { ...rl, hit: 1 }, { ...rl, hit: 1.5 }, { ...rl, traffic: 0 }, { ...rl, db_capacity: -1 }])
      expect(withCheck({ reach: both, read_load: bad }).success).toBe(false)
  })

  it('refuses unknown fields inside read_load', () => {
    expect(withCheck({ reach: both, read_load: { ...rl, extra: 1 } }).success).toBe(false)
  })
})

describe('the cache role', () => {
  const withRoles = (roles: string[]) => {
    const c = structuredClone(base) as Record<string, unknown> & { palette: { roles: string[] }[] }
    c.palette[0].roles = roles
    return CanvasChallengeSchema.safeParse(c)
  }
  it('is accepted on its own', () => {
    expect(withRoles(['cache']).success).toBe(true)
  })
  it('is refused together with another role', () => {
    const r = withRoles(['cache', 'serve'])
    expect(r.success).toBe(false)
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toContain('a cache part has no other role')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/read-load-schema.test.ts`
Expected: FAIL (cache is not a role; `read_load` is an unrecognized key).

- [ ] **Step 3: Implement**

In `src/schema/constants.ts` change the roles line to:

```ts
export const ROLES = ['route', 'serve', 'write-store', 'cache', 'neutral'] as const
```

In `src/schema/canvas.ts` replace the `CheckSchema` definition with:

```ts
const CheckSchema = z
  .strictObject({
    reach: z.array(z.enum(['serve', 'write-store'])).min(1),
    capacity: z.number().positive().optional(), // surviving `serve` capacity needed
    // Opt-in: also judge the database's read load. `traffic` is the reads, in multiples of
    // normal, that the web tier sends; `hit` is the share a live, linked cache answers;
    // `db_capacity` is the most reads the database can take, in the same multiples.
    read_load: z
      .strictObject({
        traffic: z.number().positive(),
        hit: z.number().gt(0).lt(1),
        db_capacity: z.number().positive(),
      })
      .optional(),
  })
  .superRefine((k, ctx) => {
    if (k.read_load && !(k.reach.includes('serve') && k.reach.includes('write-store')))
      ctx.addIssue({ code: 'custom', message: 'read_load needs both serve and write-store in reach', path: ['read_load'], input: k })
  })
```

In the same file, inside the existing `c.palette.forEach((p, i) => { ... })` block of `CanvasChallengeSchema.superRefine`, add after the `public` line:

```ts
      if (p.roles.includes('cache') && p.roles.length > 1) issue('a cache part has no other role', ['palette', i, 'roles'])
```

- [ ] **Step 4: Run the new test and the whole suite**

Run: `npx vitest run tests/read-load-schema.test.ts` then `npx tsc -b && npm test`
Expected: new tests PASS; full suite passes (the previous count was 183 files, 3478 tests; it grows by this file only).

- [ ] **Step 5: Check nothing treats the role list as exhaustive**

Run: `grep -rn "ROLES\|'write-store'\|\"neutral\"" src scripts vite-plugin-content.ts | grep -v "^src/game/canvas.ts\|^src/schema"`
Expected: only uses of `.includes('write-store')`, `roles.includes('neutral')` and the sandbox's `isNeutral`, none of which is a `switch` or a closed list. If any is exhaustive, fix it and note a `Ruling:` in the ledger.

- [ ] **Step 6: Regenerate the JSON Schemas and commit**

Run: `npm run schemas && git status --short`
Expected: `schemas/canvas.json`, `schemas/pick-cloud-canvas.json` (and any other schema listing `ROLES`) changed, nothing unexpected.

```bash
git add src/schema/constants.ts src/schema/canvas.ts tests/read-load-schema.test.ts schemas
git commit -m "Add the cache role and an opt-in read_load check field

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: the read-load rule in the engine, and authoring docs

**Files:**
- Modify: `src/game/canvas.ts` (hoist the serving-set computation, add the read-load block, add `fmt`)
- Create: `tests/canvas-read-load.test.ts`
- Modify: `AUTHORING.md` (canvas section)

**Interfaces:**
- Consumes (Task 1): `t.check.read_load?: { traffic, hit, db_capacity }`; role string `'cache'` via `has(n, 'cache')`.
- Produces: results for checks with `read_load` carry one extra entry in `reasons`, exactly:
  - `"<writer> would see <load>× normal reads but can take <db_capacity>× (<why>)."`
  - `<why>` is one of: `there is no cache in the design`; `<ids> was lost` / `<ids> were lost` (every cache in the design was removed in the scenario); `<ids> is not linked to a surviving cache` / `<ids> are not linked to a surviving cache` (the unshielded serving servers).
  - `<load>` is rounded to two decimals with trailing zeros dropped (`2`, `1.1`, `0.2`).
  - The reason carries the existing scenario prefix (`If cache-1 fails: `, `A zone you used but no test names (...) fails: `).

- [ ] **Step 1: Write the failing tests**

Create `tests/canvas-read-load.test.ts`:

```ts
// The opt-in read_load rule: the database's read load after a failure, and
// what a live, linked cache takes off it. Uses the real AWS canvas challenge's
// palette and layout plus a test cache part and hand-built checks, so no
// shipped challenge is needed.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { evaluateCanvas } from '../src/game/canvas.ts'
import type { CanvasChallenge, Design } from '../src/schema/canvas.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const base = canvases.find((x) => x.id === 'aws-checkout-canvas')!

const reach = ['serve', 'write-store'] as ('serve' | 'write-store')[]
const check = { reach, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
const c: CanvasChallenge = {
  ...base,
  palette: [
    ...base.palette,
    { id: 'cache', label: 'Cache', short: 'cache', scope: 'zonal', roles: ['cache'], capacity: 0, cost: 2, facts: ['A test cache.'] },
  ],
  stress_tests: [
    { id: 'sale', label: 'Sale', event: { none: true }, check },
    { id: 'zone-a', label: 'A', event: { zone_outage: 'use1-az1' }, check },
    { id: 'zone-b', label: 'B', event: { zone_outage: 'use1-az2' }, check },
    { id: 'cache-failure', label: 'Cache', event: { single_failure: 'cache' }, check },
  ],
}

const T = (from: string, to: string) => ({ from, to, kind: 'traffic' as const })
const plain: Design = {
  nodes: [
    { id: 'alb', type: 'alb', lane: 'use1' },
    { id: 'web-1', type: 'ec2-web', lane: 'use1-az1' },
    { id: 'web-2', type: 'ec2-web', lane: 'use1-az2' },
    { id: 'db-1', type: 'rds', lane: 'use1-az1' },
    { id: 'db-2', type: 'rds', lane: 'use1-az2' },
  ],
  edges: [T('users', 'alb'), T('alb', 'web-1'), T('alb', 'web-2'), T('web-1', 'db-1'), T('web-2', 'db-1'), { from: 'db-1', to: 'db-2', kind: 'sync' }],
}
const plus = (nodes: Design['nodes'], edges: Design['edges']): Design => ({ nodes: [...plain.nodes, ...nodes], edges: [...plain.edges, ...edges] })
const cache = (id: string, lane: string) => ({ id, type: 'cache', lane })
const run = (d: Design, ch = c) => Object.fromEntries(evaluateCanvas(ch, d).tests.map((t) => [t.id, t]))

describe('read_load', () => {
  it('with no cache the database sees every read, and the reason says so', () => {
    const r = run(plain)
    expect(r.sale.pass).toBe(false)
    expect(r.sale.reasons).toEqual(['db-1 would see 2× normal reads but can take 1× (there is no cache in the design).'])
  })

  it('a cache linked from every server takes the load off the database', () => {
    const d = plus([cache('cache-1', 'use1-az1')], [T('web-1', 'cache-1'), T('web-2', 'cache-1')])
    expect(run(d).sale.pass).toBe(true)
  })

  it('a zone outage that removes the only cache fails, and the standby is the one named', () => {
    const d = plus([cache('cache-1', 'use1-az1')], [T('web-1', 'cache-1'), T('web-2', 'cache-1')])
    const r = run(d)
    expect(r['zone-a'].reasons).toEqual(['db-2 would see 2× normal reads but can take 1× (cache-1 was lost).'])
    expect(r['zone-b'].pass).toBe(true)
  })

  it('losing the only cache fails, naming the cache that failed', () => {
    const d = plus([cache('cache-1', 'use1-az1')], [T('web-1', 'cache-1'), T('web-2', 'cache-1')])
    expect(run(d)['cache-failure'].reasons).toEqual(['If cache-1 fails: db-1 would see 2× normal reads but can take 1× (cache-1 was lost).'])
  })

  it('two caches, every server linked to both, survive losing a zone or a cache', () => {
    const d = plus(
      [cache('cache-1', 'use1-az1'), cache('cache-2', 'use1-az2')],
      [T('web-1', 'cache-1'), T('web-1', 'cache-2'), T('web-2', 'cache-1'), T('web-2', 'cache-2')],
    )
    const r = run(d)
    expect(Object.values(r).every((t) => t.pass)).toBe(true)
  })

  it('partial links: only the linked servers are shielded, and the others are named', () => {
    const d = plus([cache('cache-1', 'use1-az1')], [T('web-1', 'cache-1')])
    const r = run(d)
    expect(r.sale.reasons).toEqual(['db-1 would see 1.1× normal reads but can take 1× (web-2 is not linked to a surviving cache).'])
  })

  it('a cache nothing links to shields nothing', () => {
    const d = plus([cache('cache-1', 'use1-az1')], [])
    expect(run(d).sale.reasons).toEqual([
      'db-1 would see 2× normal reads but can take 1× (web-1, web-2 are not linked to a surviving cache).',
    ])
  })

  it('direction matters: a link from the cache to a server, or from the database to the cache, shields nothing', () => {
    const d = plus([cache('cache-1', 'use1-az1')], [T('cache-1', 'web-1'), T('cache-1', 'web-2'), T('db-1', 'cache-1')])
    expect(run(d).sale.pass).toBe(false)
  })

  it('unnamed zone: a design that hides its only cache in a zone no test names still fails', () => {
    const d = plus([cache('cache-1', 'usw2-az1')], [T('web-1', 'cache-1'), T('web-2', 'cache-1')])
    const r = run(d)
    expect(r['zone-a'].pass).toBe(false)
    expect(r['zone-a'].reasons[0]).toMatch(/^A zone you used but no test names \(us-west-2a\) fails: db-1 would see 2× normal reads/)
  })

  it('adds no read-load line when nothing serves, or when there is no database', () => {
    const noWeb: Design = { nodes: [plain.nodes[3]], edges: [] }
    const noDb: Design = { nodes: plain.nodes.slice(0, 3), edges: [T('users', 'alb'), T('alb', 'web-1'), T('alb', 'web-2')] }
    for (const d of [noWeb, noDb]) {
      const reasons = Object.values(run(d)).flatMap((t) => t.reasons)
      expect(reasons.length).toBeGreaterThan(0)
      expect(reasons.some((x) => /would see/.test(x))).toBe(false)
    }
  })

  it('a check without read_load is unchanged, with or without a cache in the design', () => {
    const noLoad: CanvasChallenge = { ...c, stress_tests: c.stress_tests.map((t) => ({ ...t, check: { reach } })) }
    const d = plus([cache('cache-1', 'use1-az1')], [])
    for (const design of [plain, d]) expect(Object.values(run(design, noLoad)).every((t) => t.pass)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/canvas-read-load.test.ts`
Expected: FAIL (no read-load reasons yet: `sale.pass` is true for the plain design).

- [ ] **Step 3: Implement the rule in `src/game/canvas.ts`**

Add near the top of the file, after the `type Node` line:

```ts
const fmt = (x: number) => String(Number(x.toFixed(2)))
```

In `check()`, replace the whole `if (t.check.capacity !== undefined) { ... }` block (it begins with the comment `// A server only adds capacity if it can actually write to the database.`) with the following. The helper is the old block's serving-set computation, moved out unchanged so the read-load block can share it:

```ts
  // The servers that count: reachable, and able to reach whichever database
  // currently accepts writes (every reachable server, when the design has no database).
  const serversThatCount = () => {
    const stores = d.nodes.filter((n) => has(n, 'write-store')).map((n) => n.id)
    const w = writer(d, removed, has)
    const endpoint = 'problem' in w ? new Set(stores) : w.endpoint
    const reached = d.nodes.filter((n) => has(n, 'serve') && reachable.has(n.id))
    const serving = stores.length
      ? reached.filter((n) => traffic.some((e) => e.from === n.id && endpoint.has(e.to)))
      : reached
    return { w, reached, serving }
  }

  if (t.check.capacity !== undefined) {
    // A server only adds capacity if it can actually write to the database.
    const { reached, serving } = serversThatCount()
    const unlinked = reached.filter((n) => !serving.includes(n)).map((n) => n.id)
    const cap = serving.reduce((sum, n) => sum + (c.palette.find((p) => p.id === n.type)?.capacity ?? 0), 0)
    if (cap < t.check.capacity) {
      reasons.push(
        cap === 0
          ? `no serving capacity survives; ${t.check.capacity}× is needed.`
          : `only ${cap}× of the ${t.check.capacity}× traffic needed can be served (${serving.map((n) => n.id).join(', ')}).`,
      )
      if (unlinked.length) reasons.push(`${unlinked.join(', ')} can't reach the database, so they don't count as serving capacity.`)
    }
  }

  // Opt-in (check.read_load): the database's read load. The serving servers share the reads
  // equally; one linked to a surviving cache sends only the misses to the database. Skipped
  // when nothing serves or nothing can accept writes: the reasons above already failed that.
  const rl = t.check.read_load
  if (rl) {
    const { w, serving } = serversThatCount()
    if (!('problem' in w) && serving.length) {
      const caches = d.nodes.filter((n) => has(n, 'cache'))
      const live = new Set(caches.filter((n) => !removed.has(n.id)).map((n) => n.id))
      const open = serving.filter((n) => !traffic.some((e) => e.from === n.id && live.has(e.to)))
      const share = rl.traffic / serving.length
      const load = share * open.length + share * (serving.length - open.length) * (1 - rl.hit)
      if (load - rl.db_capacity > 1e-9) {
        const lost = caches.filter((n) => removed.has(n.id)).map((n) => n.id)
        const why = !caches.length
          ? 'there is no cache in the design'
          : lost.length === caches.length
            ? `${lost.join(', ')} ${lost.length > 1 ? 'were' : 'was'} lost`
            : `${open.map((n) => n.id).join(', ')} ${open.length > 1 ? 'are' : 'is'} not linked to a surviving cache`
        reasons.push(`${w.writer} would see ${fmt(load)}× normal reads but can take ${rl.db_capacity}× (${why}).`)
      }
    }
  }
```

The block ends where the old capacity block ended; the function's `return reasons` follows unchanged.

- [ ] **Step 4: Run the new test, then everything**

Run: `npx vitest run tests/canvas-read-load.test.ts` then `npx tsc -b && npx oxlint && npm test`
Expected: new file PASS; the full suite passes unchanged (this includes `tests/canvas.test.ts` and `tests/canvas-design-holes.test.ts`, which pin the capacity behavior the refactor touched).

- [ ] **Step 5: Document it in `AUTHORING.md`**

In the "Canvas challenges" section, add this bullet after the "**The application writes, not the load balancer.**" bullet and before "**Counter-examples replace enumeration.**":

```markdown
  - **Read load and caches (opt-in).** A check may carry
    `read_load: { traffic, hit, db_capacity }`, which needs both `serve` and
    `write-store` in `reach`. The serving servers share `traffic` equally; a
    server with a traffic link to a surviving `cache` part sends only
    `1 − hit` of its share to the database, and any other server sends all of
    it. The check fails if the total exceeds `db_capacity` (all three are
    multiples of normal reads). A `cache` part has the role `cache` and no other
    role. Only a link *from* a server *to* the cache shields it. Not modelled:
    read replicas, cache replicas the player places separately, expiry and
    staleness, writes, warm-up. State every number as a scenario number, and
    model each cloud's cache from that cloud's own documentation: the scope
    (zonal or regional) and the failure behavior are different services' facts,
    never one cloud's assumed for another.
```

- [ ] **Step 6: Commit**

```bash
git add src/game/canvas.ts tests/canvas-read-load.test.ts AUTHORING.md
git commit -m "Judge the database's read load when a check opts in

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: AWS challenge `aws-cache-before-the-sale`

**Files:**
- Create: `content/cloud-design/aws-cache-before-the-sale.yaml`

**Interfaces:**
- Consumes (Tasks 1, 2): `roles: [cache]`, `read_load` on checks; the build-time `canvasChecks` in `src/content/item.ts` runs the reference design (must pass every test within budget) and counter-examples (must fail exactly their `fails`).
- Produces: a published AWS canvas challenge in track `cloud-design`.

- [ ] **Step 1: Read the AWS pages and confirm every cache sentence**

Read (WebFetch) these pages, and open nothing else for the cache facts:
`https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/AutoFailover.html` (title "Minimizing downtime in ElastiCache by using Multi-AZ with Valkey and Redis OSS").
Confirm from the page, in your own words, that: (a) a cache node runs in one Availability Zone; (b) with no replica, a replacement primary starts empty after a primary fails. If a sentence is not supported by the page, rewrite it to what the page does say, or drop it, and record a `Ruling:` line in the ledger. Note today's date for each `retrieved`.

- [ ] **Step 2: Create the file**

Create `content/cloud-design/aws-cache-before-the-sale.yaml` (change the `retrieved` dates to the dates you read the pages; the first three source entries were read 2026-09-30 for the same services in `zone-resilient-checkout` and are kept as they are):

```yaml
# yaml-language-server: $schema=../../schemas/canvas.json
type: challenge
mode: canvas
id: aws-cache-before-the-sale
track: cloud-design
difficulty: 3
title: "Keep the database standing on sale day, on AWS"
provider: aws
par_minutes: 15

brief: |
  The shop's checkout works on a normal day. A sale doubles traffic, and every
  product page re-reads the same data from the database, so the database
  buckles even though the web tier has room to spare. You build the
  architecture: keep the checkout up through the sale, through losing a zone, a
  web server or the database server, and through losing a cache node.

requirements:
  - "Serve 2× normal traffic, even with one Availability Zone down"
  - "Keep the database within what it can read on a sale day: 1× normal reads"
  - "Keep accepting orders if either zone or the database server fails, losing none"
  - "Survive any single web server or cache node failing"
  - "Stay within 14 cost units per month"
budget: 14

layout:
  regions:
    - id: r1
      label: "us-east-1"
      zones:
        - { id: r1-a, label: "us-east-1a" }
        - { id: r1-b, label: "us-east-1b" }

palette:
  - id: lb
    label: "Application Load Balancer"
    short: "ALB"
    scope: regional
    roles: [route]
    cost: 1
    facts:
      - "A regional load balancer. AWS load balancers reroute traffic to targets in healthy Availability Zones."
  - id: vm
    label: "EC2 web server"
    short: "web"
    scope: zonal
    roles: [serve]
    capacity: 1
    cost: 1
    facts:
      - "Runs in one Availability Zone."
      - "Each server handles 1× normal traffic (scenario number)."
  - id: db
    label: "RDS for PostgreSQL DB instance"
    short: "RDS"
    scope: zonal
    roles: [write-store]
    cost: 2
    facts:
      - "A DB instance runs in one Availability Zone."
      - "Connect two instances with a replication link to make one a standby or a replica of the other."
      - "On a sale day this database can read 1× normal traffic (scenario number)."
  - id: cache
    label: "ElastiCache cache node"
    short: "ElastiCache"
    scope: zonal
    roles: [cache]
    cost: 2
    facts:
      - "A cache node runs in one Availability Zone."
      - "A node with no replica that fails is replaced by a new primary that starts empty."
      - "While a linked cache is up it answers 9 in 10 reads (scenario number); the database sees the rest."

link_facts:
  sync:
    - "Like RDS Multi-AZ: a synchronous standby in another Availability Zone."
    - "Failover is automatic, typically 60–120 seconds; the database's DNS name moves to the standby."
  async:
    - "Like an RDS read replica: replication is asynchronous, so it can lag behind."
    - "Promotion to a standalone instance is a manual step."

stress_tests:
  - id: sale
    label: "A sale: 2× traffic"
    event: { none: true }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: zone-a
    label: "us-east-1a fails during the sale"
    event: { zone_outage: r1-a }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: zone-b
    label: "us-east-1b fails during the sale"
    event: { zone_outage: r1-b }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: vm-failure
    label: "Any one web server fails during the sale"
    event: { single_failure: vm }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: db-host
    label: "The database server fails during the sale"
    event: { single_failure: db }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: cache-failure
    label: "Any one cache node fails during the sale"
    event: { single_failure: cache }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }

reference_designs:
  - name: "Recommended"
    why: "Two web servers per zone keep 2× capacity after losing a zone; a synchronous standby in the other zone takes over writes. A cache node in each zone, with every web server linked to both, leaves one cache shielding the database when a zone or a node is lost."
    design:
      nodes:
        - { id: lb, type: lb, lane: r1 }
        - { id: web-1, type: vm, lane: r1-a }
        - { id: web-2, type: vm, lane: r1-a }
        - { id: web-3, type: vm, lane: r1-b }
        - { id: web-4, type: vm, lane: r1-b }
        - { id: db-1, type: db, lane: r1-a }
        - { id: db-2, type: db, lane: r1-b }
        - { id: cache-1, type: cache, lane: r1-a }
        - { id: cache-2, type: cache, lane: r1-b }
      edges:
        - { from: users, to: lb, kind: traffic }
        - { from: lb, to: web-1, kind: traffic }
        - { from: lb, to: web-2, kind: traffic }
        - { from: lb, to: web-3, kind: traffic }
        - { from: lb, to: web-4, kind: traffic }
        - { from: web-1, to: db-1, kind: traffic }
        - { from: web-2, to: db-1, kind: traffic }
        - { from: web-3, to: db-1, kind: traffic }
        - { from: web-4, to: db-1, kind: traffic }
        - { from: db-1, to: db-2, kind: sync }
        - { from: web-1, to: cache-1, kind: traffic }
        - { from: web-2, to: cache-1, kind: traffic }
        - { from: web-3, to: cache-1, kind: traffic }
        - { from: web-4, to: cache-1, kind: traffic }
        - { from: web-1, to: cache-2, kind: traffic }
        - { from: web-2, to: cache-2, kind: traffic }
        - { from: web-3, to: cache-2, kind: traffic }
        - { from: web-4, to: cache-2, kind: traffic }

counter_examples:
  - name: "No cache: every read goes to the database"
    fails: [sale, zone-a, zone-b, vm-failure, db-host, cache-failure]
    design:
      nodes:
        - { id: lb, type: lb, lane: r1 }
        - { id: web-1, type: vm, lane: r1-a }
        - { id: web-2, type: vm, lane: r1-a }
        - { id: web-3, type: vm, lane: r1-b }
        - { id: web-4, type: vm, lane: r1-b }
        - { id: db-1, type: db, lane: r1-a }
        - { id: db-2, type: db, lane: r1-b }
      edges:
        - { from: users, to: lb, kind: traffic }
        - { from: lb, to: web-1, kind: traffic }
        - { from: lb, to: web-2, kind: traffic }
        - { from: lb, to: web-3, kind: traffic }
        - { from: lb, to: web-4, kind: traffic }
        - { from: web-1, to: db-1, kind: traffic }
        - { from: web-2, to: db-1, kind: traffic }
        - { from: web-3, to: db-1, kind: traffic }
        - { from: web-4, to: db-1, kind: traffic }
        - { from: db-1, to: db-2, kind: sync }
  - name: "Caches that no web server reads from"
    fails: [sale, zone-a, zone-b, vm-failure, db-host, cache-failure]
    design:
      nodes:
        - { id: lb, type: lb, lane: r1 }
        - { id: web-1, type: vm, lane: r1-a }
        - { id: web-2, type: vm, lane: r1-a }
        - { id: web-3, type: vm, lane: r1-b }
        - { id: web-4, type: vm, lane: r1-b }
        - { id: db-1, type: db, lane: r1-a }
        - { id: db-2, type: db, lane: r1-b }
        - { id: cache-1, type: cache, lane: r1-a }
        - { id: cache-2, type: cache, lane: r1-b }
      edges:
        - { from: users, to: lb, kind: traffic }
        - { from: lb, to: web-1, kind: traffic }
        - { from: lb, to: web-2, kind: traffic }
        - { from: lb, to: web-3, kind: traffic }
        - { from: lb, to: web-4, kind: traffic }
        - { from: web-1, to: db-1, kind: traffic }
        - { from: web-2, to: db-1, kind: traffic }
        - { from: web-3, to: db-1, kind: traffic }
        - { from: web-4, to: db-1, kind: traffic }
        - { from: db-1, to: db-2, kind: sync }
  - name: "One cache node in one zone"
    fails: [zone-a, cache-failure]
    design:
      nodes:
        - { id: lb, type: lb, lane: r1 }
        - { id: web-1, type: vm, lane: r1-a }
        - { id: web-2, type: vm, lane: r1-a }
        - { id: web-3, type: vm, lane: r1-b }
        - { id: web-4, type: vm, lane: r1-b }
        - { id: db-1, type: db, lane: r1-a }
        - { id: db-2, type: db, lane: r1-b }
        - { id: cache-1, type: cache, lane: r1-a }
      edges:
        - { from: users, to: lb, kind: traffic }
        - { from: lb, to: web-1, kind: traffic }
        - { from: lb, to: web-2, kind: traffic }
        - { from: lb, to: web-3, kind: traffic }
        - { from: lb, to: web-4, kind: traffic }
        - { from: web-1, to: db-1, kind: traffic }
        - { from: web-2, to: db-1, kind: traffic }
        - { from: web-3, to: db-1, kind: traffic }
        - { from: web-4, to: db-1, kind: traffic }
        - { from: db-1, to: db-2, kind: sync }
        - { from: web-1, to: cache-1, kind: traffic }
        - { from: web-2, to: cache-1, kind: traffic }
        - { from: web-3, to: cache-1, kind: traffic }
        - { from: web-4, to: cache-1, kind: traffic }

hints:
  nudge: "A normal day passes. What changes on a sale day, and who is doing all the reading?"
  direction: "Put something between the web servers and the database that answers repeat reads, link the web servers to it, then ask what happens to the database when that something is gone."
  answer: "Two web servers and a database with a sync standby in each zone as before, plus an ElastiCache node in each zone with every web server linked to both."

analogy:
  title: "The reference desk"
  text: |
    A busy library answers the same questions all day. The librarian could walk
    to the stacks for every one, or keep the popular answers on a card at the
    desk and only walk to the stacks for the rest. On a quiet day nobody can
    tell the difference. On sale day the queue is out the door, and the
    librarian who has to fetch every answer from the stacks is the one who
    gives up first. If the desk cards get thrown out mid-rush, everyone is
    back to the stacks at once.

debrief:
  summary: |
    The database was fine on a normal day and failed on the sale because every
    page view read from it. A cache takes the repeated reads off the database:
    the application asks the cache first and only reads the database for what
    the cache does not have. Here, a live cache answers nine in ten reads, so
    the database sees a tenth of the load.

    The cache is not the source of truth. An ElastiCache node with no replica
    that fails is replaced by one that starts empty, so until it warms up
    every read goes back to the database. Put a cache node in each zone and
    link every web server to both, and losing one zone or one node leaves the
    other still shielding the database.

    The hit rate and the database's limit are scenario numbers, not
    measurements; real figures depend on the data and the traffic. This
    challenge does not model read replicas, ElastiCache replicas and Multi-AZ
    replication groups, expiry and staleness, or writes.
  real_world: |
    Keep the shape safe as well as available: only the load balancer takes
    traffic from users, and the web servers, caches and database stay behind
    it. Resilience does not replace backups: keep automated backups with
    point-in-time restore on the database.

sources:
  - title: "Minimizing downtime in ElastiCache by using Multi-AZ with Valkey and Redis OSS"
    url: "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/AutoFailover.html"
    retrieved: 2026-10-28
  - title: "Amazon RDS: Multi-AZ DB instance deployments"
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html"
    retrieved: 2026-09-30
  - title: "Amazon RDS: Failing over a Multi-AZ DB instance"
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html"
    retrieved: 2026-09-30
  - title: "AWS Well-Architected Reliability Pillar: REL10-BP01 Deploy the workload to multiple locations"
    url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_fault_isolation_multiaz_region_system.html"
    retrieved: 2026-09-30
```

- [ ] **Step 3: Run the content validation and the tests**

Run: `node -e "import('./vite-plugin-content.ts').then(m=>{try{m.loadContent('content');console.log('OK')}catch(e){console.log(e.message)}})"`
Expected: `OK`. If it prints `reference design ... fails: ...` or `counter-example ... should fail [...] but fails [...]`, fix the YAML (not the engine) unless the message shows a genuine engine bug, in which case stop and report. Do not edit a `fails` list to match a result you have not understood: work out why each test fails from the printed reasons.

Then run: `npx tsc -b && npx oxlint && npm test && npm run schemas && git status --short`
Expected: all pass; `git status` shows only the new file.

- [ ] **Step 4: Check the links, then commit**

Run: `npm run check-links 2>&1 | tail -8`
Expected: only the known failures (`dev.mysql.com`, `nftables.org`); the new ElastiCache URL must pass.

```bash
git add content/cloud-design/aws-cache-before-the-sale.yaml
git commit -m "Add the AWS cache-before-the-sale canvas challenge

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Azure challenge `azure-cache-before-the-sale`

**Files:**
- Create: `content/cloud-design/azure-cache-before-the-sale.yaml`

**Interfaces:**
- Consumes (Tasks 1, 2): as Task 3.
- Produces: a published Azure canvas challenge. Its cache part is **regional** (lane `r1`), with five tests (no `cache-failure`).

- [ ] **Step 1: Read the Azure page and confirm every cache sentence**

Read (WebFetch) `https://learn.microsoft.com/en-us/azure/reliability/reliability-managed-redis`. Confirm, in your own words: (a) with high availability the cache has at least two nodes, placed in different availability zones in regions that have them; (b) zone redundancy reduces the risk that a zone outage makes the cache unavailable; (c) replication between nodes is asynchronous, so data not yet replicated to another zone can be lost in a zone failure; (d) failover to a healthy zone typically takes 10 to 15 seconds; (e) the page recommends designing for cache-aside, where the application keeps working with degraded performance by falling back to the primary data store when Redis is temporarily unavailable. Rewrite or drop any sentence the page does not support and record a `Ruling:` in the ledger. Do not borrow anything about Azure's cache from another cloud.

- [ ] **Step 2: Create the file**

Create `content/cloud-design/azure-cache-before-the-sale.yaml` (the first three source entries were read 2026-09-30 for the same services in `zone-resilient-checkout`; set the Managed Redis `retrieved` to the date you read it):

```yaml
# yaml-language-server: $schema=../../schemas/canvas.json
type: challenge
mode: canvas
id: azure-cache-before-the-sale
track: cloud-design
difficulty: 3
title: "Keep the database standing on sale day, on Azure"
provider: azure
par_minutes: 15

brief: |
  The shop's checkout works on a normal day. A sale doubles traffic, and every
  product page re-reads the same data from the database, so the database
  buckles even though the web tier has room to spare. You build the
  architecture in East US 2: keep the checkout up through the sale and through
  losing a zone, a web server or the database server.

requirements:
  - "Serve 2× normal traffic, even with one availability zone down"
  - "Keep the database within what it can read on a sale day: 1× normal reads"
  - "Keep accepting orders if either zone or the database server fails, losing none"
  - "Survive any single web server failing"
  - "Stay within 12 cost units per month"
budget: 12

layout:
  regions:
    - id: r1
      label: "East US 2"
      zones:
        - { id: r1-a, label: "Zone 1" }
        - { id: r1-b, label: "Zone 2" }

palette:
  - id: lb
    label: "Application Gateway v2"
    short: "App Gateway"
    scope: regional
    roles: [route]
    cost: 1
    facts:
      - "A regional layer-7 load balancer with autoscaling and zone redundancy."
      - "A zone-resilient load balancer with health checks can route traffic to VMs in healthy zones."
  - id: vm
    label: "Azure virtual machine (web, zonal)"
    short: "web"
    scope: zonal
    roles: [serve]
    capacity: 1
    cost: 1
    facts:
      - "A zonal VM is pinned to a single availability zone and isn't resilient to zone outages by itself."
      - "Each server handles 1× normal traffic (scenario number)."
  - id: db
    label: "Azure Database for PostgreSQL flexible server"
    short: "PostgreSQL"
    scope: zonal
    roles: [write-store]
    cost: 2
    facts:
      - "A server runs in one availability zone."
      - "High availability adds a standby server, billed like the primary, in the same zone (zonal HA) or another zone (zone-redundant HA)."
      - "On a sale day this database can read 1× normal traffic (scenario number)."
  - id: cache
    label: "Azure Managed Redis cache (high availability)"
    short: "Managed Redis"
    scope: regional
    roles: [cache]
    cost: 2
    facts:
      - "With high availability the cache has at least two nodes, and in a region with availability zones they sit in different zones. Zone redundancy reduces the risk that a zone outage makes the cache unavailable."
      - "Replication between the nodes is asynchronous, so data not yet copied to another zone can be lost in a zone failure. A failover to a healthy zone typically takes 10 to 15 seconds."
      - "While the cache is up it answers 9 in 10 reads (scenario number); the database sees the rest."

link_facts:
  sync:
    - "Like PostgreSQL high availability: a transaction isn't complete until both primary and standby acknowledge the write."
    - "Failover is automatic, typically within 60-120 seconds."
  async:
    - "Like a read replica: updated asynchronously, so it can lag the primary."
    - "Azure doesn't promote read replicas automatically."

stress_tests:
  - id: sale
    label: "A sale: 2× traffic"
    event: { none: true }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: zone-a
    label: "Zone 1 fails during the sale"
    event: { zone_outage: r1-a }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: zone-b
    label: "Zone 2 fails during the sale"
    event: { zone_outage: r1-b }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: vm-failure
    label: "Any one web server fails during the sale"
    event: { single_failure: vm }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: db-host
    label: "The database server fails during the sale"
    event: { single_failure: db }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }

reference_designs:
  - name: "Recommended"
    why: "Two web servers per zone keep 2× capacity after losing a zone; a standby in the other zone (zone-redundant HA) takes over writes. One high-availability cache, linked from every web server, spans the zones, so a zone outage does not remove it."
    design:
      nodes:
        - { id: lb, type: lb, lane: r1 }
        - { id: web-1, type: vm, lane: r1-a }
        - { id: web-2, type: vm, lane: r1-a }
        - { id: web-3, type: vm, lane: r1-b }
        - { id: web-4, type: vm, lane: r1-b }
        - { id: db-1, type: db, lane: r1-a }
        - { id: db-2, type: db, lane: r1-b }
        - { id: cache-1, type: cache, lane: r1 }
      edges:
        - { from: users, to: lb, kind: traffic }
        - { from: lb, to: web-1, kind: traffic }
        - { from: lb, to: web-2, kind: traffic }
        - { from: lb, to: web-3, kind: traffic }
        - { from: lb, to: web-4, kind: traffic }
        - { from: web-1, to: db-1, kind: traffic }
        - { from: web-2, to: db-1, kind: traffic }
        - { from: web-3, to: db-1, kind: traffic }
        - { from: web-4, to: db-1, kind: traffic }
        - { from: db-1, to: db-2, kind: sync }
        - { from: web-1, to: cache-1, kind: traffic }
        - { from: web-2, to: cache-1, kind: traffic }
        - { from: web-3, to: cache-1, kind: traffic }
        - { from: web-4, to: cache-1, kind: traffic }

counter_examples:
  - name: "No cache: every read goes to the database"
    fails: [sale, zone-a, zone-b, vm-failure, db-host]
    design:
      nodes:
        - { id: lb, type: lb, lane: r1 }
        - { id: web-1, type: vm, lane: r1-a }
        - { id: web-2, type: vm, lane: r1-a }
        - { id: web-3, type: vm, lane: r1-b }
        - { id: web-4, type: vm, lane: r1-b }
        - { id: db-1, type: db, lane: r1-a }
        - { id: db-2, type: db, lane: r1-b }
      edges:
        - { from: users, to: lb, kind: traffic }
        - { from: lb, to: web-1, kind: traffic }
        - { from: lb, to: web-2, kind: traffic }
        - { from: lb, to: web-3, kind: traffic }
        - { from: lb, to: web-4, kind: traffic }
        - { from: web-1, to: db-1, kind: traffic }
        - { from: web-2, to: db-1, kind: traffic }
        - { from: web-3, to: db-1, kind: traffic }
        - { from: web-4, to: db-1, kind: traffic }
        - { from: db-1, to: db-2, kind: sync }
  - name: "A cache that no web server reads from"
    fails: [sale, zone-a, zone-b, vm-failure, db-host]
    design:
      nodes:
        - { id: lb, type: lb, lane: r1 }
        - { id: web-1, type: vm, lane: r1-a }
        - { id: web-2, type: vm, lane: r1-a }
        - { id: web-3, type: vm, lane: r1-b }
        - { id: web-4, type: vm, lane: r1-b }
        - { id: db-1, type: db, lane: r1-a }
        - { id: db-2, type: db, lane: r1-b }
        - { id: cache-1, type: cache, lane: r1 }
      edges:
        - { from: users, to: lb, kind: traffic }
        - { from: lb, to: web-1, kind: traffic }
        - { from: lb, to: web-2, kind: traffic }
        - { from: lb, to: web-3, kind: traffic }
        - { from: lb, to: web-4, kind: traffic }
        - { from: web-1, to: db-1, kind: traffic }
        - { from: web-2, to: db-1, kind: traffic }
        - { from: web-3, to: db-1, kind: traffic }
        - { from: web-4, to: db-1, kind: traffic }
        - { from: db-1, to: db-2, kind: sync }
  - name: "The cache is linked from the Zone 1 web servers only"
    fails: [sale, zone-a, vm-failure, db-host]
    design:
      nodes:
        - { id: lb, type: lb, lane: r1 }
        - { id: web-1, type: vm, lane: r1-a }
        - { id: web-2, type: vm, lane: r1-a }
        - { id: web-3, type: vm, lane: r1-b }
        - { id: web-4, type: vm, lane: r1-b }
        - { id: db-1, type: db, lane: r1-a }
        - { id: db-2, type: db, lane: r1-b }
        - { id: cache-1, type: cache, lane: r1 }
      edges:
        - { from: users, to: lb, kind: traffic }
        - { from: lb, to: web-1, kind: traffic }
        - { from: lb, to: web-2, kind: traffic }
        - { from: lb, to: web-3, kind: traffic }
        - { from: lb, to: web-4, kind: traffic }
        - { from: web-1, to: db-1, kind: traffic }
        - { from: web-2, to: db-1, kind: traffic }
        - { from: web-3, to: db-1, kind: traffic }
        - { from: web-4, to: db-1, kind: traffic }
        - { from: db-1, to: db-2, kind: sync }
        - { from: web-1, to: cache-1, kind: traffic }
        - { from: web-2, to: cache-1, kind: traffic }

hints:
  nudge: "A normal day passes. What changes on a sale day, and who is doing all the reading?"
  direction: "Put something between the web servers and the database that answers repeat reads, and link every web server to it. Then check which servers still read from it after you lose a zone."
  answer: "Two web servers and a database with a zone-redundant standby as before, plus one Azure Managed Redis cache with high availability, linked from every web server."

analogy:
  title: "The reference desk"
  text: |
    A busy library answers the same questions all day. The librarian could walk
    to the stacks for every one, or keep the popular answers on a card at the
    desk and only walk to the stacks for the rest. On a quiet day nobody can
    tell the difference. On sale day the queue is out the door, and the
    librarian who has to fetch every answer from the stacks is the one who
    gives up first.

debrief:
  summary: |
    The database was fine on a normal day and failed on the sale because every
    page view read from it. A cache takes the repeated reads off the database:
    the application asks the cache first and only reads the database for what
    the cache does not have. Here, a live cache answers nine in ten reads, so
    the database sees a tenth of the load, but only for the web servers that
    are actually linked to it.

    Azure's documentation for Azure Managed Redis describes a high-availability
    cache whose nodes sit in different availability zones, so a zone outage does
    not remove it. Failover to a healthy zone typically takes 10 to 15 seconds,
    and data not yet replicated to another zone can be lost. The same page
    recommends designing for cache-aside: the application keeps working, with
    degraded performance, by falling back to the primary data store when Redis
    is briefly unavailable. That fallback is why the database still has to be
    able to take reads for a short time.

    The hit rate and the database's limit are scenario numbers, not
    measurements; real figures depend on the data and the traffic. This
    challenge does not model read replicas, active geo-replication, expiry and
    staleness, or writes.
  real_world: |
    Keep the shape safe as well as available: only the load balancer takes
    traffic from users, and the web servers, cache and database stay behind it.
    Resilience does not replace backups: keep automated backups with
    point-in-time restore on the database.

sources:
  - title: "Reliability in Azure Managed Redis"
    url: "https://learn.microsoft.com/en-us/azure/reliability/reliability-managed-redis"
    retrieved: 2026-10-28
  - title: "Reliability in Azure Database for PostgreSQL"
    url: "https://learn.microsoft.com/en-us/azure/reliability/reliability-database-postgresql"
    retrieved: 2026-09-30
  - title: "Reliability in Azure Virtual Machines"
    url: "https://learn.microsoft.com/en-us/azure/reliability/reliability-virtual-machines"
    retrieved: 2026-09-30
  - title: "What is Azure Application Gateway"
    url: "https://learn.microsoft.com/en-us/azure/application-gateway/overview"
    retrieved: 2026-09-30
```

- [ ] **Step 3: Run the content validation and the tests**

Run: `node -e "import('./vite-plugin-content.ts').then(m=>{try{m.loadContent('content');console.log('OK')}catch(e){console.log(e.message)}})"`
Expected: `OK`. Same rule as Task 3: fix the YAML, never edit a `fails` list to match a result you have not understood.

Then run: `npx tsc -b && npx oxlint && npm test && npm run schemas && git status --short`
Expected: all pass; only the new file in `git status`.

- [ ] **Step 4: Check the links, then commit**

Run: `npm run check-links 2>&1 | tail -8`
Expected: only the known failures.

```bash
git add content/cloud-design/azure-cache-before-the-sale.yaml
git commit -m "Add the Azure cache-before-the-sale canvas challenge

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Google Cloud challenge `gcp-cache-before-the-sale`

**Files:**
- Create: `content/cloud-design/gcp-cache-before-the-sale.yaml`
- Create: `tests/cache-challenges.test.ts` (covers all three challenges, so it lands once the third exists)

**Interfaces:**
- Consumes (Tasks 1, 2): as Task 3.
- Produces: a published Google Cloud canvas challenge. Its cache part is **zonal**, with six tests.

- [ ] **Step 1: Read the Google Cloud pages and confirm every cache sentence**

Read (WebFetch) `https://docs.cloud.google.com/memorystore/docs/redis/redis-tiers` and `https://docs.cloud.google.com/memorystore/docs/redis/high-availability-for-memorystore-for-redis`. Confirm, in your own words: (a) the Basic tier is a single node, in one zone, with no cross-zone replication; (b) the page's own description of what the Basic tier is suited to (the draft says an ephemeral cache); (c) what the pages say happens to a Basic-tier instance's data when its node or zone fails. If (c) is not stated, the `cache-failure` label below stays as written (it names the event, not a claim) and the debrief makes no claim about what happens to the data beyond (a) and (b). Rewrite or drop any sentence the pages do not support and record a `Ruling:` in the ledger. Do not borrow anything about Memorystore from another cloud.

- [ ] **Step 2: Create the file**

Create `content/cloud-design/gcp-cache-before-the-sale.yaml` (the last three source entries were read 2026-09-30 for the same services in `zone-resilient-checkout`; set the Memorystore `retrieved` dates to the dates you read them):

```yaml
# yaml-language-server: $schema=../../schemas/canvas.json
type: challenge
mode: canvas
id: gcp-cache-before-the-sale
track: cloud-design
difficulty: 3
title: "Keep the database standing on sale day, on Google Cloud"
provider: gcp
par_minutes: 15

brief: |
  The shop's checkout works on a normal day. A sale doubles traffic, and every
  product page re-reads the same data from the database, so the database
  buckles even though the web tier has room to spare. You build the
  architecture in us-central1: keep the checkout up through the sale, through
  losing a zone, a web server or the database server, and through losing a
  cache node.

requirements:
  - "Serve 2× normal traffic, even with one zone down"
  - "Keep the database within what it can read on a sale day: 1× normal reads"
  - "Keep accepting orders if either zone or the database server fails, losing none"
  - "Survive any single web server or cache node failing"
  - "Stay within 14 cost units per month"
budget: 14

layout:
  regions:
    - id: r1
      label: "us-central1"
      zones:
        - { id: r1-a, label: "us-central1-a" }
        - { id: r1-b, label: "us-central1-b" }

palette:
  - id: lb
    label: "Regional external Application Load Balancer"
    short: "Regional ALB"
    scope: regional
    roles: [route]
    cost: 1
    facts:
      - "Regional external Application Load Balancers support backends in a single region."
      - "Spread backends across zones so traffic can move to another zone if one fails."
  - id: vm
    label: "Compute Engine VM (web)"
    short: "web"
    scope: zonal
    roles: [serve]
    capacity: 1
    cost: 1
    facts:
      - "VM instances are zonal resources."
      - "Each server handles 1× normal traffic (scenario number)."
  - id: db
    label: "Cloud SQL for PostgreSQL instance"
    short: "Cloud SQL"
    scope: zonal
    roles: [write-store]
    cost: 2
    facts:
      - "An instance runs in one zone."
      - "High availability pairs a primary with a standby in a different zone."
      - "On a sale day this database can read 1× normal traffic (scenario number)."
  - id: cache
    label: "Memorystore for Redis (Basic tier)"
    short: "Memorystore"
    scope: zonal
    roles: [cache]
    cost: 2
    facts:
      - "On the Basic tier this is a single node in one zone with no cross-zone replication, suited to an ephemeral cache."
      - "While a linked cache is up it answers 9 in 10 reads (scenario number); the database sees the rest."

link_facts:
  sync:
    - "Like Cloud SQL high availability: writes reach both zones before they're confirmed."
    - "On failover, expect about 60 seconds of unavailability."
  async:
    - "Like a read replica: replicated asynchronously."
    - "It doesn't take over writes automatically."

stress_tests:
  - id: sale
    label: "A sale: 2× traffic"
    event: { none: true }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: zone-a
    label: "us-central1-a fails during the sale"
    event: { zone_outage: r1-a }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: zone-b
    label: "us-central1-b fails during the sale"
    event: { zone_outage: r1-b }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: vm-failure
    label: "Any one web server fails during the sale"
    event: { single_failure: vm }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: db-host
    label: "The database server fails during the sale"
    event: { single_failure: db }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
  - id: cache-failure
    label: "Any one cache node is lost during the sale"
    event: { single_failure: cache }
    check: { reach: [serve, write-store], capacity: 2, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }

reference_designs:
  - name: "Recommended"
    why: "Two web servers per zone keep 2× capacity after losing a zone; a standby in the other zone takes over writes. A Basic-tier cache in each zone, with every web server linked to both, leaves one cache shielding the database when a zone or a node is lost."
    design:
      nodes:
        - { id: lb, type: lb, lane: r1 }
        - { id: web-1, type: vm, lane: r1-a }
        - { id: web-2, type: vm, lane: r1-a }
        - { id: web-3, type: vm, lane: r1-b }
        - { id: web-4, type: vm, lane: r1-b }
        - { id: db-1, type: db, lane: r1-a }
        - { id: db-2, type: db, lane: r1-b }
        - { id: cache-1, type: cache, lane: r1-a }
        - { id: cache-2, type: cache, lane: r1-b }
      edges:
        - { from: users, to: lb, kind: traffic }
        - { from: lb, to: web-1, kind: traffic }
        - { from: lb, to: web-2, kind: traffic }
        - { from: lb, to: web-3, kind: traffic }
        - { from: lb, to: web-4, kind: traffic }
        - { from: web-1, to: db-1, kind: traffic }
        - { from: web-2, to: db-1, kind: traffic }
        - { from: web-3, to: db-1, kind: traffic }
        - { from: web-4, to: db-1, kind: traffic }
        - { from: db-1, to: db-2, kind: sync }
        - { from: web-1, to: cache-1, kind: traffic }
        - { from: web-2, to: cache-1, kind: traffic }
        - { from: web-3, to: cache-1, kind: traffic }
        - { from: web-4, to: cache-1, kind: traffic }
        - { from: web-1, to: cache-2, kind: traffic }
        - { from: web-2, to: cache-2, kind: traffic }
        - { from: web-3, to: cache-2, kind: traffic }
        - { from: web-4, to: cache-2, kind: traffic }

counter_examples:
  - name: "No cache: every read goes to the database"
    fails: [sale, zone-a, zone-b, vm-failure, db-host, cache-failure]
    design:
      nodes:
        - { id: lb, type: lb, lane: r1 }
        - { id: web-1, type: vm, lane: r1-a }
        - { id: web-2, type: vm, lane: r1-a }
        - { id: web-3, type: vm, lane: r1-b }
        - { id: web-4, type: vm, lane: r1-b }
        - { id: db-1, type: db, lane: r1-a }
        - { id: db-2, type: db, lane: r1-b }
      edges:
        - { from: users, to: lb, kind: traffic }
        - { from: lb, to: web-1, kind: traffic }
        - { from: lb, to: web-2, kind: traffic }
        - { from: lb, to: web-3, kind: traffic }
        - { from: lb, to: web-4, kind: traffic }
        - { from: web-1, to: db-1, kind: traffic }
        - { from: web-2, to: db-1, kind: traffic }
        - { from: web-3, to: db-1, kind: traffic }
        - { from: web-4, to: db-1, kind: traffic }
        - { from: db-1, to: db-2, kind: sync }
  - name: "Caches that no web server reads from"
    fails: [sale, zone-a, zone-b, vm-failure, db-host, cache-failure]
    design:
      nodes:
        - { id: lb, type: lb, lane: r1 }
        - { id: web-1, type: vm, lane: r1-a }
        - { id: web-2, type: vm, lane: r1-a }
        - { id: web-3, type: vm, lane: r1-b }
        - { id: web-4, type: vm, lane: r1-b }
        - { id: db-1, type: db, lane: r1-a }
        - { id: db-2, type: db, lane: r1-b }
        - { id: cache-1, type: cache, lane: r1-a }
        - { id: cache-2, type: cache, lane: r1-b }
      edges:
        - { from: users, to: lb, kind: traffic }
        - { from: lb, to: web-1, kind: traffic }
        - { from: lb, to: web-2, kind: traffic }
        - { from: lb, to: web-3, kind: traffic }
        - { from: lb, to: web-4, kind: traffic }
        - { from: web-1, to: db-1, kind: traffic }
        - { from: web-2, to: db-1, kind: traffic }
        - { from: web-3, to: db-1, kind: traffic }
        - { from: web-4, to: db-1, kind: traffic }
        - { from: db-1, to: db-2, kind: sync }
  - name: "One cache node in one zone"
    fails: [zone-a, cache-failure]
    design:
      nodes:
        - { id: lb, type: lb, lane: r1 }
        - { id: web-1, type: vm, lane: r1-a }
        - { id: web-2, type: vm, lane: r1-a }
        - { id: web-3, type: vm, lane: r1-b }
        - { id: web-4, type: vm, lane: r1-b }
        - { id: db-1, type: db, lane: r1-a }
        - { id: db-2, type: db, lane: r1-b }
        - { id: cache-1, type: cache, lane: r1-a }
      edges:
        - { from: users, to: lb, kind: traffic }
        - { from: lb, to: web-1, kind: traffic }
        - { from: lb, to: web-2, kind: traffic }
        - { from: lb, to: web-3, kind: traffic }
        - { from: lb, to: web-4, kind: traffic }
        - { from: web-1, to: db-1, kind: traffic }
        - { from: web-2, to: db-1, kind: traffic }
        - { from: web-3, to: db-1, kind: traffic }
        - { from: web-4, to: db-1, kind: traffic }
        - { from: db-1, to: db-2, kind: sync }
        - { from: web-1, to: cache-1, kind: traffic }
        - { from: web-2, to: cache-1, kind: traffic }
        - { from: web-3, to: cache-1, kind: traffic }
        - { from: web-4, to: cache-1, kind: traffic }

hints:
  nudge: "A normal day passes. What changes on a sale day, and who is doing all the reading?"
  direction: "Put something between the web servers and the database that answers repeat reads, link the web servers to it, then ask what happens to the database when that something is gone."
  answer: "Two web servers and a database with a standby in the other zone as before, plus a Memorystore Basic-tier cache in each zone with every web server linked to both."

analogy:
  title: "The reference desk"
  text: |
    A busy library answers the same questions all day. The librarian could walk
    to the stacks for every one, or keep the popular answers on a card at the
    desk and only walk to the stacks for the rest. On a quiet day nobody can
    tell the difference. On sale day the queue is out the door, and the
    librarian who has to fetch every answer from the stacks is the one who
    gives up first. If the desk cards get thrown out mid-rush, everyone is
    back to the stacks at once.

debrief:
  summary: |
    The database was fine on a normal day and failed on the sale because every
    page view read from it. A cache takes the repeated reads off the database:
    the application asks the cache first and only reads the database for what
    the cache does not have. Here, a live cache answers nine in ten reads, so
    the database sees a tenth of the load.

    A Memorystore for Redis Basic-tier instance is a single node in one zone
    with no cross-zone replication, which Google describes as suited to an
    ephemeral cache: treat its contents as disposable. Put a cache in each zone
    and link every web server to both, and losing one zone or one node leaves
    the other still shielding the database.

    The hit rate and the database's limit are scenario numbers, not
    measurements; real figures depend on the data and the traffic. This
    challenge does not model the Standard tier's replica, read replicas, expiry
    and staleness, or writes.
  real_world: |
    Keep the shape safe as well as available: only the load balancer takes
    traffic from users, and the web servers, caches and database stay behind
    it. Resilience does not replace backups: keep automated backups with
    point-in-time recovery on the database.

sources:
  - title: "Redis tier capabilities"
    url: "https://docs.cloud.google.com/memorystore/docs/redis/redis-tiers"
    retrieved: 2026-10-28
  - title: "High availability for Memorystore for Redis"
    url: "https://docs.cloud.google.com/memorystore/docs/redis/high-availability-for-memorystore-for-redis"
    retrieved: 2026-10-28
  - title: "Compute Engine: Regions and zones"
    url: "https://docs.cloud.google.com/compute/docs/regions-zones"
    retrieved: 2026-09-30
  - title: "Cloud Load Balancing overview"
    url: "https://docs.cloud.google.com/load-balancing/docs/load-balancing-overview"
    retrieved: 2026-09-30
  - title: "Cloud SQL for PostgreSQL: High availability"
    url: "https://docs.cloud.google.com/sql/docs/postgres/high-availability"
    retrieved: 2026-09-30
```

- [ ] **Step 3: Run the content validation and the tests**

Run: `node -e "import('./vite-plugin-content.ts').then(m=>{try{m.loadContent('content');console.log('OK')}catch(e){console.log(e.message)}})"`
Expected: `OK`. Same rule as Task 3.

Then run: `npx tsc -b && npx oxlint && npm test && npm run schemas && git status --short`
Expected: all pass; only the new file in `git status`.

- [ ] **Step 4: Add the content test for all three challenges**

Create `tests/cache-challenges.test.ts`:

```ts
// The three cache-before-the-sale challenges: each cloud's cache is modelled from that
// cloud's own documentation, so the scope differs, and so do the tests.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const get = (id: string) => canvases.find((x) => x.id === id)!

const shape = {
  aws: { id: 'aws-cache-before-the-sale', scope: 'zonal', tests: ['sale', 'zone-a', 'zone-b', 'vm-failure', 'db-host', 'cache-failure'] },
  azure: { id: 'azure-cache-before-the-sale', scope: 'regional', tests: ['sale', 'zone-a', 'zone-b', 'vm-failure', 'db-host'] },
  gcp: { id: 'gcp-cache-before-the-sale', scope: 'zonal', tests: ['sale', 'zone-a', 'zone-b', 'vm-failure', 'db-host', 'cache-failure'] },
} as const

for (const [provider, want] of Object.entries(shape))
  describe(`${provider} cache-before-the-sale`, () => {
    const c = get(want.id)
    const cache = c.palette.find((p) => p.id === 'cache')!

    it('is that cloud\'s challenge, in the cloud design track', () => {
      expect(c.provider).toBe(provider)
      expect(c.track).toBe('cloud-design')
    })
    it(`models its cache as a ${want.scope} part with the cache role alone`, () => {
      expect(cache.scope).toBe(want.scope)
      expect(cache.roles).toEqual(['cache'])
    })
    it('has the tests that cloud\'s documented behavior supports, all judging read load', () => {
      expect(c.stress_tests.map((t) => t.id)).toEqual(want.tests)
      c.stress_tests.forEach((t) => expect(t.check.read_load).toEqual({ traffic: 2, hit: 0.9, db_capacity: 1 }))
    })
    it('lists only its own cloud\'s documentation', () => {
      const host = { aws: 'docs.aws.amazon.com', azure: 'learn.microsoft.com', gcp: 'docs.cloud.google.com' }[provider]!
      c.sources.forEach((s) => expect(new URL(s.url).host).toBe(host))
    })
  })
```

Run: `npx vitest run tests/cache-challenges.test.ts`
Expected: PASS (reference designs and counter-examples are already proven by the build-time check in Step 3).

- [ ] **Step 5: Check the links, then commit**

Run: `npm run check-links 2>&1 | tail -8`
Expected: only the known failures.

```bash
git add content/cloud-design/gcp-cache-before-the-sale.yaml tests/cache-challenges.test.ts
git commit -m "Add the Google Cloud cache-before-the-sale canvas challenge and the cache challenge tests

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: whole-branch verification (controller, not an implementer)

**Files:** none changed unless a check fails.

- [ ] **Step 1:** `npx tsc -b && npx oxlint && npm test && npm run schemas && git status --short`. Expected: clean, suite green, schemas fresh.
- [ ] **Step 2:** `npm run check-links 2>&1 | tail -8`. Expected: only `dev.mysql.com` and `nftables.org`.
- [ ] **Step 3:** Whole-branch review by the most capable model, with the Review Focus list above and the ledger's `Ruling:` lines. Fix Critical and Important findings in one pass, each with a failing test first.
- [ ] **Step 4:** Browser pass with the Chrome extension: `npm run dev`; seed local progress (test data in the dev origin) so Cloud System Design unlocks; for each of the three challenges play the plain checkout, see the sale test fail with the read-load reason, add a cache, link it, rerun, then lose a zone (and, on AWS and Google Cloud, a cache node). Confirm a pre-existing canvas challenge still behaves as before. Clear the seeded progress and stop the dev server afterwards.
- [ ] **Step 5:** Report to the user; push, PR and merge only when asked.
