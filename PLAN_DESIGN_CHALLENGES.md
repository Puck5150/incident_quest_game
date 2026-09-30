# Plan: Design-challenge mode (cloud system design, part 2)

Status: **draft, awaiting your approval.** No code has been written.

---

## 1. The idea in one paragraph

Incidents teach you to diagnose a system someone else built. Design challenges
teach you to **build** one. You get a brief with requirements (traffic,
availability, data-loss tolerance, budget). You pick a service for each tier of
the architecture, and the diagram updates as you go. Then you run **stress tests**
(an Availability Zone goes down, traffic spikes 10×, the database fails over) and
watch which ones your design survives. You can revise and re-run. The debrief
compares your design with reference designs, calls out over-engineering as well
as under-engineering, and links the official architecture guidance.

---

## 2. Core design decisions

### Slots, not a free-form canvas
Each challenge defines **tiers** (edge, compute, data, cache, async…), and each
tier offers 3–5 **options** (real services and configurations, e.g. "RDS Single-AZ",
"RDS Multi-AZ", "Aurora Global Database"). You pick one per tier (some tiers
allow "none").

*Why:* it's accessible (native radio groups, keyboard friendly), works on phones,
and every combination can be evaluated deterministically and explained. A
drag-and-drop canvas is far more code, and it's harder to score fairly. It goes
in the parking lot.

### Deterministic rules, not a simulator
We don't simulate traffic. Each option carries hidden **capabilities** written
by the author (`survives: [instance-failure, az-outage]`, `scales-to: 10x`,
`rpo: seconds`), and each stress test checks them. The results are exact, testable
and explainable: every pass or fail comes with authored feedback tied to a doc source.

### The player sees facts, not answers
Option cards show sourced facts: "Synchronous standby in another AZ; automatic
failover, typically 60–120 s (RDS docs)". They **don't** show "passes AZ outage".
Reasoning from the facts to the outcome is the skill being practiced. The
stress test reveals the answer.

### Over-engineering counts too
Passing every test isn't the whole score. AWS's Well-Architected Framework lists
"a multi-Region architecture when a multi-AZ architecture would satisfy business
requirements" as an anti-pattern. Each challenge's **budget** and **reference
designs** reward the simplest design that meets the requirements.

### Relative cost, not real prices
Real cloud prices vary by region, change often, and can't be kept verified here.
Options use **cost units** (for example 1–10 per month), labelled clearly as
illustrative and chosen so relative ordering is sensible (Multi-AZ costs roughly
double Single-AZ for the database tier, which reflects the extra standby
instance). Prices never appear as facts.

---

## 3. Game loop

```
BRIEF ──▶ DESIGN ──run stress tests──▶ RESULTS ──all pass──▶ DEBRIEF
            ▲                              │
            └────── revise (costs XP) ─────┘
```

