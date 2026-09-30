# Plan: Design canvas (free-form architecture building)

Status: **approved** with the defaults in §8. Building from C2.

---

## 1. Why a canvas, and what it adds

Slot challenges ask "which option for each tier?". The architecture's *shape* is
fixed by the author, so the key idea ("does anything live in only one zone?")
is packed into option labels like "RDS Multi-AZ".

A canvas lets the player **build the shape themselves**. You place components
into zones, connect them, and decide how data is replicated. Multi-AZ stops
being a checkbox and becomes something you construct: a primary in zone A, a
standby in zone B, and a *synchronous* replication link between them. The stress
tests then knock out zones and components and check whether traffic can still
reach something that can serve it.

Canvas challenges are an **additional mode**. Slot challenges stay; they're
quicker and better for introducing a concept.

---

## 2. What the canvas looks like

```
┌ Palette ───────┐  ┌──────────────── us-east-1 ─────────────────┐  ┌ Global ─────┐
│ + Load balancer│  │  ┌── us-east-1a ──┐   ┌── us-east-1b ──┐    │  │             │
│ + Web server   │  │  │ [web-1]        │   │ [web-2]        │    │  │ [CDN]       │
│ + Database     │  │  │ [db-primary] ══╪═══╪═[db-standby]   │    │  │             │
│ + Read replica │  │  └────────────────┘   └────────────────┘    │  └─────────────┘
│ + Cache        │  │  Regional: [ALB]                            │
└────────────────┘  └─────────────────────────────────────────────┘
  users ──▶ CDN ──▶ ALB ──▶ web-1, web-2 ──▶ db-primary      ═══ = sync replication
```

- **Lanes, not free positioning.** Zones are columns inside a region box, and
  there are lanes for regional and global services. Where you drop a component
  *is* a design decision (which zone). Within a lane, components simply stack.
  There are no x/y coordinates to fiddle with, the layout is always tidy, and it
  collapses to stacked lanes on a phone.
- **Two kinds of connection:** *traffic* (arrows: who sends requests to whom) and
  *replication* (double line, marked **sync** or **async**).
- The palette only offers the components the challenge allows, each with the
  same kind of sourced facts as today's option cards.

---

## 3. Interaction, and accessibility as a requirement

Dragging is a convenience, never the only way. WCAG 2.2 has a success criterion
for exactly this (2.5.7 Dragging Movements, level AA): anything done by dragging
must also be possible with single clicks or taps. I'll quote its wording in the
first build milestone.

| Action | With a mouse / touch | Without dragging (keyboard, screen reader, phone) |
|---|---|---|
| Add a component | Drag from the palette into a lane | Palette item → "Add to…" menu listing the lanes |
| Move a component | Drag to another lane | Component menu → "Move to…" |
| Connect | Click **Connect**, then click the target | Component menu → "Send traffic to…" / "Replicate to… (sync/async)" |
| Remove | Component menu → Remove | Same |

- **Connections are never dragged.** Drawing lines by dragging is fiddly with a
  mouse and nearly impossible with a keyboard or on a phone. A two-click
  "connect mode" works for everyone.
- Every change is announced to screen readers ("web-2 added to us-east-1b").
  The canvas also has a plain **list view** of components and connections,
  which doubles as the phone layout.
- **Drag library:** my default is **none**. Drop targets are whole lanes (big and
  forgiving), so plain pointer events plus the menus cover it in a small amount
  of code. If touch edge cases bite (scrolling while dragging on iOS), I'd add
  **dnd-kit** rather than hand-roll fixes. It's built with keyboard and screen-reader
  support. React Flow is overkill: it's a general pan/zoom node editor, and we
  deliberately don't want free positioning.

---

## 4. How a design is evaluated (deterministic, explainable)

The design is a small graph: components (type + lane) and connections
(traffic or replication). Each stress test is an **event** plus a **check**:

1. **Apply the event:** remove what fails. A zone outage removes every *zonal*
   component in that zone. Regional components (like a load balancer) survive a
   zone outage; global ones survive a region outage. "Instance failure" removes
   one component chosen by the author.
2. **Promote what would take over:** a standby connected by **sync** replication
   with **automatic failover** becomes the primary. An **async** replica does
   **not** take over automatically; the debrief explains the manual promotion and
   possible data loss (the lesson from the Milestone 7 AWS incident).
3. **Check:**
   - *Reachability:* is there still a traffic path from **users** to a working
     component of each required role ("serves pages", "accepts writes")?
   - *Capacity:* do the surviving compute components add up to the demand
     (for example "3× normal traffic with one zone down")?
   - *Data loss:* is the surviving writer's data fresh enough (sync = zero,
     async = seconds, backups only = minutes)?
   - *Budget:* the sum of component costs, in illustrative units, as today.

