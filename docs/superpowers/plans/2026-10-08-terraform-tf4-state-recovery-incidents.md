# Terraform TF4: batch 1, state recovery incidents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three new playable Terraform incidents in the `iac` track that run entirely on the simulator and teach the state-recovery skills: rebuilding lost state with `import`, refactoring addresses with `moved`/`state mv` without destroying anything, and finding a forgotten `taint`. Each has a real trap, world-based fix and trap detection (`done_when`), authentic Terraform output, and is verified by a scripted playthrough test of the ideal path and every trap.

**Architecture:** Pure content work on top of the finished simulator (TF1 to TF3d). Each incident is one YAML file in `content/iac/` with a `terraform:` block (files, starting state, cloud differences, evidence, optional faults) and `done_when` predicates on its actions. A shared test helper (extracted from `tests/terraform-incident.test.ts`) plays an incident through `IncidentShell` and reports which actions the session would take. One review per incident checks realism against real Terraform behavior and fairness of the puzzle.

**Tech Stack:** YAML content, vitest. No source changes are expected; if an incident needs a simulator capability that is missing, stop and report it instead of working around it (it becomes a ticket for the simulator, not a content hack).

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("Incident candidates: State recovery"). Authoring rules: `AUTHORING.md` (the `terraform:` block, `done_when`, evidence), `CONTENT_TODO.md` (log every invented or unverified Terraform/AWS wording). The model to copy: `content/iac/terraform-forces-replacement.yaml` and `tests/terraform-incident.test.ts`.

## Global Constraints

- Content standards (from the project): realistic but fair (always solvable, each teaches something), AWS first, facts only from the AWS/Terraform docs or the provider schema, never invented behavior presented as real; no accessibility-style hand-holding for focus or attention.
- Only resource types in `src/game/terraform/resources.ts` (`aws_vpc`, `aws_subnet`, `aws_security_group`, `aws_instance`, `aws_db_instance`, `aws_s3_bucket`, `aws_sqs_queue`, `aws_iam_role`, `aws_ecs_service`, `aws_cloudwatch_log_group`) and only the attributes those schemas list. All HCL must parse and plan with the simulator; the author runs the ideal path and every trap through the real shell before committing.
- Every incident has: a ticket and environment in a believable work voice; a `terminal` prompt in the lab directory; `terraform.evidence` tags attached to real command output (never invented output text: evidence matches simulator output); at least 2 wrong hypotheses with specific feedback; exactly one correct hypothesis; a `fix` action detected from the world; a `destructive` shotgun trap detected from the world (plus a button); at least one `wrong` action; `solution_paths`; `key_evidence`; three hint tiers; analogy; debrief with root cause, ideal path and real-world advice; concepts with docs URLs; sources with real URLs the author actually opened (note in `CONTENT_TODO.md` any that could not be opened); `command_notes` where scripted commands exist.
- The incident validates (`npm test` content validation), has no scripted `terraform ...` commands in `terminal.commands` (the simulator answers), and difficulty/par are set believably (par 8 to 14 minutes).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (exactly this model name).

## Review Focus

1. Every incident can be solved through at least two different real routes (e.g. `terraform import` CLI vs `import` blocks; `moved` blocks vs `state mv`), and the `done_when` predicates credit both, because they read the world (Tasks 2 to 4 tests).
2. Every incident's trap really does damage in the simulated world and is detected, even if the player does it before naming the root cause (it is taken once named); a player who follows the ideal path never trips a trap or loses a fix to a stale predicate (Tasks 2 to 4 tests).
3. All terminal output the player needs for the evidence comes from the simulator, not from scripted lookalikes; scripted lookalikes are limited to non-terraform commands (`aws ...`, `git ...`, `cat ...`) and carry `command_notes` (Tasks 2 to 4).
4. Each incident teaches a distinct skill that real operators hit, with an honest debrief (no claims about Terraform that the docs do not support) (reviewer check per task).
5. The three incidents are independent of each other and of the existing nine (no shared ids, evidence tags, state or file clashes) (Task 5).

---

### Task 1: Shared incident test helper

