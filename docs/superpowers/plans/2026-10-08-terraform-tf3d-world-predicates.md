# Terraform TF3d: `done_when` predicates over the simulated world Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An action in a Terraform incident can be taken (or a `destructive` trap sprung) by what the player's commands and edits actually did to the simulated world, not only by file text or a scripted command. After this plan: removing `prevent_destroy` and running `terraform apply` on the shipped `terraform-forces-replacement` incident springs the `remove-guard` trap even though the database is recreated; reverting `storage_encrypted` afterwards no longer earns the fix; `state mv`, a `moved` block or an import all count when they produce the required outcome.

**Architecture:** An action gains an optional `done_when` predicate (a small JSON-shaped language: `plan_clean`, `plan_has`, `state_has`, `state_lacks`, `lock_free`, `reality_has`, `reality_lacks`, `applied`, `file_contains`, combined with `all`/`any`/`not`). A pure evaluator (`predicates.ts`) answers it against a `World` view. The shell builds the `World` from the lab and the real files and exposes `doneWhen(predicate)`. The terminal session already re-checks `file:` actions after every command and every log change; it now also evaluates `done_when`, through the same root-cause gate, and takes the action. `Lab` keeps an `history` of applied steps (`"delete aws_db_instance.orders"`) so "this was destroyed at some point" survives a recreate. Everything is a function of the replayed commands, so remounts rebuild the same world and TAKE_ACTION events are not duplicated.

**Tech Stack:** TypeScript (strict), vitest, zod 4, React 19 (session hook only). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("Fixes and scoring"). TF1 to TF3c are complete. Out of scope here: new incidents (TF4+), migrating the 9 scripted incidents, scoring bonuses for good practice (plan before apply, `-out`, checking the workspace), stage-aware evidence (see `CONTENT_TODO.md`), `-target`, `-refresh-only`.

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, `import type` for types, `.ts` import extensions.
- No new npm dependencies. No randomness and no clock. A predicate's answer depends only on the world.
- Own-property discipline: never `in` / `obj[userKey] = ...` on user-keyed objects.
- Predicate evaluation never throws on player input (bad files, unparsable config, missing paths are `false`) and never mutates the lab.
- The schema is strict: a typo in a predicate key is a validation error, not a silent no-op. No recursion in the zod schema (JSON-schema generation must keep working): leaves, then `all`/`any` of leaves, with `not` allowed around a leaf.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (exactly this model name).

## Review Focus

1. On the shipped `terraform-forces-replacement` incident: after naming the root cause, removing `prevent_destroy` and applying takes `remove-guard` (destructive), the database being recreated notwithstanding; reverting `storage_encrypted` afterwards does NOT take `revert-and-migrate`; the clean path (revert only, never apply) still does (Task 5 tests).
2. `done_when` and `file` on one action require both; an action with neither detection nor a button stays valid as before; buttons still take actions directly (Tasks 3, 4).
3. A world that cannot be evaluated (config does not parse, no state) makes `plan_*` predicates false rather than throwing (Task 1 tests).
4. Replay/remount: no duplicate TAKE_ACTION for an action already in the log, `history` is rebuilt identically by replaying the commands (Tasks 2, 5).
5. The validator rejects: `done_when` without a `terraform` block, unknown predicate keys, malformed addresses, unknown resource types in `reality_has`, a `file_contains.matches` that is not a valid regex, an empty `all`/`any` (Task 3).

---

### Task 1: The predicate language and its evaluator

**Files:**
- Create: `src/game/terraform/predicates.ts`
- Modify: `src/game/terraform/render.ts` (export a `hasChanges(r: PlanResult): boolean` helper that `renderPlan` itself uses for its "No changes." decision; rendered output must stay byte-identical)
- Test: `tests/terraform-predicates.test.ts`

