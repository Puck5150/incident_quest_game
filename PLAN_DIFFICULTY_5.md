# Plan: Difficulty-5 incidents

Status: **approved 2026-10-02 with the defaults; D1 and D2 done (10 incidents re-rated: 6 up to 4, 4 up from 1 to 2); D3 done (aws-cross-account-replication-dr, azure-orders-backlog-major, gcp-scan-ingest-major); D4 in progress (Linux: media-disk-migration-major; Networking: duplicate-ip-cache-major; Databases: pgbouncer-transaction-pooling-major; Containers: evicted-checkout-major; CI/CD: release-pipeline-major; IaC: wrong-workspace-major; Microservices: consumer-rebalance-storm-major). D4 done; D5 done (red herrings added to 4 existing incidents where a tempting anomaly already existed). Complete.** From PARKING_LOT.md: "Every track
has at least 8 incidents. Next: difficulty-5 incidents."

## 1. Where we are

102 incidents (plus 19 design challenges). None are rated 5 and only two are rated 4 (aws-route53-failover,
poison-message-loop). Difficulty has no written definition: authors have guessed,
and the main thing it changes is the base score (`100 × difficulty`). So we need
two things: a rubric that says what each level means, and a top tier that
actually feels harder.

## 2. What makes a 5 (harder, not more obscure)

The help reference, field manual, hints and command breakdown all stay. A 5 is
hard because the problem has more depth, not because the game holds back
information. A difficulty-5 incident has **all** of these:

- **Three stages** (the multi-stage engine already allows up to 3). Each fix
  reveals the next fault, and each stage is verified before moving on.
- **More than one domain.** For example network, then identity, then data, so
  one specialist's instinct isn't enough.
- **At least one red herring.** This is a real anomaly in the evidence that
  isn't the cause, such as a noisy alarm, an old error, or a high but harmless
  metric. Chasing it costs time and nothing else.
- **A clean-up stage.** The last stage deals with damage the outage itself left
  behind. Examples: objects that never replicated, writes that went to the wrong
  disk, a backlog to drain. Restoring service isn't the end.
- **Par of 25 to 35 minutes**, compared with 10 to 20 for most incidents today.

## 3. Rubric for 1 to 5 (written into AUTHORING.md)

| Level | Shape | Typical |
|---|---|---|
| 1 | One fault; the first obvious command shows it | Disk full, service stopped |
| 2 | One fault; it takes two or three pieces of evidence to pin down | Wrong health check path |
| 3 | One fault that hides behind a plausible wrong answer, or a two-stage incident | Expired cert vs incomplete chain |
| 4 | Two stages, or one fault that crosses two domains | DNS failover plus TTL |
| 5 | Everything in section 2 | See section 5 |

Re-rating: I'll check the existing incidents against the rubric and propose
changes as a list for you to approve. I expect a handful of 3s to move to 4.
Nothing gets re-rated without your sign-off, because changing a rating changes
scores already earned.

## 4. Small engine and debrief additions

- **`red_herrings`** (optional; required at difficulty 5): a list of
  `{ ref, why }`, where `ref` points at a terminal command or artifact. The
  after-action report gains a **"What wasn't the cause"** section that explains
  each one. Teaching why something is irrelevant is half the skill, and today
  the game never does it.
- **Validation for difficulty 5:** three stages, at least one red herring,
  `par_minutes` of 25 or more, and a SEV1 ticket (SEV1 is reserved for them); the build fails otherwise.
  Crossing domains and the clean-up stage are checked by the author: concepts
  have no categories to validate against.
- **Map and board:** a difficulty-5 incident gets a "Major incident" badge.
  It pages as SEV1 during a shift.

No change to scoring beyond the existing base of `100 × difficulty`.

## 5. Candidate incidents, one per track (facts checked against official docs when written)

| Track | Stage 1 | Stage 2 | Stage 3 (clean-up) | Red herring |
|---|---|---|---|---|
| AWS | S3 cross-account replication stops: the replication role can't use the destination KMS key | Destination bucket policy / Object Ownership rejects the replicas | Objects written during the outage never replicate: S3 Batch Replication | 4xx alarm from an unrelated client |
| Azure | App Service VNet integration doesn't route all outbound traffic | Private DNS zone isn't linked to the integration VNet | Queued messages that failed during the outage are dead-lettered and need resubmitting | CPU alert on the plan |
| Google Cloud | GKE Workload Identity: the Kubernetes service account isn't annotated | Missing `roles/iam.workloadIdentityUser` binding | Failed uploads during the outage need replaying from a local spool | Node autoscaler events |
| Linux | Disk migration: fstab names the wrong UUID, so the data mount is missing | SELinux context on the new mount (restorecon) | Writes landed on the root filesystem underneath the mount point; move them and free the space | Load average from a backup job |
| Networking | New service: clients prefer IPv6 (AAAA record) but the firewall only allows IPv4 | Certificate SAN is missing the new name | Clients cached the bad answer; TTL and a resolver flush | Packet loss on an unrelated hop in traceroute |
| Databases | Failover: the app still points at the old primary (cached DNS, pooled connections) | Old primary still accepts writes: fence it | Writes that went to the old primary have to be reconciled | Replication lag on a reporting replica |
| Containers | Memory limits unset: pods evicted under node pressure | PodDisruptionBudget blocks the node drain | HPA can't scale because metrics-server isn't running | ImagePullBackOff on an old CronJob |
| CI/CD | Release builds use a stale cache (key ignores the lockfile) | Matrix jobs overwrite each other's artifact | A bad release was published: yank and republish | A flaky test that fails 1 time in 20 |
| IaC | Stale state lock from a cancelled CI run | Partial apply: half the change is live | Drift reconciled with `-refresh-only` and an import | Provider deprecation warnings |
| Microservices | Downstream call with no timeout | Retries without backoff amplify load (retry storm) | Drain the backlog safely, with idempotency keys | p99 latency on an unrelated service |

## 6. Milestones

| # | Work | Done when |
|---|---|---|
| D1 | Rubric in AUTHORING.md; `red_herrings` schema, validation and the debrief section; difficulty-5 rules; Major incident badge | Unit tests; existing content unchanged |
| D2 | Re-rating proposal for existing incidents (your approval) | Ratings updated |
| D3 | Difficulty-5 incidents: AWS, then Azure, then Google Cloud | Each passes validation, winnability, breakdown and link checks |
| D4 | Difficulty-5 incidents for the other seven tracks | Same |
| D5 | Optional `red_herrings` added to existing 3s and 4s where an obvious one exists | Content pass |

Every new incident keeps the continuity rules: every evidence command can be
found from `help`, every stage can be verified, and every key or verification
command has a breakdown entry.

## 7. Open questions (my default in **bold**)

1. Is the section 2 definition right (three stages, cross-domain, red herring,
   clean-up stage)? **Yes.**
2. Should red herrings, and the "What wasn't the cause" debrief, apply to all
   difficulties, not just 5? **Yes, optional below 5.**
3. Should difficulty 5 be locked until you've cleared the track's other
   incidents? **No.** It's labelled clearly instead.
4. Re-rate existing incidents? **Yes, as a proposal you approve (D2).**
5. One per track (10 in all) to start? **Yes.** AWS, Azure, Google Cloud first.
