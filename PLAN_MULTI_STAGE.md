# Plan: Multi-stage incidents

Status: **approved 2026-10-02 with the defaults in section 10; M1–M4 done.** The
stage is derived from the log (one per accepted close-out), so `Session` didn't
change; `when_actions` may name any action in the incident. JSON Schema already
regenerated. From PARKING_LOT.md:
"Multi-stage incidents (fix reveals a second problem)".

## 1. The idea

Real outages often have layers: you free the disk and the service still won't
start; you open the security group and the health check now fails for a
different reason. A multi-stage incident has two or three stages. Each stage is
a full investigate, name the cause, fix loop, and the next one starts when you
close out the previous one, the way an incident gets reopened.

The habit it teaches: **verify before you close.** The check that proves stage
1 is fixed is often the one that shows stage 2 coming.

## 2. Principles

1. **Existing incidents don't change.** The top level of a file stays stage 1;
   a multi-stage incident adds a `stages:` list for stage 2 onwards. All 53
   current files remain valid as they are.
2. **One stage at a time on screen.** Only the current stage's hypotheses and
   actions are shown; earlier fixes stay applied and the system's output
   reflects them.
3. **Same scoring, spread over stages.** No new penalty for the reopen: it's the
   scenario, not a mistake. Bonuses are earned per stage.
4. **Every stage is checked at build time** like a single incident is now, so a
   stage can't be unwinnable or have evidence nobody can see.

## 3. How it plays

1. Stage 1 plays exactly like an incident today.
2. When stage 1's fix is complete and you **close out**, the incident reopens:
   an update appears in the ticket (for example *"10:52 · Reopened by
   monitoring: health checks failing again, now with 404"*), the diagram can
   change status, new logs or metrics can appear, and the hypothesis form
   returns with stage 2's possible causes.
3. You investigate, name stage 2's cause, fix it, and close out again. After the
   last stage, the incident is resolved and the debrief opens.
4. A stage indicator in the header shows **Stage 2 of 2**. The ticket keeps a
   short timeline of updates so you can always reread what changed.

**When does stage 2 start: on close, or as soon as stage 1 is fixed?** On
close (see open question 1). A player who verifies after the stage 1 fix sees
the next symptom early (authors script the verifying command's output to show
it), which is exactly the habit we want. A player who closes without checking
still gets stage 2, as a reopen.

## 4. Authoring format

```yaml
# Stage 1 is the top level, unchanged: ticket, environment, terminal, logs,
# hypotheses, actions, solution_paths, key_evidence, evidence_labels, hints,
# debrief, ...
stages:
  - id: health-path
    update: |
      Reopened by monitoring at 10:52: targets register, then fail health
      checks with 404.
    diagram_status: { app: degraded }       # optional: node id -> new status
    terminal:                               # optional: extra commands from now on
      commands: [...]
    logs: [...]                             # optional: artifacts that appear now
    metrics: [...]
    hypotheses: [...]                       # this stage's causes (one correct)
    actions: [...]                          # this stage's actions
    solution_paths: [[fix-health-path]]
    key_evidence: [...]
    evidence_labels: {...}
    hints: { nudge, direction, answer }     # this stage's hints
    debrief:
      root_cause: |
        ...
      ideal_path: [...]
```

- **Changing earlier output:** existing commands already take `when_actions`, so
  a stage 1 command can print the stage 2 symptom once the stage 1 fix is in.
  That's how "verify reveals the next problem" is written; nothing new needed.
- **Ids** (hypotheses, actions, evidence) are unique across all stages.
- **Shared parts** stay at the top level: title, difficulty, par (for the whole
  incident), analogy, concepts, real_world, sources.
- **Limits:** up to 3 stages in total (top level plus 2), to keep a run under
  about 25 minutes.

## 5. Validation (build time)

On top of today's checks, for each stage:

- Exactly one correct hypothesis; every fix is in a solution path; solution
  paths use only that stage's actions.
- `when_actions` may name any action in the incident (a stage 1 command can
  react to a stage 2 fix, for verification).
- Key evidence must be visible **after the earlier stages' fixes and before this
  stage's own fixes** (today's rule, "visible before any action", generalised).
