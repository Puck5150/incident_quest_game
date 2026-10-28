# Cache before the sale: database read load and a build-it-yourself cache lesson

Date: 2026-10-28
Status: draft for review

## Purpose

The canvas engine judges three things after a failure: can users reach a web
server, can orders be written to a database, and is there enough serving
capacity. It has no idea that a database can be overwhelmed by *reads*, so it
cannot teach what a cache is for. Queues and caches in the design sandbox are
`neutral` parts for the same reason: the engine has nothing to say about them.

The player wants the order of the lesson to be: first see a database fail under
load, then bring in caching to prevent it. This spec covers the first of two
cycles:

1. **This spec (cycle 1):** an opt-in read-load rule in the engine, a `cache`
   role, and one new scored challenge that teaches the failure and then the fix.
2. **Cycle 2 (separate spec):** the design sandbox's cache parts switch from
   `neutral` to `cache` and the sandbox's check menu uses the same rule.

Queues are a different pattern (they buffer writes) and are out of scope for
both cycles.

### What was asked for

- Teach database failure first, then introduce caching as the way to prevent it.
- Challenge first, sandbox practice afterwards (cycle 2).
- Real cloud services on all three clouds, AWS first. Facts come from vendor
  documentation, in our own words.
- The read-load rule applies only where an author opts in; scored challenges
  that do not set it behave exactly as before.

### Success criteria

- A player who builds the plain checkout (load balancer, web servers, a database
  with a standby) fails the sale test with a reason that says the database
  cannot take the read load.
- Adding a cache and linking the web servers to it makes the sale test pass, and
  the results say what the cache absorbed.
- Losing the cache, or losing the zone it sits in, fails with a reason that
  names the load the database would see; a second cache in the other zone fixes
  it.
- The challenge exists for AWS, Azure and Google Cloud in one file.
- Every existing challenge's evaluation is byte-for-byte unchanged.

## Design

### The challenge: `cache-before-the-sale`

`content/cloud-design/cache-before-the-sale.yaml`, a `pick-cloud-canvas` with
`providers: [aws, azure, gcp]`, track `cloud-design`, difficulty 3, in the same
shape as `zone-resilient-checkout`.

**Brief.** The checkout from the earlier zone challenge works on a normal day. A
sale doubles traffic, every product page re-reads the same data from the
database, and the database buckles. Build a design that survives the sale and
still survives losing a zone, a web server, the database host, or the cache.

**Requirements shown to the player.**
- Serve 2× normal traffic, with either zone down.
- Keep the database within what it can read on a sale day.
- Survive any single web server, the database server, or a cache failing.
- Stay within the budget.

**Layout.** The same one-region, two-zone layout and per-cloud labels as
`zone-resilient-checkout` (`r1`, `r1-a`, `r1-b`).

**Palette.**

| id | role | scope | cost | capacity |
|---|---|---|---|---|
| `lb` | route | regional | 1 | |
| `vm` | serve | zonal | 1 | 1 |
| `db` | write-store | zonal | 2 | |
| `cache` | cache | zonal | 2 | |

`lb`, `vm` and `db` reuse the per-cloud labels, `short` names, facts and
`differences` text from `zone-resilient-checkout` (copied, not referenced; the
two files stay independent).

`cache` per cloud:

| cloud | label | short |
|---|---|---|
| AWS | Amazon ElastiCache for Redis OSS node | `ElastiCache` |
| Azure | Azure Managed Redis cache | `Managed Redis` |
| Google Cloud | Memorystore for Redis instance | `Memorystore` |

Each carries `facts` that describe a **single cache node with no standby, in one
zone**, and a `differences` paragraph. All three clouds also offer cache
configurations with a replica in another zone; this challenge does not model
those (a cache is one zonal part), and the `differences` text says so plainly.
The Azure part is Azure Managed Redis, not Azure Cache for Redis, which
Microsoft is retiring. Every fact, and each service's scope and what its
failure means, is verified against the vendor documentation while authoring,
not recalled. A fact that cannot be confirmed from a docs page is left out.

**Stress tests.** Six, all with `read_load` (below):

