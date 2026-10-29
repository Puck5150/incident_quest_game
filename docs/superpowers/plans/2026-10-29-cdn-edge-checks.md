# CDN and edge caching in the design sandbox: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Judge CDN and edge caching in the design sandbox on all three clouds, each modelled the way its own docs describe it: a per-part caching setting, a new `edge_load` check rule, three cloud-specific part sets, and the screen to drive them.

**Architecture:** The canvas schema gains an optional per-part `caching` setting and a per-node `caching` choice; a check can carry an opt-in `edge_load: {share, hit}` that discounts web-server capacity only when every reachable web server sits behind an active edge. The sandbox file schema allows `[route]` extra parts and `overlays` that add a caching setting to an inherited part. `sandboxChecks()` adds `edge_load` to the spike check when the design has a caching-capable part and a web server. Content, then screen, follow.

**Tech Stack:** TypeScript, Zod, React, Vitest, YAML content.

**Spec:** `docs/superpowers/specs/2026-10-29-cdn-edge-checks-design.md`. Read it first. The research behind it (per-cloud findings files) is in the session scratchpad and may not exist for you; the content tasks (3, 4, 5) therefore carry their own source list and require you to fetch each page yourself.

## Global Constraints

- **Provider docs are the only source of truth.** Each cloud's own documentation is the only source for that cloud. A capability, scope, default or failure behavior documented for one cloud is never assumed for another. If a cited page does not state a fact, it is not in the content. "Slop is forbidden."
- All fact wording is in our own words: never near-verbatim. Name a pattern only by the term the cited page uses. Cite a claim only to a page that states it, with the page's real title and URL, `retrieved: 2026-10-29`. Do not explain the same flow twice in one part.
- Scenario numbers are not provider facts: `EDGE_SHARE = 0.5` (share of requests that are cacheable GETs) and `EDGE_HIT = 0.9` (share of those a live caching edge answers). The screen says they are scenario numbers.
- An edge discounts **web-server capacity only**. `read_load` is unchanged (no docs say a CDN shields the database).
- The discount applies only when every web server reachable from users is reachable only through an active edge. An active edge is a node whose part has `caching`, which is not lost, and whose effective caching is on (`node.caching ?? part.caching.default`).
- Roles for sandbox extra parts: exactly `[neutral]`, `[cache]` or `[route]`. Refusal message: `sandbox parts are neutral, cache or route: roles must be [neutral], [cache] or [route]`.
- A `caching` setting only applies to a part with the `route` role. Schema message: `caching only applies to a part with the route role`.
- Designs with no caching-capable part: checks, labels and results byte-for-byte as before. Saved designs without `caching` load unchanged.
- The cycle-1 and cycle-2 challenge files and the scored canvas files under `content/cloud-design/` are not touched. No scoring change.
- Shell is zsh: `rm` and `cp` are interactive, so use `rm -f` and `cp -f`. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push.
- Validation commands: `npx tsc -b`, `npx oxlint`, `npm test`, `npm run schemas` (then `git status --short` must show only intended files), and `node -e "import('./vite-plugin-content.ts').then(m=>{try{m.loadContent('content');console.log('OK')}catch(e){console.log(e.message)}})"` must print `OK`.

## Review Focus