**Files:**
- Create: `tests/helpers/terraform-incident.ts`
- Modify: `tests/terraform-incident.test.ts` (use the helper; behavior unchanged)

**Interfaces (produces):**
```ts
export function loadIncident(id: string): Scenario                       // loadContent(...).scenarios.find
export function playbook(scenario: Scenario): {
  play(...lines: string[]): Promise<{ sh: IncidentShell; out: ShellResult[] }>   // fresh shell, runs lines at stage 0 with no actions taken
  detected(sh: IncidentShell, id: string): Promise<boolean>                      // the session's rule: file check (if any) AND done_when (if any), false if neither
  detectedAll(sh: IncidentShell): Promise<Record<string, boolean>>
}
```
`detected` is exactly what `tests/terraform-incident.test.ts` defines today (lines using `a.file`, `a.done_when`, `sh.read`, `sh.doneWhen`); mirror `src/components/terminal/detect.ts`'s semantics.

- [ ] **Step 1:** Move `play`, `detected`, `detectedAll` out of `tests/terraform-incident.test.ts` into the helper, parameterized by scenario. Check that `tests/helpers/` is not picked up as a test file by vitest's include patterns (`vite.config`/`vitest.config`) and not linted into failure.
- [ ] **Step 2: Verify** — `npx vitest run tests/terraform-incident.test.ts` (same tests, same results), `npm test`, `npx tsc -b`, `npm run lint`.
- [ ] **Step 3: Commit** — `git add tests && git commit -m "test: shared terraform incident playthrough helper (TF4)"` with the trailer.

---

### Task 2: Incident `terraform-state-lost` (rebuild lost state with import)

**Files:**
- Create: `content/iac/terraform-state-lost.yaml`, `tests/terraform-state-lost.test.ts`
- Modify: `CONTENT_TODO.md` (unverified wording, sources)

**Story.** A platform engineer cloned the infra repo on a new laptop (or a CI job started from a fresh checkout) after a merge dropped `backend.tf`. `terraform plan` now says it will create four resources that already exist in AWS. There is no state. Teaches: state is the mapping, losing it does not delete anything but makes Terraform want to create everything; `apply` against existing objects fails (and for non-unique types would duplicate); recovery is `import` (CLI or blocks); the real prevention is a remote backend with locking and versioning.

**Design (all values are a starting proposal; the author may adjust while keeping the properties below).**
- `terraform:` `dir: "~/infra"`; files: `main.tf` (provider aws us-east-1, required_providers `~> 5.0`), `logs.tf` (`aws_s3_bucket.app_logs` bucket `acme-app-logs`; `aws_cloudwatch_log_group.api` name `/acme/api`, `retention_in_days = 30`), `iam.tf` (`aws_iam_role.task` name `acme-task-role`, simple `assume_role_policy` JSON via `jsonencode`), `queue.tf` (`aws_sqs_queue.jobs` name `acme-jobs`). No backend block. No `state:` entries and no `terraform.tfstate`: `lab.hasState` is false.
- `cloud.add`: all four objects exist with attributes exactly matching the configuration so that a correct import plans clean (the author verifies: IDs are `acme-app-logs`, `/acme/api`, `acme-task-role`, and the SQS URL `https://sqs.us-east-1.amazonaws.com/123456789012/acme-jobs`; each with the arn the provider would give).
- Evidence (all simulator output): `no-state` = `terraform state list` contains `No state file was found!`; `wants-to-create` = `terraform plan` contains `Plan: 4 to add`; scripted `aws s3api head-bucket --bucket acme-app-logs` (output believable, `command_notes` explains) = `exists-in-aws`.
- Hypotheses (one correct): state is missing, so Terraform thinks nothing exists (correct); the resources were deleted from AWS (wrong: they exist); the config was renamed (wrong: names match); wrong region/credentials (wrong: same account/region shown).
- Actions: `import-resources` (fix; no `file`): `done_when: all[ state_has each of the four resource addresses, plan_clean ]`; button text describes importing each resource and getting a clean plan. `apply-anyway` (wrong; button only plus `match_regex` NOT used): feedback explains the AlreadyExists failures. `delete-and-recreate` (destructive; button only): feedback explains that deleting production objects to make apply pass loses data and breaks consumers. Make the player's first `terraform apply -auto-approve` instructive: it must fail with real-format `BucketAlreadyOwnedByYou`, `EntityAlreadyExists`, `ResourceAlreadyExistsException` and `QueueNameExists` errors (the simulator already does this) and leave state empty; the fix is still reachable afterwards.
- Both routes must work and be tested: four `terraform import ADDR ID` commands, and four `import {}` blocks followed by `terraform apply` (answer `yes`).

