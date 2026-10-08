# Terraform TF3c: state commands, locks, workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The player can repair a broken Terraform world with the real commands: `state mv`, `state rm`, `import`, `taint`/`untaint`, `refresh`, `workspace new|select|delete`, and can be blocked by (and recover from) a held state lock with `force-unlock`. Each command prints Terraform's real wording, mutates the simulated state the way the real one does, bumps the serial, and is replay-deterministic.

**Architecture:** Pure state operations live in a new `state-ops.ts` (no CLI, no I/O). The CLI (`cli.ts`) parses arguments, enforces the state lock, calls the operations, commits the result to the `Lab`, and prints. Locks are scenario-authored (`terraform.lock`) and checked by every command that takes the lock in real Terraform; `-lock=false` bypasses, `force-unlock` clears. Workspaces give the `Lab` a map of states; the current one is `lab.state`, switching swaps it and the workspace name flows into planning (`terraform.workspace`). The cloud (`lab.reality`) stays shared across workspaces, as in real life.

**Tech Stack:** TypeScript (strict), vitest, zod 4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("CLI", "Incident authoring", "Errors and honesty"). TF1 to TF3b are complete. Out of scope here (TF3d): `done_when` predicates and world-based destructive/fix detection; also out of scope: `-target`, `-refresh-only`, `state replace-provider|push`, `show <planfile>`, backend migration (`init -migrate-state`), state backup files, locks held by a crashed apply.

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, `import type` for types, `.ts` import extensions.
- No new npm dependencies. No randomness and no clock: output depends only on inputs (lock `created` text is authored, serials count up).
- Own-property discipline: never `in` / `obj[userKey] = ...` on user-keyed objects (`Object.hasOwn`, `Map`, `Object.fromEntries`).
- State operations never mutate their input (`structuredClone`), never throw on player input; failures are values the CLI prints as boxed errors or plain messages with a non-zero exit code.
- The world (state, reality, workspaces, lock) changes only for a run in the lab directory on the scenario's main host (the existing `here` rule).
- Terraform wording not verified against real Terraform is logged in `CONTENT_TODO.md` (Task 6).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A held lock blocks exactly the commands that take the lock in real Terraform (plan, apply, destroy, refresh, import, taint, untaint, state mv/rm, workspace new/delete), never the read-only ones (state list/show/pull, output, show, validate, init, version, workspace list/show/select), and `-lock=false` bypasses it (Task 4 tests).
2. `state mv`/`state rm` followed by `plan` give the outcomes the real workflow gives: a moved resource plans as no changes, a removed one plans as create, an imported one plans as no changes or an update (Task 3 integration tests).
3. Nothing a failed or refused state command does leaves a partial change: unknown address, destination exists, locked, wrong workspace all leave state and serial untouched (Tasks 1, 3).
4. Workspaces are isolated: the same address in two workspaces is two different objects; `terraform.workspace` follows the current one; deleting a non-empty or the active workspace is refused (Task 5 tests).
5. Replaying the same commands on a fresh shell rebuilds identical state, workspaces and lock (Task 6 shell test).

---

### Task 1: Pure state operations

**Files:**
- Create: `src/game/terraform/state-ops.ts`
- Test: `tests/terraform-state-ops.test.ts`

**Interfaces (produces):**
```ts
export type OpResult<T = object> = ({ ok: true; state: State } & T) | { ok: false; summary: string; detail: string } // detail '' = plain one-line message form

export function parseAddress(text: string): { ok: true; type: string; name: string; key?: string | number; mode: 'managed' | 'data' } | { ok: false }
// "aws_x.y", "aws_x.y[0]", 'aws_x.y["k"]', "data.aws_x.y"; module addresses ("module.m.aws_x.y") are { ok:false }

export function stateMove(state: State, from: string, to: string): OpResult<{ moved: { from: string; to: string }[] }>
export function stateRemove(state: State, addresses: string[]): OpResult<{ removed: string[] }>
export function taintInstance(state: State, address: string): OpResult
export function untaintInstance(state: State, address: string): OpResult
export function importObject(state: State, reality: Reality, address: string, id: string, declared: boolean): OpResult
```
Every successful op returns a new state with `serial + 1` (state never mutated); `importObject` adds a managed instance holding a `structuredClone` of the reality object `realityKey(type, id)`.

