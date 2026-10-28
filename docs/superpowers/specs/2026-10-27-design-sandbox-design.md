# Design sandbox

Date: 2026-10-27
Status: implemented on branch design-sandbox

## Purpose

The game has scored design challenges, including a canvas where the player
places cloud components in zones, links them, and stress tests knock parts
out. Every canvas starts from a brief, a small fixed palette and a budget.

The player wants an open-ended counterpart: a place to draw a real-world
architecture on AWS, Azure or Google Cloud, in the spirit of Visio, and still
get the game's failure feedback on it. The sandbox is for **practice with
feedback**, not scoring.

### What was asked for

- A system design sandbox with real-world architecture, resembling Visio and
  other design software: free-form, not the guided canvas challenges.
- Real cloud services for all three clouds (not cloud-neutral boxes).
- Several designs kept in the browser, with export and import.
- Feedback by standard checks the player picks and runs on demand. No score.
- Reuse the existing canvas engine first and grow it later.

### Success criteria

- A player can create a design on a chosen cloud, build it from that cloud's
  real services, and come back to it after a reload.
- The player can run "lose a zone", "lose a region", "lose any one component of
  a type" and "traffic spike" against their design, and see what breaks and why.
- Queues, caches, object storage and CDNs can be placed and linked, and the
  screen is honest that the checks do not judge them yet.
- A design can be exported to a file and imported again, and a file that the
  editor could not have produced is rejected with a plain message.
- Scored canvas challenges behave exactly as before.

## Design

### Content: `content/sandbox/{aws,azure,gcp}-sandbox.yaml`

A new content kind, `sandbox`, one file per cloud, validated at build time with
the rest of the content (and previewable like other kinds). Each file has:

- `type: sandbox`, `provider` (`aws` | `azure` | `gcp`), a `title`.
- `extends`: the id of that cloud's single-provider canvas challenge
  (`aws-checkout-canvas`, `azure-portal-canvas`, `gcp-signup-canvas`). Its
  palette (load balancer, web server, database) is reused, not copied.
- `layout`: fixed, two regions with two zones each, plus the global lane,
  using the same shape as a canvas challenge's `layout`.
- `palette`: extra items, in the same item shape as a canvas palette entry.
  Four per cloud, except Azure, which gets three: its base palette already has
  Azure Front Door as the global CDN-role part, and a second would duplicate it:

  | part | AWS | Azure | Google Cloud |
  |---|---|---|---|
  | queue | Amazon SQS | Azure Service Bus | Pub/Sub |
  | cache | Amazon ElastiCache | Azure Managed Redis (`managed-redis`; Azure Cache for Redis is being retired) | Memorystore for Redis (a zonal node) |
  | object storage | Amazon S3 | Azure Blob Storage | Cloud Storage |
  | CDN | Amazon CloudFront | (Azure Front Door, already in the base palette) | Cloud CDN |

  Scopes follow the docs: SQS, S3, Service Bus, Managed Redis, Blob Storage and
  Cloud Storage are regional; ElastiCache and Memorystore (a node) are zonal;
  CloudFront and Cloud CDN are global, and so is Pub/Sub (Google calls it a
  global service).

  Each has `facts` and the file has `sources` (title, url, retrieved), written
  from the vendor documentation in our own words. Questions about what a
  service does or its scope (zonal, regional, global) are answered from the
  docs, not from memory. Exact service choices (for example Front Door versus
  Azure CDN) are confirmed against the docs when authoring.

- `link_facts`: reused from the extended challenge.
- `sources`: required, as for other content.

### Roles

`ROLES` in `src/schema/constants.ts` gains `neutral`. A neutral part can be
placed and linked. The extra parts above use it. Before checks run
(`withoutNeutral` in `src/game/sandbox.ts`), every neutral part is contracted
away: a traffic path through one or more neutral parts (a CDN in front, a
queue between tiers) becomes a direct link from the part before to the part
after, as if the neutral part were not drawn. Any other link touching a
neutral part is dropped, so the engine never sees one.
`ROLES` is shared by the canvas and pick-cloud schemas, so the generated JSON
Schemas are regenerated (`npm run schemas`); adding a role value does not
change any existing file's validity. The plan verifies that nothing in the
engine, the editor or the schemas treats the role list as exhaustive.

### Engine: adapter, not a rewrite

`src/game/sandbox.ts` (pure, no React):

- `resolveSandbox(file, base)` builds an in-memory challenge:
  palette = base palette plus the file's extras (ids must not collide),
  the file's layout, a placeholder brief and requirements, a very large budget,
  no reference designs or counter-examples, and a `max_nodes` of 40.
- `sandboxChecks(c, design): CanvasTest[]` builds the checks menu from the
  current design:
  - one `zone_outage` per zone that has at least one component;
  - one `region_outage` per region that has at least one component;
  - one `single_failure` per palette type present in the design that has a
    non-neutral role (a neutral-only type would always "survive", implying the
    part was judged);
  - one traffic spike (`event: { none: true }`) with `capacity: 3`, only when
    the design has a web server.

  Each check's `reach` lists only the roles the design contains (`serve`,
  `write-store`); a design without a database is not failed for lacking one.
  The capacity requirement applies only when a serving component exists. A
  design with no web server and no database gets no checks at all, because
  every one would pass without meaning anything.
- `evaluateCanvas` and `canvasEdit.ts` run unchanged, apart from the node cap
  (next point). Checks run through `evaluateCanvas` on a challenge whose
  `stress_tests` are the generated list.