- [ ] **Step 1: Write the failing playthrough test** `tests/terraform-state-lost.test.ts` using the helper: (a) first `terraform plan` output contains `Plan: 4 to add` and awards `wants-to-create`; `state list` awards `no-state`; (b) `terraform apply -auto-approve` fails with the four provider errors, exit 1, state still empty, no action detected; (c) ideal path A (CLI imports) → `state list` shows four addresses, `terraform plan` says `No changes.`, `import-resources` detected, destructive/wrong not; (d) ideal path B (`import` blocks + apply) → same; (e) partial import (3 of 4) → not detected; (f) import with a wrong id fails with `Cannot import non-existent remote object` and changes nothing; (g) after the ideal path a further `terraform apply` is a no-op; (h) the debrief key evidence tags are all obtainable (every tag in `key_evidence` is awarded by some command in the ideal path).
- [ ] **Step 2: Run to verify failure** (scenario not found).
- [ ] **Step 3: Write the YAML**, following `terraform-forces-replacement.yaml` for every required section; iterate with the test until it passes. Use the simulator's real output for evidence matching strings (copy them from actual runs).
- [ ] **Step 4: Log wording**: append to `CONTENT_TODO.md` under a new `## terraform incidents batch 1 (TF4)` section every claim you could not verify in docs (import id formats per type, the "lost backend config" story details, real error texts).
- [ ] **Step 5: Verify** — targeted test, `npm test` (content validation runs over all YAML), `npx tsc -b`, `npm run lint`, `npm run build`.
- [ ] **Step 6: Commit** — `content: terraform-state-lost incident (TF4)`.

---

### Task 3: Incident `terraform-count-to-for-each` (refactor addresses without destroying)

**Files:**
- Create: `content/iac/terraform-count-to-for-each.yaml`, `tests/terraform-count-to-for-each.test.ts`
- Modify: `CONTENT_TODO.md`

**Story.** A refactor PR changes the two private subnets from `count = 2` to `for_each = toset(var.azs)` so they stop depending on list order. The plan wants to destroy both subnets and create two new ones, and replace the database host in them, because the instance addresses key by subnet id. The database host has `prevent_destroy`, so CI fails with `Instance cannot be destroyed`. Teaches: resource addresses are identities; changing `count` to `for_each` changes every address; `moved` blocks (or `state mv`) keep the objects; read `will be destroyed` lines and their reasons; `prevent_destroy` is what saved them.

