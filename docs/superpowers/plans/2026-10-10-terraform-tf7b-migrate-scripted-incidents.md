# Terraform TF7b: migrate the scripted incidents onto the simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the seven remaining scripted Terraform incidents (`terraform-count-index-shift`, `terraform-drift-hotfix`, `terraform-ignore-changes-autoscaling`, `terraform-import-existing`, `terraform-moved-block`, `terraform-state-in-git`, plus the Terraform part of `wrong-workspace-major`) onto the real simulator (`terraform:` block), retire the superseded `terraform-state-lock`, and add the small engine pieces those migrations need. Afterwards no incident scripts `terraform ...` output.

**Architecture:** Tasks 1 and 2 are engine work in `src/game/terraform/` (a `plan_has.no_change` leaf, a `random_password` resource, a local state file on disk, backend migration), default behaviour unchanged. Task 3 retires `terraform-state-lock`. Tasks 4 to 10 each migrate one incident: same id, same learning goal, same fix and trap set, but the terraform output now comes from files, state and cloud, and each fix is credited by `done_when` on the world. Task 11 hardens two published incidents against the late-naming exposure. Task 12 is the wrap-up (CONTENT_TODO, final review, release notes). Every migration is a live-content change (these incidents are published), so each ships as its own small PR, not dark.

**Tech Stack:** TypeScript (strict), YAML content, vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("The 9 current Terraform incidents stay on scripted output until they are migrated at the end"; build order step 7). Also `CONTENT_TODO.md` sections "## terraform follow-ups (TF7)", "## terraform incidents batch 4 (TF7a)" (TF7a batch status; the "Late root-cause naming vs transient fix predicates" item) and the TF7a plan `docs/superpowers/plans/2026-10-09-terraform-tf7a-destroy-engine-and-incidents.md`, whose structure this plan copies.