**Node cap.** `addNode` reads `MAX_NODES` today. It becomes
`c.max_nodes ?? MAX_NODES`, with `max_nodes` an optional field on the in-memory
type only; it is not in the content schema for scored challenges, which keep 12.

### Storage: `src/game/sandboxStore.ts`

- Key `incident-quest:sandbox`, separate from progress (`incident-quest:v1`) and
  the category filter.
- Shape: `{ version: 1, designs: [{ id, name, provider, design, updatedAt }] }`.
- Validated by hand, as `progress.ts` does, so no Zod in the startup bundle.
  Anything that fails validation (including duplicate design ids) is backed up
  to `incident-quest:sandbox:backup-<ms>` and the key is reset to an empty
  store, never silently discarded.
- Functions: `loadSandbox`, `saveSandbox`, `createDesign`, `renameDesign`,
  `deleteDesign`, `updateDesign`. All pure over a value plus the thin
  storage read/write, with `localStorage` looked up inside a try, as in
  `categoryFilter.ts`. `saveSandbox` returns false when storage is blocked or
  full, or when corrupt saved data could not be backed up (saving would
  overwrite the only copy). `createDesign` swaps in a fresh id if the given one
  is already taken.
- **Export:** one design as `{ version: 1, name, provider, design }`.
- **Import:** `readExport` checks the file's shape, then validates the design against that cloud's sandbox
  challenge: known types, node lanes allowed for their scope, edges join real
  nodes, replication links join two stores, under the node cap. A file that
  fails is rejected with a message naming the first problem. Files over
  1,000,000 bytes are refused in the list screen. Import never produces a
  design the editor could not have produced.

### Screens

- **`CanvasEditor`** (`src/components/canvas/CanvasEditor.tsx`): the editing
  surface of `CanvasScreen` (board, inspector, pointer drag, keyboard and touch
  controls, connect mode, screen-reader announcements) extracted into a
  component with props `challenge`, `design`, `onChange` and the highlight set.
  `CanvasScreen` keeps its brief, hints, cost meter and stress-run flow around
  it. This is a refactor of a shipped screen: it lands first and the existing
  `canvas-ui.test.tsx` and `canvas-edit.test.ts` must pass unchanged.
- **`SandboxListScreen`**: New (name and cloud), Open, Rename, Delete (inline confirm),
  Import. Empty state explains what the sandbox is.
- **`SandboxScreen`**: `CanvasEditor` plus a "Check" menu from
  `sandboxChecks`. Results show in the screen's own panel; failed components highlight on
  the board. Total cost is shown as information. Edits autosave. When the
  design contains neutral parts, the results panel says that queues, caches,
  CDNs and object storage are not judged by these checks, and that a link
  through one counts as a link straight past it. No score, XP or
  progress write. `App` keys the editor by design id, so it remounts per
  design.
- **Routing** (`src/App.tsx`): new `Screen` variant `{ name: 'sandbox'; id?: string }`;
  routes `#/sandbox` and `#/sandbox/<id>`; a "Design sandbox" nav button beside
  "Clearance map". Not gated by unlocks. An unknown or stale id replaces the history entry and lands on the list.
  The category filter, shifts and preview do not read sandbox data.

### Error handling and edge cases

- Storage blocked or throwing: the sandbox works for the session and says
  designs will not be saved.
- Corrupt saved data: backed up, then start empty.
- Import for a cloud whose palette changed since export: rejected, naming the
  component.
- Deleting the open design returns to the list.
- Two tabs: last writer wins, no merging.
- An empty design: checks run and say what is missing in the engine's usual
  plain-English reasons rather than crashing.
- Preview mode: unaffected.

## Testing

- `tests/sandbox-store.test.ts`: round trip; garbage and wrong-version values are
  backed up and start empty; blocked storage on read and on write; rename,
  delete and update; export shape.
- `tests/sandbox-import.test.ts`: valid file accepted; unknown type, wrong lane,
  dangling edge, replication link between non-stores, over-cap, wrong cloud.
- `tests/sandbox-engine.test.ts`: against the real engine and real content, a
  two-zone three-tier design survives losing either zone, losing any one web
  server or database, and the spike, but fails the region check and losing its
  only load balancer (it is one region and one load balancer); a single-zone
  design fails the zone check for that zone with a reason; neutral parts neither help
  nor hurt a result; a design without a database is not failed for lacking one.
- Content tests: each cloud has a sandbox file, `extends` resolves to a canvas
  challenge of the same provider, palette ids do not collide, every extra part
  has facts, the file has sources, the extras use the `neutral` role. The
  JSON-schema freshness test covers the new `sandbox` kind.
- `tests/sandbox-ui.test.tsx` (React Testing Library, in the style of
  `shift-ui.test.tsx`): create a design, add and link components, run a check and
  see highlights, reload and find it again, export then import, delete.
- Existing canvas tests unchanged, including `canvas-ui.test.tsx`.

## Out of scope

- Mixed-cloud designs (one design is one cloud).
- An editable layout (regions and zones are fixed per cloud).
- Free-form shapes, text boxes and annotations.
- PNG or SVG export; sharing by URL.
- Checks that judge neutral parts (queue, cache, CDN, object storage). Each is a
  later, separate step that adds a role and its rule.
- Scoring, XP or progress.
- Anything in the Clearance map or the category filter.

## Open points

None blocking. Two are settled when the plan is written, not by a decision here:

- Exact service choice for the CDN and queue on each cloud, and each part's
  scope (zonal, regional, global), are confirmed from the vendor docs while
  authoring.
- The sandbox node cap of 40 and the traffic-spike multiple of 3 are starting
  values; both live in one place and change in one line.
