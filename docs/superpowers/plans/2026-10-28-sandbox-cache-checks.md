# Sandbox Cache Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The design sandbox judges the database's read load once a design contains a cache, so a learner can practise the cache lesson freely, with no score.

**Architecture:** The three sandbox cache parts change from role `neutral` to `cache`. The sandbox check generator (`src/game/sandbox.ts`) adds the existing engine `read_load` field to every check when the design has a cache, a web server and a database; otherwise a cache stays inert and is treated exactly as a neutral part is today. The cycle-1 engine rule is reused unchanged. The sandbox screen explains the scenario numbers.

**Tech Stack:** TypeScript, Zod, Vitest, React (Testing Library), YAML content.

**Spec:** `docs/superpowers/specs/2026-10-28-sandbox-cache-checks-design.md`

## Global Constraints

- Provider docs are the only source of truth for each cloud. A capability, scope or failure behavior documented for one cloud is never assumed for another. A fact a cited page does not state is not in the content. Wording is our own, never copied from docs or exam questions. Cite every claim to a page that *states* it (not one that implies it), with the page's real current title and URL, `retrieved: 2026-10-28`.
- Scenario numbers: `READ_HIT = 0.9`, `DB_READS = 1`, reads judged at `SPIKE` (3x). They are scenario numbers, not provider facts, and the learner is told so.
- A design with no cache, or with a cache but no web server or no database, gets byte-for-byte the checks and results it gets today.
- Cache part scopes do not change: AWS ElastiCache node `zonal`, Azure Managed Redis `regional`, Google Cloud Memorystore for Redis node `zonal`. SQS, CDN and storage parts stay `[neutral]`.
- A sandbox file's extra palette parts have roles exactly `[neutral]` or exactly `[cache]`.
- The three cycle-1 challenge files in `content/cloud-design/` are not modified.
- Code, commits and docs are written normally. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. `rm` and `cp` are interactive on this machine: use `rm -f` and `cp -f`. Shell is zsh.
- Validation commands: `npx tsc -b`, `npx oxlint`, `npm test`, `npm run check-links` (known pre-existing external failures: `dev.mysql.com` 403 and `nftables.org` timeouts), `npm run schemas` (then `git status --short` must show only intended files), and `node -e "import('./vite-plugin-content.ts').then(m=>{try{m.loadContent('content');console.log('OK')}catch(e){console.log(e.message)}})"` must print `OK`.

## Review Focus

Input classes the spec implies that no single task's happy path exercises. Each has a test in the task that owns the code:

1. A design with no cache: checks and results identical to before (Task 2, `no cache`).
2. A cache linked from only some web servers: only those are shielded and the reason names the others (Task 2, `partial links`).
3. The only cache sits in a zone or region no other part occupies, and is lost with it (Task 2, `a cache alone in its zone`).
4. A cache but no database, or no web server: inert, results identical to the same design without it (Task 2, `inert cache`).
5. A cache linked only from the database, or reached straight from users: shields nothing, with the cycle-1 reason (Task 2, `direction`).
6. A sandbox file whose extra part has `[cache, neutral]`, `[serve]`, or an empty role list: refused with a message naming the allowed roles (Task 1).
7. A saved design that already contains a cache still opens (Task 2, `validateDesign`).

---

### Task 1: Allow the cache role in sandbox files

**Files:**
- Modify: `src/schema/sandbox.ts` (the roles check inside `superRefine`, and the `palette` comment)
- Modify: `tests/sandbox-roles.test.ts`
- Regenerate: `schemas/sandbox.json` (via `npm run schemas`)

**Interfaces:**
- Consumes: `CanvasChallengeSchema`'s palette item shape (`PaletteItemSchema`, roles array), `ROLES` containing `cache` (cycle 1).
- Produces: `SandboxSchema` accepts a palette part whose roles are exactly `['neutral']` or exactly `['cache']`; anything else is refused with a message that names both allowed roles. Later tasks' YAML relies on this.

