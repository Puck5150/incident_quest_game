# Incident Quest

A browser game that teaches IT through realistic troubleshooting. Take an
incident ticket, investigate with a simulated terminal, logs, config files,
traces, metrics and CI pipeline views, name the root cause, fix it, and get a
debrief with the ideal path, a non-IT analogy, and links to the official docs.

You're a responder on the night shift at a global ops center: incidents arrive
as missions on the ops board, sectors light up on the wall map, and you clear
them under your own callsign. There are 53 incidents across Linux, networking,
containers, infrastructure as code, CI/CD, microservices, and AWS, Azure and
Google Cloud, from platform basics to multi-stage failures where the first
fix reveals the next problem. A free **Field
manual** on every screen explains the concepts in play and how to approach the
problem without giving the answer; hints are there too, at an XP cost.

**On-call shifts** put several incidents in play at once: pages arrive while you
work, each severity (SEV1 for major incidents to SEV5) has a response target, and handling urgent pages first earns
a triage bonus. Relaxed mode turns every clock off.

**Design challenges** flip it around: you build an architecture from a brief
(pick a service per tier), run stress tests like a zone outage or a 20× traffic
spike, and get scored on meeting the requirements without over-engineering.
Current challenges cover AWS, Azure and Google Cloud, in two forms: pick an
option per tier, or build the whole shape on a **design canvas** (components in
zones, traffic links, sync or async replication), by drag and drop or entirely
by keyboard or touch. Some challenges let you **pick your cloud**: the same
brief on AWS, Azure or Google Cloud, with a debrief that names the equivalent
services side by side and says where they genuinely differ.

**Play it:** https://puck5150.github.io/incident_quest_game/ (deployed from `main` by CI; see [RELEASING.md](RELEASING.md) for how changes go live and how to roll back)

## Run it

```sh
npm install
npm run dev     # play at http://localhost:5173
npm test        # validates every scenario and runs the game logic tests
npm run build   # also fails on any invalid scenario
npm run check-links   # every source URL still resolves (CI runs it weekly)
```

## Docs

- [PLAN.md](PLAN.md): architecture, data model, game loop, scoring
- [AUTHORING.md](AUTHORING.md): write your own incidents and design challenges (they're YAML, no code);
  try a file without any setup on the [preview page](https://puck5150.github.io/incident_quest_game/#/preview)
- [PLAN_DESIGN_CHALLENGES.md](PLAN_DESIGN_CHALLENGES.md): how design challenges work
- [PLAN_ONCALL_SHIFT.md](PLAN_ONCALL_SHIFT.md): on-call shifts (arrivals, targets, triage, scoring)
- [PLAN_MULTI_STAGE.md](PLAN_MULTI_STAGE.md): multi-stage incidents
- [PLAN_THEME.md](PLAN_THEME.md) and [PLAN_GUIDANCE.md](PLAN_GUIDANCE.md): the ops-center theme and the Field manual
- [CONTENT_TODO.md](CONTENT_TODO.md): output formats still to verify against real systems
- [PARKING_LOT.md](PARKING_LOT.md): ideas for later