**Design.**
- Files: `main.tf` (provider), `vars.tf` (`variable "azs"` default `["us-east-1a", "us-east-1b"]`), `network.tf` (`aws_vpc.main`, `aws_subnet.private` with `for_each = toset(var.azs)`, `vpc_id = aws_vpc.main.id`, `cidr_block = cidrsubnet(aws_vpc.main.cidr_block, 8, index(var.azs, each.key))`, `availability_zone = each.key`; check `cidrsubnet`/`index` exist in `functions.ts`; otherwise use a literal map local), `app.tf` (`aws_instance.app` with `for_each = aws_subnet.private`, `subnet_id = each.value.id`, `lifecycle { prevent_destroy = true }` on the instance resource; `ami` and `instance_type` set).
- Starting state: VPC, `aws_subnet.private[0]` and `[1]` (count-indexed), `aws_instance.app[0]`/`[1]`... — author decides the instance keying so the cascade is realistic and the plan output is exactly: both subnets `will be destroyed` (`because resource uses count`-style reason from the simulator) and created under string keys, both instances replaced, and the instance `prevent_destroy` error as the visible failure. Keep the object count small (VPC, 2 subnets, 2 instances).
- Evidence (simulator output): `plan-destroys-subnets` (`terraform plan` contains the subnet destroy line), `address-changed` (`terraform state list` contains `aws_subnet.private[0]` while config uses for_each), `prevent-destroy-saved-you` (plan contains `Instance cannot be destroyed`).
- Hypotheses: addresses changed from index to key so state and config no longer line up (correct); AZ names changed (wrong); provider bug (wrong); someone deleted the subnets in the console (wrong: state show/reality show they exist).
- Actions: `move-addresses` (fix): `done_when: all[ state_has 'aws_subnet.private["us-east-1a"]', state_has 'aws_subnet.private["us-east-1b"]', plan_clean ... ]` plus the instance keys if they change; and `not` of any `applied delete` for the subnets and instances. Both routes tested: `moved` blocks in config then `terraform apply` (moves are applied by apply; plan alone is not clean until then) and `terraform state mv` for each address (state is immediately keyed; `plan` clean). `remove-prevent-destroy` (destructive): `done_when: any[ applied delete aws_subnet.private, applied delete aws_instance.app ]` (the trap: removing prevent_destroy and applying replaces the app host; also the first apply would hit a DependencyViolation or replace subnets — the simulator behavior decides; document what the player sees). `ignore-and-revert` (wrong, button only): reverting to `count` hides the refactor.
- A player who removes `prevent_destroy` to "unblock CI" and applies must see a real consequence (replacement of both instances; the author documents the exact simulator output in the test).

- [ ] **Step 1: Write the failing playthrough test**: (a) first `terraform plan` shows the subnet destroys/creates and the instance `prevent_destroy` error, evidence awarded; (b) route A: write `moved` blocks (shell `cat >>`), `terraform plan` shows the moves with `Plan: 0 to add, 0 to change, 0 to destroy`, `terraform apply` + `yes`, then `plan` says `No changes.`, fix detected, traps not; (c) route B: four `terraform state mv ...` commands (instances too if keys change) → `plan` clean → fix detected; (d) partial route (only subnets moved) → not detected (instances still planned for replacement); (e) trap: remove `prevent_destroy`, `terraform apply -auto-approve` → destructive detected; afterwards restoring the moved blocks cannot earn the fix (history has the deletes); (f) the fix path leaves cloud object ids unchanged (the same subnet ids as at the start); (g) every `key_evidence` tag obtainable on the ideal path.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Write the YAML**; iterate until green; copy simulator output for evidence strings; if `moved` between a `count` and `for_each` key is not handled by the simulator, STOP and report (do not special-case the content).
- [ ] **Step 4: Log wording** in `CONTENT_TODO.md`.
- [ ] **Step 5: Verify** — targeted test, `npm test`, `npx tsc -b`, `npm run lint`, `npm run build`.
- [ ] **Step 6: Commit** — `content: terraform-count-to-for-each incident (TF4)`.

---

### Task 4: Incident `terraform-forgotten-taint` (an old taint replaces production)

**Files:**
- Create: `content/iac/terraform-forgotten-taint.yaml`, `tests/terraform-forgotten-taint.test.ts`
- Modify: `CONTENT_TODO.md`

**Story.** A one-line tag change to the web server's `tags` is in review. CI's plan says the web instance "is tainted, so must be replaced": a one-instance production web tier behind a load balancer, and a replacement means minutes of downtime. Nobody remembers tainting it. State (via `state show`) shows `(tainted)`; a scripted shell history entry shows `terraform taint aws_instance.web` from nine days ago during a debugging session. Teaches: taint is a state flag persisting until applied or untainted; read plan reasons (`is tainted, so must be replaced` vs `must be replaced` due to a changed argument); `terraform untaint`; `-replace` is the modern way to do the same deliberately; plan before apply.

