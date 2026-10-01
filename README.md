# Incident Quest

A browser game that teaches IT through realistic troubleshooting. Take an
incident ticket, investigate with a simulated terminal, logs, config files,
traces, metrics and CI pipeline views, name the root cause, fix it, and get a
debrief with the ideal path, a non-IT analogy, and links to the official docs.

Current incidents cover DNS, an expired TLS certificate, Linux disk space and
a systemd memory limit, Kubernetes CrashLoopBackOff and a stuck image pull,
Terraform state locking and an unsafe refactor, GitHub Actions (a stale lock
file and token permissions), a microservices cascading failure and a message
queue poison-message loop, and cloud failures on AWS (a single-AZ database, an IAM permissions boundary,
Route 53 failover that never failed over), Azure (Application Gateway health
probes, a publicly readable blob container, an app moved away from its database) and Google Cloud (Cloud Run vs.
Cloud SQL connections, an autoscaler capped by regional CPU quota, a lifecycle rule on
the wrong bucket).

**Design challenges** flip it around: you build an architecture from a brief
(pick a service per tier), run stress tests like a zone outage or a 20× traffic
spike, and get scored on meeting the requirements without over-engineering.
Current challenges cover AWS, Azure and Google Cloud, in two forms: pick an
option per tier, or build the whole shape on a **design canvas** (components in
zones, traffic links, sync or async replication), by drag and drop or entirely
by keyboard or touch. Some challenges let you **pick your cloud**: the same
brief on AWS, Azure or Google Cloud, with a debrief that names the equivalent
services side by side and says where they genuinely differ.

**Play it:** https://puck5150.github.io/incident_quest_game/ (deployed from `main` by CI)

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
- [CONTENT_TODO.md](CONTENT_TODO.md): output formats still to verify against real systems
- [PARKING_LOT.md](PARKING_LOT.md): ideas for later
