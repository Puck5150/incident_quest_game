# Parking Lot (v2+)

Out of scope for the MVP. Add items here instead of adding them to the code.

## Platform
- Backend, accounts, cloud save/sync
- Multiplayer / team incidents
- Leaderboards
- AI-generated scenarios

## Gameplay
- Stateful terminal simulation (filesystem that actually changes, `cd`, pipes)
- Daily-play streak (MVP uses a clean-resolution streak; see PLAN.md open question 3)
- More multi-stage incidents (4 shipped: PLAN_MULTI_STAGE.md); Google Cloud ones; a difficulty-5 three-stage incident
- Shifts v2: save a shift across reloads; design challenges as "planned work" between pages
- Postmortem-writing exercise after the debrief (SRE track)

## Content
- **Next: continuity pass on every incident.** Commands that the hints, ideal path or
  debrief tell the player to run must actually be runnable in that incident's terminal
  (reported: expired-tls-certificate tells you to verify the certificate but offers no
  openssl commands). Expand each incident's commands so every verification step has
  evidence to gather; consider a build check that flags commands named in the text
  but missing from the terminal.
- More cloud content: priority AWS, then Azure, then Google Cloud. Shipped: PLAN_CLOUD_COVERAGE.md
  phases A-D and design challenges on the exam-outline gaps (ingestion, caching, containers,
  identity) for all three clouds, and 4 multi-stage incidents. Candidates: Azure DNS, canvas
  challenges on the newer topics; Google Cloud is thinnest (7 incidents)
- `concepts` for design challenges (PLAN_GUIDANCE.md G4; option facts stand in for now)
- Amazon Builders' Library source for timeouts/retries (page couldn't be fetched)
- More tracks: Fundamentals, Windows/identity, Scripting and code, Configuration as Code (Ansible/GitOps), Observability as its own track, SRE, Security/DevSecOps
- More scenarios per track (each original track has two as of 2026-10-01) and difficulty 5
