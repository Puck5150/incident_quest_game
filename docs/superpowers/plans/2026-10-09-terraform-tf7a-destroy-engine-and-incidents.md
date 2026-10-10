# Terraform TF7a: destroy problems, engine and incidents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the "destroy problems" batch on the finished simulator: four new incidents (destroy blocked by a non-empty bucket, destroy blocked by a dependency, resources deleted out-of-band, orphans after `state rm`), preceded by the simulator support they need: `create_before_destroy` ordering with a minimal deposed object, destroy-time provider errors (`BucketNotEmpty`, wrapped `DependencyViolation`, `NotFound` handling), a way for a player's action to release a blocker in the simulated cloud, and the lock-bypass marker plus `lock_bypassed` predicate leaf for state-writing commands. Migrating the 9 scripted incidents is TF7b, a separate later plan; nothing here touches them.

**Architecture:** Tasks 1 to 4 are engine work in `src/game/terraform/` (apply ordering, provider errors, the cloud-release schema field, history markers), each with its own unit tests and a review gate (same process as TF3 to TF6c). Tasks 5 to 8 are content (one YAML + one playthrough test each, copying the approved TF4/TF5/TF6c incidents; tests through `tests/helpers/terraform-incident.ts`). Task 9 is the batch wrap-up (UI resolution tests, CONTENT_TODO tidy, final review, ship dark).

**Tech Stack:** TypeScript (strict), YAML content, vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` (destroy problems candidates: destroy stuck on dependencies, non-empty bucket, resources deleted out-of-band, orphans after `state rm`). Also the open items in `CONTENT_TODO.md` section "## terraform follow-ups (TF7)" (create_before_destroy ordering, lock bypass marker) and the TF5 defect list (SG DependencyViolation wrapper).

## Global Constraints

- Real Terraform is v1.9.8 with AWS provider v5.70.0 (the lab defaults); error and plan wording must match it. Any text that cannot be checked against source or docs is written down in `CONTENT_TODO.md` as `- [ ] Unverified:` with where it came from; verified texts get `- [x] Verified <date> against <source>`.
- Incident titles name symptoms only, never the cause or the fix. One correct hypothesis per incident; wrong hypotheses are plausible. Evidence tags are per incident and must not collide with other incidents' ids in a way the content guard rejects.
- A fix is credited by world state (`done_when` predicates on state, reality, history, files), never by a button alone. Traps are real mistakes that do real damage in the simulated world; a destructive trap makes the fix unearnable or stays on the score (document which, as TF5 did).
- No new incident is playable until the review is done: ship with `published: false` (TF6c did this; `tests` guard lists what is dark). Existing scripted terraform incidents and every existing `tests/terraform-*.test.ts` stay green and byte-identical in output.
- Default behaviour is preserved: scenarios without `create_before_destroy`, without force_destroy, without the new schema fields run exactly as before.
- Shell: use `rm -f` / `cp -f` (interactive aliases hang). Verification commands for every task: the task's test file, then `npm test`, `npx tsc -b`, `npm run lint`, `npm run build`; schema changes also `npm run schemas` (git must be clean afterwards).
- Commits end with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- `AUTHORING.md` (terraform section) is updated in the same task as any scenario-schema or predicate change.

## Review Focus

1. A `create_before_destroy` replacement orders create, dependents' updates, then delete of the old object; when the delete fails the new object stays, the old one is kept as a deposed object (state, `plan`, next `apply` retry it) and nothing else is lost; non-CBD replaces and every existing test are unchanged (Task 1).
2. Destroy errors read like the real provider and are chosen by world state: a bucket is `BucketNotEmpty` only while objects exist and `force_destroy` is false IN STATE (setting it in config without applying does not help, as in real Terraform); a subnet/SG/VPC is blocked only by an object that still exists; releasing the blocker clears it (Task 2, 3).
3. An object deleted out-of-band never wedges destroy or plan: refresh drops it (drift lines), `destroy` plans nothing for it, `-refresh=false` runs treat the delete as already done, an update against a vanished object is `NotFound`, and none of this changes state for objects that still exist (Task 3).
4. `lock_bypassed: true` is true after ANY state-writing command run with `-lock=false` past a held lock and false when the lock was free or the command was read-only; existing `applied.lock_bypassed` semantics are untouched (Task 4).
5. In every incident the fix is credited by what the world looks like, every trap does real damage, a second hypothesis is plausible but wrong, and the player can finish the incident only by the documented routes (Tasks 5 to 8 tests; UI tests in Task 9).

---

### Task 1: `create_before_destroy` ordering with a minimal deposed object

**Files:**
- Modify: `src/game/terraform/apply.ts` (replace handling, deposed list), `src/game/terraform/state.ts` (`StateInstance.deposed?`), `src/game/terraform/plan.ts` (emit a destroy item for a deposed object), `src/game/terraform/render.ts` / `render-apply.ts` (deposed wording), `src/game/terraform/state-ops.ts` (`state list`/`show`/`pull` keep deposed; `state rm` of the address removes it too), `CONTENT_TODO.md` (retire the TF7 CBD item, log the simplifications)
- Test: `tests/terraform-create-before-destroy.test.ts` (new; use the `run`/`stateOf`/`cloudOf`/`ops` scaffold from `tests/terraform-apply.test.ts`)

**Interfaces:**
- Consumes: `PlanItem.createBeforeDestroy?: boolean` (plan.ts, set for `replace` when the lifecycle has it), `executeApply(input, ctx)`, `Fault`, `faultFor`, `fail(...)`, `removeInstance`, `addInstance`.
- Produces: `StateInstance.deposed?: { key: string; attributes: Record<string, Value> }[]` (key = 8 hex digits from `hex(seed, 8)`); `ApplyStep` for the old object's delete keeps `op: 'delete'` and `address` of the instance, with `id` = the OLD id; plan items `{ action: 'destroy', deposed: key }` for deposed objects. `history` lines are unchanged (`create ADDR`, `delete ADDR`).

**Behavior (verify in Terraform v1.9.8: `internal/terraform/node_resource_apply_instance.go`, `node_resource_destroy_deposed.go`, `internal/command/jsonformat/plan.go` for the `+/-` row and the deposed wording; log what cannot be checked):**
- A replace with `createBeforeDestroy`: step order is create the new object, then (as the loop already re-plans) updates of dependents that now point at the new id, then delete the old object. Dependents of the old object must NOT be destroyed before the new exists. A plain `-/+` replace keeps today's order (delete first).
- Moving the old object aside: right after the create succeeds, the state instance holds the NEW attributes and the OLD ones under `deposed: [{ key, attributes }]`. A successful old delete removes the deposed entry, the reality object, and counts `destroyed`. A failed delete (fault or `DependencyViolation`) leaves the entry: the error is `Error: deleting ...` with the same context line as other delete errors, the run continues with independent work, `counts` show added and no destroyed.
- A failed create in a CBD replace changes nothing (old object stays, no deposed entry).
- A later `terraform plan` (and `apply`) with a deposed entry plans a destroy of it: the plan row `# aws_x.y (deposed object KEY) will be destroyed` with `# (it will be destroyed because it is deposed)` wording as verified, `Plan: 0 to add, 0 to change, 1 to destroy.`, and `apply` retries the delete (faults/`until_actions` apply). `terraform destroy` also removes deposed objects. `state list` prints `aws_x.y` and a second row `aws_x.y (deposed object KEY)`; `state show` shows the live one.
- `-target`, `-replace`, `moved`, workspaces: deposed lives on the instance and moves/renames with it; no new options. Anything else (several deposed objects per address, deposed in `import`) is out of scope: log it.

