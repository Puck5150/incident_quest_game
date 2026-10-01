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
- Timed "on-call shift" mode: multiple incidents queued at once
- Multi-stage incidents (fix reveals a second problem)
- Postmortem-writing exercise after the debrief (SRE track)

## Content
- More design challenges (slot, canvas and "pick your cloud"; see AUTHORING.md)
- More cloud incidents: public storage bucket, missing autoscaling, cross-region
  latency, IAM least privilege, DNS failover TTLs.
- Amazon Builders' Library source for timeouts/retries (page couldn't be fetched)
- More tracks: Fundamentals, Windows/identity, Scripting and code, Configuration as Code (Ansible/GitOps), Observability as its own track, SRE, Security/DevSecOps
- More scenarios per track (each original track has two as of 2026-10-01) and difficulty 5

## Authoring tooling
- Scenario preview/"play from file" dev page