**Interfaces (produces):**
```ts
export type Leaf =
  | { plan_clean: true }
  | { plan_has: { no_destroy: string[] } }            // none of these instance/resource addresses is destroyed or replaced
  | { state_has: string } | { state_lacks: string }   // an instance address, or a resource address (any instance)
  | { lock_free: true }
  | { reality_has: { type: string; id: string; attr?: string; equals?: Value } }   // object exists (and the attribute equals, deep)
  | { reality_lacks: { type: string; id: string } }
  | { applied: { op: 'create' | 'update' | 'delete' | 'import' | 'forget'; address: string } } // an apply ran this op on this address (instance or resource address) at some point
  | { file_contains: { path: string; matches: string } }                           // regex (multiline) matches the file on disk
export type Predicate = Leaf | { not: Leaf } | { all: (Leaf | { not: Leaf })[] } | { any: (Leaf | { not: Leaf })[] }

export interface World {
  state: State
  reality: Reality
  lock?: object        // present = locked
  history: string[]    // "OP ADDRESS" lines, oldest first
  plan(): PlanResult | undefined   // a fresh plan against files on disk; undefined if it could not be made
  readFile(path: string): Promise<string | undefined>
}
export function evalPredicate(p: Predicate, w: World): Promise<boolean>
```
Semantics: `plan_clean` = a plan exists, has no diagnostics, and `!hasChanges(plan)`; `plan_has.no_destroy` = a plan exists with no diagnostics and no item whose `address` (or resource part before the instance key) equals a listed address with action `destroy` or `replace`; both are `false` when `plan()` is undefined. The plan is computed at most once per `evalPredicate` call (memoize inside). `state_has/lacks` match with `findInstance`/`listAddresses` (a resource address matches any instance of it). `reality_has.equals` compares with the evaluator's `equal` from `eval.ts` (missing attr is false). `applied` matches `history` lines `OP ADDRESS` exactly, where a resource address (no key) also matches `OP ADDRESS[...]` instances. `file_contains` compiles the regex with the `m` flag inside try/catch (invalid → false) and is false if the file is unreadable. `all([])` is true and `any([])` false at runtime (the schema forbids empty lists, Task 3).

