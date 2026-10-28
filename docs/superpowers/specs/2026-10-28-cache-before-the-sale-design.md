# Cache before the sale: database read load and a build-it-yourself cache lesson

Date: 2026-10-28
Status: draft for review (revised after the provider-docs rule, below)

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
   role, and three new scored challenges, one per cloud, that teach the failure
   and then the fix.
2. **Cycle 2 (separate spec):** the design sandbox's cache parts switch from
   `neutral` to `cache` and the sandbox's check menu uses the same rule.

Queues are a different pattern (they buffer writes) and are out of scope for
both cycles.

### What was asked for

- Teach database failure first, then introduce caching as the way to prevent it.
- Challenge first, sandbox practice afterwards (cycle 2).
- Real cloud services on all three clouds, AWS first. Facts come from vendor
  documentation, in our own words.
- **Each provider's documentation is the only source of truth.** A capability,
  scope or failure behavior documented for one cloud is never assumed for
  another. Where the clouds' documented behavior differs, each cloud gets its
  own model, not a shared item with a footnote. If the docs do not say it, it
  is not in the content.
- The read-load rule applies only where an author opts in; scored challenges
  that do not set it behave exactly as before.

### Success criteria

- A player who builds the plain checkout (load balancer, web servers, a database
  with a standby) fails the sale test with a reason that says the database
  cannot take the read load.
- Adding a cache and linking the web servers to it makes the sale test pass, and
  the results say what the cache absorbed.
- On AWS and Google Cloud, where the docs describe a cache node that lives in
  one zone, losing that node or its zone fails with a reason that names the load
  the database would see; a second cache in the other zone fixes it.
- On Azure, where the docs describe a zone-redundant cache, a zone outage does
  not take the cache out, and the challenge does not pretend it does.
- Each cloud has its own challenge file, authored from that cloud's docs.
- Every existing challenge's evaluation is byte-for-byte unchanged.

## Design

### The challenges: one per cloud

Three single-provider canvas challenges in `content/cloud-design/`, in the same
shape as `aws-checkout-canvas`, `azure-portal-canvas` and `gcp-signup-canvas`
(`mode: canvas`, `provider` fixed): `aws-cache-before-the-sale`,
`azure-cache-before-the-sale`, `gcp-cache-before-the-sale`. Track
`cloud-design`, difficulty 3. They are not a pick-cloud file: that shape gives a
palette item one scope for all clouds, which would force the three caches into
one model that no vendor's documentation supports.

**Why not one pick-cloud file.** Checked against the docs on 2026-10-28:
ElastiCache documents a cache node that runs in one Availability Zone;
Memorystore for Redis Basic tier documents a single node in one zone; Azure
Managed Redis documents a high-availability cache of at least two nodes in
different zones, and does not say that a non-HA cache is pinned to one zone (HA
also cannot be turned off once on). So the AWS and Google Cloud caches are
zonal parts and the Azure cache is a regional (zone-redundant) part.

**Brief (each, in the cloud's own words).** The checkout from the earlier zone
challenge works on a normal day. A sale doubles traffic, every product page
re-reads the same data from the database, and the database buckles. Build a
design that survives the sale and still survives losing a zone, a web server,
the database host, and, where the docs make it a real failure, the cache.

**Layout.** One region, two zones, with the cloud's own names (`us-east-1`,
`us-east-1a`, `us-east-1b`; `East US 2`, `Zone 1`, `Zone 2`;
`us-central1`, `us-central1-a`, `us-central1-b`).

**Palette (each).** The load balancer, web server and database come from that
cloud's existing checkout challenge (copied, not referenced), plus one cache:

| cloud | cache part | scope | cost | what the docs support |
|---|---|---|---|---|
| AWS | ElastiCache cache node | zonal | 2 | a node runs in one Availability Zone; with no replica, a replacement primary starts empty |
| Azure | Azure Managed Redis cache, high availability | regional | 2 | HA gives at least two nodes, in different zones where the region has them; failover typically takes 10 to 15 seconds; writes not yet replicated can be lost in a zone failure |
| Google Cloud | Memorystore for Redis, Basic tier | zonal | 2 | a single node in one zone with no cross-zone replication, suited to an ephemeral cache |