- [ ] **Step 1: Write the failing tests**

Append to `tests/sandbox-roles.test.ts` (it already imports `fs`, `path`, `expect`, `it`, `checkRaw`; add the `SandboxSchema` import at the top):

```ts
import { SandboxSchema } from '../src/schema/sandbox.ts'

// The first palette part of the AWS sandbox (the queue) is rewritten with other role lists.
// checkRaw validates shape only, so nothing here runs the engine.
const sandboxWithRoles = (roles: string) => {
  const file = path.resolve(import.meta.dirname, '../content/sandbox/aws-sandbox.yaml')
  const raw = fs.readFileSync(file, 'utf8').replace('roles: [neutral]', `roles: ${roles}`)
  const errors: string[] = []
  const ok = checkRaw(raw, SandboxSchema, 'aws-sandbox', errors)
  return { ok, errors }
}

it('a sandbox file accepts an extra part with only the cache role', () => {
  const { ok, errors } = sandboxWithRoles('[cache]')
  expect(errors).toEqual([])
  expect(ok).toBeTruthy()
})

it.each([['[cache, neutral]'], ['[serve]'], ['[write-store]'], ['[route]'], ['[]']])('a sandbox file refuses an extra part with roles %s, naming the allowed roles', (roles) => {
  const { ok, errors } = sandboxWithRoles(roles)
  expect(ok).toBeUndefined()
  expect(errors.join(' ')).toMatch(/neutral or cache/)
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/sandbox-roles.test.ts`
Expected: FAIL. `[cache]` is refused ("roles must be [neutral]"), and the refusals do not match `/neutral or cache/`.

- [ ] **Step 3: Implement**

In `src/schema/sandbox.ts`, change the palette comment and the role check:

```ts
    palette: z.array(PaletteItemSchema).min(1), // extra parts: neutral (not judged yet) or cache (judged for database reads)
```

```ts
    f.palette.forEach((p, i) => {
      if (p.roles.length !== 1 || (p.roles[0] !== 'neutral' && p.roles[0] !== 'cache'))
        ctx.addIssue({ code: 'custom', message: 'sandbox parts are neutral or cache: roles must be [neutral] or [cache]', path: ['palette', i, 'roles'], input: f })
    })
```

- [ ] **Step 4: Regenerate the schemas**

Run: `npm run schemas`
Then: `git status --short`
Expected: only `src/schema/sandbox.ts`, `tests/sandbox-roles.test.ts` and `schemas/sandbox.json` changed. If `schemas/sandbox.json` does not change, that is fine (the check is a `superRefine`); do not hand-edit it.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/sandbox-roles.test.ts tests/sandbox-content.test.ts` then `npx tsc -b` and `npx oxlint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/schema/sandbox.ts tests/sandbox-roles.test.ts schemas
git commit -m "Allow the cache role on sandbox parts

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Judge read load in the sandbox checks

**Files:**
- Modify: `src/game/sandbox.ts`
- Modify: `tests/sandbox-engine.test.ts`

**Interfaces:**
- Consumes: the cycle-1 engine rule: a check with `read_load: { traffic, hit, db_capacity }` and `reach` containing both `serve` and `write-store`; role `cache`; `evaluateCanvas` unchanged.
- Produces: exports `READ_HIT` (0.9), `DB_READS` (1) and `readsJudged(c: SandboxChallenge, d: Design): boolean`. `sandboxChecks()` adds `read_load: { traffic: SPIKE, hit: READ_HIT, db_capacity: DB_READS }` to every check's `check` when `readsJudged`, suffixes non-spike labels with `, reads at 3×`, and treats a cache part as neutral when `!readsJudged`. Task 4's screen uses `readsJudged`, `SPIKE`, `READ_HIT`, `DB_READS`.

- [ ] **Step 1: Write the failing tests**

In `tests/sandbox-engine.test.ts`:

1. Add the cache part at the END of the inline `file.palette` array and update the import line and the merge test:

```ts
import { resolveSandbox, runCheck, sandboxChecks, validateDesign, readsJudged, SANDBOX_MAX_NODES, SPIKE, READ_HIT, DB_READS } from '../src/game/sandbox.ts'
```

```ts
    { id: 'elasticache', label: 'ElastiCache cache node', short: 'cache', scope: 'zonal', roles: ['cache'], capacity: 0, cost: 2, facts: ['A cache.'] },
```

```ts
    expect(c.palette.map((p) => p.id)).toEqual([...base.palette.map((p) => p.id), 'sqs', 'cdn', 'elasticache'])
```

2. Add this block after the `runCheck` describe (reuse `twoZone`, `node`, `traffic`, `outcome`, `c`):

```ts
describe('a cache judges the database, only when the design can be read-loaded', () => {
  // Two caches, one per zone, both linked from both web servers.
  const caches = [node('cache-1', 'elasticache', 'use1-az1'), node('cache-2', 'elasticache', 'use1-az2')]
  const linkAll = ['web-1', 'web-2'].flatMap((w) => ['cache-1', 'cache-2'].map((k) => traffic(w, k)))
  const cached: Design = { nodes: [...twoZone.nodes, ...caches], edges: [...twoZone.edges, ...linkAll] }
  const unlinked: Design = { nodes: [...twoZone.nodes, ...caches], edges: twoZone.edges }
  const reasons = (d: Design, id: string) => runCheck(c, d, id)!.reasons.join(' ')

  it('pins the scenario numbers and when reads are judged', () => {
    expect([READ_HIT, DB_READS, SPIKE]).toEqual([0.9, 1, 3])
    expect(readsJudged(c, cached)).toBe(true)
    expect(readsJudged(c, twoZone)).toBe(false) // no cache
    expect(readsJudged(c, { nodes: twoZone.nodes.filter((n) => n.type !== 'rds').concat(caches), edges: [] })).toBe(false) // no database
    expect(readsJudged(c, { nodes: twoZone.nodes.filter((n) => n.type !== 'ec2-web').concat(caches), edges: [] })).toBe(false) // no web server
  })

  it('no cache: no check carries read_load and the labels are untouched', () => {
    expect(sandboxChecks(c, twoZone).every((t) => !t.check.read_load)).toBe(true)
    expect(sandboxChecks(c, twoZone).every((t) => !/reads at/.test(t.label))).toBe(true)
  })

  it('a cache in each zone, every server linked to both, survives everything the same design survives, and losing any one cache', () => {
    expect(outcome(cached)).toEqual({
      'zone-use1-az1': true,
      'zone-use1-az2': true,
      'region-use1': false,
      'one-alb': false,
      'one-ec2-web': true,
      'one-rds': true,
      'one-elasticache': true,
      spike: true,
    })
  })

  it('every check carries spike-level reads and says so, except the spike which already says 3x', () => {
    const checks = sandboxChecks(c, cached)
    for (const t of checks) expect(t.check.read_load).toEqual({ traffic: SPIKE, hit: READ_HIT, db_capacity: DB_READS })
    for (const t of checks.filter((x) => x.id !== 'spike')) expect(t.label, t.id).toMatch(/, reads at 3×$/)
    expect(checks.find((t) => t.id === 'spike')!.label).toBe(`Traffic spike: ${SPIKE}× normal`)
    expect(checks.find((t) => t.id === 'spike')!.check.capacity).toBe(SPIKE)
  })

  it('unlinked caches shield nothing: every check fails and the reason names the web servers', () => {
    expect(Object.values(outcome(unlinked)).every((p) => !p)).toBe(true)
    expect(reasons(unlinked, 'spike')).toContain('rds-1 would see 3× normal reads but can take 1× (web-1, web-2 are not linked to a surviving cache).')
  })

  it('partial links: only the linked server is shielded and the reason names the other', () => {
    const partial: Design = { nodes: unlinked.nodes, edges: [...twoZone.edges, traffic('web-1', 'cache-1'), traffic('web-1', 'cache-2')] }
    expect(outcome(partial).spike).toBe(false)
    expect(reasons(partial, 'spike')).toMatch(/web-2 is not linked to a surviving cache/)
    expect(reasons(partial, 'spike')).not.toMatch(/web-1/)
  })

  it('losing the only cache fails, and a cache alone in its zone and region gets its own checks', () => {
    const lone: Design = {
      nodes: [...twoZone.nodes, node('cache-1', 'elasticache', 'usw2-az1')],
      edges: [...twoZone.edges, traffic('web-1', 'cache-1'), traffic('web-2', 'cache-1')],
    }
    const ids = sandboxChecks(c, lone).map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining(['zone-usw2-az1', 'region-usw2', 'one-elasticache']))
    for (const id of ['zone-usw2-az1', 'region-usw2', 'one-elasticache']) {
      expect(runCheck(c, lone, id)!.pass, id).toBe(false)
      expect(reasons(lone, id), id).toMatch(/cache-1 was lost/)
    }
    expect(outcome(lone)['zone-use1-az1']).toBe(true) // the cache lives in the other region
  })

  it('direction matters: a cache linked only from the database, or straight from users, shields nothing', () => {
    const fromDb: Design = { nodes: unlinked.nodes, edges: [...twoZone.edges, traffic('rds-1', 'cache-1')] }
    expect(reasons(fromDb, 'spike')).toMatch(/web-1, web-2 are not linked to a surviving cache/)
    const fromUsers: Design = { nodes: unlinked.nodes, edges: [...twoZone.edges, traffic('users', 'cache-1')] }
    expect(runCheck(c, fromUsers, 'spike')!.pass).toBe(false)
    expect(reasons(fromUsers, 'spike')).toMatch(/users connect straight to the cache/)
  })

  describe('an inert cache (no database, or no web server) changes nothing', () => {
    const noDb: Design = { nodes: [node('alb-1', 'alb', 'use1'), node('web-1', 'ec2-web', 'use1-az1')], edges: [traffic('users', 'alb-1'), traffic('alb-1', 'web-1')] }
    const noWeb: Design = { nodes: [node('rds-1', 'rds', 'use1-az1')], edges: [] }
    it.each([
      ['no database', noDb],
      ['no web server', noWeb],
    ])('%s', (_name, plain) => {
      const withCache: Design = { nodes: [...plain.nodes, node('cache-1', 'elasticache', 'use1-az2')], edges: [...plain.edges, ...(plain === noDb ? [traffic('web-1', 'cache-1')] : [])] }
      expect(sandboxChecks(c, withCache).map((t) => t.id)).toEqual(sandboxChecks(c, plain).map((t) => t.id)) // no zone check for the cache's zone, no one-elasticache
      expect(sandboxChecks(c, withCache).every((t) => !t.check.read_load)).toBe(true)
      expect(outcome(withCache)).toEqual(outcome(plain))
    })
  })

  it('a saved design that contains a cache still opens', () => {
    expect(validateDesign(c, cached)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/sandbox-engine.test.ts`
