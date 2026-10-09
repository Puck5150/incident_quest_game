# Terraform TF5: batch 2, failed applies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four new playable Terraform incidents in the `iac` track that teach what to do when an apply goes wrong: a partial apply stopped by a missing IAM permission, a quota limit that only bites one resource, a state lock left behind by a cancelled CI job, and a dependency cycle between security groups. Each runs entirely on the simulator, has world-based fix and trap detection (`done_when`), authentic output, and a scripted playthrough test of the ideal path and every trap.

**Architecture:** Content work on top of the finished simulator (TF1 to TF4). Each incident is one YAML file in `content/iac/` with a `terraform:` block (files, starting state, cloud differences, `faults`, `lock`, evidence) and `done_when` predicates. Shared test helper `tests/helpers/terraform-incident.ts` (TF4). Faults, partial apply, locks and `force-unlock` already exist; this batch is where they get used. If an incident needs a simulator capability that is missing, stop and report it (it becomes a simulator ticket); small verified text fixes are allowed.

**Tech Stack:** YAML content, vitest. Simulator source changes only as noted per task.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("Incident candidates: Failed applies"). Authoring rules: `AUTHORING.md` (`terraform:`, `faults`, `lock`, `done_when`, evidence), `CONTENT_TODO.md` (log every invented or unverified wording, simulator defects). Models to copy: `content/iac/terraform-state-lost.yaml`, `terraform-count-to-for-each.yaml`, `terraform-forgotten-taint.yaml` and their tests.

## Global Constraints

- Everything in `docs/superpowers/plans/2026-10-08-terraform-tf4-state-recovery-incidents.md` "Global Constraints" binds this batch (realistic but fair, AWS first, facts only from AWS/Terraform docs or provider source, only the 10 simulator resource types and their listed attributes, evidence from simulator output, no scripted `terraform ...` commands, three hint tiers, debrief, concepts and sources with URLs the author actually opened, `command_notes`, command library entries for scripted commands, par 8 to 14 minutes).
- Lessons from TF4 reviews, applied from the start: (1) verify every real-world claim (error texts, Terraform output, AWS behavior) against the Terraform source on GitHub (`raw.githubusercontent.com`), the AWS provider source, and AWS docs; mark what could not be verified in `CONTENT_TODO.md`; real AWS error messages in `faults[].error` must follow the SDK v2 shape the provider wraps (`operation error SERVICE: Action, https response error StatusCode: N, RequestID: ..., api error Code: message`); (2) ticket and environment text must not give away the hypothesis; (3) script every plausible follow-up non-terraform command (`aws ...`, `git ...`, `cat ...`) with `command_notes` and library entries, including the obvious variants; (4) the destructive trap is reachable from the terminal and detected from the world; the fix's `done_when` excludes it; (5) both fix routes, where two exist, are tested with the real shell; (6) a fix that can be earned while leaving damage (duplicates, orphans, a held lock bypassed) must not be credited.
- A failed apply must teach the real shape: progress lines, then the boxed error with `with ADDR,`, partial state left behind, exit 1. Fault `error` texts are the text shown after `Error:`.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (exactly this model name).

## Review Focus

1. In every incident the partial-apply state is realistic (what was created before the failure exists in state and in the cloud, and the next `terraform plan` shows exactly what is left), and the player can recover without destroying anything (Tasks 1 to 4 tests).
2. The fault gating works through the real UI/session path: an action taken (button or typed matching command) flips the fault, with no stale state after a remount (Task 5 UI tests).
3. No route credits the fix while damage remains: bypassing the lock with `-lock=false`, destroying and recreating, `-target` workarounds (not simulated), or applying with the wrong size (Tasks 1 to 4 trap tests).
4. Each incident teaches a distinct skill; the debrief is honest about what Terraform guarantees (no rollback) (reviewer check per task).
5. Ids, evidence tags and files do not collide with existing incidents (Task 5).

---

### Task 1: `terraform-partial-apply-iam` (a missing permission stops an apply halfway)

**Files:** Create `content/iac/terraform-partial-apply-iam.yaml`, `tests/terraform-partial-apply-iam.test.ts`; modify `CONTENT_TODO.md`, `content/commands/*.yaml` as validation requires.

