# Parking Lot (v2+)

Out of scope for the MVP. Add items here instead of adding them to the code.

## Platform
- Backend, accounts, cloud save/sync
- Multiplayer / team incidents
- Leaderboards
- AI-generated scenarios

## Gameplay
- Terminal follow-ups (PLAN_TERMINAL.md done): real owners and modes on the simulated disk (so ls -l, stat, chmod tell the truth), more incidents with fixes made by editing files, disk files for package-lock.json excerpts
- Daily-play streak (MVP uses a clean-resolution streak; see PLAN.md open question 3)
- More multi-stage incidents (4 two-stage shipped: PLAN_MULTI_STAGE.md; 10 three-stage difficulty-5 shipped: PLAN_DIFFICULTY_5.md)
- Shifts v2: save a shift across reloads; design challenges as "planned work" between pages
- Postmortem-writing exercise after the debrief (SRE track)

## Content
- Continuity pass done 2026-10-02 (every investigation command discoverable; every stage verifiable).
  Keep reading new incidents' ideal paths against `help` before shipping.
- More cloud content: priority AWS, then Azure, then Google Cloud. Shipped: PLAN_CLOUD_COVERAGE.md
  phases A-D and design challenges on the exam-outline gaps (ingestion, caching, containers,
  identity) for all three clouds, and 4 multi-stage incidents. Candidates: Azure DNS, canvas
  challenges on the newer topics; Google Cloud is thinnest (7 incidents)
- `concepts` for design challenges (PLAN_GUIDANCE.md G4; option facts stand in for now)
- Amazon Builders' Library source for timeouts/retries (page couldn't be fetched)
- More tracks: Fundamentals, Windows/identity, Scripting and code, Configuration as Code (Ansible/GitOps), Observability as its own track, SRE, Security/DevSecOps
- Every track has at least 8 incidents (done 2026-10-02). Difficulty-5 incidents done (PLAN_DIFFICULTY_5.md): one per track