**Behavior and exact error values** (`summary` / `detail`; where `detail` is `''` the CLI prints `summary` plainly on stderr):
- `stateMove(from, to)`: both addresses must parse (`Invalid source address` / `Cannot move aws_x.y: does not match anything in the current state.` mirrors real; invalid text: summary `Invalid target address`, detail `Cannot move to ${to}: address is not a valid resource instance or resource address.`). Rules:
  - `from` without a key and the resource has instances: moves the whole resource (every instance keeps its key) to `to` (which must not carry a key); `moved` lists every instance pair in address order.
  - `from` with a key moves one instance to `to` (`to` may add/change the key); `to` without a key moves an instance to the resource's keyless slot only if the resource has no other instances.
  - source missing: summary `Invalid source address`, detail `Cannot move ${from}: does not match anything in the current state.`
  - destination already exists in state: summary `Invalid target address`, detail `Cannot move to ${to}: there is already a resource instance at that address in the current state.`
  - moving across types (`aws_a.x` → `aws_b.y`): summary `Invalid target address`, detail `Cannot move to ${to}: resource types must match (${fromType} and ${toType}).`
  - after the move, the type/name of the destination resource entry is updated; other instances' `dependencies` entries equal to the old resource address are rewritten to the new one; an emptied source resource entry is dropped; resource order in the state is preserved with the destination appended at the source's position.
- `stateRemove(addresses)`: each address matches a whole resource (all its instances) or one instance (a keyless address on a resource whose instances carry keys removes them all, as real `state rm aws_x.y` does). Nothing matches → summary `No matching objects found.`, detail ''. `removed` lists removed instance addresses in state order. Data sources can be removed too. Dependencies entries pointing at a removed resource are left alone (real Terraform does too).
- `taintInstance`: unknown instance → summary `No such resource instance`, detail `There is no resource instance with the address ${address} in the current state.`; already tainted is fine (idempotent, serial still bumps); data sources → summary `Invalid resource address`, detail `Data sources cannot be tainted.`.
- `untaintInstance`: unknown instance as above; not tainted → summary `Resource instance is not tainted`, detail `Resource instance ${address} is not tainted.`; removes `status`.
- `importObject(state, reality, address, id, declared)`: `declared === false` → summary `Resource address "${base}" does not exist in the configuration.` where `${base}` is the address without key, detail `Before importing this resource, please create its configuration in the root module. For example:\n\nresource "${type}" "${name}" {\n  # (resource arguments)\n}`; address already in state → summary `Resource already managed by Terraform`, detail `Terraform is already managing a remote object for ${address}. To import to this address you must first remove the existing object from the state.`; no reality object `realityKey(type,id)` → summary `Cannot import non-existent remote object`, detail `While attempting to import an existing object to "${address}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.` (check `src/game/terraform/plan.ts` for the existing import error text and reuse it from one shared constant if it matches); data addresses → `Invalid resource address` / `Data sources cannot be imported.`.

- [ ] **Step 1: Write the failing tests** — `tests/terraform-state-ops.test.ts`. Build states with a tiny local helper (`stateOf(...)`: reuse the pattern in `tests/terraform-apply.test.ts`). Cover, with exact expected strings and `serial` checks:
  - `parseAddress` accepts the four forms, rejects `module.m.aws_x.y`, `aws_x`, `aws_x.y[`, empty.
  - `stateMove`: whole resource (`aws_vpc.old` → `aws_vpc.new`, with an instance having `dependencies: ['aws_vpc.old']` rewritten), one instance with keys (`aws_s3_bucket.b["a"]` → `aws_s3_bucket.c["a"]`), keyed instance to a new key on the same resource, destination exists, source missing, type mismatch, invalid text; state unchanged (`toEqual` on the input copy) and returned state has `serial + 1`.
  - `stateRemove`: one instance, whole keyed resource via keyless address, two addresses at once, no match.
  - `taintInstance`/`untaintInstance`: sets/removes `status`, errors above, idempotent taint, data source refusal.
  - `importObject`: success copies reality attributes (and mutating the returned state does not touch `reality`), each of the four errors.
- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/terraform-state-ops.test.ts` → FAIL (missing module).
- [ ] **Step 3: Implement** `state-ops.ts` per the interfaces; use `instanceAddress`/`findInstance`/`listAddresses` from `state.ts`; build addresses via `instanceAddress`.
- [ ] **Step 4: Verify** — targeted tests, `npm test 2>&1 | grep -E "Test Files|Tests "`, `npx tsc -b`, `npm run lint 2>&1 | tail -5`.
- [ ] **Step 5: Commit** — `git add src tests && git commit -m "feat: pure terraform state operations: mv, rm, taint, untaint, import (TF3c)"` with the trailer.

---

### Task 2: Scenario `lock`, `workspace`, `workspaces`; Lab fields

**Files:**
- Modify: `src/schema/scenario.ts`, `schemas/incident.json` (`npm run schemas`), `src/game/terraform/lab.ts`
- Test: `tests/terraform-lab.test.ts` (append; it already holds the terraform-block validation tests)

**Interfaces (produces):**
- `TerraformSchema` gains (all strict objects, all optional):
  - `lock: { id: string; who: string; operation?: string (default "OperationTypeApply"); created: string; path?: string (default "terraform.tfstate"); info?: string (default ""); message?: string }` — `message` is the "Error message:" line of the error; default depends on nothing (see Task 4): `"resource temporarily unavailable"`.
  - `workspace: string` (current workspace; default `"default"`; must match `/^[A-Za-z0-9._-]+$/`).
  - `workspaces: Record<string, { state?: <same entry array as top-level state>; outputs?: <same as top-level outputs> }>` — other workspaces' states (the top-level `state`/`outputs` are the `default` workspace). A key `default` is rejected. Cross-field: if `workspace` is not `default` it must be a key of `workspaces`; the same state-entry validation as the top-level state (string `id`, known managed types, no duplicates) applies to each workspace's entries, with issue paths `['terraform','workspaces',name,'state',i,...]`.
  - Extend `evidence[].command` enum with: `apply`, `destroy`, `import`, `taint`, `untaint`, `refresh`, `force-unlock`, `state mv`, `state rm`, `workspace new`, `workspace select`, `workspace delete`.
- `Lab` gains: `workspace: string` (current), `workspaces: Map<string, { state: State; hasState: boolean }>` (every workspace EXCEPT the current one; the current one's data lives in `lab.state`/`lab.hasState`), `lock?: { id; who; operation; created; path; info; message }` (defaults filled). The default workspace's state is built exactly as today; each `workspaces[name]` entry builds a State with the same expansion code (extract the state-building part of `labFromScenario` into a helper reused for each workspace, including `dependencies` derivation); lineage per workspace is `00000000-0000-4000-8000-0000000000NN` where NN is a 2-digit counter (default = 01, then the other workspaces in sorted-name order from 02), serial 12 for all.
- `labFromScenario` places the scenario's current workspace in `lab.state` (swap with default if the current one is not `default`).

- [ ] **Step 1: Write failing tests**: schema accepts a valid lock/workspace/workspaces fixture and rejects: lock missing `id`/`who`/`created`, extra keys, bad `workspace` characters, `workspace: 'prod'` not in `workspaces`, a workspace named `default`, an invalid state entry inside a workspace (non-string id). `labFromScenario`: defaults filled for lock; `lab.workspace === 'default'` and `lab.workspaces.size === 0` without the new fields; with `workspace: 'dev'` + `workspaces: { dev: …, prod: … }` the current state is dev's, the map holds `default` and `prod`; lineages as above; the evidence enum accepts the new commands.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — targeted tests, `npm run schemas` (diff only adds the new fields), `npm test`, `npx tsc -b`, `npm run lint`.
- [ ] **Step 5: Commit** — `feat: scenario lock, workspace, workspaces (TF3c)`.

---

### Task 3: `state mv|rm`, `taint`, `untaint`, `import`, `refresh` commands

**Files:**
- Modify: `src/game/terraform/cli.ts`
- Test: `tests/terraform-state-cli.test.ts` (new; copy the harness from `tests/terraform-apply-cli.test.ts`)

**Interfaces (consumes):** Task 1 ops. **Produces:** the commands below; `NOT_YET` loses `import`, `taint`, `untaint`, `refresh`; `state mv|rm` stop answering "not available". `verifies`-style `ran` list is unchanged (these are not verification commands), but evidence matching (`command` string) works for all of them (`state mv`, `state rm`, `import`, `taint`, `untaint`, `refresh`).

Common rules: all of these need a state file and `lab.hasState`; without one `state mv|rm` print the existing `NO_STATE` message; `taint`/`untaint` print `Error: No state file was found!` boxed — reuse whatever `NO_STATE` form the file already has. All commit to the lab only when `here` (same mechanism as apply: `ctx.lab` is the throwaway copy elsewhere). A successful mutation sets `lab.state = result.state` and `lab.hasState = true`.

- `terraform state mv [-dry-run] [-state…ignored] SOURCE DEST`: exactly two positional args else plain `Exactly two arguments expected.`. Success stdout: for each moved pair `Move "FROM" to "TO"` (dry run: `Would move "FROM" to "TO"`), and for a real run a final line `Successfully moved N object(s).`. Dry run changes nothing and prints no final line. Errors: boxed with the op's summary/detail.
- `terraform state rm [-dry-run] ADDRESS...`: at least one address else `At least one address is required.`. Success: `Removed ADDR` per removed instance (dry run: `Would remove ADDR`) and `Successfully removed N resource instance(s).` (dry run: none). No match: stderr `No matching objects found.` exit 1.
- `terraform taint [-allow-missing] ADDRESS`: success stdout `Resource instance ADDR has been marked as tainted.`; with `-allow-missing` a missing instance exits 0 with no output. `terraform untaint ADDRESS`: success `Resource instance ADDR has been successfully untainted.` Wrong arg count: `Exactly one argument expected.`
- `terraform import [-var … -var-file … -input=false -no-color -lock… ] ADDRESS ID`: needs a configuration (reuse the plan setup: no-config error, graph diagnostics, lock-file error, variable resolution); `declared` = the root module declares a `resource` block with that type and name (use the graph/parse the file already does; for a keyed address check the block exists, not the key). Wrong arg count: `Exactly two arguments expected.` Success stdout (exact):
```
ADDR: Importing from ID "ID"...
ADDR: Import prepared!
  Prepared TYPE for import