Inputs a happy path would not exercise (the spec's list; each is pinned by a test in the task that owns the code):

1. A design with no caching-capable part: checks and results identical to before (Tasks 1, 2).
2. A caching part with caching off (Front Door and Google defaults, or CloudFront switched off): no discount, and the spike reason says why (Task 1).
3. Users linked both to the edge and straight to a load balancer: no discount; the reason names the bypassed server (Task 1).
4. The only edge lost: users are cut off; reachability reasons plus the "was lost" reason (Task 1).
5. Azure: Traffic Manager linked to Front Door and Application Gateway: losing Front Door leaves the second path, and the spike gets no discount (Tasks 2, 4).
6. A caching part but no web server: no `edge_load`, results unchanged (Task 2).
7. Google: the regional load balancer has no caching setting, the global one does; a saved design holding the removed `cloud-cdn` part shows the not-in-palette message and can still be exported (Tasks 5, 6).
8. A sandbox file with a `[route, neutral]` or `[serve]` extra, or an overlay for an unknown id, an already-cached part or a non-route part: refused with a clear message (Task 2).
9. A saved design from before this change still opens, except item 7 (Tasks 2, 6).
10. A design with both a cache and an edge keeps both rules independent (Task 2).
11. Export, import and reload keep a node's `caching` choice; `sandboxStore.readDesign` rebuilds nodes field by field and must carry it (Task 2).

---

### Task 1: Schema and engine: the caching setting and `edge_load`

**Files:**
- Modify: `src/schema/canvas.ts` (palette item, node, check, refinements)
- Modify: `src/game/canvas.ts` (the capacity block of `check()`)
- Create: `tests/edge-load-schema.test.ts`, `tests/canvas-edge-load.test.ts`
- Regenerate: `schemas/*.json` via `npm run schemas`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `CachingSchema` (exported from `src/schema/canvas.ts`: `{ label: string, default: boolean, facts: string[] }`); `PaletteItem.caching?`; `Design.nodes[].caching?: boolean`; `check.edge_load?: { share: number, hit: number }` (both strictly between 0 and 1, requires `capacity` and `serve` in `reach`); engine behavior described in Global Constraints.

- [ ] **Step 1: Write the failing schema tests**

Create `tests/edge-load-schema.test.ts`:

```ts
// The caching setting on a route part, the per-node caching choice and the opt-in
// edge_load check field: what the canvas schema accepts and refuses.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { CanvasChallengeSchema, DesignSchema } from '../src/schema/canvas.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const base = canvases.find((x) => x.id === 'aws-checkout-canvas')!
const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? [] : r.error!.issues.map((i) => i.message))

const withCheck = (check: unknown) => {
  const c = structuredClone(base) as Record<string, unknown> & { stress_tests: { check: unknown }[] }
  c.stress_tests[0].check = check
  return CanvasChallengeSchema.safeParse(c)
}
const both = ['serve', 'write-store']
const el = { share: 0.5, hit: 0.9 }

describe('edge_load', () => {
  it('is accepted with serve and capacity', () => {
    expect(withCheck({ reach: both, capacity: 3, edge_load: el }).success).toBe(true)
    expect(withCheck({ reach: ['serve'], capacity: 3, edge_load: el }).success).toBe(true)
  })

  it('is optional: a check without it is unchanged', () => {
    expect(withCheck({ reach: both, capacity: 3 }).success).toBe(true)
  })

  it('is refused without capacity or without serve in reach', () => {
    expect(messages(withCheck({ reach: both, edge_load: el }))).toContain('edge_load needs capacity and serve in reach')
    expect(messages(withCheck({ reach: ['write-store'], capacity: 3, edge_load: el }))).toContain('edge_load needs capacity and serve in reach')
  })

  it('refuses a share or hit outside (0, 1)', () => {
    for (const bad of [{ ...el, share: 0 }, { ...el, share: 1 }, { ...el, hit: 0 }, { ...el, hit: 1.2 }])
      expect(withCheck({ reach: both, capacity: 3, edge_load: bad }).success).toBe(false)
  })

  it('refuses unknown keys', () => {
    expect(withCheck({ reach: both, capacity: 3, edge_load: { ...el, extra: 1 } }).success).toBe(false)
  })
})

describe('the caching setting on a palette part', () => {
  const caching = { label: 'Caching', default: true, facts: ['A fact.'] }
  const withPart = (id: string, patch: object) => {
    const c = structuredClone(base)
    c.palette = c.palette.map((p) => (p.id === id ? { ...p, ...patch } : p))
    return CanvasChallengeSchema.safeParse(c)
  }

  it('is accepted on a route part', () => {
    expect(withPart('alb', { caching }).success).toBe(true)
  })

  it('is refused on a part without the route role', () => {
    expect(messages(withPart('ec2-web', { caching }))).toContain('caching only applies to a part with the route role')
  })

  it('needs a label, a default and at least one fact', () => {
    expect(withPart('alb', { caching: { ...caching, facts: [] } }).success).toBe(false)
    expect(withPart('alb', { caching: { label: 'Caching', facts: ['x'] } }).success).toBe(false)
    expect(withPart('alb', { caching: { ...caching, label: '' } }).success).toBe(false)
  })
})

describe('the per-node caching choice', () => {
  const node = { id: 'a', type: 'alb', lane: 'use1' }
  it('is optional and boolean', () => {
    expect(DesignSchema.safeParse({ nodes: [node], edges: [] }).success).toBe(true)
    expect(DesignSchema.safeParse({ nodes: [{ ...node, caching: false }], edges: [] }).success).toBe(true)
    expect(DesignSchema.safeParse({ nodes: [{ ...node, caching: 'yes' }], edges: [] }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/edge-load-schema.test.ts`
Expected: FAIL (the new fields are unknown to the schema).

- [ ] **Step 3: Implement the schema**

In `src/schema/canvas.ts`:

1. Above `PaletteItemSchema`, add and export:

```ts
// A route part may offer a caching setting (a CDN-style edge). `default` is whether it is on when the
// part is placed; each cloud's docs decide what a learner has to switch on.
export const CachingSchema = z.strictObject({
  label: z.string().min(1), // what the cloud calls the setting, e.g. "Cloud CDN"
  default: z.boolean(),
  facts: z.array(z.string().min(1)).min(1),
})
```

2. In `PaletteItemSchema`, after `public`, add: `caching: CachingSchema.optional(),`

3. Change `NodeSchema` to `z.strictObject({ id, type: id, lane: id, caching: z.boolean().optional() })`.

4. In `CheckSchema`, after `read_load`, add:

```ts
    // Opt-in: a live, caching edge answers `share` of the requests it can (cacheable GETs) at rate `hit`,
    // so the web servers carry less of the spike. Applies only when every web server sits behind such an edge.
    edge_load: z
      .strictObject({ share: z.number().gt(0).lt(1), hit: z.number().gt(0).lt(1) })
      .optional(),
```

   and in its `superRefine`, after the `read_load` rule:

```ts
    if (k.edge_load && !(k.capacity !== undefined && k.reach.includes('serve')))
      ctx.addIssue({ code: 'custom', message: 'edge_load needs capacity and serve in reach', path: ['edge_load'], input: k })
```

5. In `CanvasChallengeSchema`'s `superRefine`, inside the `c.palette.forEach` that already checks `public` and `cache`, add:

```ts
      if (p.caching && !p.roles.includes('route')) issue('caching only applies to a part with the route role', ['palette', i, 'caching'])
```

- [ ] **Step 4: Run the schema tests**

Run: `npx vitest run tests/edge-load-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing engine tests**

Create `tests/canvas-edge-load.test.ts`:

```ts
// The opt-in edge_load rule: a live, caching edge answers part of the traffic before it
// reaches the web servers, but only when every reachable web server sits behind one.
// Uses the real AWS canvas palette plus a test edge part and hand-built checks.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { evaluateCanvas } from '../src/game/canvas.ts'
import type { CanvasChallenge, Design } from '../src/schema/canvas.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const base = canvases.find((x) => x.id === 'aws-checkout-canvas')!

const reach = ['serve', 'write-store'] as ('serve' | 'write-store')[]
const edgeLoad = { share: 0.5, hit: 0.9 }
const c: CanvasChallenge = {
  ...base,
  palette: [
    ...base.palette,
    {
      id: 'edge',
      label: 'Edge',
      short: 'edge',
      scope: 'global',
      roles: ['route'],
      capacity: 0,
      cost: 2,
      facts: ['A test edge.'],
      caching: { label: 'Caching', default: true, facts: ['A test setting.'] },
    },
  ],
  stress_tests: [
    { id: 'spike', label: 'Spike', event: { none: true }, check: { reach, capacity: 6, edge_load: edgeLoad } },
    { id: 'plain', label: 'Plain', event: { none: true }, check: { reach, capacity: 6 } },
    { id: 'edge-failure', label: 'Edge', event: { single_failure: 'edge' }, check: { reach, capacity: 6, edge_load: edgeLoad } },
  ],
}

const T = (from: string, to: string) => ({ from, to, kind: 'traffic' as const })
const web = (id: string, lane = 'use1-az1') => ({ id, type: 'ec2-web', lane })
// users -> edge -> alb -> web(s) -> db
const behindEdge = (webs: string[], edge: Partial<Design['nodes'][number]> = {}): Design => ({
  nodes: [{ id: 'edge-1', type: 'edge', lane: 'global', ...edge }, { id: 'alb', type: 'alb', lane: 'use1' }, ...webs.map((w) => web(w)), { id: 'db-1', type: 'rds', lane: 'use1-az1' }],
  edges: [T('users', 'edge-1'), T('edge-1', 'alb'), ...webs.flatMap((w) => [T('alb', w), T(w, 'db-1')])],
})
const noEdge = (webs: string[]): Design => ({
  nodes: [{ id: 'alb', type: 'alb', lane: 'use1' }, ...webs.map((w) => web(w)), { id: 'db-1', type: 'rds', lane: 'use1-az1' }],
  edges: [T('users', 'alb'), ...webs.flatMap((w) => [T('alb', w), T(w, 'db-1')])],
})
const run = (d: Design) => Object.fromEntries(evaluateCanvas(c, d).tests.map((t) => [t.id, t]))

describe('edge_load', () => {
  it('with no caching-capable part the check is exactly as before', () => {
    const r = run(noEdge(['web-1', 'web-2']))
    expect(r.spike.pass).toBe(false)
    expect(r.spike.reasons).toEqual(['only 4× of the 6× traffic needed can be served (web-1, web-2).'])
    expect(r.spike.reasons).toEqual(r.plain.reasons)
  })

  it('a live caching edge in front of every server lowers what the servers must carry', () => {
    const r = run(behindEdge(['web-1', 'web-2']))
    expect(r.spike.pass).toBe(true) // 6x x (1 - 0.45) = 3.3x, and two servers carry 4x
    expect(r.plain.pass).toBe(false) // the same design without edge_load still needs the full 6x
  })

  it('and a design that is still short says how much it needed after the edge', () => {
    const r = run(behindEdge(['web-1']))
    expect(r.spike.pass).toBe(false)
    expect(r.spike.reasons).toEqual(['only 2× of the 3.3× traffic needed (6× minus the 45% that the edge answers) can be served (web-1).'])
  })

  it('caching switched off on the edge gives no discount and says so', () => {
    const r = run(behindEdge(['web-1', 'web-2'], { caching: false }))
    expect(r.spike.pass).toBe(false)
    expect(r.spike.reasons).toEqual(['only 4× of the 6× traffic needed can be served (web-1, web-2).', 'caching is off on edge-1.'])
  })

  it('a link from users straight to the load balancer bypasses the edge: no discount, and the reason names the servers', () => {
    const d = behindEdge(['web-1', 'web-2'])
    d.edges.push(T('users', 'alb'))
    const r = run(d)
    expect(r.spike.pass).toBe(false)
    expect(r.spike.reasons).toEqual(['only 4× of the 6× traffic needed can be served (web-1, web-2).', 'users can also reach web-1, web-2 without passing edge-1.'])
  })

  it('losing the only edge cuts users off: the reachability reasons and the edge is named as lost', () => {
    const r = run(behindEdge(['web-1', 'web-2']))['edge-failure']
    expect(r.pass).toBe(false)
    const text = r.reasons.join(' ')
    expect(text).toContain('no surviving web server is connected to users.')
    expect(text).toContain("edge-1 was lost, so it can't answer requests.")
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run tests/canvas-edge-load.test.ts`
Expected: FAIL (the discount and reasons do not exist yet; the first test may already pass).

- [ ] **Step 7: Implement the engine rule**

In `src/game/canvas.ts`, inside `check()`:

1. Just before the `if (t.check.capacity !== undefined) {` block, add:

```ts
  // Opt-in (check.edge_load): a live, caching edge answers part of the traffic before it reaches the web
  // servers. The discount applies only when every reachable web server sits behind an active edge; a server
  // users can also reach without passing one (a direct link, a second entry path) gets none.
  const edgeEffect = (el: { share: number; hit: number }) => {
    const capable = d.nodes.filter((n) => type(n.id)?.caching)
    if (!capable.length) return undefined
    const on = (n: Node) => n.caching ?? type(n.id)!.caching!.default
    const active = capable.filter((n) => on(n) && !removed.has(n.id))
    const why: string[] = []
    for (const n of capable) {
      if (removed.has(n.id)) why.push(`${n.id} was lost, so it can't answer requests.`)
      else if (!on(n)) why.push(`caching is off on ${n.id}.`)
    }
    const skip = new Set(active.map((n) => n.id))
    const around = new Set<string>([USERS])
    for (let grew = true; grew; ) {
      grew = false
      for (const e of traffic) {
        if (around.has(e.from) && alive(e.to) && !skip.has(e.to) && !around.has(e.to)) {
          around.add(e.to)
          grew = true
        }
      }
    }
    const reached = d.nodes.filter((n) => has(n, 'serve') && reachable.has(n.id))
    const open = reached.filter((n) => around.has(n.id)).map((n) => n.id)
    if (active.length && open.length) why.push(`users can also reach ${open.join(', ')} without passing ${active.map((n) => n.id).join(', ')}.`)
    const covered = active.length > 0 && reached.length > 0 && !open.length
    return { factor: covered ? 1 - el.share * el.hit : 1, pct: Math.round(el.share * el.hit * 100), why }
  }
```

2. Replace the body of the capacity block (from `const cap = ...` onward) so that it reads:

```ts
    const cap = serving.reduce((sum, n) => sum + (c.palette.find((p) => p.id === n.type)?.capacity ?? 0), 0)
    const edge = t.check.edge_load ? edgeEffect(t.check.edge_load) : undefined
    const needed = t.check.capacity * (edge?.factor ?? 1)
    if (cap < needed - 1e-9) {
      const answered = edge && edge.factor < 1 ? ` (${fmt(t.check.capacity)}× minus the ${edge.pct}% that the edge answers)` : ''
      reasons.push(
        cap === 0
          ? `no serving capacity survives; ${fmt(needed)}× is needed${answered}.`
          : `only ${cap}× of the ${fmt(needed)}× traffic needed${answered} can be served (${serving.map((n) => n.id).join(', ')}).`,
      )
      if (unlinked.length) reasons.push(`${unlinked.join(', ')} can't reach the database, so they don't count as serving capacity.`)
      if (edge) reasons.push(...edge.why)
    }
```

   Keep the existing `const { reached, serving } = serversThatCount()` and `const unlinked = ...` lines above `cap`. Existing messages for checks without `edge_load` must stay byte-for-byte (`fmt(3)` prints `3`).

- [ ] **Step 8: Run the engine tests, then everything**

Run: `npx vitest run tests/canvas-edge-load.test.ts tests/edge-load-schema.test.ts`
Expected: PASS.
Run: `npm run schemas && git status --short` — expected: the schema files that mention palette items, nodes and checks changed (`schemas/canvas.json`, `schemas/sandbox.json`, and any that embed the canvas schema); nothing else.
Run: `npx tsc -b && npx oxlint && npm test` — expected: clean and all pass.

- [ ] **Step 9: Commit**

```bash
git add src/schema/canvas.ts src/game/canvas.ts tests/edge-load-schema.test.ts tests/canvas-edge-load.test.ts schemas
git commit -m "Add the caching setting and the edge_load check rule

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Sandbox glue: roles, overlays, checks, store, editing rule

**Files:**
- Modify: `src/schema/sandbox.ts` (allowed roles, `overlays`)
- Modify: `src/game/sandbox.ts` (constants, `edgeJudged`, `resolveSandbox` overlays, spike `edge_load`)
- Modify: `src/game/sandboxStore.ts` (`readDesign` keeps `caching`)
- Modify: `src/game/canvasEdit.ts` (`setCaching`)
- Modify: `AUTHORING.md` (the "Sandbox files" paragraph), `tests/sandbox-roles.test.ts`, `tests/sandbox-engine.test.ts`
- Create or modify: the existing sandbox-store test file (find it: `grep -l sandboxStore tests/*`), and the existing canvas-edit test file (`grep -l canvasEdit tests/*`)
- Regenerate: `schemas/sandbox.json`

**Interfaces:**
- Consumes: Task 1 (`CachingSchema`, `caching`, `edge_load`).
- Produces: `EDGE_SHARE`, `EDGE_HIT`, `edgeJudged(c: SandboxChallenge, d: Design): boolean` from `src/game/sandbox.ts`; `setCaching(d: Design, id: string, on: boolean): Design` from `src/game/canvasEdit.ts`; sandbox files may declare `overlays: [{ id, caching }]` and extra parts with roles `[neutral]`, `[cache]` or `[route]`.

- [ ] **Step 1: Write the failing tests**

In `tests/sandbox-roles.test.ts`:
- Replace the header comment's first two lines to say `neutral` is the role for parts the checks do not judge yet (queues, object storage), caches have `cache`, and entry points (CloudFront, Traffic Manager, a global load balancer) have `route`.
- Replace the final `it.each` (and the test just above it) with:

```ts
it('a sandbox file accepts an extra part with only the route role', () => {
  const { ok, errors } = sandboxWithRoles('[route]')
  expect(errors).toEqual([])
  expect(ok).toBeTruthy()
})

it.each([['[cache, neutral]'], ['[route, neutral]'], ['[serve]'], ['[write-store]'], ['[]']])('a sandbox file refuses an extra part with roles %s, naming the allowed roles', (roles) => {
  const { ok, errors } = sandboxWithRoles(roles)
  expect(ok).toBeUndefined()
  expect(errors.join(' ')).toMatch(/neutral, cache or route/)
})

it('a sandbox file accepts an overlay that adds a caching setting to an inherited part, and refuses unknown keys in it', () => {
  const file = path.resolve(import.meta.dirname, '../content/sandbox/aws-sandbox.yaml')
  const raw = fs.readFileSync(file, 'utf8')
  const overlay = (extra: string) => `${raw}\noverlays:\n  - id: alb\n    caching: { label: Caching, default: false, facts: ["A fact."] }${extra}\n`
  const errors: string[] = []
  expect(checkRaw(overlay(''), SandboxSchema, 'aws-sandbox', errors)).toBeTruthy()
  expect(errors).toEqual([])
  expect(checkRaw(overlay('\n    extra: 1'), SandboxSchema, 'aws-sandbox', [])).toBeUndefined()
})
```

(The existing `[cache]` test and the `[neutral]` baseline stay as they are.)

In `tests/sandbox-engine.test.ts`: import `edgeJudged, EDGE_SHARE, EDGE_HIT` with the other sandbox imports; add to the inline `file.palette`, after the `elasticache` part:

```ts
    { id: 'edge', label: 'Edge', short: 'edge', scope: 'global', roles: ['route'], capacity: 0, cost: 2, facts: ['An edge.'], caching: { label: 'Caching', default: true, facts: ['Caches.'] } },
```

and append these tests at the end of the file (the file already defines `c`, `node`, `traffic`, `twoZone`, `oneZone`, `outcome` and `runCheck`/`sandboxChecks` imports; reuse them):

```ts
describe('an edge judges the traffic spike only when the design has a caching part and a web server', () => {
  const edgeIn = (webs: string[], extra: Design['edges'] = []): Design => ({
    nodes: [node('edge-1', 'edge', 'global'), node('alb-1', 'alb', 'use1'), ...webs.map((w) => node(w, 'ec2-web', 'use1-az1')), node('rds-1', 'rds', 'use1-az1')],
    edges: [traffic('users', 'edge-1'), traffic('edge-1', 'alb-1'), ...webs.flatMap((w) => [traffic('alb-1', w), traffic(w, 'rds-1')]), ...extra],
  })
  const spike = (d: Design) => sandboxChecks(c, d).find((t) => t.id === 'spike')!

  it('pins the scenario numbers', () => {
    expect(EDGE_SHARE).toBe(0.5)
    expect(EDGE_HIT).toBe(0.9)
  })

  it('edgeJudged needs a caching part and a web server', () => {
    expect(edgeJudged(c, twoZone)).toBe(false)
    expect(edgeJudged(c, { nodes: [node('edge-1', 'edge', 'global')], edges: [] })).toBe(false)
    expect(edgeJudged(c, edgeIn(['web-1']))).toBe(true)
  })

  it('only the spike check carries edge_load, and its label does not change', () => {
    const checks = sandboxChecks(c, edgeIn(['web-1']))
    expect(checks.filter((t) => t.check.edge_load).map((t) => t.id)).toEqual(['spike'])
    expect(spike(edgeIn(['web-1'])).check.edge_load).toEqual({ share: EDGE_SHARE, hit: EDGE_HIT })
    expect(spike(edgeIn(['web-1'])).label).toBe('Traffic spike: 3× normal')
  })

  it('a design with no caching part gets exactly the checks it always got', () => {
    expect(spike(twoZone).check).toEqual({ reach: ['serve', 'write-store'], capacity: SPIKE })
  })

  it('an edge in front of one web server lets it survive the spike; without one it does not', () => {
    expect(runCheck(c, edgeIn(['web-1']), 'spike')!.pass).toBe(true) // 3x x 0.55 = 1.65x, one server carries 2x
    expect(runCheck(c, { ...oneZone }, 'spike')!.pass).toBe(false) // 3x on one 2x server
  })

  it('a bypass link means no discount', () => {
    const r = runCheck(c, edgeIn(['web-1'], [traffic('users', 'alb-1')]), 'spike')!
    expect(r.pass).toBe(false)
    expect(r.reasons.join(' ')).toContain('users can also reach web-1 without passing edge-1.')
  })

  it('an edge is a global route part: it gets a "Lose any one" check and no zone or region check of its own', () => {
    const ids = sandboxChecks(c, edgeIn(['web-1'])).map((t) => t.id)
    expect(ids).toContain('one-edge')
    expect(ids).not.toContain('zone-global')
    expect(runCheck(c, edgeIn(['web-1']), 'one-edge')!.pass).toBe(false) // it is the only way in
  })

  it('a caching part with no web server adds no edge_load', () => {
    const d: Design = { nodes: [node('edge-1', 'edge', 'global'), node('rds-1', 'rds', 'use1-az1')], edges: [] }
    expect(sandboxChecks(c, d).some((t) => t.check.edge_load)).toBe(false)
  })

  it('keeps the cache rule independent: a design with both still judges reads', () => {
    const d = edgeIn(['web-1'])
    d.nodes.push(node('cache-1', 'elasticache', 'use1-az1'))
    d.edges.push(traffic('web-1', 'cache-1'))
    const checks = sandboxChecks(c, d)
    expect(checks.every((t) => t.check.read_load)).toBe(true)
    expect(spike(d).check.edge_load).toBeDefined()
  })

  it('saved designs without a caching choice still validate', () => {
    expect(validateDesign(c, edgeIn(['web-1']))).toBeUndefined()
  })
})

describe('overlays', () => {
  const overlay = { id: 'alb', caching: { label: 'Caching', default: false, facts: ['A fact.'] } }
  it('add a caching setting to an inherited route part', () => {
    const r = resolveSandbox({ ...file, overlays: [overlay] }, base)
    if (typeof r === 'string') throw new Error(r)
    expect(r.palette.find((p) => p.id === 'alb')!.caching).toEqual(overlay.caching)
    expect(base.palette.find((p) => p.id === 'alb')!.caching).toBeUndefined() // the base is not mutated
  })

  it('are refused for an unknown part, a repeated part, a part that already has a setting, or a part that is not a route', () => {
    expect(resolveSandbox({ ...file, overlays: [{ ...overlay, id: 'nope' }] }, base)).toMatch(/"nope".*not in/)
    expect(resolveSandbox({ ...file, overlays: [overlay, overlay] }, base)).toMatch(/more than once/)
    const cached = { ...base, palette: base.palette.map((p) => (p.id === 'alb' ? { ...p, caching: overlay.caching } : p)) }
    expect(resolveSandbox({ ...file, overlays: [overlay] }, cached)).toMatch(/already has a caching setting/)
    expect(resolveSandbox({ ...file, overlays: [{ ...overlay, id: 'ec2-web' }] }, base)).toMatch(/isn't a route part/)
  })
})
```

In the sandbox-store test file, add (follow that file's existing imports and helper style):

```ts
it('keeps a boolean caching choice on a node and drops anything else', () => {
  // Use the file's existing way of feeding raw data through the read path (readData / loadSandbox / import).
  // Build a saved design with nodes [{ id: 'edge-1', type: 'cloudfront', lane: 'global', caching: false },
  // { id: 'edge-2', type: 'cloudfront', lane: 'global', caching: 'yes' }, { id: 'a', type: 'alb', lane: 'use1' }]
  // and expect: edge-1.caching === false, edge-2 has no caching key, node 'a' has no caching key.
})
```

   Replace the comment body with real code in that file's style so the assertion runs (the three expectations in the comment are the test).

In the canvas-edit test file add:

```ts
it('setCaching sets one node, leaves the others, and does not mutate the design', () => {
  const d = { nodes: [{ id: 'a', type: 't', lane: 'global' }, { id: 'b', type: 't', lane: 'global' }], edges: [] }
  const next = setCaching(d, 'a', false)
  expect(next.nodes).toEqual([{ id: 'a', type: 't', lane: 'global', caching: false }, { id: 'b', type: 't', lane: 'global' }])
  expect(d.nodes[0]).toEqual({ id: 'a', type: 't', lane: 'global' })
})
```

(import `setCaching` from `../src/game/canvasEdit.ts`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/sandbox-roles.test.ts tests/sandbox-engine.test.ts` and the two other test files you edited.
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/schema/sandbox.ts`:
- Import `CachingSchema` from `./canvas.ts` (alongside `LayoutSchema`, `PaletteItemSchema`).
- Add to the strict object, after `palette`: `overlays: z.array(z.strictObject({ id, caching: CachingSchema })).optional(), // add a caching setting to an inherited route part`
- Change the palette comment to `extra parts: neutral (not judged yet), cache (judged for database reads) or route (an entry point, which may offer a caching setting)`.
- Replace the roles check with:

```ts
      const only = p.roles.length === 1 ? p.roles[0] : undefined
      if (only !== 'neutral' && only !== 'cache' && only !== 'route')
        ctx.addIssue({ code: 'custom', message: 'sandbox parts are neutral, cache or route: roles must be [neutral], [cache] or [route]', path: ['palette', i, 'roles'], input: f })
```

`src/game/sandbox.ts`:
- Beside `DB_READS` add:

```ts
export const EDGE_SHARE = 0.5 // scenario number: the share of requests that are cacheable GETs
export const EDGE_HIT = 0.9 // scenario number: the share of those a live, caching edge answers
```

- In `resolveSandbox`, after the `clash` check and before `return`, add:

```ts
  const overlays = f.overlays ?? []
  for (const [i, o] of overlays.entries()) {
    const p = base.palette.find((x) => x.id === o.id)
    if (!p) return `overlay "${o.id}" is not in ${base.id}'s palette`
    if (overlays.findIndex((q) => q.id === o.id) !== i) return `overlay "${o.id}" appears more than once`
    if (p.caching) return `${o.id} already has a caching setting`
    if (!p.roles.includes('route')) return `${o.id} isn't a route part, so it can't have a caching setting`
  }
  const basePalette = base.palette.map((p) => {
    const o = overlays.find((x) => x.id === p.id)
    return o ? { ...p, caching: o.caching } : p
  })
```

  and use `palette: [...basePalette, ...f.palette]`.
- After `readsJudged`, add:

```ts
// The edge rule applies when the design has a part with a caching setting and a web server to relieve.
export const edgeJudged = (c: SandboxChallenge, d: Design) =>
  d.nodes.some((n) => c.palette.find((p) => p.id === n.type)?.caching) && hasRole(c, d, 'serve')
```

- In `sandboxChecks`, change the spike line to:

```ts
  if (has('serve'))
    tests.push({ id: 'spike', label: `Traffic spike: ${SPIKE}× normal`, event: { none: true }, check: { ...check, capacity: SPIKE, ...(edgeJudged(c, d) && { edge_load: { share: EDGE_SHARE, hit: EDGE_HIT } }) } })
```

`src/game/sandboxStore.ts`: in `readDesign`, replace the `nodes.push(...)` line so a boolean `caching` is kept and nothing else is:

```ts
    nodes.push({ id: n.id, type: n.type, lane: n.lane, ...(typeof n.caching === 'boolean' && { caching: n.caching }) })
```

`src/game/canvasEdit.ts`: add

```ts
export const setCaching = (d: Design, id: string, on: boolean): Design => ({
  ...d,
  nodes: d.nodes.map((n) => (n.id === id ? { ...n, caching: on } : n)),
})
```

`AUTHORING.md` "Sandbox files": replace "may add only parts with `roles: [neutral]` (queue, object storage, CDN)" wording (it now reads: ...extra parts that are `roles: [neutral]` (queue, object storage, CDN) or `roles: [cache]` (the cache part, which carries no other role)) with: extra parts that are `roles: [neutral]` (queue, object storage), `roles: [cache]` (the cache part, which carries no other role) or `roles: [route]` (an entry point such as a CDN or a DNS routing service; it may offer a caching setting). Add one sentence: a sandbox file may carry `overlays` to add a `caching` setting to a route part it inherits from the canvas, so the scored canvas is not edited. Keep the paragraph's style.

- [ ] **Step 4: Run**

Run: `npx vitest run tests/sandbox-roles.test.ts tests/sandbox-engine.test.ts` plus the store and edit test files; then `npm run schemas && git status --short` (only `schemas/sandbox.json` and sources/tests/AUTHORING.md changed), `npx tsc -b`, `npx oxlint`, `npm test`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A src tests AUTHORING.md schemas
git commit -m "Let sandbox files add route parts and caching overlays, and judge the spike with an edge

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: AWS: CloudFront as a global route part that caches by default

**Files:**
- Modify: `content/sandbox/aws-sandbox.yaml` (the `cloudfront` part and `sources`)
- Create: `tests/sandbox-edge-content.test.ts`
- Modify: `tests/sandbox-content.test.ts` (the shipped-files test accepts route extras)

**Interfaces:**
- Consumes: Tasks 1 and 2 (schema accepts `[route]` extras and `caching`).
- Produces: the AWS sandbox's `cloudfront` part: scope `global`, roles `[route]`, `caching: { label, default: true, facts }`; `tests/sandbox-edge-content.test.ts` (Tasks 4 and 5 add their cloud's block to it).

- [ ] **Step 1: Research (no code): confirm every fact from AWS's own pages**

Fetch each page below (WebFetch). For every fact string you will write, decide: stated by the cited page / only implied / not stated. Write only stated facts, in our own words. Write the findings (per fact: stated / implied / not stated, page) to the task report.

- What is Amazon CloudFront? `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html`
- How CloudFront delivers content `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HowCloudFrontWorks.html`
- Cache behavior settings `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html`
- Manage how long content stays in the cache (expiration) `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html`
- Request and response behavior for custom origins `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html`
- Use managed cache policies `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html`
- Resilience in Amazon CloudFront `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/disaster-recovery-resiliency.html`

The part must cover these topics (previous research found each stated; re-verify, and drop any you cannot find): CloudFront is a global service that serves from edge locations, with regional edge caches between those and the origin; only GET and HEAD responses are cached (OPTIONS if turned on), while POST, PUT, PATCH and DELETE are never cached and always reach the origin, so a checkout is not offloaded; without a cache policy the default time to live is 24 hours, so content caches by default; the CachingDisabled managed policy turns caching off (this is what the `caching` setting stands for). Do NOT state a hit ratio, an edge-failure mechanism, origin failover or serve-stale (docs for those are out of scope this cycle), and do not state anything from another cloud's CDN.

The existing `cloudfront` facts (a latency-routing sentence and a cache-miss sentence with "24 hours by default") predate this research: keep only what a cited page states, reworded.

- [ ] **Step 2: Write the failing tests**

Create `tests/sandbox-edge-content.test.ts`:

```ts
// The sandbox's edge parts, per cloud: the right role and scope for each cloud's service,
// the caching setting the cloud's own docs describe, and sources only from that cloud's docs.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'

const { sandboxes } = loadContent(path.resolve(import.meta.dirname, '../content'))
const sandbox = (provider: string) => sandboxes.find((s) => s.provider === provider)!
const part = (provider: string, id: string) => sandbox(provider).palette.find((p) => p.id === id)
const host = (url: string) => new URL(url).hostname

describe('aws', () => {
  const s = sandbox('aws')
  const p = part('aws', 'cloudfront')

  it('CloudFront is a global route part that caches by default', () => {
    expect(p, 'cloudfront').toBeDefined()
    expect(p!.roles).toEqual(['route'])
    expect(p!.scope).toBe('global')
    expect(p!.caching?.default).toBe(true)
    expect(p!.caching?.label).toBeTruthy()
    expect(p!.facts.length).toBeGreaterThan(0)
    expect(p!.caching!.facts.length).toBeGreaterThan(0)
  })

  it("cites only AWS's own documentation", () => {
    for (const src of s.sources) expect(['docs.aws.amazon.com'], src.url).toContain(host(src.url))
  })
})
```

In `tests/sandbox-content.test.ts`: update the header comment (`only add neutral, cache or route parts`), the `it.each` title (`... adds only explained neutral, cache or route parts`), and change

```ts
    const extras = s.palette.filter((p) => p.roles.includes('neutral') || p.roles.includes('cache'))
```
to
```ts
    const extras = s.palette.filter((p) => p.roles.includes('neutral') || p.roles.includes('cache') || p.roles.includes('route'))
```
and
```ts
      expect(['neutral', 'cache'], p.id).toContain(p.roles[0])
```
to
```ts
      expect(['neutral', 'cache', 'route'], p.id).toContain(p.roles[0])
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/sandbox-edge-content.test.ts`
Expected: FAIL (`cloudfront` is still neutral).

- [ ] **Step 4: Write the content**

In `content/sandbox/aws-sandbox.yaml`, change the `cloudfront` part: `roles: [route]`; keep `scope: global`, `cost: 2`, `label: "CloudFront distribution"`, `short: "CDN"`; replace `facts` with your researched, own-words facts about what the part is (not the caching setting); add

```yaml
    caching:
      label: "Caching"
      default: true
      facts:
        - "<own-words facts about the caching setting, each stated by a cited page>"
```

(replace the placeholder line with your real facts; the file must contain no placeholder text). Add to `sources` every page your facts rely on (real titles and the URLs above), each with `retrieved: 2026-10-29`; remove no source another fact still needs.

- [ ] **Step 5: Run everything**

Run: `npx vitest run tests/sandbox-edge-content.test.ts tests/sandbox-content.test.ts tests/sandbox-cache-content.test.ts`, then `npm run schemas && git status --short` (only intended files), the `loadContent` one-liner (must print `OK`), `npx tsc -b`, `npx oxlint`, `npm test`.
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add content/sandbox/aws-sandbox.yaml tests
git commit -m "Judge CloudFront in the AWS sandbox: a global route part that caches by default

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Azure: caching on Front Door, and Traffic Manager

**Files:**
- Modify: `content/sandbox/azure-sandbox.yaml` (an `overlays` entry, a `traffic-manager` part, `sources`)
- Modify: `tests/sandbox-edge-content.test.ts` (add the Azure block)

**Interfaces:**
- Consumes: Tasks 1 and 2 (overlays, `[route]` extras, `caching`).
- Produces: `front-door` with a caching setting (default `false`) via an overlay; a `traffic-manager` part, scope `global`, roles `[route]`.

- [ ] **Step 1: Research (no code): confirm every fact from Microsoft's own pages**

Fetch each page (WebFetch). For every fact string: stated / implied / not stated. Write only stated facts, in our own words. Record findings per fact in the task report. Also report what each page says about the default state of the "Enable caching" setting: if no page states the default, set `default: false` as a modelling choice, state NO default-state claim in any fact, and say so in the report.

- Azure Front Door Overview `https://learn.microsoft.com/en-us/azure/frontdoor/front-door-overview`
- Caching - Azure Front Door `https://learn.microsoft.com/en-us/azure/frontdoor/front-door-caching`
- Global Routing Redundancy for Mission-Critical Web Applications `https://learn.microsoft.com/en-us/azure/architecture/guide/networking/global-web-applications/overview`
- Mission-Critical Global HTTP Ingress `https://learn.microsoft.com/en-us/azure/architecture/guide/networking/global-web-applications/mission-critical-global-http-ingress`
- Architecture Best Practices for Azure Front Door - Microsoft Azure Well-Architected Framework `https://learn.microsoft.com/en-us/azure/well-architected/service-guides/azure-front-door`
- Azure Traffic Manager overview `https://learn.microsoft.com/en-us/azure/traffic-manager/traffic-manager-overview`
- How Azure Traffic Manager Works `https://learn.microsoft.com/en-us/azure/traffic-manager/traffic-manager-how-it-works`
- Reliability in Azure Traffic Manager `https://learn.microsoft.com/en-us/azure/reliability/reliability-traffic-manager`
- Azure Traffic Manager - FAQ `https://learn.microsoft.com/en-us/azure/traffic-manager/traffic-manager-faqs`
- Azure Traffic Manager endpoint monitoring `https://learn.microsoft.com/en-us/azure/traffic-manager/traffic-manager-monitoring`

Topics the overlay's caching facts must cover (previous research found each stated; re-verify, drop any you cannot find): caching is an "Enable caching" setting on a Front Door route (not a separate component); only GET responses are cached and other methods always go to the origin; anything not cached still goes through Front Door to the origin; Microsoft recommends separate routes for static and dynamic content with caching off on the dynamic one, and warns that caching authenticated or dynamic content risks serving one user's data to another. Topics the `front-door` facts the overlay cannot change stay as they are in the canvas; do not edit `content/cloud-design/`.

Topics the `traffic-manager` part must cover: it is a DNS-based service that answers lookups and is not in the request path (it is not a proxy or gateway), so it does no caching, WAF or TLS termination; it is one global service whose infrastructure Microsoft spreads across zones and regions; Front Door is documented as a possible single point of failure, and Microsoft's mission-critical guidance puts Traffic Manager in front of Front Door plus a second path, which loses Front Door's caching; failover through DNS is not instant (it depends on DNS caching and probe settings). Do NOT state an SLA percentage, a customer-chosen zone-redundant setting, that Front Door is an "Azure endpoint" type, a failover time, or anything about another cloud's DNS routing.

- [ ] **Step 2: Write the failing tests**

Append to `tests/sandbox-edge-content.test.ts`:

```ts
describe('azure', () => {
  const s = sandbox('azure')
  const fd = part('azure', 'front-door')
  const tm = part('azure', 'traffic-manager')

  it('Front Door carries a caching setting that is off to start, added by an overlay (the canvas part is untouched)', () => {
    expect(fd!.roles).toEqual(['route'])
    expect(fd!.scope).toBe('global')
    expect(fd!.caching?.default).toBe(false)
    expect(fd!.caching?.label).toBe('Enable caching')
    expect(fd!.caching!.facts.length).toBeGreaterThan(0)
  })

  it('Traffic Manager is a global route part with no caching setting of its own', () => {
    expect(tm, 'traffic-manager').toBeDefined()
    expect(tm!.roles).toEqual(['route'])
    expect(tm!.scope).toBe('global')
    expect(tm!.caching).toBeUndefined()
    expect(tm!.facts.length).toBeGreaterThan(0)
  })

  it("cites only Microsoft's own documentation", () => {
    for (const src of s.sources) expect(['learn.microsoft.com'], src.url).toContain(host(src.url))
  })
})
```

Run: `npx vitest run tests/sandbox-edge-content.test.ts` — Expected: FAIL for azure.

- [ ] **Step 3: Write the content**

In `content/sandbox/azure-sandbox.yaml`:
- After `layout:` and before `palette:`... place at the end of the file's top-level keys (after `palette`) an overlay:

```yaml
overlays:
  - id: front-door
    caching:
      label: "Enable caching"
      default: false
      facts:
        - "<own-words facts, each stated by a cited page>"
```

- Add to `palette` a part `id: traffic-manager`, `label: "Azure Traffic Manager profile"`, `short: "Traffic Manager"`, `scope: global`, `roles: [route]`, `cost: 1`, and your researched own-words `facts`.
- Add to `sources` every page the new facts rely on (real titles, URLs above), `retrieved: 2026-10-29`.
No placeholder text may remain.

- [ ] **Step 4: Run everything**

Run: `npx vitest run tests/sandbox-edge-content.test.ts tests/sandbox-content.test.ts tests/sandbox-cache-content.test.ts`; `npm run schemas && git status --short`; the `loadContent` one-liner (`OK`); `npx tsc -b`; `npx oxlint`; `npm test`.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add content/sandbox/azure-sandbox.yaml tests
git commit -m "Judge Azure edge caching: a caching setting on Front Door, and Traffic Manager

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Google Cloud: a global load balancer with Cloud CDN as a setting

**Files:**
- Modify: `content/sandbox/gcp-sandbox.yaml` (remove `cloud-cdn`, add `global-alb`, `sources`)
- Modify: `tests/sandbox-edge-content.test.ts` (add the Google block)

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: `global-alb` part (scope `global`, roles `[route]`, `caching: { label: "Cloud CDN", default: false, facts }`); the canvas `lb` part keeps no caching setting; the `cloud-cdn` part no longer exists.

- [ ] **Step 1: Research (no code): confirm every fact from Google's own pages**

Fetch each page (WebFetch). For every fact string: stated / implied / not stated. Write only stated facts, in our own words, and record findings in the task report. If no page states that Cloud CDN is off until enabled, set `default: false` as a modelling choice, make no default-state claim in any fact, and say so in the report.

- Cloud CDN overview `https://docs.cloud.google.com/cdn/docs/overview`
- Caching overview (Cloud CDN) `https://docs.cloud.google.com/cdn/docs/caching`
- Load balancer feature comparison `https://docs.cloud.google.com/load-balancing/docs/features`
- Request distribution for external Application Load Balancers `https://docs.cloud.google.com/load-balancing/docs/https/request-distribution`
- Application Load Balancer overview `https://docs.cloud.google.com/load-balancing/docs/application-load-balancer`
- External Application Load Balancer overview `https://docs.cloud.google.com/load-balancing/docs/https`

The `global-alb` part must cover: it is the global external Application Load Balancer; it can send traffic to healthy backends in another region when a region has none (Premium Tier; the regional external mode cannot); the canvas's regional load balancer part is a different, regional mode. The `caching` ("Cloud CDN") facts must cover: Cloud CDN is a setting on a backend of the global external or classic Application Load Balancer, not a separate hop (the cache lookup happens at the Google Front End that receives the request); cache lookups apply to GET and HEAD; a miss, or a response that cannot be cached, goes through the load balancer to the backend; HTML and JSON are not cached by default; Google's feature comparison lists Cloud CDN only for the global and classic modes. Do NOT state a hit ratio, an edge-capacity limit, serve-stale or origin failover (Media CDN only; out of scope), and do not state anything from another cloud's CDN. Do not claim any page says the regional external load balancer's backend services lack Cloud CDN unless a page states it: say only what the feature comparison lists.

- [ ] **Step 2: Write the failing tests**

Append to `tests/sandbox-edge-content.test.ts`:

```ts
describe('gcp', () => {
  const s = sandbox('gcp')
  const alb = part('gcp', 'global-alb')

  it('the global external load balancer is a global route part with a Cloud CDN setting that is off to start', () => {
    expect(alb, 'global-alb').toBeDefined()
    expect(alb!.roles).toEqual(['route'])
    expect(alb!.scope).toBe('global')
    expect(alb!.caching?.label).toBe('Cloud CDN')
    expect(alb!.caching?.default).toBe(false)
    expect(alb!.facts.length).toBeGreaterThan(0)
    expect(alb!.caching!.facts.length).toBeGreaterThan(0)
  })

  it('the regional load balancer has no CDN setting, and the standalone Cloud CDN part is gone', () => {
    expect(part('gcp', 'lb')!.caching).toBeUndefined()
    expect(part('gcp', 'cloud-cdn')).toBeUndefined()
  })

  it("cites only Google Cloud's own documentation", () => {
    for (const src of s.sources) expect(['cloud.google.com', 'docs.cloud.google.com'], src.url).toContain(host(src.url))
  })
})
```

Run: `npx vitest run tests/sandbox-edge-content.test.ts` — Expected: FAIL for gcp.

- [ ] **Step 3: Write the content**

In `content/sandbox/gcp-sandbox.yaml`: delete the `cloud-cdn` part; add `id: global-alb`, `label: "Global external Application Load Balancer"`, `short: "Global LB"`, `scope: global`, `roles: [route]`, `cost: 2`, with your researched own-words `facts`, and

```yaml
    caching:
      label: "Cloud CDN"
      default: false
      facts:
        - "<own-words facts, each stated by a cited page>"
```

(no placeholder text may remain). Add to `sources` every page the new facts rely on (real titles, URLs above), `retrieved: 2026-10-29`. Remove a source only if no remaining fact (including the Pub/Sub, Memorystore and Cloud Storage parts) still relies on it.

- [ ] **Step 4: Run everything**

Run: `npx vitest run tests/sandbox-edge-content.test.ts tests/sandbox-content.test.ts tests/sandbox-cache-content.test.ts`; `npm run schemas && git status --short`; the `loadContent` one-liner (`OK`); `npx tsc -b`; `npx oxlint`; `npm test`.
Expected: all pass. If a test elsewhere references `cloud-cdn`, update it to match (report it).

- [ ] **Step 5: Commit**

```bash
git add content/sandbox/gcp-sandbox.yaml tests
git commit -m "Judge Cloud CDN as a setting on a global load balancer in the Google sandbox

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Screen: the caching toggle and the notes

**Files:**
- Modify: `src/components/canvas/Inspector.tsx` (the toggle), `src/components/canvas/CanvasEditor.tsx` (wire it), `src/screens/SandboxScreen.tsx` (notes)
- Modify: `README.md` (the sandbox paragraph), `tests/sandbox-ui.test.tsx`

**Interfaces:**
- Consumes: Task 2 (`setCaching`, `edgeJudged`, `EDGE_SHARE`, `EDGE_HIT`), Tasks 3 to 5 (the real parts).
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `tests/sandbox-ui.test.tsx` (it already defines `open`, `add`, `create`, `selectNode`, `link`, `inspector`; the palette `Add` button names use each part's label; the lane value for a global part is `global`):

```tsx
const savedDesign = (name: string) => {
  const data = JSON.parse(localStorage.getItem(KEY)!)
  return data.designs.find((d: { name: string }) => d.name === name).design
}
const caching = (name: string) => within(inspector()).getByRole('checkbox', { name })

it('AWS: a CloudFront distribution caches by default, the toggle persists, and a reload keeps it', async () => {
  render(<App />)
  open()
  await create('Edge shop', 'aws')
  add('CloudFront distribution', 'global')
  selectNode('cdn-1')
  expect((caching('Caching') as HTMLInputElement).checked).toBe(true)
  fireEvent.click(caching('Caching'))
  expect((caching('Caching') as HTMLInputElement).checked).toBe(false)
  expect(savedDesign('Edge shop').nodes.find((n: { id: string }) => n.id === 'cdn-1').caching).toBe(false)
  cleanup()
  render(<App />)
  open()
  fireEvent.click(await screen.findByRole('link', { name: /Edge shop/ }).catch(() => screen.getByText('Edge shop')))
  await screen.findByRole('region', { name: 'Palette' })
  selectNode('cdn-1')
  expect((caching('Caching') as HTMLInputElement).checked).toBe(false)
})

it('Azure: Front Door has an off-to-start "Enable caching" setting; Application Gateway has none', async () => {
  render(<App />)
  open()
  await create('Azure edge', 'azure')
  add('Azure Front Door', 'global')
  selectNode('front-door-1')
  expect((caching('Enable caching') as HTMLInputElement).checked).toBe(false)
  add('Application Gateway v2', 'eus2')
  selectNode('app-gateway-1')
  expect(within(inspector()).queryByRole('checkbox')).toBeNull()
})

it('Google Cloud: the global load balancer offers Cloud CDN, the regional one does not', async () => {
  render(<App />)
  open()
  await create('Google edge', 'gcp')
  add('Global external Application Load Balancer', 'global')
  selectNode('global-lb-1')
  expect((caching('Cloud CDN') as HTMLInputElement).checked).toBe(false)
  add('Regional load balancer (for VMs)', 'usc1')
  selectNode('lb-1')
  expect(within(inspector()).queryByRole('checkbox')).toBeNull()
})

it('the edge note appears only when the design has a caching part and a web server, and the neutral note no longer mentions CDNs', async () => {
  render(<App />)
  open()
  await create('Notes', 'aws')
  add('CloudFront distribution', 'global')
  expect(screen.queryByText(/Caching is judged on the traffic spike/)).toBeNull()
  add('EC2 web server', 'use1-az1')
  expect(screen.getByText(/Caching is judged on the traffic spike/)).toBeTruthy()
  expect(screen.getByText(/half of requests are cacheable GETs/)).toBeTruthy()
  expect(screen.getByText(/scenario numbers, not measurements/, { exact: false })).toBeTruthy()
  add('Amazon SQS queue', 'use1')
  expect(screen.getByText(/Queues and object storage aren't judged by these checks yet/)).toBeTruthy()
  expect(screen.queryByText(/CDNs/)).toBeNull()
})
```

(Adjust the exact node ids and the reload-open step to what the app really produces: node ids come from `addNode`'s slug of the part's `short ?? label`: `cdn-1` for CloudFront (`short: "CDN"`), `front-door-1`, `app-gateway-1`, `global-lb-1`, `lb-1`. For reopening a saved design, follow the existing reload test in this file. Keep every assertion's intent.)

Run: `npx vitest run tests/sandbox-ui.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement**

`src/components/canvas/Inspector.tsx`: add prop `onCaching: (id: string, on: boolean) => void` to the props type and the destructuring; after the "Move to" block (before the "Send traffic to" block) add, inside the main `<section>`:

```tsx
      {node && item?.caching && (
        <div className="space-y-1">
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={node.caching ?? item.caching.default}
              onChange={(e) => onCaching(node.id, e.target.checked)}
              className="accent-accent"
            />
            {item.caching.label}
          </label>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
            {item.caching.facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
```

`src/components/canvas/CanvasEditor.tsx`: import `setCaching` from `../../game/canvasEdit.ts` (next to the other edit imports) and pass to `<Inspector>`:

```tsx
            onCaching={(id, on) => apply(setCaching(design, id, on), `${id}: caching ${on ? 'on' : 'off'}.`)}
```

`src/screens/SandboxScreen.tsx`: import `edgeJudged, EDGE_SHARE, EDGE_HIT` with the other sandbox imports; add `const edge = edgeJudged(c, design)` beside `const reads`; change the neutral note text to `Queues and object storage aren't judged by these checks yet. A link through one is treated as a direct link to what's behind it.`; add after the reads notes:

```tsx
              {edge && (
                <p className="mt-3 text-xs text-muted">
                  Caching is judged on the traffic spike. It assumes half of requests are cacheable GETs ({Math.round(EDGE_SHARE * 100)}%) and that a caching edge answers {Math.round(EDGE_HIT * 10)} in 10 of those, so the web servers carry {Math.round((1 - EDGE_SHARE * EDGE_HIT) * 100)}% of the spike. These are scenario numbers, not measurements. Servers that users can also reach without passing the edge get no discount.
                </p>
              )}
```

  (The sentence must contain "half of requests are cacheable GETs", "Caching is judged on the traffic spike" and "scenario numbers, not measurements" as the tests expect. `Math.round(EDGE_SHARE * 100)` renders 50 inside the parentheses; if "half" and "50%" read as redundant, drop the parenthesis and keep "half".)

`README.md`: in the Design sandbox paragraph change the closing sentences to say that queues and object storage can be placed and linked but the checks don't judge them yet; a cache is judged once the design has a web server and a database; and CDN or edge parts (CloudFront, Azure Front Door and Traffic Manager, a Google global load balancer with Cloud CDN) are judged on the traffic spike, each modelled the way its own cloud's docs describe it. Keep the paragraph's style and length.

- [ ] **Step 3: Run everything**

Run: `npx vitest run tests/sandbox-ui.test.tsx`, then `npx tsc -b`, `npx oxlint`, `npm test`.
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src README.md tests
git commit -m "Show the caching toggle and explain the edge checks on the sandbox screen

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Whole-branch verification (controller)

**Files:** none (verification only; fixes go back to an implementer).

- [ ] **Step 1:** Run the full validation: `npx tsc -b`, `npx oxlint`, `npm test`, `npm run schemas` (`git status --short` clean), the `loadContent` one-liner, `npm run check-links` (known failures only: `dev.mysql.com` 403 and `nftables.org` timeouts).
- [ ] **Step 2:** Final whole-branch review by the most capable model, with the Review Focus list and the ledger's `Ruling:` lines, and an independent provider-facts check of the three sandbox edge parts (and the Front Door overlay) against their cited pages. Fix Critical and Important findings in one pass, each with a failing test first.
- [ ] **Step 3:** Browser pass with the Chrome extension (tab visibility throttles timers: drive loops with MessageChannel ticks; stop the dev server by its own LISTEN pid, e.g. `lsof -ti tcp:PORT -sTCP:LISTEN`): for each of the three sandboxes, build a checkout, add the cloud's edge part (AWS CloudFront; Azure Front Door and then Traffic Manager with a second path through Application Gateway; Google global load balancer), link users to it and it to the load balancer, run the spike check with caching on (expect a pass with one web server) and off (expect the "caching is off" reason), add a direct users-to-load-balancer link (expect the bypass reason), lose the edge, confirm the notes and the Inspector toggle, reload and check the toggle persisted, and confirm a design with no edge part runs exactly as before. Clear seeded data and close the tab afterwards.
- [ ] **Step 4:** Report to the user; push, PR and merge only when asked.
