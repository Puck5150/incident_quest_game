# Incident Quest

A browser game that teaches IT through realistic troubleshooting. Take an
incident ticket, investigate with a simulated terminal, logs, config files,
traces, metrics and CI pipeline views, name the root cause, fix it, and get a
debrief with the ideal path, a non-IT analogy, and links to the official docs.

Current incidents cover DNS, Linux disk space, Kubernetes CrashLoopBackOff,
Terraform state locking, GitHub Actions, a microservices cascading failure, and
cloud architecture failures on AWS (single-AZ database), Azure (Application
Gateway health probes) and Google Cloud (Cloud Run vs. Cloud SQL connections).

**Design challenges** flip it around: you build an architecture from a brief
(pick a service per tier), run stress tests like a zone outage or a 20× traffic
spike, and get scored on meeting the requirements without over-engineering.
Current challenges cover AWS, Azure and Google Cloud, in two forms: pick an
option per tier, or build the whole shape on a **design canvas** (components in
zones, traffic links, sync or async replication), by drag and drop or entirely
by keyboard or touch.

## Run it

```sh
npm install
npm run dev     # play at http://localhost:5173
npm test        # validates every scenario and runs the game logic tests
npm run build   # also fails on any invalid scenario
```

## Docs

- [PLAN.md](PLAN.md): architecture, data model, game loop, scoring
- [AUTHORING.md](AUTHORING.md): write your own incidents and design challenges (they're YAML, no code)
- [PLAN_DESIGN_CHALLENGES.md](PLAN_DESIGN_CHALLENGES.md): how design challenges work
- [CONTENT_TODO.md](CONTENT_TODO.md): output formats still to verify against real systems
- [PARKING_LOT.md](PARKING_LOT.md): ideas for later