**Story.** The new `orders` environment pipeline ran its first `terraform apply` from CI and failed after creating the network. The CI role is missing permission to create the database. The pipeline log (scripted `cat ci-apply.log` or similar) shows the error; the player must reproduce/inspect in the lab, understand that the VPC, subnets and security group already exist (partial apply, no rollback), find the denial (`AccessDenied` ... `not authorized to perform: rds:CreateDBInstance`, via the error text), get the permission granted, and re-run apply. Teaches: Terraform has no rollback; state records what succeeded; read `with ADDR,` and the denied action; fix the cause then re-apply; never `terraform destroy` to "start clean" and never edit state.

**Design.**
- Files: `main.tf` (provider), `network.tf` (`aws_vpc.main`, two `aws_subnet`, `aws_security_group.db`), `db.tf` (`aws_db_instance.orders` with a `depends_on`-free reference to the subnets' ids via the security group/vpc as the simulator allows; keep to listed attributes).
- Starting world: nothing exists yet (empty state, `hasState` false is fine, or a state with the network created by the CI run: choose the latter so `terraform state list` shows the partial result); `terraform.faults`: `{ at: aws_db_instance.orders, on: create, error: "<real AccessDenied shape for rds:CreateDBInstance>", until_actions: [grant-rds-permission] }`. The first player `terraform apply -auto-approve` therefore reproduces the failure after creating whatever is missing.
- Evidence (simulator output): `partial-apply` (`terraform state list` shows network objects but no database; or `terraform plan` shows `Plan: 1 to add`), `access-denied` (the apply error contains `not authorized to perform: rds:CreateDBInstance`), scripted `aws sts get-caller-identity` (`ci-role`) with `command_notes`.
- Hypotheses (one correct): the CI role lacks `rds:CreateDBInstance` (correct); Terraform rolled back and left nothing (wrong: the network exists); the database config is invalid (wrong: validate passes and the error is authorization); the region is wrong (wrong).
- Actions: `grant-rds-permission` (fix; typed command `aws iam put-role-policy ...` via `match_regex` and a button; it flips the fault; no world detection needed because it is an out-of-Terraform change); `finish-apply` (fix, world-detected): `done_when: all[ state_has aws_db_instance.orders, plan_clean, not applied delete aws_vpc.main ]`; `solution_paths: [[grant-rds-permission, finish-apply]]`. `destroy-and-retry` (destructive, world-detected): `done_when: any[ applied delete aws_vpc.main, applied delete aws_security_group.db ]` (destroying the partial network to "start clean"); `edit-state` (wrong, button only): hand-editing state.
- The fix must also work if the player grants the permission before ever reproducing the failure (granting first then apply succeeds in one go) — test it.

- [ ] **Step 1: Write the failing playthrough test**: (a) `terraform plan` shows exactly what remains; `state list` shows the partial network (evidence); (b) `terraform apply -auto-approve` fails with the AccessDenied box (`with aws_db_instance.orders,`), exit 1, the cloud and state unchanged by the failed step, still no database; repeated apply gives the same error; (c) after the action is taken (`actionsTaken` set containing `grant-rds-permission`, as the session passes it to `sh.run`) apply succeeds, `Apply complete! Resources: 1 added`, fix detected, trap not; (d) trap: `terraform destroy -auto-approve` after the failure → destructive detected, fix not earnable afterwards; (e) the typed `aws iam put-role-policy` command is matched by the action's regex (use the engine's `actionFor`), and a mistyped one is not; (f) all `key_evidence` obtainable on the ideal path.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Write the YAML**; iterate to green; evidence strings verbatim from simulator output; verify the AccessDenied message shape and the `rds:CreateDBInstance` wording against AWS docs/SDK error shapes.
- [ ] **Step 4: Log wording** in `CONTENT_TODO.md` (section `## terraform incidents batch 2 (TF5)`).
- [ ] **Step 5: Verify** — targeted test, `npm test`, `npx tsc -b`, `npm run lint`, `npm run build`.
- [ ] **Step 6: Commit** — `content: terraform-partial-apply-iam incident (TF5)`.

---

### Task 2: `terraform-vcpu-limit` (a quota stops one resource; two real fixes)

**Files:** Create `content/iac/terraform-vcpu-limit.yaml`, `tests/terraform-vcpu-limit.test.ts`; modify `CONTENT_TODO.md`, command library as needed.

**Story.** A load-test environment apply creates the network and a small instance, then fails creating a large compute instance with `VcpuLimitExceeded`. Teaches: account/region service quotas are a cloud-side limit not a Terraform bug; the failure is partial; two legitimate fixes (right-size the instance in code, or request a quota increase through Service Quotas) and why re-running apply is safe; do not loop retries or hop regions blindly.