ADDR: Refreshing state... [id=ID]

Import successful!

The resources that were imported are shown above. These resources are now in
your Terraform state and will henceforth be managed by Terraform.
```
- `terraform refresh [-var … -var-file …]`: same setup as plan; runs `planConfig` with refresh, commits `plan.refreshed` (and bumps the serial only if the refreshed state differs from the current state) like the no-change apply path already does; stdout = the same `ADDR: Refreshing state... [id=…]` lines `plan` prints (reuse the helper), then if the state has outputs a blank line + `Outputs:` section exactly as `apply` prints it (reuse `outputsText`); no outputs → nothing more. Log in `CONTENT_TODO.md` (Task 6) that real Terraform may print a deprecation warning.

- [ ] **Step 1: Write failing tests** (concrete code against the harness): for each command, success output exact + `lab.state` effect + serial bump; each refusal leaves `lab.state`/serial unchanged; `-dry-run`; outside the lab directory (`-chdir=/tmp`) nothing changes; and these integration tests (Review Focus 2):
  - `state mv aws_db_instance.old aws_db_instance.orders` after the config renamed the resource → `terraform plan` prints `No changes.`
  - `state rm aws_s3_bucket.b` → `terraform plan` plans a create for `aws_s3_bucket.b`; then `terraform import aws_s3_bucket.b legacy` → plan is `No changes.`
  - `taint aws_vpc.main` → plan shows `-/+` with `# aws_vpc.main is tainted, so must be replaced`; `untaint` → `No changes.`
  - import of an id that exists only in `cloud.add` works; import with undeclared resource, already-managed, and non-existent id print the boxed errors from Task 1.
  - `refresh` after a cloud patch: state holds the new value, serial +1; second `refresh` leaves serial alone.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** in `cli.ts` (extend `cmdState`; add `cmdTaint`, `cmdImport`, `cmdRefresh`; keep existing outputs byte-identical — existing CLI tests that assert "not available" for `import`/`state mv` etc. must be updated to use a still-unavailable command such as `console`).
- [ ] **Step 4: Verify** — targeted, full suite, `npx tsc -b`, lint.
- [ ] **Step 5: Commit** — `feat: terraform state mv/rm, taint, untaint, import, refresh (TF3c)`.

---

### Task 4: State lock and `force-unlock`

**Files:**
- Modify: `src/game/terraform/cli.ts`
- Test: `tests/terraform-lock-cli.test.ts` (new; same harness)