Expected: FAIL (`readsJudged`, `READ_HIT`, `DB_READS` are not exported; the merge test fails on the new part until the code lands).

- [ ] **Step 3: Implement**

In `src/game/sandbox.ts`:

1. Constants beside `SPIKE`:

```ts
export const SPIKE = 3 // the traffic-spike check: this many times normal traffic
export const READ_HIT = 0.9 // scenario number: the share of reads a live, linked cache answers
export const DB_READS = 1 // scenario number: the most reads the database can take, in multiples of normal
```

2. Replace `isNeutral`/`rolesOf` helpers and add `readsJudged`:

```ts
const rolesOf = (c: SandboxChallenge, type: string) => c.palette.find((p) => p.id === type)?.roles ?? []
const hasRole = (c: SandboxChallenge, d: Design, role: string) => d.nodes.some((n) => rolesOf(c, n.type).includes(role as never))

// Reads are judged only when the design has a cache, a web server and a database.
// Without all three a cache is inert: treated as a neutral part is, so such a
// design gets exactly the checks and results it always has.
export const readsJudged = (c: SandboxChallenge, d: Design) => hasRole(c, d, 'cache') && hasRole(c, d, 'serve') && hasRole(c, d, 'write-store')

const isNeutral = (c: SandboxChallenge, type: string, reads: boolean) => {
  const roles = rolesOf(c, type)
  return roles.length > 0 && roles.every((r) => r === 'neutral' || (r === 'cache' && !reads))
}
```