- [ ] **Step 1: Write the failing tests** — `tests/terraform-predicates.test.ts`: build a `World` by hand (state via a small helper like `tests/terraform-apply.test.ts`'s `stateOf`, reality via `realityKey`, `plan()` returning a real `planConfig` result for an inline config, `readFile` over a Map). Cover every leaf true/false, resource-vs-instance addresses (`aws_s3_bucket.b` matches `aws_s3_bucket.b["x"]` for `state_has` and `applied`), `reality_has` with and without `attr`, deep `equals`, `not`/`all`/`any`, `plan_clean` true for a converged world and false with a pending create, false when `plan()` returns undefined, false when the plan has diagnostics, `plan_has.no_destroy` true when only an update is planned and false for a `-/+` replace of the listed address, `lock_free` both ways, `file_contains` with a bad regex → false, unreadable → false, and that `evalPredicate` calls `plan()` once even when several plan leaves are used.
- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/terraform-predicates.test.ts` → FAIL (missing module).
- [ ] **Step 3: Implement.** In `render.ts` extract the "any visible item or output change" test already used for the `No changes.` branch into the exported `hasChanges`.
- [ ] **Step 4: Verify** — targeted tests, `npm test 2>&1 | grep -E "Test Files|Tests "`, `npx tsc -b`, `npm run lint 2>&1 | tail -5`.
- [ ] **Step 5: Commit** — `git add src tests && git commit -m "feat: world predicates and their evaluator (TF3d)"` with the trailer.

---

### Task 2: Lab history

**Files:**
- Modify: `src/game/terraform/lab.ts` (field), `src/game/terraform/cli.ts` (record)
- Test: `tests/terraform-apply-cli.test.ts` (append)

**Interfaces (produces):** `Lab.history: string[]` (initially `[]`; the throwaway lab outside the lab directory gets its own fresh array). Every successful or failed step of `terraform apply`/`destroy` run in the lab directory on the main host appends one line per step that completed OK: `"OP ADDRESS"` with `OP` one of `create`, `update`, `delete`, `import`, `forget` (use `ApplyStep.op` and `address` directly), in execution order, regardless of workspace. A failed step (`ok: false`) adds nothing. State commands (`state rm`, `import` command, `taint`) do not add history.

- [ ] **Step 1: Write failing tests** (append to `tests/terraform-apply-cli.test.ts`, existing harness): `apply -auto-approve` of a two-resource network records `['create aws_vpc.main', 'create aws_subnet.a']`; a replace records `delete …` then `create …` in that order; a failing second create (fault) records only the first; a cancelled apply and a locked apply record nothing; `-chdir=/tmp terraform apply -auto-approve` leaves `lab.history` unchanged; `destroy` records deletes; a no-change apply records nothing.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (the commit block in `cmdApply` that assigns `lab.state/reality/hasState`).
- [ ] **Step 4: Verify** — targeted, full suite, `npx tsc -b`, lint.
- [ ] **Step 5: Commit** — `feat: lab keeps a history of applied steps (TF3d)`.

---

### Task 3: `done_when` in the schema and validator

**Files:**
- Modify: `src/schema/scenario.ts`, `schemas/incident.json` (`npm run schemas`)
- Test: `tests/terraform-lab.test.ts` (append; it holds the terraform-block validation tests) — put schema tests that need a full valid scenario next to the existing ones

**Interfaces (produces):** `ActionsSchema` items gain optional `done_when: Predicate` (zod mirror of Task 1's type; each leaf and each wrapper is a `z.strictObject` with exactly its keys; `plan_clean` and `lock_free` are `z.literal(true)`; `all`/`any` are `z.array(LeafOrNot).min(1)`; use one `z.union` — no `z.lazy`). Types are inferred from the schema and `predicates.ts` imports `Predicate` from the schema file instead of declaring its own (if Task 1 already declared the type, replace its declaration with the schema-inferred type and keep the exported names).

Cross-field rules (`superRefine`, issue paths pointing at `done_when`):
- `done_when` on any action (scenario or stage) requires `terraform` on the scenario: `done_when needs a terraform block`.
- addresses (`plan_has.no_destroy[]`, `state_has`, `state_lacks`, `applied.address`) match `/^(data\.)?[a-z][\w]*\.[\w-]+(\[(\d+|"[^"]*")\])?$/`.
- `reality_has.type` / `reality_lacks.type` is a type `schemaFor` knows (same check as `terraform.state[].type`); `id` non-empty.
- `file_contains.path` is absolute; `matches` compiles as a regex.
- `applied.op` is one of the five ops.
- An action may now have `done_when` as its only machine detection (no `match_regex`, no `file`); check the existing rules about how actions are detected and relax any that would reject this for terraform scenarios.

- [ ] **Step 1: Write failing tests**: accepts one valid action per leaf plus an `all` with a `not`; rejects: `done_when` with no terraform block, unknown key (`{ plan_clear: true }`), two keys in one object, malformed address, unknown `reality_has.type`, bad regex, relative `file_contains.path`, empty `all`, `plan_clean: false`, nested `all` inside `all`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — targeted, `npm run schemas` (diff only adds `done_when`), full suite, `npx tsc -b`, lint.
- [ ] **Step 5: Commit** — `feat: done_when predicates in the scenario schema (TF3d)`.

---

### Task 4: The shell exposes the world; the session takes world-detected actions

**Files:**
- Modify: `src/game/terraform/cli.ts` (export `worldPlan`), `src/game/shell.ts`, `src/components/terminal/session.ts`
- Test: `tests/terraform-shell-world.test.ts` (new; model on `tests/terraform-shell-apply.test.ts`), and a UI-level test in `tests/incident.test.tsx` (Task 5 uses it)

**Interfaces (produces):**
- `cli.ts`: `export async function worldPlan(ctx: CliContext): Promise<PlanResult | undefined>` — loads the working directory's configuration, resolves variables exactly as `plan` does (`prepare`/`resolveVars`; `lab.vars` and `TF_VAR_*` from `ctx.env`), runs `planConfig` against the current `lab.state`/`lab.reality`/`lab.workspace` with refresh on, and returns `undefined` when there is no configuration, the lock file is missing, or variables cannot be resolved. It never commits anything and ignores the state lock. Plan diagnostics are returned inside the result (the predicate treats them as not clean).
- `shell.ts`: refactor the `CliContext` construction in `terraform()` into a private `cliContext(ctx, mainHost)` used by both `terraform()` and the new `async doneWhen(pred: Predicate): Promise<boolean>`: builds a `World` (`state`, `reality`, `lock`, `history` from `this.lab`; `plan: lazily via worldPlan on the main host in the lab directory`; `readFile` over the main host's filesystem) and calls `evalPredicate`. Returns `false` when the scenario has no `terraform` block or the shell is not on a state where the lab directory is readable; never throws.
- `session.ts`: `checkFileFixes` becomes `checkFixes` (keep the exported/internal call sites working): for each action not yet taken, the action is *detected* when `(a.file ? matches : true) && (a.done_when ? await sh.doneWhen(a.done_when) : true) && (a.file || a.done_when)`; detection goes through the same root-cause gate as today (`namedRootCause` → `onTakeAction`, else the one-time note; the note text is unchanged). Evaluate `done_when` only when the cheap `file` test (if any) already passed, and never evaluate for already-taken actions.

- [ ] **Step 1: Write failing tests** (`tests/terraform-shell-world.test.ts`): through `new IncidentShell(scenario)` on an inline terraform scenario: `doneWhen({ state_lacks: 'aws_s3_bucket.b' })` before and after `terraform state rm`; `doneWhen({ plan_clean: true })` false with a pending create, true after `terraform apply -auto-approve`; `doneWhen({ applied: { op: 'delete', address: 'aws_vpc.main' } })` after a replace; `lock_free` before/after `force-unlock -force`; `file_contains` after `sed -i`; `doneWhen` on a scenario without terraform → false; with an unparsable config → plan predicates false, others still work; `doneWhen` never changes `lab.state.serial` or history. For `session.ts` logic, extract the pure decision as a small exported function (e.g. `detectedActions(actions, { fileMatches, doneWhen, taken })` or similar, document it) and unit-test: file-only action; done_when-only action; both required; neither → never; taken actions skipped; `done_when` not evaluated when the file test fails (spy).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Existing behavior for `file:`-only actions must be unchanged (existing tests pass).
- [ ] **Step 4: Verify** — targeted, full suite, `npx tsc -b`, lint, `npm run build`.
- [ ] **Step 5: Commit** — `feat: shell evaluates done_when; the session takes world-detected actions (TF3d)`.

---

### Task 5: The shipped incident uses the world (closes the TF3b hole)

**Files:**
- Modify: `content/iac/terraform-forces-replacement.yaml`, `tests/terraform-incident.test.ts`, `tests/incident.test.tsx`
- Docs touched in Task 6

**Changes to the YAML** (keep every other field): 
- `remove-guard` (destructive): `done_when: { applied: { op: delete, address: aws_db_instance.orders } }`.
- `revert-and-migrate` (fix): keep `file:`; add `done_when: { all: [ { plan_clean: true }, { not: { applied: { op: delete, address: aws_db_instance.orders } } } ] }`.
- `ignore-encryption` (wrong): it has no `file` today, so give it only `done_when: { file_contains: { path: /home/you/infra/db.tf, matches: 'ignore_changes\s*=\s*\[[^\]]*storage_encrypted' } }`. The button still works as before.
- `modify-console` stays button/regex only.
(If a rule in the validator or `file:` requires `after` content for the button, keep what exists.)

- [ ] **Step 1: Write failing tests.**
  - `tests/terraform-incident.test.ts` (shell level, existing helpers): play the incident and assert with the real predicates against the shell: (a) ideal path (revert only; never apply) → `revert-and-migrate`'s detection is true (file regex and `doneWhen`), `remove-guard`'s false; (b) trap path: sed out `prevent_destroy`, `terraform apply -auto-approve` (prevent_destroy removed so the replace runs) → `remove-guard` detection true; then restore `storage_encrypted = false` in `db.tf` and re-add nothing else → `revert-and-migrate` detection is FALSE even though the file regex matches (because history shows the delete), and `terraform plan` shows the replace; (c) `ignore_changes` edit → `ignore-encryption` detection true while the others are false.
  - `tests/incident.test.tsx` (UI, jsdom; extends the Task-6-of-TF3b test that already applies on this incident): after naming the root cause, remove the guard, `terraform apply`, answer `yes` → the log contains `TAKE_ACTION remove-guard` exactly once; reload/remount rebuilds the transcript with no duplicate TAKE_ACTION; the debrief/score shows the destructive deduction (look at how the existing UI tests assert on destructive actions).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the YAML change; fix whatever the new tests reveal in Tasks 1–4's code (report it).
- [ ] **Step 4: Verify** — `npm test` (content validation runs over all YAML), `npx tsc -b`, lint, `npm run build`.
- [ ] **Step 5: Commit** — `content: terraform-forces-replacement detects the destructive apply and the stale fix (TF3d)`.

---

### Task 6: Docs and honesty log

**Files:**
- Modify: `AUTHORING.md`, `CONTENT_TODO.md`

- [ ] **Step 1: `AUTHORING.md`** (`terraform:` section): document `done_when` — every predicate with an example; `all`/`any`/`not` nesting limits; evaluated after each terminal command and each log change against the live world; combined with `file:` means both; buttons still take actions directly as the accessible fallback (so `done_when` is not enforced on a button click); the root-cause gate (an action detected before the root cause is named is taken once it is named); `applied` survives a recreate (use it to catch "destroyed at some point"); `plan_clean` runs a real refresh-and-plan against the files on disk and variables as `plan` resolves them, ignores locks; guidance for authors: pair every `destructive` trap with an `applied` or `reality_*` predicate, and make a `fix` predicate include `not applied delete …` when destroying the resource would make the file text look fixed. Include the evidence-timing rule from the TF3c review: evidence entries are visible from the start at every stage, so do not make evidence that depends on a world a fix changes (e.g. the lock error after `force-unlock`) a `key_evidence` tag of a later stage.
- [ ] **Step 2: `CONTENT_TODO.md`**: remove the two entries added at the end of TF3b about the `terraform-forces-replacement` hole (they are fixed); add `## terraform done_when predicates (TF3d)` with unchecked items: the note text shown for a world-detected action before the root cause is named; `plan_clean` ignoring `-target`/`-refresh-only`; no scoring bonus yet for good practice (plan before apply, `-out`, checking the workspace); stage-aware evidence is still open; any predicate semantics decisions that were ambiguous in the plan (list what the implementers chose in Tasks 1 to 5).
- [ ] **Step 3: Verify** — `npm test`, `npx tsc -b`, `npm run lint`.
- [ ] **Step 4: Commit** — `docs: done_when predicates for terraform incidents (TF3d)`.

---

## Self-review (done)

- **Spec coverage:** the spec's `plan_clean`, `plan_has: { no_destroy }`, `state_has`/`state_lacks`, `lock_free`, `reality_has` and `file_contains` are all there, plus `reality_lacks` and `applied` (needed for "destroyed at some point"). "Any route that produces the outcome counts" holds because predicates read the world, not the command. "Wrong fixes have real consequences" is the destructive trap now firing on a real destroy; scoring already counts `destructive` actions.
- **Placeholders:** none; test cases are listed concretely; the places that depend on existing helpers name the file to copy from.
- **Type consistency:** `Leaf`/`Predicate`/`World`/`evalPredicate` (Task 1), `Lab.history` (Task 2), schema `done_when` (Task 3, source of the inferred `Predicate`), `worldPlan`/`doneWhen`/`checkFixes` (Task 4), YAML (Task 5) use the same names.
- **Review Focus:** 1 → Task 5 tests; 2 → Tasks 3 and 4 tests; 3 → Task 1 tests; 4 → Tasks 2 and 5; 5 → Task 3.
