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
- **Cloud system design (AWS, Azure, GCP)** (requested 2026-09-30). Two possible shapes:
  1. *Incident-style:* troubleshoot a flawed architecture (single-AZ database outage,
     missing autoscaling, public S3 bucket, cross-region latency). Fits the current
     engine and schema as-is.
  2. *Design challenges:* a new game mode where the player builds an architecture from
     requirements (SLOs, traffic, budget) and is scored on trade-offs. Needs new
     schema, UI and scoring. Would lean on the AWS Well-Architected Framework, the
     Azure Well-Architected Framework / Architecture Center, and the Google Cloud
     Architecture Framework.
  Note: the plan's track 6 covers AWS/Azure core services but not GCP.
- Amazon Builders' Library source for timeouts/retries (page couldn't be fetched)
- Tracks beyond the six MVP scenarios: Fundamentals, Windows/identity, Scripting and code, Cloud (AWS/Azure), Configuration as Code (Ansible/GitOps), Observability as its own track, SRE, Security/DevSecOps
- More scenarios per track and difficulty levels 3–5

## Authoring tooling
- JSON Schema generated from the Zod schema, for YAML autocomplete and validation in VS Code
- Scenario preview/"play from file" dev page
- Link checker for `sources` URLs in CI