- [ ] **Step 1: Write failing tests** (`tests/terraform-create-before-destroy.test.ts`): (a) SG replaced on a name change with CBD and a dependent instance: ops are `create aws_security_group.web`, `update aws_instance.app`, `delete aws_security_group.web` (new id differs from the old, the instance points at the new id before the delete); (b) the same without CBD: `delete` then `create` (today's order, regression); (c) CBD with a `delete` fault on the old group (the TF5 sg-cycle shape, `DependencyViolation`): `ops` ends in `!delete aws_security_group.web`, errors has one `Error` with the delete text, state holds the new group plus `deposed` with the old id, reality holds both ids, counts `{ added: 1, changed: 1, destroyed: 0 }`; (d) a second `executeApply` on that state with the fault inactive deletes the deposed object, leaves the new one, clears `deposed`; (e) a failed create under CBD leaves the old object and no deposed entry; (f) plan rendering of the deposed row and `Plan: 0 to add, 0 to change, 1 to destroy.`; (g) `state list` shows the deposed row, `state rm aws_security_group.web` removes both; (h) CBD resource that is NOT replaced behaves as today; (i) full existing suite untouched.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/terraform-create-before-destroy.test.ts`; expected FAIL (no `deposed`, delete runs first).
- [ ] **Step 3: Implement** in `apply.ts`: in `pickNext`, treat a `replace` with `createBeforeDestroy` as a create (ready when its dependencies are ready) and defer its delete half; in the loop, after the create succeeds, move the old attributes into `deposed` and pick the delete half as a destroy-phase step once no pending create/update still depends on the old id. `plan.ts`: emit the deposed destroy item; renderers: the wording from the verification.
- [ ] **Step 4: Run tests until they pass**, then the full suite twice, `npx tsc -b`, `npm run lint`.
- [ ] **Step 5: Docs and commit** — AUTHORING.md note (a CBD replace can leave a deposed object after a failed delete), CONTENT_TODO: mark the CBD item done, log unverified wording and the one-deposed-per-address limit. Commit `feat: create_before_destroy ordering with a minimal deposed object (TF7a)`.

---

### Task 2: Destroy-time provider errors: `BucketNotEmpty` and a wrapped SG `DependencyViolation`

**Files:**
- Modify: `src/game/terraform/provider.ts` (`bucketNotEmpty`, `dependencyViolation` SG text, S3 object helper), `src/game/terraform/apply.ts` (delete path), `AUTHORING.md`, `CONTENT_TODO.md`
- Test: `tests/terraform-destroy-errors.test.ts` (new)

**Interfaces:**
- Consumes: `referencedBy(reality, type, id)`, `dependencyViolation(type, id, seed)`, the destroy branch in `executeApply` (`faultFor(i, 'delete', attrs) ?? (ref ? dependencyViolation(...) : undefined)`), `requestId(seed)`.
- Produces: `export function bucketObjects(reality: Reality, bucket: string): string[]` (reality keys of type `aws_s3_object` whose id starts with `BUCKET/`); `export function bucketNotEmpty(name: string, seed: string): string`; the delete path calls `bucketNotEmpty` when the type is `aws_s3_bucket`, the bucket has objects and the STATE attribute `force_destroy` (`prior`) is not `true`; with `force_destroy` true in state the objects are removed from reality and the bucket deleted. Objects in reality are authored with `cloud.add: [{ type: aws_s3_object, attrs: { id: "BUCKET/path/key", bucket: BUCKET, key: path/key } }]`.

**Behavior (verify in provider v5.70.0 `internal/service/s3/bucket.go` resourceBucketDelete and the S3 DeleteBucket API reference; log the rest):**
- `terraform destroy` (and a replace or removal of the bucket) with objects present and `force_destroy = false` in state: `Error: deleting S3 Bucket (NAME): operation error S3: DeleteBucket, https response error StatusCode: 409, RequestID: ..., HostID: ..., api error BucketNotEmpty: The bucket you tried to delete is not empty`. The wording, 409, HostID and a possible `You must delete all versions in the bucket.` suffix for versioned buckets are unverified unless found: flag in CONTENT_TODO.
- `force_destroy` is read from STATE, not configuration: after editing the config to `force_destroy = true`, a `destroy` straight away still fails; `apply` (an in-place update writing the attribute) then `destroy` succeeds and removes the objects. The plan for the update is the usual `~ force_destroy = false -> true` row.
- A bucket with no objects deletes as today. Bucket versions/delete markers are not modelled (log).
- The built-in SG text gains the SDK v2 wrapper: `deleting Security Group (ID): operation error EC2: DeleteSecurityGroup, https response error StatusCode: 400, RequestID: ..., api error DependencyViolation: resource ID has a dependent object`; subnet and VPC texts stay. Existing tests that assert the old SG text are updated in this task (grep `has a dependent object`).
- ENI blocker: an `aws_network_interface` (or any reality object whose attributes mention the subnet or SG id) blocks the delete through `referencedBy` exactly like an instance; no new engine path, but a test pins it for subnet, SG and VPC (VPC blocked by a subnet created out of band).

- [ ] **Step 1: Write failing tests**: bucket with two objects, `force_destroy` false in state: destroy fails with the BucketNotEmpty text (summary, context `resource "aws_s3_bucket" "logs"`, address, file/line), objects and bucket remain, state keeps the bucket and `counts.destroyed` is 0; edit-config-only then destroy still fails; update then destroy succeeds, `reality` has no bucket and no objects; empty bucket deletes; subnet blocked by an ENI mentioning its id (exact DeleteSubnet text), SG blocked by an ENI (wrapped text), VPC blocked by a foreign subnet; dependents still skipped when a delete fails; a second destroy after removing the blocker from reality succeeds.
- [ ] **Step 2: Run to verify they fail**, `npx vitest run tests/terraform-destroy-errors.test.ts`.
- [ ] **Step 3: Implement** the helpers and the delete-path branch (bucket check before faults? scripted `faults` still win, as for other types).
- [ ] **Step 4: Run** the new file, then the full suite twice; fix the SG-text assertions in existing tests (only the wrapper changes).
- [ ] **Step 5: Docs and commit** — AUTHORING (how to author objects in a bucket, `force_destroy` reads state, blocker objects in `cloud.add`), CONTENT_TODO (retire the TF5 "built-in SG text lacks the wrapper" defect, log unverified BucketNotEmpty details). Commit `feat: BucketNotEmpty and wrapped SG DependencyViolation on destroy (TF7a)`.

---

### Task 3: Out-of-band deletes (`NotFound`) and a player action that releases a blocker

**Files:**
- Modify: `src/game/terraform/apply.ts` (delete/update of a vanished object), `src/game/terraform/provider.ts` (`notFound(type, id, op, seed)`), `src/schema/scenario.ts` (`terraform.cloud.release`), `src/game/terraform/lab.ts` + `cli.ts` (apply releases before each terraform command), `AUTHORING.md`, `CONTENT_TODO.md`
- Test: `tests/terraform-out-of-band.test.ts` (new); schema guard cases in the existing scenario schema test file

**Interfaces:**
- Consumes: `Reality`, `refresh()` drift kind `'deleted'`, `ctx.taken` (CLI context: set of taken action ids), `terraform.cloud` schema (`add`, `patch`, `delete`).
- Produces: `terraform.cloud.release: [{ type: string, id: string, when_actions: string[] }]` (strict object; validated like faults' `until_actions`: unknown action ids rejected, `type:id` must exist in state or `cloud.add`); runtime rule: before any terraform command, every release whose actions are ALL in `taken` is deleted from `lab.reality` (idempotent). `provider.notFound(type, id, op, seed): string` with per-type SDK wording.

**Behavior (verify in Terraform v1.9.8 `internal/terraform/node_resource_abstract_instance.go` refresh path and provider v5.70.0 delete functions; most providers treat a NotFound delete as success):**
- Plan/destroy with refresh (default): an object missing from reality is drift `deleted`; `terraform destroy` shows `Plan: 0 to add, 0 to change, 0 to destroy.` with the "has been deleted outside of Terraform" notes only where the existing renderer shows them, and `apply` then removes the entry from state with no provider call (unchanged behaviour; pinned by a test here since the incident depends on it).
- `-refresh=false` destroy of an object missing from reality: the delete step succeeds (provider treats NotFound as gone), counts `destroyed`, removes the state entry; no error.
- `-refresh=false` update of a vanished object: `Error: updating EC2 Instance (ID): operation error EC2: ..., api error InvalidInstanceID.NotFound: The instance ID 'ID' does not exist` (EC2) / `NoSuchBucket` (S3) / generic `NotFound` text per type; the failed resource blocks its dependents as other errors do. Unverified wording goes to CONTENT_TODO.
- `-refresh=false` plan against a vanished object shows no drift (state is trusted): a test pins the wrong-but-real "No changes" answer, which is what makes `-refresh=false` a trap in the out-of-band incident.
- `cloud.release` is how a typed player command (an `aws ... delete-network-interface`-style scripted action matched by `match_regex`, as the vcpu quota action) removes a blocker object from the cloud: no scripted output engine change; the action's feedback carries the story.

- [ ] **Step 1: Write failing tests**: destroy with refresh after a console delete (0 to destroy, state emptied, no step ops); `-refresh=false` destroy (delete step ok, no error); `-refresh=false` update gives NotFound text and skips dependents; `-refresh=false` plan says no changes; `cloud.release` through a scenario built with the schema (parse test: unknown action, unknown object rejected; accepted case): a subnet blocked by an ENI fails `destroy`, then after the action is taken (`taken` set) the same command succeeds; release is idempotent and replay-safe (remount rebuilds the same reality).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement**; keep the release application in one place (the CLI entry that already builds `ctx`), not scattered per command.
- [ ] **Step 4: Run** the new tests, full suite twice, `npx tsc -b`, `npm run lint`, `npm run schemas`.
- [ ] **Step 5: Docs and commit** — AUTHORING (`cloud.release`, out-of-band authoring with `cloud.delete`, the `-refresh=false` behaviours), CONTENT_TODO unverified notes. Commit `feat: NotFound handling and cloud.release for destroy problems (TF7a)`.

---

### Task 4: Lock-bypass marker for state-writing commands, `lock_bypassed` predicate leaf

**Files:**
- Modify: `src/game/terraform/cli.ts` (every `checkLock(ctx, a.lock)` caller: `state mv`, `state rm`, `taint`, `untaint`, `import`, `workspace new`, `workspace delete`), `src/game/terraform/predicates.ts` (new leaf, history helper), `src/schema/scenario.ts` (`LeafSchema` leaf), `AUTHORING.md`, `CONTENT_TODO.md` (retire the TF7 lock-bypass item)
- Test: `tests/terraform-lock-bypass.test.ts` (new); extend `tests/terraform-predicates.test.ts`

**Interfaces:**
- Consumes: `LOCK_BYPASSED = ' (lock bypassed)'`, `lab.history: string[]`, `lab.lock`, `checkLock(ctx, lock)`.
- Produces: history lines for state-writing commands: `state-rm ADDR`, `state-mv ADDR`, `taint ADDR`, `untaint ADDR`, `import ADDR`, `workspace-new NAME`, `workspace-delete NAME`, each with `LOCK_BYPASSED` appended only when `-lock=false` ran while `lab.lock` was held; a helper `export function recordWrite(ctx, op: string, target: string, lock: boolean): void` in cli.ts (pushes the line; the marker only when bypassed). Predicate leaf `{ lock_bypassed: true }` (strict object, `z.literal(true)`) true when ANY history line ends with `LOCK_BYPASSED`. Existing `applied.op` enum is unchanged (the new ops are not creatable through `applied`), and `applied` still matches only its five ops.

- [ ] **Step 1: Write failing tests**: with a held lock, `terraform state rm -lock=false aws_x.y` records `state-rm aws_x.y (lock bypassed)` and `{ lock_bypassed: true }` is true; the same command with the lock FREE records an unmarked line and the leaf stays false; without `-lock=false` the lock error fires and nothing is recorded; each of the seven commands; read-only commands (`state list`, `plan -lock=false`, `show`) record nothing; `plan`/`apply` with `-lock=false` and a held lock still mark their steps (existing) and satisfy the leaf; `not: { lock_bypassed: true }` composes; schema accepts the leaf and rejects `lock_bypassed: false`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement**: `recordWrite` calls at the success point of each command (a command that fails after the lock check records nothing); predicate leaf in `leaf()`.
- [ ] **Step 4: Run** new and existing tests, full suite twice, `npx tsc -b`, `npm run lint`, `npm run schemas`.
- [ ] **Step 5: Docs and commit** — AUTHORING predicate reference gains `lock_bypassed`. Commit `feat: lock-bypass marker for state-writing commands and lock_bypassed leaf (TF7a)`.

---

### Task 5: `terraform-destroy-nonempty-bucket`

**Files:**
- Create: `content/iac/terraform-destroy-nonempty-bucket.yaml`, `tests/terraform-destroy-nonempty-bucket.test.ts`
- Modify: `CONTENT_TODO.md` (new section `## terraform incidents batch 4 (TF7a)` with a "TF7a batch status" line and per-incident verified/unverified lists)

**Interfaces:**
- Consumes: Task 2 (`BucketNotEmpty`, `force_destroy` read from state, `aws_s3_object` in `cloud.add`), `loadIncident` / `playbook` (`tests/helpers/terraform-incident.ts`: `play(...lines)`, `detectedAll(sh)`, `detected(sh, id)`), the sg-cycle test as the scaffold.
- Produces: scenario id `terraform-destroy-nonempty-bucket`, `published: false`.

**Story.** A teardown job for a retired reporting stack (`terraform destroy` in CI) fails at the last step: the VPC pieces and queue are gone, but the log bucket `acme-reports-logs` remains with `BucketNotEmpty`. Title is the symptom (the destroy stops on the bucket), not the cause.

**Design.** Files: `main.tf` with the bucket (`force_destroy = false`), a queue, an SG; state matches; `cloud.add` puts ~3 `aws_s3_object` entries in the bucket. Evidence (simulator output): the destroy error box; `terraform state show aws_s3_bucket.logs` (`force_destroy = false`); scripted `aws s3 ls s3://acme-reports-logs --recursive` showing objects. One correct hypothesis: the bucket holds objects and `force_destroy` (state) is false. Wrong hypotheses: permissions/IAM (the error is not AccessDenied; scripted `aws sts get-caller-identity` shows an admin role), a lingering dependency, a lock. Fix routes, world-detected: (A) set `force_destroy = true` in `main.tf` AND `terraform apply` AND `terraform destroy`: `done_when: all[ state_lacks aws_s3_bucket.logs, reality_lacks bucket, file_contains force_destroy = true anchored regex ]`; (B) empty the bucket with a typed scripted command (a `cloud.release` entry of the objects, action `empty-bucket`, matching `^aws s3 rm s3://acme-reports-logs --recursive`) then destroy. Traps: only editing the config then destroying again (not a trap, just fails and teaches state-vs-config; the debrief explains); deleting the bucket from state with `terraform state rm` then destroy (orphans the bucket and its data, `reality_has` bucket afterwards: destructive trap, fix `done_when` requires `reality_lacks`); `aws s3 rb --force` button-free typed command is accepted as route B variant only if credited by the same world rule (decide, test, log). Real-world note in the debrief: versioned buckets also need versions and delete markers removed; `force_destroy` on production data is a data-loss switch, set it only when the data is disposable.

- [ ] **Step 1: Write the failing playthrough test** (`tests/terraform-destroy-nonempty-bucket.test.ts`):

```ts
const scenario = loadIncident('terraform-destroy-nonempty-bucket')
const { play, detectedAll } = playbook(scenario)
it('destroy stops on BucketNotEmpty and everything else is gone', async () => {
  const { sh, out } = await play('cd ~/reporting-infra', 'terraform destroy -auto-approve')
  expect(out[1].exitCode).toBe(1)
  expect(out[1].output).toContain('BucketNotEmpty')
  expect(out[1].hits).toContain('evidence:bucket-not-empty')
})
```

  plus: key evidence obtainable before any change (error, `state show` force_destroy false, the scripted object listing), route A (edit with `sed -i` one-liner; destroy before the apply still fails; apply; destroy succeeds; fix detected once), route B (empty then destroy), partial routes not credited (config edited only; apply only), the `state rm` trap detected and the fix unearnable, wrong-hypothesis commands give honest output, nothing destroyed beyond the intended resources (`not: applied delete` where relevant), idempotence.
- [ ] **Step 2: Run to verify it fails** (`npx vitest run tests/terraform-destroy-nonempty-bucket.test.ts`; fails: unknown incident).
- [ ] **Step 3: Author the YAML**: all schema blocks the guard requires (stages, actions with `kind: fix | trap | ...`, `solution_paths`, `key_evidence`, `evidence_labels`, hints, debrief with real_world); scripted `aws` lookalikes in `terminal.commands`; cloud objects in `terraform.cloud.add`.
- [ ] **Step 4: Log in CONTENT_TODO** what was verified (provider `force_destroy` behaviour, S3 DeleteBucket) and what was not (BucketNotEmpty exact text, 409, HostID, the `aws s3 ls`/`rm` output shapes, invented ids and account).
- [ ] **Step 5: Verify** the targeted test, `npm test`, `npx tsc -b`, `npm run lint`, `npm run build`.
- [ ] **Step 6: Commit** `content: terraform-destroy-nonempty-bucket incident (TF7a)`.

---

### Task 6: `terraform-destroy-dependency-violation`

**Files:**
- Create: `content/iac/terraform-destroy-dependency-violation.yaml`, `tests/terraform-destroy-dependency-violation.test.ts`
- Modify: `CONTENT_TODO.md`

**Interfaces:**
- Consumes: Task 2 (blocker via `referencedBy`, wrapped SG/subnet text), Task 3 (`cloud.release` + a matching typed scripted action), Task 1 not required.
- Produces: scenario id `terraform-destroy-dependency-violation`, `published: false`.

**Story.** `terraform destroy` for a retired app stack stops at the subnet: `DependencyViolation: The subnet 'subnet-...' has dependencies and cannot be deleted.` The instances and security group are gone; the VPC and subnet are not. A network interface that Terraform never created sits in the subnet (an interface from a VPC-attached service another team stood up, `Description: "Interface for the shared ingest endpoint"`, owner/requester not Terraform). Title: the destroy stops at the subnet.

**Design.** State: vpc, subnet, SG, instance. `cloud.add`: one `aws_network_interface` object (not in state; attrs mention the subnet id and SG id). Evidence: the destroy error; `terraform state list` (the ENI is not Terraform's); scripted `aws ec2 describe-network-interfaces --filters Name=subnet-id,Values=subnet-...` showing the interface, its description and attachment owner. One correct hypothesis: something outside Terraform lives in the subnet; Terraform cannot (and must not) delete it. Wrong hypotheses: a Terraform ordering bug (`depends_on` fixes it: dead end; the order is already right), a stale state (refresh shows nothing), permissions. Fix: the owning team detaches/deletes the interface (typed scripted `aws ec2 delete-network-interface --network-interface-id eni-...` action `release-eni`, backed by `cloud.release`; the debrief says in real life you ask the owner first, and the sim lets the player do it after the evidence shows it is an orphaned interface on a retired stack: decide the exact justification, evidence tag `eni-owner`) then `terraform destroy` again: `done_when: all[ state_lacks aws_subnet.app, state_lacks aws_vpc.main, reality_lacks vpc, applied delete aws_subnet.app ]`. Traps: `terraform state rm aws_subnet.app` and `aws_vpc.main` to "make destroy finish" (leaves the subnet and VPC billed and blocked, destructive; fix unearnable: `reality_has` after), `terraform destroy -target=aws_vpc.main` (does not skip the dependency, errors the same: not destructive, teaches), deleting the ENI before reading whose it is (evidence-order: methodical bonus is lost, not a trap).

- [ ] **Step 1: Write the failing playthrough test**: destroy error exact text (subnet text from `provider.ts`), partial-destroy state (`state list` = vpc and subnet only), key evidence obtainable pre-fix, ideal route (release action then destroy; detected once; second destroy is a no-op), `-target` dead end, `state rm` trap and fix unearnable, `depends_on` edit has no effect on the error, the two typed variants of the delete command accepted/refused as authored, idempotence.
- [ ] **Step 2 to 6:** failing run, YAML (stages, actions incl. `release-eni` with `match_regex`, trap action ids, hints, debrief), CONTENT_TODO verified/unverified (SG wrapper now verified or flagged; ENI describe output shape unverified; the "other team's interface" story illustrative), verify (targeted test, `npm test`, `npx tsc -b`, `npm run lint`, `npm run build`), commit `content: terraform-destroy-dependency-violation incident (TF7a)`.

---

### Task 7: `terraform-deleted-out-of-band`

**Files:**
- Create: `content/iac/terraform-deleted-out-of-band.yaml`, `tests/terraform-deleted-out-of-band.test.ts`
- Modify: `CONTENT_TODO.md`

**Interfaces:**
- Consumes: Task 3 (refresh drift, `-refresh=false` behaviours, NotFound), `cloud.delete` in the scenario, predicates `plan_clean`, `state_has`, `applied`.
- Produces: scenario id `terraform-deleted-out-of-band`, `published: false`.

**Story.** After a cleanup in the console, the nightly `terraform plan` shows two resources "deleted outside of Terraform" and wants to create them again, and a teammate's `terraform destroy` earlier today printed `Plan: 0 to add, 0 to change, 0 to destroy.` for an environment "that should have been torn down". Title: the plan wants to create things that were already there, and destroy does nothing (symptom wording, no cause).

**Design.** State has vpc, subnet, queue, instance; `cloud.delete` removes the queue and the instance (someone cleaned up "unused" things). Evidence: `terraform plan` (drift notes `Objects have changed outside of Terraform`, `# aws_sqs_queue.jobs has been deleted`, then `+ create`), `terraform state list` (still lists them), scripted `aws sqs list-queues` / `aws ec2 describe-instances` (gone). One correct hypothesis: they were deleted outside Terraform, so state is stale. Fix choices are a decision, credited by world: (A) the objects should exist: `terraform apply` recreates them (new ids): `state_has` both, `plan_clean`, `not file_contains` removal of the resources from config; (B) they should be gone (the cleanup was intended): remove the resource blocks from the configuration (or `terraform apply -refresh-only` is NOT enough for removal from config) and `terraform apply`: `state_lacks` both, `plan_clean`, the vpc and subnet untouched (`not applied delete aws_vpc.main`). Both are valid; the incident gives a hint in the story (an email thread, scripted `cat NOTES.md`) deciding which is right: the queue is still read by the app (recreate), the instance was an intentional retirement (remove from config): so the correct world is mixed and a single bulk action fails. Traps: `terraform state rm` of both (state forgets them but config still wants them: plan still creates; not destructive, wasted), `terraform apply -refresh=false` / `plan -refresh=false` trusting stale state (shows "No changes" and hides the problem; the player is told it is clean when it is not: `plan_clean` is false under refresh so no credit), `terraform destroy` to start clean (destroys vpc and subnet that other things use: destructive, `applied delete aws_vpc.main`).

- [ ] **Step 1: Write the failing playthrough test**: plan output exact for drift + creates (text from the existing renderer; assert the lines the incident depends on, not the whole box), `-refresh=false` plan says no changes (the trap), destroy with refresh is `0 to destroy` and leaves vpc/subnet (read and prove with `state list` after), the mixed ideal path (recreate queue, remove the instance block, apply; detected once; vpc and subnet ids unchanged), bulk routes not credited, `state rm` and destroy traps, evidence obtainable pre-fix, idempotence.
- [ ] **Step 2 to 6:** failing run, YAML (own the `NOTES.md` file in `files`, hints, debrief), CONTENT_TODO (the "deleted outside of Terraform" box wording already verified in the renderer? re-verify against `jsonformat/plan.go`; scripted aws output shapes unverified), verify, commit `content: terraform-deleted-out-of-band incident (TF7a)`.

---

### Task 8: `terraform-orphans-after-state-rm`

**Files:**
- Create: `content/iac/terraform-orphans-after-state-rm.yaml`, `tests/terraform-orphans-after-state-rm.test.ts`
- Modify: `CONTENT_TODO.md`

**Interfaces:**
- Consumes: Task 2 (blockers via `referencedBy`), Task 4 (`lock_bypassed`, bypass of a held lock), existing `terraform import`, `state rm`, `force-unlock`, lock authoring from `terraform-cancelled-ci-lock`.
- Produces: scenario id `terraform-orphans-after-state-rm`, `published: false`.

**Story.** To "get a stuck apply moving" last sprint someone ran `terraform state rm aws_instance.worker` and `aws_db_instance.reports`; both still run in the cloud, unmanaged. Now `terraform destroy` for the environment fails: the subnet and security group cannot be deleted (`DependencyViolation`, the unmanaged worker uses them), the database is not in the destroy plan at all, and the monthly bill never went down. A teammate's interrupted cleanup left the state lock held. Title: destroy leaves resources behind and fails on the subnet.

**Design.** State: vpc, subnet, SG only; `cloud` also holds the instance and db instance (`cloud.add`, mentioning the subnet and SG ids). The `.tf` still declares worker and reports (so `plan` shows `+ create` for both, then fails with the natural-key conflict `DBInstanceAlreadyExists` for the db; the instance would just be created twice). Lock held by the teammate's dead session (use the cancelled-ci-lock authoring). Evidence: `terraform plan` (two creates), the apply error for the db (`DBInstanceAlreadyExists`), the destroy error text, `terraform state list` (missing both), scripted `aws ec2 describe-instances` / `aws rds describe-db-instances` (running). One correct hypothesis: they were dropped from state but not from the cloud; Terraform manages what is in state. Fix (world-detected): force-unlock the stale lock (prove the holder is dead first, as in TF5), `terraform import aws_instance.worker i-...` and `terraform import aws_db_instance.reports reports-db` (or `import` blocks in config), then `terraform destroy` (the db needs `skip_final_snapshot` handled as the schema supports; keep to what the simulator models): `done_when: all[ lock_free, applied delete aws_instance.worker, applied delete aws_db_instance.reports, state_lacks aws_vpc.main, reality_lacks db, reality_lacks vpc, not lock_bypassed ]`. Traps: `-lock=false` on `import`/`state rm`/`destroy` while the lock is held (`lock_bypassed: true`: the new leaf; destructive; fix unearnable), `terraform apply` expecting to recreate (the instance is duplicated, a second worker appears in reality: `reality` has two instances: destructive/duplicate), deleting the SG/subnet by hand is not available, `state rm` of the remaining resources to "finish" (orphans more: `reality_has vpc`).

- [ ] **Step 1: Write the failing playthrough test**: held-lock errors on import/destroy without `-lock=false`, `force-unlock` only after the evidence of a dead holder (reuse the TF5 evidence ids pattern), imports succeed, destroy completes and cloud is empty, `-lock=false` trap via `lock_bypassed`, apply-recreate trap leaves two workers, evidence obtainable pre-fix, idempotence.
- [ ] **Step 2 to 6:** failing run, YAML, CONTENT_TODO (`import` ID forms for instance and RDS verified against provider docs; `describe-*` outputs unverified), verify, commit `content: terraform-orphans-after-state-rm incident (TF7a)`.

---

### Task 9: Batch wrap-up, UI resolution tests, final review, ship dark

**Files:**
- Create: `tests/terraform-batch4-ui.test.tsx`
- Modify: `CONTENT_TODO.md`, the content guard test that lists dark incidents (the one TF6c extended; find it with `grep -rn "published" tests | grep -i terraform`)

- [ ] **Step 1:** confirm no registration is needed and no incident id, evidence tag, command-library id or file collides with existing incidents/commands (grep across `content/`, run the content loader test).
- [ ] **Step 2:** UI-level tests (jsdom, patterns from `tests/terraform-batch3-ui.test.tsx` and `tests/terraform-batch2-ui.test.tsx`) for each of the four incidents: the ideal path through `IncidentScreen` (fix recorded exactly once, `fixComplete`, close out, resolved, `score(...).mistakes.destructive === 0`, methodical bonus earnable because key evidence is obtainable before the fix) and the trap path (exactly one destructive `TAKE_ACTION`, `mistakes.destructive === 1`, the fix then not earnable). Extra: a remount rebuilds identical transcripts and reality (`cloud.release` replays), the typed release/empty commands detect, the force-unlock dialog in the orphans incident. Typed input is one line.
- [ ] **Step 3:** tidy `## terraform incidents batch 4 (TF7a)` in `CONTENT_TODO.md` (by incident; a "TF7a batch status" line listing the four incidents and what each teaches; open simulator defects found; the TF7b note: migrate the 9 scripted incidents, retire `terraform-state-lock.yaml`, and the remaining TF7 follow-ups untouched).
- [ ] **Step 4: Final review** — dispatch/perform one whole-branch review (correctness of Tasks 1 to 4 against Review Focus 1 to 4, incident fairness against Review Focus 5); fix findings in one tidy commit.
- [ ] **Step 5: Ship dark** — every new incident has `published: false`; extend the guard so it lists the four as dark; do not flip any to published here.
- [ ] **Step 6: Verify** — `npm test` twice, `npx tsc -b`, `npm run lint`, `npm run build`, `npm run schemas` (git clean).
- [ ] **Step 7: Commit** — `test: TF7a incidents resolve through the UI; content log tidy`.

---

## Self-review (done)

- **Spec coverage:** the four destroy-problem candidates map to Tasks 5 (non-empty bucket), 6 (stuck on dependencies), 7 (deleted out-of-band), 8 (orphans after `state rm`). Engine items from the TF7 follow-ups: `create_before_destroy` ordering (Task 1), lock bypass marker and predicate (Task 4); provider errors the incidents need (Tasks 2 and 3). Not included on purpose: migrating the scripted incidents and retiring `terraform-state-lock.yaml` (TF7b), parallelism, address-independent faults, scripted exit codes, `IncidentShell` profile handling, bucket versioning, several deposed objects per address.
- **Placeholders:** none intended; design choices left to the implementer are named with their options and must be tested and logged (Tasks 5 to 8: exact typed-command variants, justification text, `import` forms).
- **Type consistency:** `bucketObjects`, `bucketNotEmpty`, `notFound`, `cloud.release[].when_actions`, `StateInstance.deposed`, `recordWrite`, `{ lock_bypassed: true }` and history ops `state-rm`, `state-mv`, `taint`, `untaint`, `import`, `workspace-new`, `workspace-delete` are used with the same names in every task.
- **Review Focus:** 1 to Task 1, 2 to Tasks 2 and 3, 3 to Task 3, 4 to Task 4, 5 to Tasks 5 to 9.
