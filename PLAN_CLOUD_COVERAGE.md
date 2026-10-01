# Plan: Cloud coverage on AWS, Azure and Google Cloud

Status: **draft, awaiting approval**. Requested 2026-10-01: a comprehensive suite of
incidents and design challenges on all three platforms, with each platform's basics
covered. Priority: **AWS, then Azure, then Google Cloud**.

## 1. Where we are

17 cloud items: 9 incidents (3 per provider, difficulty 2–4) and 8 design challenges.
They're good at failure modes (zones, health checks, failover, quotas, latency) but
assume the basics.

| Area | AWS | Azure | Google Cloud |
|---|---|---|---|
| Regions & zones, resilience | ✓ RDS single-AZ, AZ challenges | ✓ zone canvas | ✓ zone canvas |
| Identity & access: basics | ✗ | ✗ | ✗ |
| Identity & access: advanced | ✓ permissions boundary | ✗ | ✗ |
| Networking: VPC/VNet, subnets, routes, NAT | ✗ | ✗ | ✗ |
| Firewalls: security groups / NSGs / VPC firewall rules | partial (Route 53 incident) | ✗ | ✗ |
| Compute & autoscaling | partial (challenges) | partial (challenges) | ✓ quota |
| Serverless | ✗ Lambda | ✗ Functions | ✓ Cloud Run |
| Object storage | ✗ S3 | ✓ public container | ✓ lifecycle |
| Databases | ✓ RDS | ✓ PostgreSQL | ✓ Cloud SQL |
| Load balancing & health checks | partial | ✓ App Gateway | partial |
| DNS | ✓ Route 53 | ✗ | ✗ |
| Monitoring & alerting | ✗ | ✗ | ✗ |
| Secrets & keys | partial | ✗ | ✗ |
| Messaging | ✗ | ✗ | ✗ |
| Cost | ✗ | ✗ | ✗ |

## 2. Proposal

### 2.1 Tracks: one per provider

The single "Cloud Platforms" track can't hold 30+ incidents without becoming a wall.
Split it into **AWS**, **Azure** and **Google Cloud** tracks, each unlocked by
Networking (as today), with **Cloud System Design** unlocked by any one of them.

Item ids don't change (progress is saved by id), only folders: `content/aws/`,
`content/azure/`, `content/gcp/`. The `cloud` track id is retired; existing
completions still count toward rank and XP. The skill tree and queue already handle
any number of tracks.

### 2.2 Basics as difficulty-1 incidents

Each provider gets a **basics set**: short, difficulty-1 incidents, one core concept
each, with a single clear root cause and a debrief that teaches the concept from
scratch (what a route table is, how a security group differs from a network ACL).
No new game mode: the incident loop already teaches well, and difficulty 1 is
currently empty in the cloud tracks.

To support true newcomers, the debrief of a basics incident gets an optional
**"Concepts" block**: 2–4 plain-English definitions with links to the provider's own
docs. It's one optional schema field (`concepts: [{ term, text, url }]`), rendered in
the debrief only when present.

### 2.3 What gets built, in priority order

**Phase A: AWS basics** (6 incidents, difficulty 1–2)
1. EC2 in a private subnet can't reach the internet: no NAT gateway route (VPC, route tables, IGW vs NAT)
2. App unreachable on port 8080: security group only allows 443 (security groups, stateful rules)
3. S3 `AccessDenied` for the app: bucket policy and Block Public Access (S3 basics)
4. App on EC2 uses hard-coded keys that were revoked: use an instance role instead (IAM roles vs users)
5. CloudWatch alarm never fired: alarm on the wrong metric dimension (CloudWatch basics)
6. Surprise bill: NAT gateway data processing from traffic that should use an S3 gateway endpoint (cost)

**Phase B: Azure basics** (6 incidents, difficulty 1–2)
1. VM unreachable over SSH: NSG rule priority (NSGs)
2. Two VNets can't talk: peering missing in one direction (VNets, peering)
3. Function app can't read Key Vault: no role assignment for its managed identity (RBAC, managed identities)
4. Deployment fails in a resource group: role assigned at the wrong scope (subscriptions, resource groups, scopes)
5. Azure Monitor alert never fired: action group with no receivers (Azure Monitor)
6. Surprise bill: VMs "stopped" in the OS but not deallocated (cost)

**Phase C: AWS and Azure depth** (4 incidents, difficulty 2–4)
Lambda timeouts and concurrency, SQS visibility timeout duplicates, Azure Service Bus
dead-lettering, Azure DNS / Front Door. One more design challenge per provider on
networking (public/private subnets, NAT, endpoints).

**Phase D: Google Cloud basics** (4 incidents, difficulty 1–2)
VPC firewall rules, service account roles, Cloud Monitoring alerting, BigQuery cost
(scanning unpartitioned tables).

Each phase ships on its own, tested and sourced to the same standard as today.

## 3. Risks

- **Accuracy at volume.** 20 more incidents means a lot of representative output.
  Same rules as always: behavior from official docs, representative output listed in
  CONTENT_TODO.md. For AWS and Azure you can check those lists from experience.
- **Repetition.** Several basics are "a rule blocks traffic". Each incident teaches a
  different rule system and a different tell, and the debriefs compare them.
- **Track split.** Moving files changes folders, not ids, so saved progress keeps
  working; the content tests prove ids are unchanged.

## 4. Open questions (my default in **bold**)

1. Split the cloud track per provider? **Yes, in Phase A.**
2. Basics as difficulty-1 incidents with an optional Concepts block? **Yes.**
3. Phase order: **A (AWS basics), B (Azure basics), C (AWS/Azure depth), D (GCP basics).**
4. Start Phase A right after approval? **Yes.**