| id | event | check |
|---|---|---|
| `sale` | none | reach serve, write-store; capacity 2 |
| `zone-a` | `zone_outage: r1-a` | reach serve, write-store; capacity 2 |
| `zone-b` | `zone_outage: r1-b` | reach serve, write-store; capacity 2 |
| `vm-failure` | `single_failure: vm` | reach serve, write-store; capacity 2 |
| `db-host` | `single_failure: db` | reach serve, write-store; capacity 2 |
| `cache-failure` | `single_failure: cache` | reach serve, write-store; capacity 2 |

(The existing challenge's `db-host` and `vm-failure` do not require `serve`
and `write-store` together; here every test does, because the read load only
exists when something serves and something stores.)

Shared numbers: `read_load: { traffic: 2, hit: 0.9, db_capacity: 1 }`. These are
scenario numbers, like the web server's "1× normal traffic": the labelled
facts say so, and the debrief says the real figures depend on the workload.
On a normal day (1×) the database copes without a cache, so the problem only
appears on sale day, which is the point of the lesson.

**Reference design ("Recommended").** One load balancer, two web servers in each
zone, a primary database in `r1-a` with a synchronous standby in `r1-b`, and a
cache in each zone, every web server linked to both caches. It passes all six
tests. Cost 13 against a budget of 14.

**Counter-examples**, each listing the tests it fails:
- No cache (the plain checkout): fails all six; the reason on each is the
  database read load.
- One cache in `r1-a`, linked from every web server: fails `zone-a` and
  `cache-failure`, passes the rest.
- Two caches that no web server links to: fails all six (a cache nothing reads
  from protects nothing).

**Hints, analogy, debrief.** The hints point at the failing reason without giving
the design: nudge ("a normal day passes; what is different about a sale day,
and who is doing all the reading?"), direction (a cache between the web servers
and the database, and what happens when it is cold), answer. The debrief names
the pattern (cache-aside: the application checks the cache first and reads the
database only on a miss), the catch (a cold or lost cache sends every read back
to the database, which is why the design needs more than one cache and why
losing it is a stress test), and what is deliberately not modelled: read
replicas, cache replicas, expiry and staleness, and writes. It keeps the
checkout debrief's reminders about private subnets, encryption and backups.

**Sources**, per cloud, from vendor documentation read while authoring
(Amazon ElastiCache, Azure Managed Redis, Memorystore for Redis, plus the pages
already cited by `zone-resilient-checkout` for the load balancer, VM and
database). Each has title, url and retrieved date.

### Engine: the `read_load` rule

`CheckSchema` (`src/schema/canvas.ts`) gains an optional field:

```
read_load: { traffic: positive number, hit: number in (0, 1), db_capacity: positive number }
```

The field is optional, so every existing file stays valid. It requires `reach` to
include both `serve` and `write-store` (a refinement on the schema); an author
cannot set it on a check that has no database or no server to apply it to.
`traffic`, `hit` and `db_capacity` are multiples of normal read traffic.

`ROLES` gains `cache` (`src/schema/constants.ts`). `ROLES` is shared by the canvas
and pick-cloud schemas, so the generated JSON Schemas are regenerated
(`npm run schemas`). Adding a role changes no existing file's validity. The plan
verifies that nothing treats the role list as exhaustive. A palette item with
role `cache` carries no other role.

In `check()` (`src/game/canvas.ts`), after the capacity block and only when
`t.check.read_load` is set:

1. Take the serving set the capacity logic already computes: web servers
   reachable from users that can reach the database that currently accepts
   writes. If the serving set is empty, or the writer logic already reported a
   problem, add no read-load reason (the existing reason has already failed the
   scenario and a second line would be noise).
2. `share = traffic / servingCount`. A serving server counts as *shielded* when it
   has a traffic link to at least one cache that has not been removed in this
   scenario. A shielded server sends `share × (1 − hit)` of reads to the
   database; an unshielded one sends `share`.
3. `load` is the sum. If `load > db_capacity`, add one reason, in plain English
   and with the numbers: the database would see `load`× normal reads and can take
   `db_capacity`×, naming the unshielded servers, and saying whether a cache
   exists but is down, is not linked, or does not exist. When a scenario removed
   a cache the reason says so ("with cache-1 gone, ...").