**Behavior:**
- Commands that take the lock when `lab.lock` is set (and the run is in the lab directory on the main host): `plan`, `apply`, `destroy`, `refresh`, `import`, `taint`, `untaint`, `state mv`, `state rm`, `workspace new`, `workspace delete`. Not locked (never blocked): `init`, `validate`, `version`, `show`, `output`, `state list|show|pull`, `workspace show|list|select`, `fmt`, `force-unlock` itself. `-lock=false` (also `-lock=false` form on `plan`/`apply`/`destroy`/`refresh`/`import`/`taint`/`untaint`/`state mv`/`state rm`; flag parse must accept `-lock=false|true` and `-lock-timeout=DURATION` there) bypasses the check. `-lock-timeout` has no waiting effect (instant failure; same text).
- The check happens after argument and configuration errors that real Terraform reports before locking (flag errors, no-config, graph diagnostics) and before anything that reads or writes state. Because plan reads state under the lock, `plan` with a held lock prints only the lock error.
- The lock error (stderr, exit 1), exactly:
```
╷
│ Error: Error acquiring the state lock
│ 
│ Error message: MESSAGE
│ Lock Info:
│   ID:        LOCKID
│   Path:      PATH
│   Operation: OPERATION
│   Who:       WHO
│   Version:   TFVERSION
│   Created:   CREATED
│   Info:      INFO
│ 
│ 
│ Terraform acquires a state lock to protect the state from being written
│ by multiple users at the same time. Please resolve the issue above and try
│ again. For most commands, you can disable locking with the "-lock=false"
│ flag, but this is not recommended.
╵
```
  built with `formatDiagnostic`'s `preserveLines` option (look at how `lockError`-style boxes in `cli.ts` pass `true`): `MESSAGE` = `lab.lock.message` (default text from Task 2), `TFVERSION` = `lab.version`, `INFO` = `lab.lock.info`; a trailing-space line like `Info:      ` is kept when info is empty.
- `terraform force-unlock [-force] LOCKID`:
  - exactly one positional argument, else plain stderr `Expected a single argument: LOCK_ID.` exit 1 (log unverified).
  - no lock held: boxed `Failed to unlock state` with detail `no lock is held on this state` (log unverified).
  - ID mismatch: boxed `Failed to unlock state` / detail `failed to unlock state: lock ID "GIVEN" does not match existing lock ID "ACTUAL"`.
  - match: unless `-force`, ask via the same answer sources as apply (piped `ctx.stdin` first line, else `ctx.confirm`, else none) with this prompt exactly: `Do you really want to force-unlock?\n  Terraform will remove the lock on the remote state.\n  This will allow local Terraform commands to modify this state, even though it\n  may be still be in use. Only 'yes' will be accepted to confirm.\n\n  Enter a value: ` (confirm hook gets the same text; stdout echoes the prompt and the answer like apply does). Anything but `yes` prints `Unlock cancelled.` exit 1, lock kept (log unverified). On success (and with `-force`) clear `lab.lock` (only when `here`) and print `Terraform state has been successfully unlocked!\n\nThe state has been unlocked, and Terraform commands should now be able to\nobtain a new lock on the remote state.`
- A lock never changes because a command failed; `apply` that fails halfway does not leave a lock.

- [ ] **Step 1: Write failing tests**: for every locked command a held lock yields the exact error above and changes nothing (state, reality, serial, savedPlans); for every unlocked command the lock is ignored; `-lock=false` runs `plan`, `apply -auto-approve`, `state rm`, `taint` normally; flag errors beat the lock error (`terraform plan -nope` shows the flag error); `force-unlock` with the wrong id, no lock, declined (`stdin: 'no'`), accepted (`stdin: 'yes'`, and via `confirm` hook, and `-force`); after unlock `terraform plan` works; the same commands outside the lab directory ignore the lock.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** a single `checkLock(ctx, command, flags)` helper called from the command functions at the right point; `NOT_YET` loses `force-unlock`.
- [ ] **Step 4: Verify** — targeted, full suite, `npx tsc -b`, lint.
- [ ] **Step 5: Commit** — `feat: state lock errors and force-unlock (TF3c)`.

---

### Task 5: Workspaces

**Files:**
- Modify: `src/game/terraform/cli.ts`, `src/game/terraform/apply.ts` / `plan.ts` only if the `workspace` input is not already honoured end to end (verify first)
- Test: `tests/terraform-workspace-cli.test.ts` (new; same harness)