3. In `sandboxChecks`, compute `const reads = readsJudged(c, d)`, build `check` with the optional `read_load`, pass `reads` to `isNeutral`, use it for `occupied` and `judged`, suffix labels, and spread `check` into the spike:

```ts
export function sandboxChecks(c: SandboxChallenge, d: Design): CanvasTest[] {
  const has = (role: 'serve' | 'write-store') => hasRole(c, d, role)
  const reach = (['serve', 'write-store'] as const).filter(has)
  if (!reach.length) return []
  const reads = readsJudged(c, d)
  const check = { reach, ...(reads && { read_load: { traffic: SPIKE, hit: READ_HIT, db_capacity: DB_READS } }) }
  const note = reads ? `, reads at ${SPIKE}×` : ''
  const occupied = (lane: string) => d.nodes.some((n) => n.lane === lane && !isNeutral(c, n.type, reads)) // neutral parts don't make a zone worth testing
  const label = (type: string) => c.palette.find((p) => p.id === type)?.label ?? type
  const judged = [...new Set(d.nodes.filter((n) => !isNeutral(c, n.type, reads) && rolesOf(c, n.type).length > 0).map((n) => n.type))]
```

(keep the `tests` array as is, appending `${note}` to the three non-spike labels, e.g. `` label: `Lose ${z.label}${note}` ``, `` label: `Lose region ${r.label}${note}` ``, `` label: `Lose any one ${label(t)}${note}` ``), and the spike line becomes:

```ts
  if (has('serve')) tests.push({ id: 'spike', label: `Traffic spike: ${SPIKE}× normal`, event: { none: true }, check: { ...check, capacity: SPIKE } })
```

Note the `judged` filter must keep the old meaning (parts with a role other than neutral): the old code used `rolesOf(...).some((r) => r !== 'neutral')`. A part with no roles was therefore excluded by `some` on `[]`; the `length > 0` guard above preserves that.

4. In `withoutNeutral`, compute the flag and pass it:

```ts
function withoutNeutral(c: SandboxChallenge, d: Design): Design {
  const reads = readsJudged(c, d)
  const neutral = new Set(d.nodes.filter((n) => isNeutral(c, n.type, reads)).map((n) => n.id))
```

