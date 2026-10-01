# Plan: In-game guidance (help without giving the answer)

Status: **G2 and G3 built** (2026-10-01) with the defaults below, except: no
evidence counter (counting only key evidence would show which logs matter) and
no coaching toggle (the coach line lives inside the Field guide, so it's never
in the way). Requested 2026-10-01: "help reference and
guidance in all of these challenges along the way", not an auto-complete.

## 1. Where we are

| Help | Incidents | Slot challenges | Canvas challenges |
|---|---|---|---|
| Hints (nudge, direction, answer; cost XP) | ✓ | ✓ | ✓ |
| Option / component facts (sourced) | | ✓ | ✓ |
| Concepts (definitions + docs links) | debrief only, 32 of 63 items | none | none |
| How to approach the problem | none | none | none |

Hints are the only in-play help, and they're about *this* problem, so each one
costs XP and edges toward the answer. A learner who doesn't know what a route
table or an RU is has nowhere to look without paying for a hint.

## 2. Principles

1. **Reference, not answers.** Guidance explains the platform and the method;
   only hints point at this problem's cause. The line: guidance would still be
   true and useful in a *different* incident on the same services.
2. **Free and always there.** Like having the docs open at work. No XP cost;
   hints keep their cost.
3. **Doesn't give away the cause by what it includes.** A reference panel
   listing only "reserved concurrency" would be a hint. Each item's reference
   covers the services and ideas *in the scenario* (including the ones behind
   wrong hypotheses), never just the one that matters.
4. **Pull, not push.** Nothing pops up mid-play. One optional line of coaching
   per phase, which players can turn off.

## 3. What gets built

### 3.1 Field guide panel (all three modes)

A "Field guide" tab next to the hints, with three sections:

- **Concepts in this scenario:** the item's `concepts` (term, plain-English
  text, official docs link), shown *during* play, and still in the debrief.
  Content work: add `concepts` to every incident and challenge (about 30 items
  have none; existing ones are reviewed for spoilers under principle 3).
- **How to approach it:** short method cards per mode, shared across items, so
  they teach a habit rather than a solution. Examples:
  - Incident: "Read the whole error: what refused it, and why?" / "Compare
    what works with what doesn't" / "What changed just before it broke?" /
    "Check, then change one thing, then verify."
  - Design: "Turn each requirement into a test" / "Which part lives in only one
    zone?" / "What does each option cost, and is that what the brief asked for?"
- **Tools on this screen:** how to use the terminal (help, history, Tab,
  typed fixes), logs, metrics charts, traces, the pipeline view, the canvas
  keyboard controls. Shared, written once.

### 3.2 Phase coach (one line, optional)

A single sentence that changes with the phase, e.g. incidents: Briefing →
"Read the ticket for symptoms, not causes." Investigating → "Collect evidence
from at least two places before naming a cause." Acting → "You named the
cause; now fix it, then check it's fixed before closing." Design: before the
first run → "Run the stress tests early: failures tell you which requirement
you missed." A settings toggle ("Coaching tips") turns it off. Shared text,
not per item.

### 3.3 Evidence progress (incidents)

"Evidence found: 2" counted from the key evidence the player has opened,
shown *without* the total, so it rewards investigating without saying how much
is left. (Optional; see open question 3.)

### 3.4 Authoring rules and checks

- `concepts` becomes required for every incident and challenge (2–6 items).
- AUTHORING gets a "Writing guidance that isn't a hint" section with the
  principle-3 test.
- The validator rejects concept terms that appear in a hypothesis marked
  correct or an action label of kind fix as an exact phrase, as a cheap
  spoiler guard (authors can rephrase).

## 4. Milestones

| # | Work | Done when |
|---|---|---|
| G1 | This plan | Approved |
| G2 | Field guide panel (concepts in play, method cards, tool help) for incidents; phase coach + toggle | Playable; tests; docs |
| G3 | Same panel for slot and canvas challenges; challenge method cards | Playable in both modes |
| G4 | `concepts` for every item that lacks them (AWS and Azure first), spoiler review of existing ones, validator rule, AUTHORING section | `npm test` enforces it |
| G5 | Design challenges on the remaining exam topics (Kinesis ingestion, ElastiCache, containers on ECS/EKS and AKS, Entra ID), built with guidance from the start | Shipped |

## 5. Risks

- **Guidance becomes a hint.** Principle 3, the review in G4 and the validator
  guard; method cards are generic by design.
- **Clutter.** Everything lives in one tab, collapsed; the coach line is one
  sentence and can be turned off.
- **Authoring cost.** About 30 items need concepts; done in G4, AWS and Azure
  first, reusing definitions across items where they're identical.

## 6. Open questions (my default in **bold**)

1. Field guide free, hints keep their XP cost? **Yes.**
2. Phase coach on by default (toggle to turn off)? **Yes.**
3. Evidence progress counter ("Evidence found: 2", no total)? **Yes.**
4. Then build the G5 design challenges? **Yes, after G4.**