- Typed-fix regexes can't overlap scripted commands or other stages' typed fixes.
- The JSON Schema for editors gains `stages`.

## 6. Engine and scoring

- **Stage** is derived from the log: the number of accepted close-outs. The log
  stays one list of events, so replays, the transcript rebuild and shifts keep
  working unchanged.
- `CLOSE_INCIDENT` with the current stage fixed: if there's another stage,
  advance (phase back to investigating, feedback shows the update); otherwise
  resolve. Closing before the stage is fixed behaves as today.
- Hypotheses, actions and typed fixes come from the current stage; artifacts
  are the top level's plus every stage's up to the current one.
- **Scoring** (base still `100 × difficulty`; multi-stage incidents are rated
  3 to 5):
  - Methodical and Verified bonuses split evenly across stages: each stage
    that's methodical earns its share, and so on.
  - Hints: each stage has its own three tiers; each hint costs what it does now.
  - Wrong hypotheses and actions count across the whole incident.
  - The time bonus uses the incident's par for the whole run.
- **Debrief:** root cause and ideal path per stage, under "Stage 1" and
  "Stage 2" headings; evidence grouped by stage; the timeline marks each reopen.

## 7. Content: first conversions and new incidents

AWS first, then Azure. Two approaches, see open question 2:

- **New ids** that build on existing setups (for example
  `aws-alb-targets-unhealthy-twice`: security group port, then health check
  path), so players who finished the original still have it on record.
- Each new incident gets documentation-sourced facts and the usual
  CONTENT_TODO entries; no stage claims a behaviour the docs don't support.

Candidate scenarios (to be checked against the docs before writing):

| Cloud | Stage 1 | Stage 2 |
|---|---|---|
| AWS | ALB targets unhealthy: security group blocks the health check port | Then unhealthy with 404: health check path wrong after an app change |
| AWS | Lambda in a VPC can't reach the internet: no NAT route | Then calls time out at the database: security group or function timeout |
| Azure | Private endpoint DNS not linked to the app's VNet | Then refused: storage firewall or public access settings |
| Azure | Slot swap moved the wrong connection string | Then the new slot's managed identity can't read Key Vault |

## 8. Milestones

| # | Work | Done when |
|---|---|---|
| M1 | Schema, validation, engine stages, scoring split | Unit tests with a two-stage fixture; all 53 incidents unchanged |
| M2 | UI: stage indicator, ticket timeline, per-stage forms and hints, debrief by stage; works inside shifts | UI test plays a two-stage incident end to end |
| M3 | Content: 2 AWS, then 2 Azure multi-stage incidents | Sourced, linked, CONTENT_TODO entries |
| M4 | AUTHORING section, template, JSON Schema, preview page support | An author can write one from the docs alone |

## 9. Risks

- **Long runs.** Max 3 stages; par covers the whole incident.
- **Confusing reopen.** The update is shown prominently, in the ticket timeline
  and as feedback; the stage indicator says where you are.
- **Spoilers across stages.** Stage 2's hypotheses aren't visible until stage 2,
  and the Field manual's concepts are written as reference (PLAN_GUIDANCE.md).
- **Engine regressions.** M1 lands with every existing test unchanged.

## 10. Open questions (my default in **bold**)

1. Next stage starts on **close-out** (as a reopen), or automatically as soon as
   the previous fix is complete?
2. **New incident ids** for multi-stage versions, or convert existing incidents
   in place?
3. Hints: **separate tiers per stage**, or one set for the whole incident?
4. Up to **3 stages**?
5. Multi-stage incidents allowed as shift pages? **Yes**, they just take longer.
