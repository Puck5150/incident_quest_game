# CDN and edge caching in the design sandbox, modelled per cloud from each cloud's docs

Date: 2026-10-29
Status: draft for review

## Purpose

The sandbox's CDN parts are `neutral` today: the engine contracts them away, so a
learner can place CloudFront or Cloud CDN but the checks ignore it. This cycle
makes CDN and edge caching judged, on all three clouds, with each cloud modelled
the way its own documentation describes it. The three clouds do not share a
shape, and the tool exists to teach that difference:

- **AWS:** a CloudFront distribution is a separate global layer in front of the
  origin. It caches by default.
- **Azure:** there is no separate CDN part. Caching is a route setting on Azure
  Front Door (Standard/Premium), which Microsoft calls its flagship CDN. It is
  off until enabled. Front Door is documented as a possible single point of
  failure, and Microsoft's mission-critical guidance adds a second entry path
  through Azure Traffic Manager.
- **Google Cloud:** Cloud CDN is a setting on a backend of a *global external or
  classic* Application Load Balancer. It is not a separate hop, and Google's docs
  do not offer it on a regional external load balancer. It is off until enabled.

Out of scope (next cycle): origin groups, per-method origin failover, serving
stale content, a second origin. Also out of scope: queues, object storage, an
editable layout, mixed-cloud designs, Media CDN, and any change to the scored
challenges.

## Decisions (agreed in brainstorming)

- All three clouds in one cycle, each with its own part and facts (user rule:
  provider docs are the only source of truth; build every cloud as its docs
  describe it; no shortcuts).
- Mechanics in this cycle: spike offload, entry path, per-cloud caching defaults.
  The Azure caching-misconfiguration check is dropped (see "Not modelled").
- A new engine rule, not `read_load`: a CDN relieves web-server capacity, not the
  database.

## Provider-docs rule

Each provider's own documentation is the only source of truth. A capability,
scope, default or failure behavior documented for one cloud is never assumed for
another. A fact a page does not state is not in the content. All wording is in our
own words. Page titles and URLs are the pages' real ones. The research for this
spec (retrieved 2026-10-29) is summarized below; the content task re-fetches
every page before any fact is written.

### What each cloud's docs state (basis for the model)

| Topic | AWS (CloudFront) | Azure (Front Door, Traffic Manager) | Google Cloud (Cloud CDN) |
|---|---|---|---|
| What the learner places | A distribution: a global service, viewers reach edge locations, then regional edge caches, then the origin. Origins include ALB, EC2, S3 | Front Door Standard/Premium. Caching is an "Enable caching" setting on a route, not a separate resource. Every other Microsoft CDN product has an announced retirement | A setting on a backend service or backend bucket of a global external or classic Application Load Balancer. Not a separate resource or hop |
| Scope | Global | Global (not zonal or regional) | The load balancer's: global for the global external mode |
| Cacheable | GET and HEAD (OPTIONS if enabled). POST, PUT, PATCH, DELETE are never cached and always pass through | GET only. Other methods are always proxied to the origin. Anything not cached still goes through Front Door to the origin | Cache lookups for GET and HEAD. Misses and uncacheable responses go through the load balancer to the origin. HTML and JSON are not cached by default |
| Default | Caches by default (default TTL 24 hours without a cache policy; the CachingDisabled policy turns it off) | Off until "Enable caching" is set on the route | Off until enabled on the backend |
| Hit ratio stated | No | No | No |
| Dynamic or checkout traffic | Reaches the origin | Reaches the origin; Microsoft recommends separate routes for static and dynamic content, caching off on the dynamic one | Reaches the origin |
| Entry-path resilience | Only a 99.9% SLA commitment on AWS's legal page. No edge-failover mechanics | Front Door is a possible single point of failure. For mission-critical apps only, Microsoft puts Traffic Manager (a DNS service, not in the request path) in front of Front Door plus a second path. That path loses Front Door's caching | Cloud CDN shares the load balancer's frontend, so it is not a separate failure domain. The global external load balancer can send traffic to healthy backends in another region |
| Sources (titles) | What is Amazon CloudFront?; How CloudFront delivers content; Cache behavior settings; Manage how long content stays in the cache; Request and response behavior for custom origins; Resilience in Amazon CloudFront; Use managed cache policies | Azure Front Door Overview; Caching - Azure Front Door; Global Routing Redundancy for Mission-Critical Web Applications; Azure Traffic Manager overview; How Azure Traffic Manager Works; Reliability in Azure Traffic Manager; Azure Traffic Manager - FAQ | Cloud CDN overview; Caching overview (Cloud CDN); Load balancer feature comparison; Request distribution for external Application Load Balancers; Choose a CDN product |

The exact URLs are in the research notes and are re-verified in the content task.