`runCheck` and `validateDesign` need no change. Make sure no other caller of the old two-argument `isNeutral` remains (`grep -n isNeutral src`).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/sandbox-engine.test.ts tests/sandbox-content.test.ts tests/sandbox-ui.test.tsx tests/sandbox-failures-ui.test.tsx` then `npx tsc -b` and `npx oxlint`
Expected: PASS, clean. The existing neutral-part tests must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/game/sandbox.ts tests/sandbox-engine.test.ts
git commit -m "Judge the database's read load in sandbox checks when a design has a cache

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Switch the three sandbox cache parts to the cache role, from each cloud's own docs

**Files:**
- Modify: `content/sandbox/aws-sandbox.yaml`, `content/sandbox/azure-sandbox.yaml`, `content/sandbox/gcp-sandbox.yaml` (only the cache part and the `sources` entries it relies on)
- Modify: `tests/sandbox-content.test.ts` (the shipped-files test now allows the cache part)
- Create: `tests/sandbox-cache-content.test.ts`

**Interfaces:**
- Consumes: Task 1 (the schema accepts `[cache]`), the cycle-1 challenge files `content/cloud-design/{aws,azure,gcp}-cache-before-the-sale.yaml` (their `sources` entries, titles and URLs are the reference for what each page is called).
- Produces: each sandbox's cache part has `roles: [cache]`, the unchanged scope, and facts that each stated by a cited page of that cloud.

- [ ] **Step 1: Read the pages and confirm every fact (research step; no code)**

Read the pages below yourself (WebFetch or WebSearch). For EVERY fact string of the three cache parts, decide: stated by the cited page / only implied / not on a cited page. Keep stated facts (reworded in our own words if they mirror the page closely); reword implied facts to what the page states; drop facts no cited page states. Do not carry a fact from one cloud to another. Write the findings to the task report.

- AWS: `https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/AutoFailover.html` (already cited) and `https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/RegionsAndAZs.html`. The cycle-1 review found that "a cache node runs in one Availability Zone" is stated by RegionsAndAZs ("Locating your nodes": you choose the zone for each node or let ElastiCache choose), not by AutoFailover.
- Google Cloud: `https://docs.cloud.google.com/memorystore/docs/redis/redis-tiers` ("Redis tier capabilities"), the "High availability for Memorystore for Redis" page already cited, and the "Create and manage Redis instances" page (you choose a region and zone for the instance). The cycle-1 review found that Google's pages do NOT say the Basic tier is "a single node in one zone"; they say one Redis node, no replication, no cross-zone replication, and that you choose a zone when you create an instance. Check, too, whether any page states that Standard-tier replication is asynchronous or that an acknowledged write can be lost on failover; if none does, drop that fact.
- Azure: "Reliability in Azure Managed Redis" (`https://learn.microsoft.com/en-us/azure/reliability/reliability-managed-redis`, already cited). Re-check each Azure cache fact (retirement of Azure Cache for Redis and the Managed Redis recommendation; at least two nodes in different zones with high availability; asynchronous replication and possible loss of data not yet copied; failover timing; region outage needing active geo-replication). Change a fact only if a cited page does not state it.

- [ ] **Step 2: Write the failing tests**

Create `tests/sandbox-cache-content.test.ts`:

```ts
// The sandbox's cache parts: judged (role cache), the right scope for each cloud's
// service, explained, and sourced only from that cloud's own documentation.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'

const { sandboxes } = loadContent(path.resolve(import.meta.dirname, '../content'))
const host = (url: string) => new URL(url).hostname

// Scope follows each service as its own documentation describes it.
const expected = {
  aws: { scope: 'zonal', hosts: ['docs.aws.amazon.com'] },
  azure: { scope: 'regional', hosts: ['learn.microsoft.com'] },
  gcp: { scope: 'zonal', hosts: ['cloud.google.com', 'docs.cloud.google.com'] },
} as const

describe.each(sandboxes.map((s) => [s.provider, s] as const))('%s sandbox cache part', (provider, s) => {
  const want = expected[provider as keyof typeof expected]
  const part = s.palette.find((p) => p.roles.includes('cache'))

  it('exists, carries only the cache role, has the cloud-specific scope and explains itself', () => {
    expect(part, 'a cache part').toBeDefined()
    expect(part!.roles).toEqual(['cache'])
    expect(part!.scope).toBe(want.scope)
    expect(part!.facts.length).toBeGreaterThan(0)
  })

  it('is the only judged part: every other extra part is neutral', () => {
    for (const p of s.palette.filter((x) => x !== part)) expect(p.roles, p.id).toEqual(['neutral'])
  })

  it("cites only this cloud's own documentation", () => {
    for (const src of s.sources) expect(want.hosts, src.url).toContain(host(src.url))
  })
})
```

In `tests/sandbox-content.test.ts`, change the shipped-files test: the header comment, the test title and the `extras` assertions so a cache part is allowed:

```ts
// The shipped sandbox files: they resolve against their canvas challenge, only
// add neutral or cache parts, and every part explains itself.
```