Every failure produces a sentence built from the graph, for example: *"After
us-east-1a failed: users → ALB → web-2 → ✗ no database accepts writes. db-1 was
in us-east-1a; db-2 is an async replica and needs manual promotion."*

The canvas highlights the failed components and the broken path, reusing the
existing stress-test sequence.

**Over-engineering** works as today: components can carry an `overkill` note, and
the challenge has a budget and reference topologies.

---

## 5. Data model (sketch)

```yaml
type: challenge
mode: canvas                 # slot challenges have no mode (the default)
id: aws-checkout-canvas
provider: aws
layout:
  regions:
    - { id: use1, label: "us-east-1", zones: [use1-az1, use1-az2] }
  global: true               # show a global lane

palette:
  - id: alb
    label: "Application Load Balancer"
    scope: regional          # zonal | regional | global -> which lanes accept it
    role: [route]
    cost: 1
    facts: ["..."]
  - id: ec2
    label: "EC2 instance (web)"
    scope: zonal
    role: [serve]
    capacity: 1              # units of normal traffic
    cost: 1
  - id: rds
    label: "RDS PostgreSQL instance"
    scope: zonal
    role: [write-store]
    replication: { sync_failover: auto, async_promotion: manual }
    cost: 2

demand: { serve: 3 }         # needed capacity
stress_tests:
  - id: az1-outage
    event: { zone_outage: use1-az1 }
    check: { reach: [serve, write-store], capacity: serve, rpo_at_most: zero }

reference_designs:           # full topologies; each must pass
  - name: "Recommended"
    nodes: [ ... ]
    edges: [ ... ]
counter_examples:            # designs that must FAIL a named test
  - name: "Everything in one zone"
    fails: [az1-outage]
    nodes: [ ... ]
    edges: [ ... ]
```

**Validator rules:** every reference design passes. Every counter-example fails
exactly the tests it names, which proves each stress test can catch a real
mistake. With free-form graphs we can't enumerate every possible design as the
slot validator does, so authors supply the counter-examples instead. Palette
scopes must match the lanes, and component counts are capped (≤ 12 per design)
so screens and explanations stay readable.

**Code layout:** `src/game/canvas.ts` holds the pure graph engine (apply event,
promote, reach, capacity, explain), unit-tested hard. The canvas UI only edits a
`{nodes, edges}` value and asks the engine what happened. Scoring, progress,
queue, skill tree and debrief header are reused unchanged.

---

## 6. Milestones

| # | Deliverable | Done when |
|---|---|---|
| C1 | This plan | You approve it |
| C2 | Canvas schema + validator (references pass, counter-examples fail), graph engine with explanations, thorough unit tests, one AWS canvas challenge (content only, no UI yet) | Tests and build pass; a broken reference or counter-example fails both |
| C3 | Canvas UI: lanes, palette, add/move via menus **and** drag, connect mode, remove, list view, running stress tests with failed nodes and paths highlighted | Build an architecture end to end with mouse and with keyboard only |
| C4 | Accessibility + phone pass: screen-reader announcements, WCAG 2.5.7 check, phone layout; canvas debrief shows your topology next to the reference (read-only canvas) | Keyboard-only and phone playthroughs; reduced-motion path |
| C5 | Content: canvas versions of the AWS, Azure and Google Cloud challenges, template + AUTHORING section | All validate; sources recorded |

Estimated at roughly twice the size of the slot-challenge mode. C2 is the part
that makes or breaks it: if the engine's explanations aren't clear, the canvas
won't teach anything.

---

## 7. Risks

- **Scope creep toward a diagramming tool.** Guard: lanes only, capped component
  count, no free positioning, zoom or styling.
- **"Why did that fail?" confusion.** Guard: every failure sentence is generated
  from the actual path, and the canvas highlights it. C2 isn't done until those
  sentences read well.
- **Authoring gets harder.** Guard: a template, counter-examples that document
  intent, and validator errors that name the failing path.
- **Phone usability.** Guard: the list view with menus is a full, first-class
  way to play, not a fallback.

---

## 8. Open questions (my default in **bold**)

1. **Lanes (zones and regions) instead of free x/y positioning.** **Yes.**
2. **Connections by click-to-connect and menus, never by dragging.** **Yes.**
3. **No drag library at first** (pointer events + menus); add dnd-kit only if touch problems appear. **Yes.**
4. **Canvas is an additional mode**; slot challenges stay. **Yes.**
5. **Replication as explicit sync/async links** the player builds, rather than a "Multi-AZ" toggle. **Yes**, because building it is the lesson. Provider-managed options can still appear as a single palette item when the provider hides the topology.
6. **Full play on phones** through the list view and menus; dragging on larger screens only. **Yes.**
7. **Cap at 12 components per design.** **Yes.**