4. Otherwise no reason: the check passes on that line.

Scenarios, events, the zone-fan-out for unnamed zones, and everything else in
`scenarios()` and `evaluateCanvas` are unchanged. The result type is unchanged:
the new line is one more entry in `reasons`.

**Why an opt-in field on the shared engine, not a second evaluator.** The
failure scenarios (which parts are down for a zone, region or single failure) are
already computed by the engine and are not exported; a second evaluator would
copy them and drift. The field is absent from every scored challenge today, so
their results cannot change; existing canvas tests pin that.

**What is not modelled** (stated in the debrief and AUTHORING.md): read replicas
absorbing reads, cache replicas and cross-zone cache failover, expiry and
staleness, write-through and write-behind caching, cache warm-up time, and
reads that bypass the web tier. The database's read capacity applies to
whichever database currently accepts writes.

### Editor and screens

No editor change: `connect()` already allows traffic links between any two
components, so a web server links to a cache and to the database with the
links the player already has. The inspector and board render a `cache` part as
any other part (its `short` name and cost). The result panel shows the new
reason like any other. The sandbox is untouched in this cycle: its cache parts
stay `neutral` until cycle 2, and `isNeutral` there still holds because the
sandbox file schema still requires `[neutral]` for its extra parts.

### Content authoring

`AUTHORING.md` gains a short section on `read_load` and the `cache` role: the
three fields, the rule, the worked numbers from this challenge, the list of what
is not modelled, and the rule that an author states every number as a scenario
number.

### Error handling and edge cases

- No cache in the design: the rule treats every server as unshielded; the reason
  says no cache is in the design.
- A cache linked from some servers only: only those servers are shielded; the
  reason names the unshielded ones.
- A cache lost by the scenario (zone or single failure): its links are ignored
  in that scenario; a second linked cache still shields.
- A link from a cache to a server or to the database: it does not shield
  anything (only server-to-cache links count); the editor still allows it.
- Design with no database, or none that survives: existing reasons apply and the
  read-load line is not added.
- Region outage, if an author tests one: handled by the same removed set.
- Existing challenges and tests that set no `read_load`: unaffected.

## Testing

- `tests/canvas-read-load.test.ts` (engine, pure): the plain checkout fails with
  the read-load reason at 2×; with a cache linked from every server it passes;
  a cache nothing links to fails; a cache linked from only some servers fails
  and names the others; the cache lost fails; two caches survive one loss;
  a zone loss that removes the only cache fails and one cache in each zone
  passes; the standby taking over still carries the load; no serving server or
  no writer adds no read-load line; a check without `read_load` is unchanged on
  a design that has a cache.
- Schema tests: `read_load` accepted when `reach` has both roles; rejected when
  it does not, when `hit` is 0 or 1 or more, and when a number is not positive;
  `cache` accepted as a role; an item with `cache` and another role rejected.
- Every existing canvas test passes unchanged, including `canvas-ui.test.tsx`
  and `canvas-edit.test.ts`.
- Content tests for the challenge, in the pattern already used for canvases: the
  reference design passes all six tests on each of the three clouds; each
  counter-example fails exactly the tests it lists; every palette item has
  facts; the file has sources for each cloud; the JSON-schema freshness test
  covers the new field.
- Browser pass (the extension is connected now): play the challenge on all three
  clouds, see the plain checkout fail on the sale test, add a cache, link it,
  rerun, then lose the cache.

## Out of scope

- Sandbox cache checks and any sandbox change (cycle 2).
- Queues, buffers, workers, and write availability through a queue.
- Read replicas, cache replicas and failover, expiry, staleness, write-through,
  warm-up.
- Per-cloud numbers; one set of scenario numbers serves all three clouds.
- Any change to existing challenges.

## Open points

None blocking. Settled while authoring, from the vendor docs, not decided here:

- The exact wording of each cloud's cache facts, and whether the single-node,
  no-standby configuration is described accurately for Azure Managed Redis
  (where that is the high-availability-off configuration). If a cloud's docs do
  not support describing it honestly as a zonal part, the plan raises it before
  content is written.
- The scenario numbers (traffic 2, hit 0.9, database capacity 1) and the budget
  (14) are starting values, each in one place in the file.