## Design

### Schema: a per-part caching setting (`src/schema/canvas.ts`)

- `PaletteItemSchema` gains an optional `caching: { label, default, facts }`:
  the part offers a caching setting. `label` is what the cloud calls it (for
  example "Cloud CDN"), `default` is whether it is on when the part is placed
  (true for CloudFront, false for Front Door and the Google global load balancer,
  each per its docs), and `facts` are shown with the setting.
- A design node gains an optional `caching: boolean`. Absent means the part's
  default. `DesignSchema` and the saved-design and export formats accept it;
  designs without it load unchanged.
- The check object gains an opt-in `edge_load: { share, hit }`: `share` is the
  fraction of requests that are cacheable GETs and `hit` the fraction of those the
  edge answers. Both are strictly between 0 and 1. It needs `capacity` and `serve`
  in the same check (a refinement refuses it otherwise, as `read_load` does).
- `schemas/*.json` are regenerated.

### Engine rule (`src/game/canvas.ts`)

A node is an **active edge** when its part has `caching`, the node is not lost,
and its effective caching is on. In a check with `edge_load`, the capacity test
changes only when the design has at least one active edge:

- If every web server reachable from users is reachable only through an active
  edge, the traffic the servers must carry is `capacity × (1 − share × hit)`.
- If some web server is reachable from users along a path that avoids every active
  edge (a direct link to a load balancer, or a second entry path), no traffic is
  discounted: those requests reach the origin without passing the cache.
- The reason when the capacity test fails now states the traffic needed after the
  edge, and why a discount was withheld when it was: caching is off on the part,
  the part was lost, or users can also reach a named server without passing the
  edge.

Reachability and "users connect straight to X" rules are unchanged. `read_load`
is unchanged: an edge discounts web-server capacity only, because the docs do not
say it shields the database.

### Sandbox (`src/schema/sandbox.ts`, `src/game/sandbox.ts`)

- Extra palette parts may be `[neutral]`, `[cache]` or `[route]`. A `route` extra
  is an entry point: users may connect to it, as to a load balancer. The refusal
  message names the three allowed roles.
- A sandbox file may carry `overlays: [{ id, caching }]`, which adds a `caching`
  setting to an inherited part (this is how Front Door gets one without touching
  the scored Azure canvas). `resolveSandbox` merges it, and returns an error
  message when the id is not in the base palette or the part already has a
  `caching` setting.
- Two constants beside `SPIKE`: `EDGE_SHARE = 0.5` and `EDGE_HIT = 0.9`. They are
  scenario numbers, not provider facts (no page states a hit ratio), and the
  learner is told so. A spike check of 3x therefore asks the web tier to carry
  3 × (1 − 0.45) = 1.65x when the edge is active.
- `sandboxChecks()` adds `edge_load: { share: EDGE_SHARE, hit: EDGE_HIT }` to the
  spike check when the design has a caching-capable part and a web server, so the
  reason can say why caching did or did not help. Labels do not change.
- Route extras are judged parts: they occupy no zone or region (they are global),
  and each gets a "Lose any one <part>" check like the load balancer does.
- `isNeutral` is unchanged. Contracting away neutral parts is unchanged.
- Helper `edgeJudged(c, d)`, exported for the screen.

### Content

**AWS (`content/sandbox/aws-sandbox.yaml`):** `cloudfront` becomes roles
`[route]`, scope `global`, with `caching: { label: "Caching", default: true }`.
Facts come from the CloudFront pages above: global, edge locations and regional
edge caches, GET and HEAD cached, POST always reaches the origin, caches by
default and what `CachingDisabled` does. SQS and S3 stay `[neutral]`.

**Azure (`content/sandbox/azure-sandbox.yaml`):**
- An overlay adds `caching: { label: "Enable caching", default: false }` to
  `front-door`, with facts from the Front Door pages (a route setting, GET only,
  anything else proxied to the origin, Microsoft's advice to cache static routes
  and not dynamic ones, off until enabled).
- A new `traffic-manager` part: scope `global`, roles `[route]`, facts from the
  Traffic Manager pages. It answers DNS lookups and is not in the request path,
  so it does no caching, WAF or TLS termination. It is a global service whose
  infrastructure Microsoft spreads over zones and regions. Facts also state that
  Microsoft's Front Door redundancy pattern uses it with a second path that
  loses caching, and that failover is not instant (DNS caching and probe
  settings). The part's links express which entry points the DNS name can
  resolve to.
- Service Bus and Blob stay `[neutral]`.

**Google Cloud (`content/sandbox/gcp-sandbox.yaml`):**
- A new `global-alb` part, "Global external Application Load Balancer": scope
  `global`, roles `[route]`, `caching: { label: "Cloud CDN", default: false }`,
  with facts from the load-balancer and Cloud CDN pages (CDN is enabled on a
  backend of this load balancer, not a separate hop; it can send traffic to
  healthy backends in another region).