**Behavior (`terraform workspace …`)** over `lab.workspace` / `lab.workspaces` (Task 2), committing only when `here`:
- `show`: prints the current name. `list`: one line per workspace in plain alphabetical order (`default` is just another name); the current one prefixed `* `, others `  `; output ends with a blank line (`"  default\n* dev\n  prod\n"` — the existing `list` output `* default\n` shows the trailing newline form).
- `new NAME` (name must match `/^[A-Za-z0-9._-]+$/`; invalid: boxed `Invalid workspace name` / `The workspace name "NAME" is not allowed. The name must contain only URL safe characters, and no path separators.`): exists → plain stderr `Workspace "NAME" already exists` (unverified). Success: stores the current state into the map under the old name, creates an empty state (new lineage `00000000-0000-4000-8000-0000000000NN`, NN = 10 + number of workspaces created so far, serial 0, `hasState` false, version = lab version), switches, prints exactly:
```
Created and switched to workspace "NAME"!

You're now on a new, empty workspace. Workspaces isolate their state,
so if you run "terraform plan" Terraform will not see any existing state
for this configuration.
```
- `select NAME`: unknown → plain stderr `Workspace "NAME" doesn't exist.\n\nYou can create this workspace with the "new" subcommand \nor include the "-or-create" flag with the "select" subcommand.`; already current → still prints success; success prints `Switched to workspace "NAME".`; `-or-create` creates when missing (prints the `new` text).
- `delete [-force] NAME`: unknown → plain `Workspace "NAME" doesn't exist.`; the current workspace → boxed `Workspace is your active workspace` / `You cannot delete the currently active workspace. Please switch to another workspace and try again.`; `default` → boxed `Failed to delete workspace` / `Can't delete default workspace`; a workspace whose state has managed or data resources and no `-force` → boxed `Workspace is not empty` / `Workspace "NAME" is currently tracking the following resource instances:\n  - ADDR\n  - ADDR\n\nDeleting this workspace would cause Terraform to lose track of any associated remote objects, which would then require you to delete them manually outside of Terraform. You should destroy these objects with Terraform before deleting the workspace.\n\nIf you want to delete this workspace anyway, and have destroyed these objects, use the -force option.`; success prints `Deleted workspace "NAME"!` (with `-force` on a non-empty one the same, plus the preceding text is not printed).
- Plumbing: every command that plans/applies/refreshes passes `workspace: lab.workspace` into `planConfig`/`executeApply` (so `terraform.workspace` evaluates to the current name; add `workspace?` to `PlanInput` pass-through in `executeApply` if missing — it spreads input, so it should already work); saved plans record the workspace and `apply tfplan` from another workspace is refused with the stale error (`Saved plan is stale` is fine; or a plan-specific message if easy, logged as unverified).
- `state list` etc. read the current workspace's `lab.state` automatically (no change needed). `terraform workspace new` does not touch the cloud.

- [ ] **Step 1: Write failing tests** (Review Focus 4): list/show formatting across three workspaces; `new` output exact and empty state (`state list` prints `No state file was found!` form already used for `hasState` false, `plan` plans creates for everything, and the cloud objects that exist produce `AlreadyExists` errors on apply for natural-key types such as S3 buckets); `select` swaps states and back preserves each; `terraform.workspace` interpolation (config using `terraform.workspace` in a resource name shows different planned names after `select`); delete rules (active, default, non-empty, `-force`, empty); unknown names; saved plan from another workspace refused; workspace commands outside the lab directory change nothing.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (`cmdWorkspace` becomes async and gets `ctx`; keep `show`/`list` outputs byte-identical for the single-workspace case — existing tests must pass).
- [ ] **Step 4: Verify** — targeted, full suite, `npx tsc -b`, lint.
- [ ] **Step 5: Commit** — `feat: terraform workspaces (TF3c)`.

---

### Task 6: Shell integration, docs, honesty log

**Files:**
- Modify: `src/game/engine.ts` (the `help` Terraform list near the `['init', 'validate', 'plan', …]` array: add `apply`, `destroy` if missing, plus `import`, `taint`, `untaint`, `refresh`, `force-unlock`, `state mv`, `state rm`, `workspace new`, `workspace select`, `workspace delete`; update any test asserting the exact list), `AUTHORING.md`, `CONTENT_TODO.md`
- Test: `tests/terraform-shell-state.test.ts` (new; model on `tests/terraform-shell-apply.test.ts`)

