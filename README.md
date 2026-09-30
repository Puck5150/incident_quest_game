# Incident Quest

A browser game that teaches IT through realistic troubleshooting. Take an
incident ticket, investigate with a simulated terminal, logs, config files,
traces, metrics and CI pipeline views, name the root cause, fix it, and get a
debrief with the ideal path, a non-IT analogy, and links to the official docs.

Current incidents cover DNS, Linux disk space, Kubernetes CrashLoopBackOff,
Terraform state locking, GitHub Actions, and a microservices cascading failure.

## Run it

```sh
npm install
npm run dev     # play at http://localhost:5173
npm test        # validates every scenario and runs the game logic tests
npm run build   # also fails on any invalid scenario
```

## Docs

- [PLAN.md](PLAN.md): architecture, data model, game loop, scoring
- [AUTHORING.md](AUTHORING.md): write your own incidents (they're YAML, no code)
- [CONTENT_TODO.md](CONTENT_TODO.md): output formats still to verify against real systems
- [PARKING_LOT.md](PARKING_LOT.md): ideas for later