**Design.**
- Files: `network.tf` (VPC, subnet), `compute.tf` (`aws_instance.loadgen` with `instance_type = "c5.24xlarge"` (96 vCPU) plus `aws_instance.agent` small), variables as needed.
- Fault: `{ at: aws_instance.loadgen, on: create, error: "<real VcpuLimitExceeded shape: operation error EC2: RunInstances, ... api error VcpuLimitExceeded: You have requested more vCPU capacity than your current vCPU limit of N allows for the instance bucket that the specified instance type belongs to. Please visit http://aws.amazon.com/contact-us/ec2-request to request an adjustment to this limit.>", if: { attr: instance_type, equals: "c5.24xlarge" }, until_actions: [request-quota-increase] }`. So both routes clear it: change `instance_type` in the file (the `if` stops matching) or take the quota action.
- Evidence: `quota-error` (apply error contains `VcpuLimitExceeded`), `partial` (`state list` shows the network and `agent` but no `loadgen`), scripted `aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A` (Running On-Demand Standard instances) with `command_notes`, `aws ec2 describe-instance-types ... VCpuInfo` for the instance type's vCPUs. Verify the quota code and the quota's unit/semantics in the AWS docs.
- Hypotheses: account vCPU quota too low for the requested type (correct); Terraform bug/instance type typo (wrong: type valid, error names the limit); AZ capacity shortage (wrong: `InsufficientInstanceCapacity` is a different error and message); IAM denial (wrong).
- Actions: `right-size` (fix, route A; world-detected): `done_when: all[ state_has aws_instance.loadgen, plan_clean, not: { file_contains: { path: <compute.tf>, matches: 'c5\.24xlarge' } } ]` (the "smaller type" is expressed as the large type no longer being in the file, plus the world proof that the instance exists); `request-quota-increase` (fix, route B; button and typed `aws service-quotas request-service-quota-increase ...` via `match_regex`) followed by `finish-apply` (world-detected: `state_has aws_instance.loadgen` + `plan_clean`); `solution_paths`: `[[right-size], [request-quota-increase, finish-apply]]`. Traps: `switch-region` (wrong, button only), `destroy-everything` (destructive, world-detected `applied delete` of the network).
- Teach honestly that a quota increase can take time in real life; the simulator grants it at once (note in CONTENT_TODO).

- [ ] **Step 1: Write the failing playthrough test**: first apply creates network + agent, fails on loadgen with the error box, partial state as described; route A (sed the type, apply) → complete, fix detected; route B (action taken, apply) → complete, fix detected; the instance type edited to another still-too-large type (`c5.18xlarge`, 72 vCPU) — decide with the author what the sim's `if` does and write the test: it must not be credited unless apply actually succeeded; trap: destroy → destructive; key evidence obtainable.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Write the YAML**; iterate; verify the quota facts (default quota, code, name) in AWS docs.
- [ ] **Step 4: Log wording.**
- [ ] **Step 5: Verify** — targeted, `npm test`, `npx tsc -b`, lint, build.
- [ ] **Step 6: Commit** — `content: terraform-vcpu-limit incident (TF5)`.

---

### Task 3: `terraform-cancelled-ci-lock` (a cancelled pipeline leaves the state locked)

**Files:** Create `content/iac/terraform-cancelled-ci-lock.yaml`, `tests/terraform-cancelled-ci-lock.test.ts`; modify `CONTENT_TODO.md`, command library as needed.

**Story.** Someone cancelled a CI `terraform apply` job halfway (runner killed). Now every plan and apply fails with `Error acquiring the state lock`, showing a Lock Info block (ID, Who `ci@runner-17`, Operation `OperationTypeApply`, Created time). State is partly applied: some resources created, others not. Teaches: read the Lock Info; check whether the process holding the lock is really dead before breaking it (CI log, runner status — scripted); `terraform force-unlock LOCK_ID`; then review the partial state with `plan` before applying; never use `-lock=false` to push through while a job may still be running.