```ts
  it.each(content.sandboxes.map((s) => [s.id, s] as const))('%s: extends a same-cloud canvas and adds only explained neutral or cache parts', (_id, s) => {
```

```ts
    const extras = s.palette.filter((p) => p.roles.includes('neutral') || p.roles.includes('cache'))
    expect(extras.length).toBeGreaterThanOrEqual(3)
    for (const p of extras) {
      expect(['neutral', 'cache'], p.id).toContain(p.roles[0])
      expect(p.roles, p.id).toHaveLength(1)
      expect(p.facts.length, p.id).toBeGreaterThan(0)
    }
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run tests/sandbox-cache-content.test.ts tests/sandbox-content.test.ts`
Expected: FAIL (the cache parts are still `[neutral]`).

- [ ] **Step 4: Edit the three YAML files**

In each file, change the cache part's `roles: [neutral]` to `roles: [cache]`, and replace the cache part's `facts` with the findings from Step 1. Starting points (use only what Step 1 confirmed; reword so they are not near-verbatim copies of a page):

- AWS: first fact "Each cache node is placed in one Availability Zone, chosen by you or by ElastiCache." Keep the Multi-AZ replica and failover facts only as far as the AutoFailover page states them. Add this source (copy title and URL from `content/cloud-design/aws-cache-before-the-sale.yaml`, `retrieved: 2026-10-28`):

```yaml
  - title: "Choosing regions and availability zones for ElastiCache"
    url: "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/RegionsAndAZs.html"
    retrieved: 2026-10-28
```

- Google Cloud: first fact along the lines of "On the Basic tier this is one Redis node with no replication, so no cross-zone replication; you choose its zone when you create it. Google describes it as an ephemeral cache. The Standard tier adds a replica and automatic failover." Add the "Create and manage Redis instances" page to `sources` if a fact relies on it (copy title and URL from `content/cloud-design/gcp-cache-before-the-sale.yaml`, `retrieved: 2026-10-28`).
- Azure: change only what Step 1 found unstated.

For every source you add or whose fact you re-checked, set `retrieved: 2026-10-28`.

- [ ] **Step 5: Run the validation**

Run: `npx vitest run tests/sandbox-cache-content.test.ts tests/sandbox-content.test.ts tests/sandbox-engine.test.ts`, then `npx tsc -b`, `npx oxlint`, `npm test`, `npm run schemas` (`git status --short` shows only the intended files), the `loadContent` one-liner (prints `OK`), and `npm run check-links` (known failures only).
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add content/sandbox tests/sandbox-content.test.ts tests/sandbox-cache-content.test.ts
git commit -m "Make the sandbox cache parts judged, with facts each cloud's docs state

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Explain the cache checks on the sandbox screen

**Files:**
- Modify: `src/screens/SandboxScreen.tsx`
- Modify: `tests/sandbox-ui.test.tsx`

**Interfaces:**
- Consumes: Task 2's `readsJudged`, `SPIKE`, `READ_HIT`, `DB_READS` from `src/game/sandbox.ts`; Task 3's AWS sandbox (the part `ElastiCache cache node` has role `cache`).
- Produces: the user-visible notes under the check result.

- [ ] **Step 1: Write the failing tests**

Append to `tests/sandbox-ui.test.tsx` (it already has `add`, `link`, `create`, `open`):