- [ ] **Step 1: Write the shell test** through `new IncidentShell(scenario)` with an inline scenario (copy the fixture builder from `tests/terraform-shell-apply.test.ts`) that has `lock`, a second workspace and a bucket in `cloud.add` not in state:
  - `terraform plan` → lock error; `terraform force-unlock -force LOCKID` → success; `terraform plan` works. (Review Focus 1.)
  - `echo yes | terraform force-unlock LOCKID` unlocks (piped answer); `terraform force-unlock LOCKID` with no `onConfirm` prints `Unlock cancelled.`.
  - The recovery walk: `terraform import aws_s3_bucket.b legacy` → `terraform plan` clean; `terraform state rm aws_s3_bucket.b` → plan wants to create; `terraform state mv` back path; `terraform workspace new qa` → `terraform plan` plans everything as create; `terraform workspace select default` → plan clean again.
  - Replay determinism (Review Focus 5): a fresh `IncidentShell` runs the same command list → identical `terraform state pull`, `terraform workspace list`, and `terraform plan` output as the first shell.
- [ ] **Step 2: Run to verify failure** (fails until Tasks 1-5 are in; it is written last on purpose, so it should pass once the previous tasks are done — if it fails for a real reason, fix the code, not the test).
- [ ] **Step 3: Docs.**
  - `AUTHORING.md` (`terraform:` block section): document `lock` (fields, defaults, that it blocks plan/apply/destroy/refresh/import/taint/untaint/state mv|rm/workspace new|delete and not the read-only commands, `-lock=false` and `force-unlock` clear it; example from the "stuck lock after a CI run was cancelled" story), `workspace`/`workspaces` (top-level `state`/`outputs` are the default workspace; the cloud is shared across workspaces; example for a "wrong workspace" incident), the new commands and what each does to state, the extended `evidence[].command` list, that `import` needs the resource declared in the configuration, that a `lock` is not set by failed applies.
  - `CONTENT_TODO.md`: append `## terraform simulator (state commands, locks, workspaces, TF3c)` with unchecked items: every error summary/detail marked "invented/approximate" in this plan (`Invalid source address`/`Invalid target address` texts for `state mv`, `No matching objects found.`, `No such resource instance`, `Resource instance is not tainted`, the import error family, `Workspace already exists` plain form, the `select` unknown-workspace text, `Workspace is not empty` text, `Workspace is your active workspace`), the `state mv`/`state rm` success lines, `import` output, `refresh` output and a possible deprecation warning, the lock error body and `Error message:` per backend (S3+DynamoDB, azurerm, gcs differ), `force-unlock` prompt/cancel/success and mismatch texts, `-lock-timeout` has no waiting effect, no `terraform.tfstate.backup` is written by `state mv|rm`, no "Acquiring state lock" lines on remote backends, workspace-specific `terraform.tfstate.d` files are not on the simulated disk, locks are only authored (an interrupted apply never leaves one).
- [ ] **Step 4: Verify** — `npm test`, `npx tsc -b`, `npm run lint`, `npm run build`.
- [ ] **Step 5: Commit** — `docs+test: state commands, locks, workspaces end to end (TF3c)`.

---

## Self-review (done)

- **Spec coverage:** spec CLI list (`import`, `state mv/rm`, `taint`/`untaint`, `force-unlock`, `workspace new/select/list/show`, plus `refresh` and `workspace delete`), `backend` lock and holder, `env` workspace, and the "Error acquiring the state lock" error shape are covered; `done_when` and world-based scoring are TF3d.
- **Placeholders:** none. Where a harness is "copied" the task names the file. A few real-Terraform wordings are explicitly marked approximate and logged in Task 6.
- **Type consistency:** `OpResult`, `parseAddress`, `stateMove`, `stateRemove`, `taintInstance`, `untaintInstance`, `importObject` (Task 1) are the names Task 3 uses; `Lab.lock/workspace/workspaces` (Task 2) are what Tasks 4 and 5 use; evidence enum additions in Task 2 are what Task 6 docs list.
- **Review Focus:** each line maps to tests (1: Task 4; 2: Task 3 integration; 3: Tasks 1 and 3 refusal tests; 4: Task 5; 5: Task 6 shell test).