Each cache part has facts written from that cloud's pages only, read while
authoring; a fact the docs do not support is left out, not borrowed from
another cloud. `capacity` is 0 and the role is `cache` alone.

**Stress tests (each).** All carry `read_load` (below) and require `serve` and
`write-store`:

| id | event | on |
|---|---|---|
| `sale` | none | all three |
| `zone-a`, `zone-b` | zone outage | all three |
| `vm-failure` | `single_failure: vm` | all three |
| `db-host` | `single_failure: db` | all three |
| `cache-failure` | `single_failure: cache` | AWS and Google Cloud only |

Azure has no `cache-failure` test: its documented cache is zone-redundant, so a
zone outage cannot remove it, and the docs describe its other failure modes
(failover blips of seconds, a region outage) as ones the application should
absorb by falling back to the database, not as a fault the design can prevent
with another cache. The debrief says so and cites the page. (Whether the
Google Cloud docs describe a node failure well enough to name it in a test
label is checked while authoring; the label states the event, not a claim.)

Every check has `capacity: 2`. Numbers: `read_load: { traffic: 2, hit: 0.9,
db_capacity: 1 }`, stated as scenario numbers like the web server's "1× normal
traffic". On a normal day (1×) the database copes without a cache, so the
problem only shows on sale day. They are authored per file; nothing says the
three clouds share numbers.

**Reference design ("Recommended").**
- AWS and Google Cloud: one load balancer, two web servers in each zone, a
  primary database in the first zone with a synchronous standby in the second, a
  cache in each zone, every web server linked to both caches. Passes all six
  tests. Cost 13, budget 14.
- Azure: the same, with one regional cache linked from every web server. Passes
  all five tests. Cost 11, budget 12.

**Counter-examples**, each listing the tests it fails, checked by the build:
- No cache: fails every test (the reason on each is the database read load).
- A cache that no web server links to: fails every test.
- AWS and Google Cloud: one cache in one zone, linked from every web server:
  fails that zone's test and `cache-failure`.
- Azure: a cache linked from the web servers in one zone only: fails the tests
  where the unlinked servers carry the sale.
Exact `fails` lists are fixed when the plan's tests run; the build check
enforces them.

**Hints, analogy, debrief (each).** The nudge points at the reason, not the
design ("a normal day passes; what changes on a sale day, and who is doing all
the reading?"). The debrief names the pattern (cache-aside: check the cache
first, read the database on a miss), and on every cloud what its own docs say
about a cache that is down or empty. It says what is not modelled: read
replicas, cache replicas the player places separately, expiry and staleness,
writes. It keeps the checkout debrief's reminders about private subnets,
encryption and backups.

**Sources**, per file, from that cloud's documentation read while authoring
(each file lists only its own cloud's pages): title, url, retrieved date.

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
- Content tests for the challenges, in the pattern already used for canvases: the
  build-time check (`canvasChecks`) runs each file's reference design (must
  pass) and counter-examples (must fail exactly what they list); every palette
  item has facts; each file has its own cloud's sources; the JSON-schema
  freshness test covers the new field; one test asserts the AWS and Google Cloud
  caches are zonal and the Azure cache is regional.
- Browser pass (the extension is connected now): play each cloud's challenge, see
  the plain checkout fail on the sale test, add a cache, link it, rerun, then
  lose the zone (and, on AWS and Google Cloud, the cache).

## Out of scope

- Sandbox cache checks and any sandbox change (cycle 2).
- Queues, buffers, workers, and write availability through a queue.
- Read replicas, cache replicas and failover, expiry, staleness, write-through,
  warm-up.
- A shared multi-cloud version of this challenge: the documented cache behavior differs per cloud.
- Any change to existing challenges.

## Open points

None blocking. Settled while authoring, from each cloud's docs, not decided here:

- The exact wording of each cache's facts. The scope choices (AWS and Google
  Cloud zonal, Azure regional) rest on pages read on 2026-10-28 and, for the
  AWS and Google Cloud parts, on the pages already cited by the sandbox files.
  They are re-read while authoring.
- Whether the Google Cloud docs describe a Basic-tier node failure explicitly
  enough to name it in the `cache-failure` label. If not, the label says only
  that a cache node is lost.
- The scenario numbers (traffic 2, hit 0.9, database capacity 1) and budgets
  (14, 12) are starting values, each in one place per file.