```ts
it('says caches are judged once the design has a web server and a database, and states the scenario numbers', async () => {
  render(<App />)
  open()
  await screen.findByRole('heading', { name: 'Design sandbox' })
  await create('Cache', 'aws')

  // Only a cache: inert, with a note saying what it needs.
  add('ElastiCache cache node', 'use1-az1')
  expect(screen.getByText(/A cache is judged once the design has a web server and a database/)).toBeTruthy()
  expect(screen.queryByText(/scenario numbers/)).toBeNull()
  expect(screen.queryByText(/aren't judged by these checks/)).toBeNull() // no queue, CDN or storage in the design

  // With a web server and a database, reads are judged and the numbers are stated.
  add('EC2 web server', 'use1-az1')
  add('RDS for PostgreSQL DB instance', 'use1-az1')
  expect(screen.queryByText(/A cache is judged once/)).toBeNull()
  expect(screen.getByText(/Reads are judged at 3× normal/)).toBeTruthy()
  expect(screen.getByText(/answers 9 in 10/)).toBeTruthy()
  expect(screen.getByText(/can read 1× normal/)).toBeTruthy()
  expect(screen.getByText(/scenario numbers, not measurements/)).toBeTruthy()
})

it('the neutral-parts note no longer lists caches', async () => {
  render(<App />)
  open()
  await screen.findByRole('heading', { name: 'Design sandbox' })
  await create('Queue', 'aws')
  add('Amazon SQS queue', 'use1')
  expect(screen.getByText(/Queues, CDNs and object storage aren't judged by these checks yet/)).toBeTruthy()
  expect(screen.queryByText(/Queues, caches/)).toBeNull()
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/sandbox-ui.test.tsx`
Expected: FAIL (the old note text still mentions caches; no cache notes exist).

- [ ] **Step 3: Implement**

In `src/screens/SandboxScreen.tsx`: change the import on line 6 to `import { readsJudged, runCheck, sandboxChecks, SPIKE, READ_HIT, DB_READS, validateDesign } from '../game/sandbox.ts'`, and compute the flags next to `hasNeutral`:

```tsx
  const hasNeutral = design.nodes.some((n) => part(n.type)?.roles.includes('neutral'))
  const reads = readsJudged(c, design)
  const hasCache = design.nodes.some((n) => part(n.type)?.roles.includes('cache'))
```

Replace the neutral note and add the two cache notes, in the same place:

```tsx
              {hasNeutral && (
                <p className="mt-3 text-xs text-muted">
                  Queues, CDNs and object storage aren't judged by these checks yet. A link through one is treated as a direct link to what's behind it.
                </p>
              )}
              {reads && (
                <p className="mt-3 text-xs text-muted">
                  Reads are judged at {SPIKE}× normal. A cache that is up and linked from a web server answers {Math.round(READ_HIT * 10)} in 10 of that server's reads; the database can read {DB_READS}× normal. These are scenario numbers, not measurements.
                </p>
              )}
              {hasCache && !reads && (
                <p className="mt-3 text-xs text-muted">A cache is judged once the design has a web server and a database.</p>
              )}
```


- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/sandbox-ui.test.tsx tests/sandbox-failures-ui.test.tsx` then `npx tsc -b`, `npx oxlint`, `npm test`.
Expected: all PASS, clean. The existing "says neutral parts are not judged" test must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/screens/SandboxScreen.tsx tests/sandbox-ui.test.tsx
git commit -m "Explain the sandbox's cache checks and their scenario numbers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Whole-branch verification (controller)

**Files:** none (verification only; fixes go back to an implementer).

- [ ] **Step 1:** Run the full validation: `npx tsc -b`, `npx oxlint`, `npm test`, `npm run schemas` (`git status --short` clean), the `loadContent` one-liner, `npm run check-links` (known failures only).
- [ ] **Step 2:** Final whole-branch review by the most capable model, with the Review Focus list above and the ledger's `Ruling:` lines, and a provider-facts check of the three sandbox cache parts against their cited pages. Fix Critical and Important findings in one pass, each with a failing test first.
- [ ] **Step 3:** Browser pass with the Chrome extension: start the dev server and stop it by its own PID afterwards. For each of the three sandboxes: create a design, build a checkout (load balancer, two web servers across two zones, a database with a standby), add a cache, see the "cache but unlinked" read-load reason, link every web server, rerun, lose a zone, lose one cache; confirm the scenario-numbers note appears and the inert-cache note shows with only a cache; confirm a design with no cache runs exactly as before, and that reloading keeps the design. Clear any seeded test data and close the tab afterwards.
- [ ] **Step 4:** Report to the user; push, PR and merge only when asked.
