# Parking Lot (v2+)

Out of scope for the MVP. Add items here instead of adding them to the code.

## Platform
- Backend, accounts, cloud save/sync
- Multiplayer / team incidents
- Leaderboards
- AI-generated scenarios
- URL routing / deep links to a specific incident / back-button support

## Gameplay
- Typed fix commands in the terminal counting as actions (e.g. `systemctl restart nginx`)
- Stateful terminal simulation (filesystem that actually changes, `cd`, pipes)
- Tab completion in the terminal
- Daily-play streak (MVP uses a clean-resolution streak; see PLAN.md open question 3)
- Option to disable the time bonus / "relaxed mode"
- Timed "on-call shift" mode: multiple incidents queued at once
- Multi-stage incidents (fix reveals a second problem)
- Postmortem-writing exercise after the debrief (SRE track)

- Collapse the ticket/diagram once investigating starts, so the tools sit higher on the screen
- Human-readable labels for evidence tags in the debrief (currently shows the tag id plus where it lives)

## Content
- **Cloud system design, part 2: design-challenge mode** (requested 2026-09-30).
  Part 1 (incident-style cloud scenarios) shipped in Milestone 7. Part 2 is a new
  game mode: build an architecture from requirements (SLOs, traffic, budget) and
  get scored on trade-offs. Needs new schema, UI and scoring; would draw on the
  AWS and Azure Well-Architected Frameworks and the Google Cloud Architecture Framework.
  **Planned in PLAN_DESIGN_CHALLENGES.md (awaiting approval).**
- More cloud incidents: public storage bucket, missing autoscaling, cross-region
  latency, IAM least privilege, DNS failover TTLs.
- Amazon Builders' Library source for timeouts/retries (page couldn't be fetched)
- Tracks beyond the six MVP scenarios: Fundamentals, Windows/identity, Scripting and code, Cloud (AWS/Azure), Configuration as Code (Ansible/GitOps), Observability as its own track, SRE, Security/DevSecOps
- More scenarios per track and difficulty levels 3–5

## Authoring tooling
- JSON Schema generated from the Zod schema, for YAML autocomplete and validation in VS Code
- Scenario preview/"play from file" dev page
- Link checker for `sources` URLs in CI