**Design.**
- Files: small S3/SQS-free config using listed types (VPC, subnet, security group, instance); starting state: network created, the instance missing (partial apply); `terraform.lock`: `{ id: "<uuid>", who: "ci@runner-17", operation: OperationTypeApply, created: "<believable UTC timestamp>", path: "<backend path string>", message: "<S3/DynamoDB-style Error message: ConditionalCheckFailedException ...>" }` — verify the real S3+DynamoDB lock error shape (`Error message: ConditionalCheckFailedException: The conditional request failed`) from the provider/backend source and use it.
- Scripted non-terraform evidence: `cat ci-pipeline.log` (the job cancelled message, last line `Terminated`) and `gh run list`/`gh run view` style output or a runner status command (choose one believable command, with `command_notes` and library entry): shows the job is cancelled, not running. Evidence tags: `lock-error` (plan output contains `Error acquiring the state lock`), `lock-info` (contains `Who:       ci@runner-17`), `job-dead` (scripted), `partial-state` (after unlock, `terraform plan` shows what's left).
- Hypotheses: a cancelled CI job left a stale lock (correct); someone is applying right now (wrong: the CI log shows the job terminated, and Who/Created time); the state file is corrupt (wrong: the error is about the lock, not state); backend credentials broken (wrong: the lock info was read, so the backend is reachable).
- Actions: `force-unlock` (fix, world-detected): `done_when: all[ lock_free, state_has <the remaining resource>, plan_clean, not: skip-the-lock's own predicate ]` (the author writes the concrete addresses; the fix is complete once the lock is gone AND the remaining resource has been created AND the bypass trap never fired); `skip-the-lock` (destructive, world-detected): bypassing with `-lock=false` and applying while the lock is held: `done_when: all[ not: lock_free, any[ applied create <remaining resource> ] ]` (an apply happened while the lock was still held); `delete-the-lock-file`/`rebuild-state` (wrong, button only).
- Make sure the order of play is fair: investigating the CI log before unlocking is rewarded by the debrief (not by a score hook): the wrong hypothesis feedback must lean on the log evidence.

- [ ] **Step 1: Write the failing playthrough test**: plan/apply blocked with the exact lock box (compare against the simulator's output; check the exact fields), `state list`/`output`/`state show` still work (unlocked commands); wrong-ID `force-unlock` and declined unlock change nothing; piped `echo yes | terraform force-unlock ID` and `-force` both work; after unlock `plan` shows the remaining resource, `apply` completes → fix detected; trap: `terraform apply -auto-approve -lock=false` while locked → destructive detected, fix NOT credited afterwards (even after force-unlock) because damage-flag; `-lock=false plan` alone (read-only intent) is not a trap; key evidence obtainable.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Write the YAML**; iterate; verify the lock error shape and force-unlock semantics (and the `-lock-timeout` flag mention) against Terraform docs/source.
- [ ] **Step 4: Log wording.**
- [ ] **Step 5: Verify** — targeted, `npm test`, `npx tsc -b`, lint, build.
- [ ] **Step 6: Commit** — `content: terraform-cancelled-ci-lock incident (TF5)`.

---

### Task 4: `terraform-sg-cycle` (a dependency cycle between security groups)

**Files:** Create `content/iac/terraform-sg-cycle.yaml`, `tests/terraform-sg-cycle.test.ts`; modify `CONTENT_TODO.md`, command library as needed. Check first whether the simulator supports nested `ingress { ... security_groups = [...] }` blocks in `aws_security_group` and reports a real-format cycle error; if not, STOP and report exactly what is missing.

**Story.** A PR adds a rule so the web tier can reach the app tier and vice versa, with inline `ingress` blocks referencing each other's security group. `terraform plan` (and `validate`) fails with `Error: Cycle: aws_security_group.app, aws_security_group.web`. Teaches: Terraform builds a dependency graph from references; two resources referencing each other can never be ordered; `terraform graph` (not simulated) / reading the references; break the cycle by removing one direction or referencing a CIDR/other attribute instead (the separate rule resources `aws_security_group_rule` are the idiomatic fix but are not a simulator type: the incident's fix must be achievable with the simulator types: e.g. restrict one tier by the subnet CIDR block instead of the other group's id).

**Design.**
- Files: `network.tf` (VPC, subnets with known CIDRs), `security.tf` (`aws_security_group.web` allowing ingress from `aws_security_group.app.id` on 8080 and `aws_security_group.app` allowing ingress from `aws_security_group.web.id` on 443 — the cycle), the PR diff via scripted `git diff`.
- Starting state: the VPC/subnets exist and both groups exist from before the PR with simple CIDR rules (the PR only adds the cross-references), so the broken plan is realistic. Evidence: `cycle-error` (plan/validate output contains `Cycle:` and both addresses), `pr-diff` (scripted git diff).
- Hypotheses: mutual references form a dependency cycle (correct); the provider has a bug with security group rules (wrong); a missing `depends_on` (wrong: more `depends_on` would not break a cycle, it would add edges); AWS rejects circular rules (wrong: AWS allows groups to reference each other, the problem is Terraform's graph).
- Actions: `break-the-cycle` (fix, world-detected): `done_when: all[ plan_has: { no_destroy: [aws_security_group.web, aws_security_group.app] }, state_has aws_security_group.web, state_has aws_security_group.app, file_contains (security.tf) 'security_groups\s*=\s*\[aws_security_group', not: applied delete aws_security_group.web, not: applied delete aws_security_group.app ]` and, once the corrected ingress has been applied, `plan_clean` (a second action `finish-apply` if the author prefers two steps); the `file_contains` clause keeps "delete both rules" from being credited as a fix; `force-replace-groups` (destructive, world-detected `applied delete` of either group) — only reachable if the player removes the rules in a way that recreates the groups: the author must find out whether such a path exists in the simulator and, if not, make this trap button-only and say so; `add-depends-on` (wrong, button only).
- The incident must not accept "remove everything": the acceptable fix keeps one direction by id and the other by CIDR; document in the action text.

- [ ] **Step 1: Write the failing playthrough test**: plan and validate both fail with the exact Cycle error format (compare the simulator's text to Terraform's `Error: Cycle: a, b` format; verify in Terraform source `terraform/transform_reference.go`/`dag` message format and sorted names) and no partial plan is printed; ideal path (edit security.tf: one side uses the subnet CIDR) → plan shows only the in-place ingress update, apply completes, fix detected; removing both cross-references → not credited; `depends_on` added → still Cycle; key evidence obtainable.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Write the YAML**; iterate; verify the Cycle message format and that AWS permits mutually referencing security groups.
- [ ] **Step 4: Log wording.**
- [ ] **Step 5: Verify** — targeted, `npm test`, `npx tsc -b`, lint, build.
- [ ] **Step 6: Commit** — `content: terraform-sg-cycle incident (TF5)`.

---

### Task 5: Batch wrap-up, UI resolution tests, merge-readiness

**Files:** Create `tests/terraform-batch2-ui.test.tsx`; modify `CONTENT_TODO.md`.

- [ ] **Step 1:** Confirm the four incidents need no manual registration and no id, evidence tag, command-library id or file collides with existing incidents/commands (grep).
- [ ] **Step 2:** UI-level tests (jsdom, patterns from `tests/terraform-batch1-ui.test.tsx` and `tests/incident.test.tsx`) for each incident: ideal path resolved through `IncidentScreen` with the fix recorded exactly once and no destructive mistakes; trap path records exactly one destructive `TAKE_ACTION`, mistakes.destructive === 1 and the fix cannot then be earned. For partial-apply-iam and vcpu-limit also test the fault gating through the real session: take the action by the typed command (and by the button) and check the next apply succeeds, and that a remount rebuilds the same transcript (fault `times`/gating replay). For cancelled-ci-lock test the dialog flow of `force-unlock` (answer yes in the dialog).
- [ ] **Step 3:** Tidy the `## terraform incidents batch 2 (TF5)` section of `CONTENT_TODO.md`: by incident, plus open simulator defects found along the way, minus anything fixed.
- [ ] **Step 4: Verify** — `npm test`, `npx tsc -b`, `npm run lint`, `npm run build`.
- [ ] **Step 5: Commit** — `test: TF5 incidents resolve through the UI; content log tidy`.

---

## Self-review (done)

- **Spec coverage:** failed-apply candidates covered: partial apply and IAM denied mid-apply (Task 1), quota limits (Task 2), the lock left by an interrupted run (Task 3, from the spec's "a crashed run leaves it held"), dependency cycle (Task 4). Deferred: eventual consistency (the simulator has no retry/timeout model) and stale saved plan in CI (needs a world event between `plan -out` and `apply`); both are logged for a later milestone with the simulator work they need.
- **Placeholders:** none; where a precise `done_when` depends on what the simulator does, the task says to decide it with the real shell and test it.
- **Review Focus:** 1 to 3 → per-incident tests and Task 5; 4 → per-incident review; 5 → Task 5.