**Inventory (checked with `for f in content/iac/terraform-*.yaml; do grep -q '^terraform:' $f || echo $f; done`).** The spec said "9"; today: `terraform-forces-replacement` already runs on the simulator (done in TF4); `terraform-state-lock` is superseded and is retired; `wrong-workspace-major.yaml` (the spec's "wrong workspace") is not named `terraform-*` but is still scripted, so it is in scope. That leaves 7 to migrate (count-index-shift, drift-hotfix, ignore-changes-autoscaling, import-existing, moved-block, state-in-git, wrong-workspace-major) and 1 to retire.

## Decisions (made here, with reasons)

| Incident | Decision | Why |
|---|---|---|
| terraform-state-lock | **Retire** (delete the file) | `terraform-cancelled-ci-lock` teaches the same lesson on the simulator (stale lock after a cancelled apply) with real `force-unlock`. No redirect: progress is `completed[scenarioId]` in localStorage (`src/game/progress.ts`), every reader looks up by the ids of loaded content, `loadProgress` validates shape not ids, no track `requires` names an incident, and shifts keep ids in memory only. A player who cleared it keeps the XP; the home counters only count existing items. Task 3 pins this with a test. |
| count-index-shift | **Migrate**, same id | Engine already covers count, for_each, `moved`, `state mv`. Distinct lesson from `count-to-for-each` (removing from a list shifts indexes). |
| drift-hotfix | **Migrate**, needs `plan_has.no_change` | The fix is "the plan no longer proposes an in-place update of the SG", which no current leaf can say (`plan_clean` is false because the routine tag change is still pending). |
| ignore-changes-autoscaling | **Migrate** | `ignore_changes` is supported (`plan.ts`), `aws_ecs_service` is in `resources.ts`. |
| import-existing | **Migrate** and fix the known wrong fact | In us-east-1 the provider pre-checks and prints `creating S3 Bucket (NAME): BucketAlreadyExists`, not `BucketAlreadyOwnedByYou` (CONTENT_TODO "BucketAlreadyOwnedByYou" item). The CI log, hypothesis feedback, evidence label, debrief and sources are corrected; the log text is pinned to the engine's real error by a test. |
| moved-block | **Migrate**, keep (do not retire) | `terraform-module-refactor` (unpublished, harder, nested modules) is a different step of the same ladder; this is the one-resource entry point. `state mv` becomes an accepted second route (spec: "any route that produces the outcome counts"); it was a `wrong` button only because the scripted engine could not credit it. |
| state-in-git | **Migrate**, needs engine (random provider, state file on disk, backend migration) | The lesson (secrets live in state; move to a protected remote backend; rotate) cannot be played without a visible `terraform.tfstate` and `init -migrate-state`. |
| wrong-workspace-major | **Migrate the terraform part only**, keep stages/story/aws commands scripted | `workspace` and `-var-file` are supported. Largest incident, so last. |
| Late-naming latch | **No generic latch** (CONTENT_TODO says so). Task 11 rewrites the second-step fix predicates of the two published incidents (`partial-apply-iam`, `vcpu-limit`) to history-based leaves. The other incidents in that list are unpublished or low risk and stay logged. |

**Ids stay stable** for every migrated incident, so saved progress, shifts and links keep working. Evidence tags, action ids and `solution_paths` are kept unless a task says otherwise (moved-block: `state-mv` turns from `wrong` to a second `fix`; Task 8).

## Global Constraints

- Real Terraform is v1.9.8 with AWS provider v5.70.0 (the lab defaults); error and plan wording must match it. Any text that cannot be checked against source or docs is written down in `CONTENT_TODO.md` as `- [ ] Unverified:` with where it came from; verified texts get `- [x] Verified <date> against <source>`.
- Incident titles name symptoms only. One correct hypothesis per incident; wrong hypotheses stay plausible. Learning goal, difficulty, hypotheses, hints, debrief, analogy and concepts are preserved; only terraform output, state and fix detection change (plus factual corrections, logged).
- A fix is credited by world state (`done_when` on state, reality, history, files), never by a button alone. Traps are real mistakes that do real damage in the simulated world and stay on the score. Any route that produces the outcome counts (fairness): every task lists the routes it accepts.
- Do not script `terraform ...` commands in `terminal.commands` of a migrated incident (AUTHORING.md "Terraform incidents"). `git`, `aws`, `cat` and CI `pipeline`/`logs` text stay scripted, but any scripted text that quotes terraform output is pinned to the engine's real output by a test.
- Migrations are live: each ships as its own PR from its own branch off `main` (`tf7b-<slug>`), published as before (no `published: false`), merged only when its tests, the UI test and the checks below are green. Existing `tests/terraform-*.test.ts` stay green and byte-identical in output; engine tasks preserve default behaviour (new fields are opt-in).
- Rollback is tag-based (`.github/workflows/rollback.yml` redeploys a tag or commit). Before merging the first PR record the newest release tag (`git tag --sort=-v:refname | head -1`) in every PR description; to roll a migration back run Rollback with that tag, then revert the PR on `main`. Ids are stable, so a rollback loses no progress.
- Shell: use `rm -f` / `cp -f` (interactive aliases hang). Verification for every task: the task's test file, then `npm test`, `npx tsc -b`, `npm run lint`, `npm run build`; schema changes also `npm run schemas` (git must be clean afterwards). Rewrite YAML with Edit/Write or a small Python script, not `cp`.
- Commits end with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. `AUTHORING.md` (terraform section) is updated in the same task as any schema or predicate change.

## Review Focus

1. For every migrated incident each documented fix route is credited, each trap does its damage and is detected, and a fix is not credited by the trap or by a state that merely looks similar (count-index-shift: a replaced queue has the same URL as the old one, so detection must use history, not reality ids; Tasks 4 to 10 tests).
2. A fix that was credited stays credited when the player keeps working (history/file based leaves; Task 11 for the two published incidents) and a `remount` replays to the same world.
3. Scripted text that quotes terraform (CI logs, pipeline plan output) cannot drift from the engine: the same strings appear in a real run (import-existing error, moved-block plan, state-in-git `grep` output).
4. `plan_has.no_change` is true only when the plan proposes no update, replace or destroy of the named addresses (including module children and keyed instances), false when the plan has diagnostics; `plan_has.no_destroy` is unchanged (Task 1).
5. Local state file and backend migration do not change any lab that does not opt in; with opt-in the file always equals `state pull`, a migrated lab has no secret left on disk except where real Terraform leaves it (the `.backup`), and `init -migrate-state` without a changed backend says so (Task 2).
6. Retiring a published incident cannot break a saved game: a progress object containing `terraform-state-lock` loads, renders and scores (Task 3).

---

### Task 1: `plan_has.no_change` leaf and a `random_password` resource

**Files:**
- Modify: `src/schema/scenario.ts` (`plan_has` gains `no_change`), `src/game/terraform/predicates.ts` (`plan_has` branch), `src/game/terraform/resources.ts` (+ `providers.ts` if the provider table needs `random`), `AUTHORING.md` (predicate reference, resource list), `CONTENT_TODO.md`
- Test: `tests/terraform-predicates.test.ts` (extend), `tests/terraform-resources.test.ts` (extend)

**Interfaces:**
- Consumes: `PlanItem.action` (`create | update | replace | destroy | ...`), `addressCovers(pattern, address)` (`covers` in predicates.ts), `resources.ts` schema entries (see `aws_sqs_queue` for the shape: `forces_replacement`, `computed`, `sensitive`).
- Produces: `{ plan_has: { no_destroy?: string[]; no_change?: string[] } }` (at least one key; strict object). `no_change` is true iff the plan has no diagnostics and no item with action `update`, `replace` or `destroy` whose address is covered by any listed address. Resource type `random_password` (provider `registry.terraform.io/hashicorp/random`): arguments `length` (required number), `special` (bool, default true), `upper`/`lower`/`numeric` (bool, default true), `min_special` etc. may be left unsupported with `Unsupported argument`; computed `id`, `result` (sensitive, generated deterministically from the lab seed so a replay yields the same value; a replacement yields a new one), `bcrypt_hash` omitted. All argument changes force replacement (`keepers`, `length`, `special`...): check the provider docs. `-replace=random_password.db` and `taint` work through the existing generic paths.

- [ ] **Step 1: Write failing tests.** Predicates: a plan with an in-place SG update makes `{ plan_has: { no_change: ['aws_security_group.payments'] } }` false and `{ plan_has: { no_destroy: [...] } }` true; with the update removed it is true; a keyed instance and a whole module are covered by a key-less / module address; a plan with a diagnostic (broken config) is false; schema accepts `no_change` alone, `no_destroy` alone, both, and rejects `{}` and unknown keys. Resources: `random_password` plans as a create with `result = (sensitive value)` and `length`, `special` shown, applies with a stable 32-char result from the seed (letters/digits/specials per flags), changing `length` shows `# forces replacement`, `terraform state show random_password.db` prints `result = (sensitive value)` while `state pull` holds the plain text value, and `required_providers { random = { source = "hashicorp/random" } }` is accepted by `init` (provider installed line).
- [ ] **Step 2:** `npx vitest run tests/terraform-predicates.test.ts tests/terraform-resources.test.ts`; expected FAIL (schema rejects `no_change`, `Unsupported resource type "random_password"`).
- [ ] **Step 3: Implement** the schema change (keep `no_destroy` backward compatible: make both optional with a refine of "at least one"), the predicate branch, and the resource entry. Verify argument/forces-replacement facts against the random provider docs (log what cannot be checked).
- [ ] **Step 4:** run the two test files, then the full suite twice, `npx tsc -b`, `npm run lint`, `npm run schemas` (clean git).
- [ ] **Step 5: Docs and commit.** AUTHORING: `plan_has.no_change`, `random_password` in the supported list. Commit `feat: plan_has.no_change leaf and random_password resource (TF7b)`.

---

### Task 2: Local state file on disk and backend migration

**Files:**
- Modify: `src/schema/scenario.ts` (`terraform.state_file: boolean`), `src/game/terraform/lab.ts` (materialise and refresh `terraform.tfstate`, `terraform.tfstate.backup`), `src/game/terraform/cli.ts` (`init` detects a changed backend, `-migrate-state`, `-reconfigure`, `-force-copy`; plan/apply refuse until init), `src/game/shell.ts` (file sync after state-writing commands), `AUTHORING.md`, `CONTENT_TODO.md`
- Test: `tests/terraform-state-file.test.ts` (new; scaffold from `tests/terraform-shell-state.test.ts`)

**Interfaces:**
- Consumes: the lab's virtual disk (the same one `file_contains` and `cat` read), `state pull` serializer (`tfstate` JSON), `lab.history`, the HCL `terraform { backend "s3" { ... } }` block (already parsed; `orphans-after-state-rm` has one but only as text).
- Produces: scenario field `terraform.state_file: true` (default false). When true and the config has no `backend` block, `<dir>/terraform.tfstate` always equals `terraform state pull` of the default workspace (written at mount and after every command that writes state, `.backup` holds the previous serial after the first write). When the config gains a `backend "s3"` (or `"local"` with another path) block that differs from what `init` last recorded (`.terraform/terraform.tfstate`), every command that opens the backend fails with the real `Error: Backend initialization required, please run "terraform init"` (reason: `Backend configuration changed`; verify exact wording in `internal/command/meta_backend.go`). `terraform init` then fails with `Error: Backend configuration changed` and the message that asks for `-migrate-state` or `-reconfigure`; `init -migrate-state` copies state to the remote backend (state keeps its serial and lineage, the history gets `init-migrate`), prints the real "Successfully configured the backend" lines, empties `terraform.tfstate` and leaves `terraform.tfstate.backup` as real Terraform does (VERIFY in `internal/backend/local` and `internal/command/meta_backend_migrate.go`; if it differs, follow the source and note it); `-reconfigure` switches without copying (state appears empty: `plan` wants to create everything). No remote state file is shown on disk. A lab without `state_file: true` is byte-for-byte unchanged.

- [ ] **Step 1: Write failing tests**: opt-in lab has `terraform.tfstate` equal to `state pull`, changes serial after `apply`/`state rm`, `.backup` holds the previous state, a lab without the flag has no such file (regression), `grep password terraform.tfstate` finds a sensitive attribute in plain text; adding a `backend "s3"` block makes `plan` fail with the init-required error and `init` ask for `-migrate-state`; `init -migrate-state` then `plan` works against the same state (no changes), the local file is emptied, the backup file remains; `init -reconfigure` yields an empty state (plan wants to create everything) and leaves the local file untouched; `init` with no backend change is as today; removing the backend block again is also a change.
- [ ] **Step 2:** `npx vitest run tests/terraform-state-file.test.ts`; expected FAIL.
- [ ] **Step 3: Implement.** Keep the file sync in one function called from where `lab.state` is committed (not scattered per command). Remote state with a lock (`lock:`) is untouched.
- [ ] **Step 4:** run the new file, full suite twice, `npx tsc -b`, `npm run lint`, `npm run schemas`.
- [ ] **Step 5: Docs and commit.** AUTHORING (`state_file`, backend change flow, what remains on disk), CONTENT_TODO (log unverified wording, simplifications: one remote backend type, no workspaces prefix handling). Commit `feat: local state file on disk and init backend migration (TF7b)`.

---

### Task 3: Retire `terraform-state-lock`

**Files:**
- Delete: `content/iac/terraform-state-lock.yaml`
- Modify: `CONTENT_TODO.md` (remove the "## iac/terraform-state-lock" section and the TF7 retire item; keep the supersession note), `PLAN.md:67` only if it lists the file as current content (leave history prose alone)
- Test: `tests/terraform-retired.test.ts` (new)

**Interfaces:**
- Consumes: `loadProgress`/`isProgress`/`recordResult` (`src/game/progress.ts`), `unlockedTracks`, the content loader.
- Produces: nothing new. Branch `tf7b-retire-state-lock`.

- [ ] **Step 1: Write the test** (passes before and after, it pins the contract): a progress object `{ version: 1, xp: 120, completed: { 'terraform-state-lock': { bestScore: 100, completedAt: '2026-10-01T00:00:00.000Z', hintsUsed: 0, clean: true } }, streak, settings }` satisfies `isProgress`, `loadProgress` returns it untouched (no backup key written), `recordResult` on another incident keeps the entry, and `unlockedTracks(content.tracks, items, completed)` is unchanged by it; content has no item with that id and `terraform-cancelled-ci-lock` exists and is published (the replacement).
- [ ] **Step 2:** `rm -f content/iac/terraform-state-lock.yaml`; grep that nothing references the id (`grep -rn terraform-state-lock content src tests scripts` shows only history prose).
- [ ] **Step 3:** `npm test` (content guards: evidence/id checks), `npx tsc -b`, `npm run lint`, `npm run build`; `npm run check-links` is unaffected.
- [ ] **Step 4: Commit and PR** `content: retire terraform-state-lock, superseded by terraform-cancelled-ci-lock (TF7b)`. PR body: why no redirect (see Decisions), last release tag for rollback.

---

### Task 4: Migrate `terraform-count-index-shift`

**Files:**
- Modify: `content/iac/terraform-count-index-shift.yaml` (add `terraform:`, drop scripted terraform commands and the `queues.tf` `files` entry, whose content now lives in the lab)
- Create: `tests/terraform-count-index-shift.test.ts`, `tests/terraform-batch5-ui.test.tsx` (new, shared by Tasks 4 to 10; pattern from `tests/terraform-batch4-ui.test.tsx`)
- Modify: `CONTENT_TODO.md` (new section `## terraform migrations (TF7b)` with a batch status line, per-incident lists)

**Interfaces:**
- Consumes: `loadIncident`, `playbook` (`tests/helpers/terraform-incident.ts`), `aws_sqs_queue` schema (`name` forces replacement), count/`for_each`/`moved`.
- Produces: same scenario id; actions `for-each-moved` (fix), `apply-anyway` (destructive), `keep-placeholder`, `state-rm` (wrong) unchanged; evidence tags `shift-plan`, `indexed-state`, `count-list` now awarded by `terraform.evidence` (`plan` contains `must be replaced`; `state list` contains `aws_sqs_queue.queue[3]`; the config shows `count`, via a file read). `done_when` below. Branch `tf7b-count-index-shift`.

**Lab:** `dir: ~/infra`; `queues.tf` is the PR-branch file (list without "returns", `count = length(var.queue_names)`, `name = var.queue_names[count.index]`); state holds `aws_sqs_queue.queue[0..3]` named orders, returns, refunds, shipping (ids = queue URLs derived from the names); cloud equals state. Expected real output: two `must be replaced`, one `will be destroyed`, `Plan: 2 to add, 0 to change, 3 to destroy.` (assert exactly the scripted summary).

**Fix routes accepted.** (a) Switch to `for_each = toset(var.queue_names)` with `moved` blocks from each index to its name, (b) the same with `terraform state mv` of each index to its key, (c) stay on `count` and shuffle state with `state mv` (returns moved out of the way to a free index, the rest shifted down) so that the apply destroys only returns. Detection must not use queue ids (a replaced queue gets the same URL), so:

```yaml
- id: for-each-moved
  kind: fix
  done_when:
    all:
      - plan_clean: true
      - reality_lacks: { type: aws_sqs_queue, id: <returns url> }
      - reality_has:   { type: aws_sqs_queue, id: <orders url> }
      - reality_has:   { type: aws_sqs_queue, id: <refunds url> }
      - reality_has:   { type: aws_sqs_queue, id: <shipping url> }
      - not: { applied: { op: delete, address: 'aws_sqs_queue.queue[1]' } }
      - not: { applied: { op: delete, address: 'aws_sqs_queue.queue[2]' } }
      - not: { applied: { op: delete, address: 'aws_sqs_queue.queue[3]' } }
- id: apply-anyway
  kind: destructive
  done_when:
    any:
      - applied: { op: delete, address: 'aws_sqs_queue.queue[2]' }
      - applied: { op: delete, address: 'aws_sqs_queue.queue[3]' }
```

(Confirm in the first test that `applied` takes a keyed address and that route (c)'s destroy of the returns queue lands on a different index than 1 to 3; if the player reuses an index, document it and keep `[2]`/`[3]` only.)

- [ ] **Step 1: Write failing tests** (`tests/terraform-count-index-shift.test.ts`, scaffold from `tests/terraform-forces-replacement.test.ts`): backed by the simulator (`scenario.terraform` set, no scripted `terraform` command); `plan` summary and rows as above, evidence tags earnable before any fix (key evidence obtainable); route (a) with `sed`/heredoc edits plus `moved` blocks, remove "returns" in the list (config already without it), `plan` shows only `will be destroyed` for returns, `apply -auto-approve`, `detected(sh, 'for-each-moved')` true, `apply-anyway` false; route (b) with `state mv` of four addresses; route (c) with count and `state mv`; `apply -auto-approve` straight away: `apply-anyway` detected, `for-each-moved` never true afterwards (even after the player adds moved blocks later); a partial fix (for_each, no moves) shows 4 destroys/creates and credits nothing; `keep-placeholder` (list keeps "returns") plan clean but `reality_lacks` fails so the fix is not credited; `state rm` of all queues then `plan` wants to create everything (trap is visible, not credited); every `solution_paths` id exists.
- [ ] **Step 2:** run, expected FAIL (scripted engine, no `terraform` block).
- [ ] **Step 3: Rewrite the YAML** with a Python script or Edit: add the `terraform:` block, fix `done_when`, move `files` content into the lab, keep hypotheses/hints/debrief/analogy/concepts/sources verbatim.
- [ ] **Step 4:** tests green, then `tests/terraform-batch5-ui.test.tsx` case for this incident: ideal path (route a) through `IncidentScreen`: fix recorded once, `fixComplete`, resolved, `score(...).mistakes.destructive === 0`; trap path: exactly one destructive `TAKE_ACTION`; remount replays the same transcript. Then full suite twice, `npx tsc -b`, `npm run lint`, `npm run build`.
- [ ] **Step 5: Commit and PR** `content: terraform-count-index-shift runs on the simulator (TF7b)`. Not dark.

---

### Task 5: Migrate `terraform-drift-hotfix`

**Files:**
- Modify: `content/iac/terraform-drift-hotfix.yaml`, `tests/terraform-batch5-ui.test.tsx`, `CONTENT_TODO.md`
- Create: `tests/terraform-drift-hotfix.test.ts`

**Interfaces:**
- Consumes: Task 1 (`plan_has.no_change`), `cloud.patch`, `aws_security_group` inline `ingress`, `plan -refresh-only`, `apply -refresh-only`, `-target`.
- Produces: same id; actions `codify` (fix), `apply-anyway` (destructive), `target-instance`, `refresh-apply` (wrong); evidence `plan-removes-rule` (plan contains `ingress`), `drift` (plan contains `has changed` after `-refresh-only`), `hotfix-note` (scripted `logs`, unchanged). Branch `tf7b-drift-hotfix`.

**Lab:** `main.tf` with `aws_security_group.payments` (id `sg-0payments`, existing ingress rule 443 in state) and `aws_instance.payments_worker` whose config adds `tags = { cost-center = "payments" }` (state has no such tag). `cloud.patch` on the SG adds the 198.51.100.0/24:8443 rule `partner hotfix`. Expected `plan`: drift note, instance `~ tags` and SG `~ ingress` removing the hotfix rule, `Plan: 0 to add, 2 to change, 0 to destroy.`; `plan -refresh-only` shows the SG changed outside Terraform.

```yaml
- id: codify
  kind: fix
  done_when:
    all:
      - file_contains: { path: /home/you/infra/main.tf, matches: '198\.51\.100\.0/24' }
      - plan_has: { no_change: [aws_security_group.payments] }
      - not: { applied: { op: update, address: aws_security_group.payments } }
- id: apply-anyway
  kind: destructive
  done_when: { applied: { op: update, address: aws_security_group.payments } }
```

(Use the real lab directory path; the vcpu-limit YAML shows the `/home/you/...` convention. The `not applied update` leaf means that even a player who codifies after applying anyway is not credited the clean fix.)

- [ ] **Step 1: Write failing tests**: scripted plan replaced by the real one (rows above, SG change present); `-refresh-only` evidence; codify (edit the SG block to add the rule, then `plan`): only the tag change remains, `detected(codify)` true; `apply -auto-approve` after codify updates only the instance; `apply -auto-approve` straight away removes the rule from reality (`reality_has` ingress no longer contains 8443; `apply-anyway` detected, `codify` can never be credited after); `apply -target=aws_instance.payments_worker`: SG untouched, a later plan still proposes removing the rule, `codify` false; `apply -refresh-only -auto-approve`: state now holds the rule but plan still proposes removal (`codify` false); the rule written with a different description or CIDR order is accepted if the plan no longer changes the SG.
- [ ] **Step 2:** run, expected FAIL. **Step 3:** rewrite YAML as in Task 4. **Step 4:** UI ideal + trap tests (trap: exactly one destructive action, fix then unearnable), full checks. **Step 5:** commit and PR `content: terraform-drift-hotfix runs on the simulator (TF7b)`.

---

### Task 6: Migrate `terraform-ignore-changes-autoscaling`

**Files:**
- Modify: `content/iac/terraform-ignore-changes-autoscaling.yaml`, `tests/terraform-batch5-ui.test.tsx`, `CONTENT_TODO.md`
- Create: `tests/terraform-ignore-changes-autoscaling.test.ts`

**Interfaces:**
- Consumes: `aws_ecs_service` (`resources.ts:86`; `desired_count`, `name`, `cluster`, `task_definition`), `lifecycle.ignore_changes`, `cloud.patch`.
- Produces: same id; `ignore-desired` (fix), `remove-autoscaling` (destructive, button-only: the autoscaling target is not a modelled type; its feedback is kept), `set-12`, `apply-at-night` (wrong). Evidence: `plan-reset` (plan contains `desired_count`), `autoscaling` (scripted `aws application-autoscaling ...` command), `desired-fixed` (file read of `ecs.tf`). Branch `tf7b-ignore-changes`.

**Lab:** `ecs.tf` with `aws_ecs_service.checkout` (`desired_count = 2`, literal `cluster = "prod"` and a literal `task_definition` string if `aws_ecs_cluster` is not in `resources.ts`); state `desired_count: 2`; `cloud.patch` sets 12 (the autoscaler). Expected `plan`: `~ desired_count = 12 -> 2` (assert text), `Plan: 0 to add, 1 to change, 0 to destroy.`. The scripted `aws ecs describe-services ... desiredCount` stays scripted (`12`) and `when_actions`-free.

```yaml
- id: ignore-desired
  kind: fix
  done_when:
    all:
      - file_contains: { path: /home/you/infra/ecs.tf, matches: 'ignore_changes\s*=\s*\[[^\]]*desired_count' }
      - plan_clean: true
      - not: { applied: { op: update, address: aws_ecs_service.checkout } }
```

`set-12` (config `desired_count = 12`) makes `plan_clean` true but fails the `file_contains` leaf: pin that in a test so hard-coding the autoscaler's number is not credited. Accepted spellings: `ignore_changes = [desired_count]` with or without other attributes and in a one- or multi-line list.

- [ ] **Step 1: Write failing tests**: plan text above; evidence tags earnable; fix via heredoc and via `sed`, plan says `No changes. Your infrastructure matches the configuration.`, detected; apply-first (`apply -auto-approve`) resets reality to 2 (reality attr, trap damage), `ignore-desired` then not credited; `set-12` not credited; `ignore_changes = all` is accepted? decide: not accepted (too broad; regex requires the attribute name), say so in the feedback of a test comment and in CONTENT_TODO; typo `ignore_change` gives the real `Unsupported argument` and no credit.
- [ ] **Step 2 to 5** as Task 5. Commit/PR `content: terraform-ignore-changes-autoscaling runs on the simulator (TF7b)`.

---

### Task 7: Migrate `terraform-import-existing` and correct the bucket error

**Files:**
- Modify: `content/iac/terraform-import-existing.yaml`, `tests/terraform-batch5-ui.test.tsx`, `CONTENT_TODO.md` (retire the "BucketAlreadyOwnedByYou" item with `- [x] Verified`)
- Create: `tests/terraform-import-existing.test.ts`

**Interfaces:**
- Consumes: `import` blocks and `terraform import ADDR ID` (needs the object in `cloud.add`), the TF4 S3 duplicate-create error, `applied: { op: import }`.
- Produces: same id; `import-block` (fix, now `done_when`), `rename`, `ignore-error` (wrong), `delete-recreate` (destructive). Evidence `not-in-state` (`terraform.evidence`: `state show aws_s3_bucket.analytics_raw` contains `No instance found for the given address`; verify the text), `plan-create` (plan contains `will be created`), `exists` (scripted `aws s3api head-bucket`, unchanged), `already-owned` (the CI log; tag keeps its id, label text corrected). Branch `tf7b-import-existing`.

**Corrections (CONTENT_TODO item):** in us-east-1 the provider pre-checks with HeadBucket and prints `Error: creating S3 Bucket (acme-analytics-raw): BucketAlreadyExists` (see TF4 verification); replace the log line, the hypothesis feedback, the evidence label and the debrief wording that name `BucketAlreadyOwnedByYou`; keep a one-sentence note in the debrief that other Regions answer differently. The CI `logs` block is copied from a real `apply` run in the lab (test in Step 1 compares them) so wording cannot drift.

**Lab:** `main.tf` with the new `aws_s3_bucket.analytics_raw` (`bucket = "acme-analytics-raw"`), empty state, `cloud.add` the bucket with the provider-default attributes the schema expects and a few `aws_s3_object` rows (so a delete-recreate attempt hits `BucketNotEmpty` instead of silently succeeding: realistic, and the player must not be able to "fix" by deleting a 9 TB bucket). Fix routes: an `import { to = ..., id = ... }` block then `apply`, or `terraform import aws_s3_bucket.analytics_raw acme-analytics-raw`.

```yaml
- id: import-block
  kind: fix
  done_when:
    all:
      - state_has: aws_s3_bucket.analytics_raw
      - plan_clean: true
      - not: { applied: { op: delete, address: aws_s3_bucket.analytics_raw } }
- id: delete-recreate
  kind: destructive
  done_when: { applied: { op: delete, address: aws_s3_bucket.analytics_raw } }
```

(`delete-recreate` is only reachable if the player first lifts the objects or `force_destroy`; keep the button feedback and make the typed route the `aws s3 rb --force` scripted command's responsibility: if no typed destructive route exists, leave `delete-recreate` button-only and say so in CONTENT_TODO.)

- [ ] **Step 1: Write failing tests**: `apply` on the untouched lab fails with exactly the `BucketAlreadyExists` text, and the `already-owned` log contains that same line (extract the `Error:` line from the apply output and `expect(log).toContain(line)`); no mention of `BucketAlreadyOwnedByYou` anywhere in the YAML; `import` block route: `plan` shows `Plan: 1 to import, 0 to add, 0 to change, 0 to destroy.`, `apply -auto-approve` imports, state has the bucket, plan clean, detected; CLI `terraform import` route detected without an apply; importing with a wrong id or a bucket not in the cloud gives the real error and credits nothing; renaming the bucket in config then `apply` creates a new empty bucket (reality has both, nothing credited); `plan -generate-config-out` is "not simulated" (assert the message, log it).
- [ ] **Step 2 to 5** as Task 5. Commit/PR `content: terraform-import-existing runs on the simulator; correct us-east-1 bucket error (TF7b)`.

---

### Task 8: Migrate `terraform-moved-block`

**Files:**
- Modify: `content/iac/terraform-moved-block.yaml`, `tests/terraform-batch5-ui.test.tsx`, `CONTENT_TODO.md`
- Create: `tests/terraform-moved-block.test.ts`

**Interfaces:**
- Consumes: root-level `moved` blocks into a local module (`tests/terraform-modules-moved.test.ts` shows the supported form), `modules.installed`, `state mv` into a module, `applied`, `plan_has.no_destroy`.
- Produces: same id; `moved-block` (fix) and `state-mv` (now **fix** as a second route, was `wrong`), `prevent-destroy` (wrong), `merge-with-snapshot` (destructive). `solution_paths: [[moved-block], [state-mv]]`. The `pipeline` block stays (the PR plan CI posted); evidence `plan-destroy` (pipeline stage), `state-address` (`state list` contains `aws_db_instance.orders`), `refactor-diff`/`same-settings` (scripted `git diff`, `files`). Branch `tf7b-moved-block`.

**Why `state-mv` becomes a fix:** the spec says any route that yields the outcome counts, and on a shared remote state `state mv` is a legitimate (if unreviewed and not reproducible per environment) move. The debrief keeps the point that `moved` is the reviewed, repeatable way; the score difference (if any) belongs to `good practice`, not to a false "wrong". Log this content change in CONTENT_TODO and in the PR.

**Lab:** root `main.tf` (the PR branch: `module "database" { source = "./modules/database" }`, no root DB), `modules/database/main.tf` with the same `aws_db_instance.orders`, installed; state holds root `aws_db_instance.orders` (identifier `orders-prod`, id `db-ORDERSPROD7Q2X`) and the vpc. Expected `plan`: destroy of the root address (`is not in configuration`), create in the module, `Plan: 1 to add, 0 to change, 1 to destroy.`. The pipeline stage log keeps its text; a test asserts its key rows and summary appear in a real `plan` of the same lab.

```yaml
- id: moved-block
  kind: fix
  done_when:
    all:
      - file_contains: { path: /home/you/infra-prod/main.tf, matches: 'moved\s*\{[^}]*from\s*=\s*aws_db_instance\.orders[^}]*to\s*=\s*module\.database\.aws_db_instance\.orders' }
      - plan_has: { no_destroy: [aws_db_instance.orders, module.database.aws_db_instance.orders] }
      - not: { applied: { op: delete, address: aws_db_instance.orders } }
- id: state-mv
  kind: fix
  done_when:
    all:
      - state_has: module.database.aws_db_instance.orders
      - state_lacks: aws_db_instance.orders
      - plan_has: { no_destroy: [module.database.aws_db_instance.orders] }
      - not: { applied: { op: delete, address: aws_db_instance.orders } }
- id: merge-with-snapshot
  kind: destructive
  done_when: { applied: { op: delete, address: aws_db_instance.orders } }
```

- [ ] **Step 1: Write failing tests**: real plan rows and summary; the pipeline log is consistent with it; `moved` block route: plan `# aws_db_instance.orders has moved to module.database.aws_db_instance.orders` and `Plan: 0 to add, 0 to change, 0 to destroy.`, apply keeps the same id (reality unchanged), `moved-block` detected, `state-mv` not; `state mv` route detected, `moved-block` not; `apply -auto-approve` on the untouched lab destroys the real DB (reality lacks `db-ORDERSPROD7Q2X`, `merge-with-snapshot` detected, neither fix creditable afterwards); `prevent_destroy = true` added to the module resource gives `Instance cannot be destroyed` and no credit; `moved` block with the wrong `to` fails validation or still plans a destroy, no credit.
- [ ] **Step 2 to 5** as Task 5. Commit/PR `content: terraform-moved-block runs on the simulator; state mv credited (TF7b)`.

---

### Task 9: Migrate `terraform-state-in-git`

**Files:**
- Modify: `content/iac/terraform-state-in-git.yaml`, `tests/terraform-batch5-ui.test.tsx`, `CONTENT_TODO.md`
- Create: `tests/terraform-state-in-git.test.ts`

**Interfaces:**
- Consumes: Task 1 (`random_password`), Task 2 (`state_file: true`, backend migration), scripted `git ls-files` / `git log` commands (git history purging cannot be simulated; the incident keeps those scripted and credits the terraform-side facts).
- Produces: same id; `remote-backend` (fix), `rotate` (fix), `gitignore-only`, `make-private` (wrong); `solution_paths: [[remote-backend, rotate]]` unchanged; evidence `password-in-state` (`state pull` contains `result`... use `terraform.evidence` on `state show random_password.db` contains `(sensitive value)` AND a `grep` of the state file as a scripted-free shell command is awarded by `terminal` evidence on `grep`, check which the engine supports), `state-tracked` (scripted `git ls-files` listing `terraform.tfstate` and `.backup`), `no-backend` (a file read of `main.tf`). Branch `tf7b-state-in-git`.

**Lab:** `state_file: true`; `main.tf` without a backend, `random_password.db` (length 32) feeding `aws_db_instance.analytics.password`; `.gitignore` absent or listing only `.terraform/`; state holds both (the password in plain text in `terraform.tfstate`). Scripted `git ls-files` shows the tracked state and backup.

```yaml
- id: remote-backend
  kind: fix
  done_when:
    all:
      - file_contains: { path: /home/you/analytics-infra/main.tf, matches: 'backend\s+"s3"' }
      - file_contains: { path: /home/you/analytics-infra/.gitignore, matches: 'terraform\.tfstate' }
      - not: { file_contains: { path: /home/you/analytics-infra/terraform.tfstate, matches: '"result"' } }
      - not: { file_contains: { path: /home/you/analytics-infra/terraform.tfstate.backup, matches: '"result"' } }
- id: rotate
  kind: fix
  done_when: { applied: { op: create, address: random_password.db } }
```

(`rotate` is history-based so it survives later work; the `remote-backend` leaves require the player to also delete the leftover `.backup` with `rm`, mirroring the real "migration leaves a copy behind" trap. If Task 2 verifies that real Terraform does NOT leave the backup, drop the `.backup` leaf and say so. `gitignore-only` is credited nothing: backend leaf fails. `make-private` is button-only.)

- [ ] **Step 1: Write failing tests**: `grep -c password terraform.tfstate` style check finds the secret (the lab's evidence route); `state show random_password.db` hides it while `state pull` and the file show it; `.gitignore`-only edit credits nothing; backend block without migration makes `plan` fail with init-required (trap: plan wants to create everything after `init -reconfigure`, apply then creates a second database and a new password); `init -migrate-state` plus `.gitignore` plus `rm terraform.tfstate.backup` credits `remote-backend`; `apply -replace=random_password.db` credits `rotate` and the new password differs from the old one; replace order independence (rotate before migrate) credits both; each fix survives a later unrelated `apply`; remount replays.
- [ ] **Step 2 to 5** as Task 5. Commit/PR `content: terraform-state-in-git runs on the simulator (TF7b)`.

---

### Task 10: Migrate the Terraform part of `wrong-workspace-major`

**Files:**
- Modify: `content/iac/wrong-workspace-major.yaml`, `tests/terraform-batch5-ui.test.tsx`, `CONTENT_TODO.md`
- Create: `tests/terraform-wrong-workspace-major.test.ts`

**Interfaces:**
- Consumes: workspaces (`workspace`, `workspaces`, `terraform.workspace`), `-var-file`, `aws_db_instance` (`instance_class`, `multi_az`; check which attributes force replacement), the incident's existing stages/diagram/pipeline blocks.
- Produces: same id, same stages, hypotheses, scripted `aws rds ...` commands (their `when_actions` stay keyed to the existing action ids), actions `prod-apply` (fix), `select-staging`, `console-resize` (wrong), `state-rm` (destructive). Branch `tf7b-wrong-workspace`.

Read the whole incident before editing; replace only `terraform ...` commands. Lab: `dir: ~/infra/data`, `workspace: prod`, `workspaces: { staging: {...} }`, `main.tf` driven by `var.instance_class` / `var.environment` with a check that `var.environment == terraform.workspace` only in the debrief's recommended fix (not in the starting config); `prod.tfvars` and `staging.tfvars` as files; prod state holds the shrunk instance (applied from `staging.tfvars` last Monday by mistake, see the incident history); cloud equals state. Expected: `workspace show` prints `prod`; `plan -var-file=prod.tfvars` proposes the resize back (`~ instance_class`); the scripted RDS commands keep telling the CPU/maintenance-window story.

```yaml
- id: prod-apply
  kind: fix
  done_when:
    all:
      - reality_has: { type: aws_db_instance, id: <prod instance id>, attr: instance_class, equals: <prod class> }
      - plan_clean: true
- id: state-rm
  kind: destructive
  done_when: { state_lacks: aws_db_instance.orders }
```

(The `prod-apply` predicate is workspace-aware by construction: `plan_clean` is evaluated in the current workspace. Using the staging var-file in prod must not satisfy it. Keep `file_contains` for the optional guard out of the predicate: the guard is advice, not a requirement.)

- [ ] **Step 1: Write failing tests**: `workspace show`/`list`; `plan` without a var-file vs with `staging.tfvars` vs `prod.tfvars` (three outputs); applying `prod.tfvars` in `prod` credits `prod-apply`; selecting `staging` and applying `staging.tfvars` changes only staging state (`select-staging` is a wrong button, nothing credited, prod untouched); `state rm aws_db_instance.orders` in prod credits `state-rm` (destructive) and a subsequent `plan` wants to create a second prod database; apply of `prod.tfvars` while in `staging` is refused or changes staging only; all scripted `aws` commands still resolve with the same `when_actions`; stage transitions of the existing multi-stage flow still advance (`tests/` for stages: copy the assertion style of the existing stage tests).
- [ ] **Step 2 to 5** as Task 5. Commit/PR `content: wrong-workspace-major terraform runs on the simulator (TF7b)`.

---

### Task 11: Persistent fix predicates for `terraform-partial-apply-iam` and `terraform-vcpu-limit`

**Files:**
- Modify: `content/iac/terraform-partial-apply-iam.yaml`, `content/iac/terraform-vcpu-limit.yaml`, `CONTENT_TODO.md` (update the "Late root-cause naming" item: these two done, the rest logged as unchanged)
- Test: `tests/terraform-partial-apply-iam.test.ts`, `tests/terraform-vcpu-limit.test.ts` (extend)

**Interfaces:**
- Consumes: `checkFixes` behaviour (`src/components/terminal/session.ts:121`): a fix action is taken only when the root cause is named at that moment, so a predicate that is true only transiently is lost if the world changes before the player names the cause. History leaves (`applied`) and file leaves persist.
- Produces: `finish-apply` in both incidents rewritten without the transient `state_has`/`plan_clean` pair, e.g. for partial-apply-iam:

```yaml
- id: finish-apply
  kind: fix
  done_when:
    all:
      - applied: { op: create, address: aws_db_instance.orders }
      - not: { applied: { op: delete, address: aws_vpc.main } }
      - not: { applied: { op: delete, address: aws_security_group.db } }
      - not: { applied: { op: delete, address: aws_subnet.data_a } }
      - not: { applied: { op: delete, address: aws_subnet.data_b } }
```

and for vcpu-limit `finish-apply`: `applied: { op: create, address: aws_instance.loadgen }` replaces `state_has` + `plan_clean`, keeping the `file_contains` size regex and the three `not applied delete` leaves. `right-size` gets the same treatment. Branch `tf7b-persistent-predicates`. Not dark (the incidents are published).

Trade-off recorded in CONTENT_TODO: a fix credited by history stays credited if the player later destroys the resource by another route (the destructive actions' own `applied delete` leaves still catch the damage, and `not applied delete` on the dependencies stays in the fix).

- [ ] **Step 1: Write failing tests** (they fail before the rewrite): for each incident, play the ideal path, then run a state-changing command before the cause is named (a `terraform state rm` of an unrelated resource in vcpu-limit, a `terraform apply -replace=...` of a leaf resource in partial-apply-iam) and assert `detected(sh, 'finish-apply')` is still true; the trap path (destroy dependencies) never credits `finish-apply`; ideal-path regression of the existing tests; a player who never applies (state edit only, `edit-state`) credits nothing.
- [ ] **Step 2:** run, expected FAIL (the transient predicates are false after the extra command). **Step 3:** rewrite the two actions. **Step 4:** run both test files, the existing UI tests for these incidents (`tests/terraform-batch2-ui.test.tsx`), full checks. **Step 5:** commit and PR `fix: persistent finish-apply predicates for partial-apply-iam and vcpu-limit (TF7b)`.

---

### Task 12: Batch wrap-up, final review, release

**Files:**
- Modify: `CONTENT_TODO.md`, `AUTHORING.md` (remove the "scripted terraform" caveats if any remain), `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` (one dated line under "Context": the scripted incidents were migrated in TF7b; do not rewrite history)
- Test: `tests/terraform-batch5-ui.test.tsx` (complete), a guard test `tests/terraform-no-scripted.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 1 to 11 merged on `main`.
- Produces: guard that no incident in `content/` has `terminal.commands` whose `match`/`match_regex`/`example` starts with `terraform` unless it also has no `terraform:` block (the old scripted engine is now unused by content, but keep it: out-of-scope to remove).

- [ ] **Step 1:** guard test: every incident with a `terraform:` block has no scripted `terraform` command, and the list of incidents without a `terraform:` block that mention scripted terraform output is empty (`grep -l 'match: "terraform' content/**/*.yaml`).
- [ ] **Step 2:** confirm no evidence tag, id, command-library id or file collides (`npm test` content guards) and that every migrated incident's `key_evidence` is obtainable before the fix in the UI test (methodical bonus earnable).
- [ ] **Step 3:** tidy `## terraform migrations (TF7b)` in `CONTENT_TODO.md`: per incident, what changed, verified/unverified lists, content changes to review (moved-block `state-mv` now a fix; import-existing error text; wrong-workspace scope), the retired id and why no redirect; mark the TF7b line in "TF7a batch status" done; leave the other TF7 follow-ups open.
- [ ] **Step 4: Final review.** One whole-branch review across the merged PRs: Review Focus 1 to 6, fairness of each fix route, no accidental change to wording not listed above; fix findings in one tidy commit.
- [ ] **Step 5: Verify** on `main`: `npm test` twice, `npx tsc -b`, `npm run lint`, `npm run build`, `npm run schemas` (clean git), `npm run check-links`.
- [ ] **Step 6: Release.** Tag the next version (`v0.x`) after the last PR merges; the release notes list the migrated ids, the retired id and the previous tag (the Rollback workflow target).
- [ ] **Step 7: Commit** `test: TF7b incidents resolve through the UI; content log tidy`.

---

## Self-review (done)

- **Spec coverage:** the spec's "migrate the 9 scripted incidents at the end": state lock (retired, Task 3), drift (5), import (7), moved (8), count-index shift (4), forces-replacement (already migrated in TF4; nothing to do), `ignore_changes` (6), secrets in state (9), wrong workspace (10). CONTENT_TODO items: retire `terraform-state-lock` (3), BucketAlreadyOwnedByYou fix (7), late-naming latch for the two published incidents (11); the other late-naming incidents stay logged on purpose.
- **Placeholders:** the `<... url>` / `<prod instance id>` values in Tasks 4 and 10 are read from the YAML's own lab when authoring (the test fixes them); every other value is concrete. Items marked VERIFY name the source file to check.
- **Type consistency:** `plan_has.no_change`, `terraform.state_file`, `random_password`, history ops `create`/`update`/`delete`/`import` (the `applied` enum is `create | update | delete | import | forget`) and the shared test file `tests/terraform-batch5-ui.test.tsx` are named identically in every task.
- **Review Focus:** 1 to Tasks 4 to 10, 2 to Tasks 9 and 11, 3 to Tasks 7, 8, 9, 4 to Task 1, 5 to Task 2, 6 to Task 3.