1. **Brief:** the scenario (a business need, not a tech spec), requirements as a
   checklist (for example "Survive the loss of one AZ", "Lose at most a few seconds
   of orders", "Handle 5× launch traffic", "Budget: 12 units/month").
2. **Design:** one radio group per tier, with option cards. The live diagram and
   a cost meter update as you choose. Hints are available at the same three tiers
   and costs as incidents.
3. **Run stress tests:** each test runs in sequence with a short animation (the
   affected diagram node goes down, then the result appears). Each result has a
   one-line reason ("RDS Single-AZ: the only database copy was in the failed zone").
   Budget is checked like a test.
4. **Revise:** change options and re-run. Each extra run costs 10% of base XP,
   the same as a wrong hypothesis.
5. **Debrief:** your design next to the reference designs ("minimal passing",
   "recommended"), an over-engineering note if you spent more than needed, which
   tests failed on the first run and why, the analogy, and the sources.

---

## 4. Data model

A challenge is YAML in the same `content/<track>/<id>.yaml` layout, with
`type: challenge`. The schema becomes a discriminated union on `type`
(`incident` stays the default), so the loader, validator, id/track rules and
saved progress all keep working unchanged.

```yaml
type: challenge
id: aws-checkout-az-resilience
track: cloud-design
difficulty: 2
title: "A checkout that survives losing a data center"
provider: aws

brief: |
  The shop lost 40 minutes of sales last month when one Availability Zone had
  problems. Leadership wants checkout to keep working through the loss of any
  single AZ, without paying for more than it needs.

requirements:              # shown to the player as a checklist
  - "Keep checkout available if one Availability Zone fails"
  - "Lose no more than a few seconds of orders"
  - "Handle 3× normal traffic during sales"
budget: 12                  # cost units per month

tiers:
  - id: compute
    label: "Web / app tier"
    options:
      - id: ec2-single
        label: "One EC2 instance"
        cost: 1
        facts: ["A single virtual machine in one Availability Zone."]
        capabilities: { survives: [], scales: 1 }
      - id: asg-multi-az
        label: "EC2 Auto Scaling group across 2+ AZs behind an ALB"
        cost: 3
        facts: ["Auto Scaling can launch and replace instances across Availability Zones.", "..."]
        capabilities: { survives: [instance-failure, az-outage], scales: 10 }
  - id: database
    label: "Orders database"
    options:
      - id: rds-single-az
        label: "RDS PostgreSQL, Single-AZ"
        cost: 2
        facts: ["One DB instance in one Availability Zone."]
        capabilities: { survives: [], rpo: minutes }
      - id: rds-multi-az
        label: "RDS PostgreSQL, Multi-AZ"
        cost: 4
        facts: ["Synchronous standby in a different AZ.", "Automatic failover, typically 60–120 seconds."]
        capabilities: { survives: [instance-failure, az-outage], rpo: zero }
      - id: aurora-global
        label: "Aurora Global Database (two Regions)"
        cost: 11
        facts: ["Replicates across AWS Regions for Region-level disaster recovery."]
        capabilities: { survives: [instance-failure, az-outage, region-outage], rpo: seconds }
        overkill: "Region-level recovery wasn't a requirement; multi-AZ meets it for a third of the cost."

stress_tests:
  - id: az-outage
    label: "us-east-1a becomes unreachable"
    requires: { every_tier_survives: az-outage }
  - id: sale-traffic
    label: "Traffic triples during a flash sale"
    requires: { tier: compute, min_scales: 3 }
  - id: data-loss
    label: "Database host fails mid-transaction"
    requires: { tier: database, rpo_at_most: seconds }

failure_feedback:          # optional per option × test explanation overrides
  rds-single-az:
    az-outage: "The only copy of the database was in the failed zone."

reference_designs:
  - name: "Recommended"
    picks: { compute: asg-multi-az, database: rds-multi-az }
    why: "Every tier spans two AZs; synchronous replication keeps RPO at zero."

hints: { nudge: ..., direction: ..., answer: ... }
analogy: { title: ..., text: ... }
debrief: { summary: ..., real_world: ... }
sources: [ ... ]
```

**Rule vocabulary (kept deliberately small):** `every_tier_survives: <event>`,
`tier + min_scales`, `tier + rpo_at_most` (zero < seconds < minutes < hours), and the
budget. New rule types get added only when a challenge needs one.

**Validator additions:**
- At least one reference design passes every test and fits the budget.
- Every design tagged "Recommended" really is passing.
- Option ids are unique, and picks reference real tiers and options.
- Every option has at least one sourced fact.
- A test proves some design fails each stress test, so no test is decorative.

---

## 5. Architecture

- `src/game/challenge.ts`: pure functions. `evaluate(challenge, picks)` returns
  per-test pass/fail with reasons; `scoreChallenge(challenge, runs, hints)` returns
  the itemized score. Unit-tested the same way as incident scoring.
- `src/screens/ChallengeScreen.tsx`: brief, tier radio groups with option cards,
  live diagram (reuses `Diagram`), cost meter, run button, results sequence.
- `src/screens/ChallengeDebrief.tsx`: reuses `Card`, `Prose`, `CountUp`, `Icon`
  and the resolve animation.
- The queue, skill tree and progress need no structural change: a challenge is
  just another item with an id, a track and a best score. Queue cards get a
  "Design" label so the two modes are easy to tell apart.

### Scoring (starting point)
| Line | Value |
|---|---|
| Base | 100 × difficulty |
| Passed on first run | +20% |
| Within budget, no over-engineering | +20% |
| Extra run | −10% each |
| Hints | −10 / −25 / −50% (same as incidents) |
| Floor | 10% |

---

## 6. First three challenges (one per provider)

All three sit in a new **Cloud System Design** track that requires Cloud Platforms.

1. **AWS: "A checkout that survives losing a data center"** (difficulty 2). Choices
   across compute, database and caching; tests are an AZ outage, 3× traffic and a
   DB host failure. Aurora Global is the over-engineering trap.
   *Sources: RDS Multi-AZ docs, EC2 Auto Scaling docs, Well-Architected REL10.*
2. **Azure: "A marketing site ready for a TV ad"** (difficulty 2). Choices across
   the edge (Front Door vs. an Application Gateway alone), compute (App Service
   scale-out settings) and static assets (Blob Storage + CDN). Tests are a 20× spike,
   a failed region and a health-probe failure (links back to the Milestone 7
   incident). *Sources: Azure Architecture Center, Front Door / App Service docs,
   Azure Well-Architected.*
3. **Google Cloud: "Launch-day sign-ups without melting the database"** (difficulty 3).
   Choices across Cloud Run max instances, the connection strategy (pool size,
   managed connection pooling) and write buffering (Pub/Sub or not). Tests are a
   15× spike, the connection budget and a DB failover. It's the design sequel to
   the Milestone 7 incident. *Sources: Cloud Run and Cloud SQL docs, Google Cloud
   Architecture Framework.*

Each option's facts get fetched from official docs while writing, as before, with
anything unverifiable logged in `CONTENT_TODO.md`.

---

## 7. Milestones

| # | Deliverable | Done when |
|---|---|---|
| D1 | This plan | You approve it |
| D2 | Schema union + validator rules, `challenge.ts` engine + scoring with tests, one placeholder challenge playable in a plain UI | Tests and build pass; a broken challenge fails both; you can design, run, revise, finish |
| D3 | Challenge UI polish: option cards, live diagram, cost meter, stress-test sequence (with reduced-motion path), challenge debrief, "Design" labels in queue and tree | Browser check desktop + phone, keyboard-only playthrough |
| D4 | Three doc-sourced challenges, `_challenge_template.yaml`, AUTHORING.md section | All validate; reference designs pass; sources recorded |

---

## 8. Open questions (my default in **bold**)

1. **Relative cost units instead of real prices.** **Yes**, because real prices can't be kept verified.
2. **Hide which stress tests each option passes.** **Yes**; show sourced facts only.
3. **Re-runs allowed, with a penalty.** **Yes, −10% each**, same as a wrong hypothesis.
4. **One provider per challenge** (not "pick your cloud"). **Yes**; a provider-agnostic version goes in the parking lot.
5. **Slots, not a drag-and-drop canvas.** **Yes** for now; the canvas goes in the parking lot.
6. **New "Cloud System Design" track requiring Cloud Platforms.** **Yes**, rather than mixing challenges into the incident track.