- The existing canvas part `lb` (Regional load balancer) gets no caching setting:
  Google's docs do not offer Cloud CDN there, and the part's own facts say it is
  regional. That difference is the lesson.
- The standalone `cloud-cdn` part is removed: Cloud CDN is not a separate
  resource. A saved design that still contains it fails to open with the existing
  "isn't in this cloud's palette" message and can still be exported or deleted.
  Pub/Sub and Cloud Storage stay `[neutral]`.

Each file's `sources` gains the pages its new facts rely on, with
`retrieved: 2026-10-29`. No claim is cited to a page that does not state it.

### Screen (`src/screens/SandboxScreen.tsx`, `src/components/canvas/Inspector.tsx`)

- The Inspector shows a checkbox with the part's `caching.label` for a part that
  offers it, bound to the node's `caching`, with the setting's facts.
- The neutral note becomes "Queues and object storage aren't judged by these
  checks yet. A link through one is treated as a direct link to what's behind
  it."
- When `edgeJudged`: a note says the spike check assumes half of requests are
  cacheable GETs and that a caching edge answers 9 in 10 of those, so the web tier
  carries 55% of the spike; these are scenario numbers, not measurements; and the
  discount applies only to servers reached through the edge. Numbers derive from
  `EDGE_SHARE` and `EDGE_HIT`.

### Saved designs and import/export

Designs store part types and now an optional per-node `caching`. Old designs load
unchanged, except the Google `cloud-cdn` case above. A saved AWS design that put
CloudFront between users and the load balancer now gets edge verdicts it did not
get before; that is expected.

## Not modelled (docs silent or contradict), and why

- **Azure caching misconfiguration as a failing check.** Microsoft warns that
  caching an authenticated or dynamic *route* risks leaking data and recommends
  separate static and dynamic routes. The sandbox graph has no routes or path
  patterns, so a check would fail every design that turns caching on and teach
  that enabling it is wrong. The warning is in the part's facts and the screen
  note instead.
- A cache hit ratio, edge capacity, edge-location failure mechanics for AWS or
  Azure, request collapsing for Azure, Origin Shield, serve-stale, origin groups
  and per-method failover (next cycle). Traffic Manager's health-check-off,
  manual-failover pattern (the verdicts assume traffic has been moved; DNS
  failover time is stated in the facts, not simulated).
- Behavior of one cloud's CDN applied to another's.

## Review focus

Inputs a happy path would not exercise:

1. A design with no caching-capable part: checks and results identical to before.
2. A caching part with caching off (Front Door and Google defaults), or CloudFront
   with caching switched off: no discount, and the spike reason says why.
3. Users linked both to the edge and straight to a load balancer: no discount,
   and the reason names the bypassed server.
4. The only edge lost: users are cut off; the spike and "Lose any one" reasons are
   the existing reachability reasons.
5. Azure: Traffic Manager linked to Front Door and to Application Gateway; losing
   Front Door leaves the second path (reachable), and the spike gets no discount
   because the second path bypasses the edge.
6. A caching part but no web server: no `edge_load`, results unchanged.
7. Google: the regional load balancer part has no caching setting; the global one
   does. A saved design containing the removed `cloud-cdn` part shows the
   not-in-palette message and can still be exported.
8. A sandbox file with a `[route, neutral]` or `[serve]` extra, or an overlay for
   an unknown id or an already-cached part: refused with a clear message.
9. A saved design from before this change still opens (except item 7).
10. Interaction with the cache rule: a design with both a cache and an edge keeps
    both rules independent.

## Testing

- Schema: `caching` field, `edge_load` refinement, overlay merge and its errors,
  the three allowed extra role lists.
- Engine: discount applies only when every server sits behind an active edge;
  exact reason strings for caching off, edge lost, bypass.
- Sandbox: spike label and `edge_load` presence per design; Traffic Manager
  second-path case; no-edge designs byte-for-byte as before.
- Content, per cloud: part scope, roles, `caching` default, own-docs hosts only
  (AWS `docs.aws.amazon.com`; Azure `learn.microsoft.com`; Google
  `cloud.google.com` and `docs.cloud.google.com`).
- UI: Inspector toggle, neutral note without "CDNs", edge note only when judged.
- Whole suite, `tsc`, `oxlint`, `npm run schemas`, link check and content load.
- A browser pass on all three sandboxes (toggle caching, bypass link, lose the
  edge, Azure second path), with seeded data cleared afterwards.

## Not decided here

Nothing is left open for this cycle. Next cycle: origin groups, per-method
failover and serving stale content, per cloud.