**Design.**
- Files: `main.tf` (provider), `web.tf` (`aws_security_group.web`, `aws_instance.web` with `tags = { Name = "web", Team = "platform" }`, `ami`, `instance_type`, `subnet_id`; the PR diff adds `CostCenter = "1234"`). State: VPC/subnet/SG/instance with `aws_instance.web` `status: tainted`; cloud equals state.
- Evidence: `replace-planned` (`terraform plan` contains `is tainted, so must be replaced`), `tainted-in-state` (`terraform state show aws_instance.web` contains `(tainted)`), `taint-history` (scripted `history | grep taint` output; `command_notes`).
- Hypotheses: a leftover taint in state (correct); the tag change forces replacement (wrong: tags update in place — the plan reason differs, feedback tells them how to tell); the AMI drifted (wrong); someone changed the instance in the console (wrong: no drift shown).
- Actions: `untaint` (fix): `done_when: all[ plan_has: { no_destroy: [aws_instance.web] }, not: applied delete aws_instance.web ]` — plan then shows only the in-place tag update. Routes tested: `terraform untaint aws_instance.web`; also `terraform state rm` + `import` would count if the plan has no destroy (author may test it as a bonus route; not required). `apply-the-pr` (destructive): `done_when: applied delete aws_instance.web`: applying the PR as is replaces the production web server (the real consequence; production downtime in the feedback). `revert-the-tag` (wrong, button only): the PR is fine, the plan would still replace the instance.
- The one-line PR diff is shown via scripted `git diff main -- web.tf` with `command_notes`.

- [ ] **Step 1: Write the failing playthrough test**: (a) plan shows `-/+` with `is tainted, so must be replaced` and the tags in the diff, evidence awarded; (b) `state show` awards `tainted-in-state`; (c) ideal path: `terraform untaint aws_instance.web` → plan shows `~ update in-place` for tags only, `Plan: 0 to add, 1 to change, 0 to destroy.`, fix detected; then `terraform apply` + `yes` completes without delete; (d) trap: `terraform apply -auto-approve` with the taint → destructive detected, `applied delete aws_instance.web`; afterwards `untaint`/reverting cannot earn the fix; (e) `terraform plan -replace=aws_instance.web` on an untainted instance shows `(because ... requested)` style reason (document the simulator output) — demonstrates the deliberate way; (f) untaint of an instance that is not tainted gives the state-ops error; (g) key evidence obtainable.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Write the YAML**; iterate until green.
- [ ] **Step 4: Log wording** in `CONTENT_TODO.md`.
- [ ] **Step 5: Verify** — targeted test, `npm test`, `npx tsc -b`, `npm run lint`, `npm run build`.
- [ ] **Step 6: Commit** — `content: terraform-forgotten-taint incident (TF4)`.

---

### Task 5: Batch wrap-up and review

**Files:**
- Modify: `CONTENT_TODO.md` (tidy the TF4 section), possibly track listing or incident index tests if the content validator needs it

- [ ] **Step 1:** Run `npm test`, `npx tsc -b`, `npm run lint`, `npm run build`; confirm the three incidents appear in the app's iac track (look at how incidents are listed in `content/tracks.yaml`/the content loader; no manual registration should be needed — if it is, do it) and that no id, evidence tag or file path collides with the nine existing incidents.
- [ ] **Step 2:** Play each of the three incidents once through the UI path in jsdom the way `tests/incident.test.tsx` does for `terraform-forces-replacement` (name the root cause, run the ideal path in the simulated terminal, close the incident) — add one compact UI test per incident or one parametrized test; assert the incident can be resolved, scored with no destructive deduction, and that the trap path records exactly one `TAKE_ACTION` for the destructive action.
- [ ] **Step 3: Commit** — `test: TF4 incidents resolve through the UI; content log tidy`.

---

## Self-review (done)

- **Spec coverage:** the spec's state-recovery candidates are covered by lost state (import), refactor/`state mv` (the "state rm/mv" item), and tainted resources with `-replace`. "Backend migration" and "backend or lock file mismatch" are deferred: they need simulator work (backend blocks in `init`, lock-file version constraints) and are listed for TF6 (provider version and lock file drift). Lost-or-corrupt state files on disk, with `terraform.tfstate.backup`, is not modeled by the simulator (no state file on the simulated disk); noted for a future simulator milestone.
- **Placeholders:** none; story, design properties, evidence, actions and predicates are specified per incident; authors choose exact HCL and prose.
- **Review Focus:** 1 to 3 → per-incident tests; 4 → per-incident review; 5 → Task 5.
