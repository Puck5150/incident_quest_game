# Terraform TF6a: modules engine, first milestone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The simulator supports local-path Terraform modules end to end for single-instance module calls: `module "net" { source = "./modules/net" ... }` loads, `terraform init` prints the module lines and records the install, `validate`/`plan`/`apply` plan and create resources at `module.net.aws_x.y` addresses, module inputs and outputs flow, state lists and shows module addresses, `state mv`/`rm`/`taint`/`-replace`/`import` accept module addresses, and a `moved` block (or `state mv`) can move a root resource into a module so a refactor plans no changes. This is the first milestone from the module design; it unlocks the "refactor into a module" incident. It does not add module `count`/`for_each`, nested modules, registry modules, or version handling (TF6b).

**Architecture:** The memo's choice A: expand module calls into one flattened graph with statically qualified node addresses (`module.net.aws_vpc.main`); variables become bindings of the call's argument expressions in the parent scope; outputs become values read as `module.net.out`. The root-module-only assumption (`${type}.${name}` keys everywhere) is replaced by a single shared address model first (Task 1), with no behavior change, then the loader (Task 2), the graph (Task 3), plan/apply/refresh evaluation (Task 4) and `moved`/`import` (Task 5) build on it.

**Tech Stack:** TypeScript (strict), vitest, zod 4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-terraform-modules-design.md` — read it in full first; it carries the inventory of every address-handling site (with file:line), the loader/init/error texts verified against Terraform v1.9.8, the state shape, and the risks. Parent spec: `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md`. TF1 to TF5 are complete. **Out of scope here (TF6b):** module `count`/`for_each`, nested modules, registry modules and versions, `terraform get`/`-upgrade`, provider constraints vs lock file, `terraform_remote_state`; deferred beyond TF6: see the spec's Defer list.

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, `import type` for types, `.ts` import extensions.
- No new npm dependencies. No randomness and no clock.
- Own-property discipline: never `in` / `obj[userKey] = ...` on user-keyed objects (module names, keys): `Map` / `Object.hasOwn` / `Object.fromEntries`. `__proto__` as a module name must not break anything.
- **Zero behavior change for configurations without modules.** The ~30 existing `tests/terraform-*.test.ts` files and all incident tests must pass unchanged at the end of every task (a test may only be edited when the task says so and for a reason recorded in the commit message). Keep `buildGraph(files)` / `planConfig({ files, ... })` call signatures working (compatibility path: a flat list of root files is a module tree with only a root).
- Real-Terraform texts that the spec marks verified are used verbatim; anything marked (?) or invented is logged in `CONTENT_TODO.md` under a new section `## terraform modules engine (TF6a)`.
- Models: Tasks 3 and 4 are the hard ones (graph flattening, plan evaluation): run them on the most capable model available; the rest can run on a mid-tier model.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (exactly this model name).

## Review Focus

1. A configuration without modules behaves byte-for-byte as before (all existing tests pass unchanged; Tasks 1 to 4).
2. A module's resources get the right addresses everywhere they are shown or typed: plan lines `# module.net.aws_vpc.main will be created`, state list/show, `-replace`, `state mv`/`rm`/`taint`/`import`, apply progress lines, errors `with module.net.aws_x.y,`, the `module` field in `terraform state pull` JSON (Tasks 1, 4).
3. Module inputs and outputs: values flow in both directions; unknown propagates; an undeclared variable, a missing required variable, an unsupported argument, an undeclared module output each give the real Terraform error at a location inside the module's own file (`on modules/net/main.tf line N`) (Task 3 tests).
4. Dependency ordering across the module boundary is right for apply and destroy, and a cycle across modules is reported (Tasks 3, 4).
5. The refactor works end to end: moving `aws_vpc.main` into `module.net` without `moved` plans destroy + create with the real `(because aws_vpc.main is not in configuration)`-style reason; with a `moved` block or `terraform state mv` it plans no changes, and apply performs no destroy (Tasks 4, 5).

---

### Task 1: The shared address model and `StateResource.module`

**Files:** Modify `src/game/terraform/state.ts`, `addresses.ts`, `state-ops.ts`, `lab.ts`, `views.ts`, `cli.ts` (state commands, the two ADDRESS regexes, `-replace` validation), `src/schema/scenario.ts` (state entries accept `module`; `faults.at` regex accepts module prefixes). Possibly create `src/game/terraform/address.ts`. Test: `tests/terraform-address.test.ts` (new), plus appends to `tests/terraform-state-ops.test.ts`, `terraform-state.test.ts`, `terraform-lab.test.ts`, `terraform-state-cli.test.ts`.

**Interfaces (produces):**
```ts
// address.ts
export interface ModStep { name: string; key?: string | number }          // module.net / module.net["a"] / module.net[0]
export interface ResAddr { module: ModStep[]; mode: 'managed' | 'data'; type: string; name: string; key?: string | number }
export function parseResAddr(text: string): ResAddr | undefined           // full instance or resource address, with module prefix; undefined if malformed
export function parseModuleAddr(text: string): ModStep[] | undefined      // "module.net" / 'module.net["a"].module.sub'
export function formatModule(steps: ModStep[]): string                    // "module.net[\"a\"]"
export function formatResAddr(a: ResAddr): string
export function resourceKey(a: Pick<ResAddr, 'module' | 'mode' | 'type' | 'name'>): string  // "module.net.aws_x.y" (no instance key): the identity used for resource-level matching everywhere
// state.ts
StateResource { module?: string }                  // "module.net" or 'module.net["a"]' (instance-qualified, as in tfstate v4); absent = root
instanceAddress(r, key?) includes the module prefix; findInstance / listAddresses use it; a comparator `compareAddresses` orders root resources before child-module resources, then by path, type, name, key (list/sort everywhere that sorted by address string)
stateJson writes the `module` field in real tfstate v4 position (it comes first in a resource entry, before `mode`; verify against the spec's state section)
```
All the places the spec inventory lists (state.ts, lab.ts, moves.ts group key/`step()` — moves is Task 5, so only prepare the shared helpers here —, state-ops.ts `sameResource`/`ADDRESS`/`parseAddress`, apply.ts `res()`/`addInstance` use `resourceKey`/the helper, predicates.ts `covers()` becomes segment-aware, cli.ts looser ADDRESS regex merged with the state-ops parser) switch to the shared model. Behavior for root-only addresses is byte-identical.

- [ ] **Step 1: Write failing tests** — `tests/terraform-address.test.ts`: parse/format round-trip for root, keyed (`["a.b"]`, numeric), data, module (`module.net.aws_x.y`, `module.net["a"].aws_x.y["k"]`, nested `module.a.module.b.aws_x.y`), module-only addresses, malformed inputs (`module.net`, trailing dot, unclosed brackets, whitespace) returning undefined where appropriate, `__proto__` names, comparator ordering (root first, then `module.a` before `module.b`, `module.net` before `module.net["a"]`). State-level tests on a hand-built state with module resources: `listAddresses` order, `findInstance`, `stateJson` field order and content (`"module": "module.net"`), `state-ops` `stateMove` (root → module, module → root, rename module, module instance key), `stateRemove` (whole module via `module.net`, single resource), `taint`, `importObject` with module addresses (declared flag semantics: the resource exists in that module's configuration — for now accept a boolean passed by the caller), CLI state commands (`state list`, `state show module.net.aws_vpc.main`, `state mv`, `state rm module.net`, `terraform taint module.net.aws_x.y`, `-replace=module.net.aws_x.y` accepted by the flag validator). The scenario schema accepts `module` on state entries (`module: "module.net"`) and rejects malformed values; lab builds modules' resources into `StateResource.module`; dependencies derivation uses `resourceKey`.
- [ ] **Step 2: Run to verify failure**, then **Step 3: refactor + implement** in small steps: first introduce `address.ts` and switch every existing site with no behavior change (run the whole suite after the refactor, before adding module behavior), then add module support.
- [ ] **Step 4: Verify** — targeted tests, `npm test` (the existing suite must pass unchanged), `npx tsc -b`, `npm run lint`.
- [ ] **Step 5: Commit** — `refactor: one address model with module support in state and state commands (TF6a)`.

---

### Task 2: The module loader, manifest, and `terraform init`

**Files:** Modify `src/game/terraform/cli.ts` (`loadConfig`, `cmdInit`, `prepare`), `layout.ts`, `src/game/paths.ts`, `src/schema/scenario.ts`, `src/game/terraform/lab.ts`; create `src/game/terraform/modules.ts` (the pure part: module tree type, manifest parse/format, source resolution, error diagnostics). Tests: `tests/terraform-modules-loader.test.ts` (new) + CLI tests in `tests/terraform-modules-cli.test.ts` (new).

**Interfaces (produces):**
```ts
// modules.ts
export interface ModuleFiles { dir: string /* lab-relative, '' for root */; files: { name: string /* lab-relative path, e.g. 'modules/net/main.tf' */; text: string }[] }
export interface ModuleCall { name: string; source: string; version?: string; pos: Pos; file: string; moduleDir: string /* of the calling module */ }
export interface ModuleTree { root: ModuleFiles; children: Map<string /* call key e.g. 'net' */, { call: ModuleCall; files: ModuleFiles }> }  // single-instance nesting only in TF6a: children of root; deeper nesting arrives in TF6b
export function loadModuleTree(...)  // reads the lab dir and, for each `module` block with a local source ("./x", "../x"), the module dir; consults `.terraform/modules/modules.json` for installed state
```
- Config loading: `loadConfig` returns the root files plus child module files for local sources; file names in diagnostics are lab-relative (`modules/net/main.tf`). A module block whose directory does not exist: `Error: Unreadable module directory` / `Unable to evaluate directory symlink: lstat ./modules/nope: no such file or directory` (verify the real text; see the spec's loader section). Registry/git sources are recognised and produce a clear lab-specific error `Unsupported module source` (TF6b adds registry).
- **Installation state:** `terraform.modules.installed` in the scenario (optional list of `{ key, source, dir }`) seeds `.terraform/modules/modules.json` on the simulated disk (a scenario with local modules that starts "initialised" has it; one that starts un-initialised does not). Before `init`, `validate`/`plan`/`apply` on a configuration with module calls not in the manifest fail with the real `Module not installed` error (verify text in the spec: `This module is not yet installed. Run "terraform init" to install all modules required by this configuration.` with the `on main.tf line N:` / source line context; also `Module source has changed` when the manifest's source differs from the config).
- `terraform init` with module calls prints, in order after the backend line: `Initializing modules...` and for each local module `- NAME in modules/net` (verified format in the spec section "terraform init output"), writes/updates `.terraform/modules/modules.json` (real shape: `{"Modules":[{"Key":"","Source":"","Dir":"."},{"Key":"net","Source":"./modules/net","Dir":"modules/net"}]}`), then proceeds as today. `terraform get` is implemented for local modules (prints `- net in modules/net`), exit 0.
- Mounting: `paths.ts` mounts the manifest when `terraform.modules.installed` is present; files under `modules/...` already mount through `terraform.files`.

- [ ] **Step 1: Write failing tests**: pure loader tests (tree for root-only config equals today's file list; one local module; module dir missing; source with `..`; names of files are lab-relative; modules.json parse/format round-trip incl. Dir for root `.`); CLI: `init` output with and without modules (exact lines), manifest written to disk and read back by a following `plan`; un-initialised plan → `Module not installed` error exact text, exit 1, state untouched; source changed → `Module source has changed`; `terraform get`; `terraform validate` loads child module files (a syntax error in `modules/net/main.tf` is reported with that file path and line); registry source gives the lab error; commands in directories other than the lab dir are unaffected.
- [ ] **Step 2 to 5:** run failing, implement, verify (`npm test`, `npx tsc -b`, `npm run lint`, `npm run build`), commit — `feat: local module loader, init and get (TF6a)`.

---

### Task 3: Graph flattening

**Files:** Modify `src/game/terraform/graph.ts` (and `types.ts` if needed), `parse.ts` only if the study's open question 5 (module refs parse) fails. Tests: `tests/terraform-graph-modules.test.ts` (new).

**Interfaces (produces):** `buildGraph(input: Block-or-files-compat | ModuleTree)` returns the same `Graph` shape with: nodes for every module's resources/data/variables/locals/outputs with module-qualified addresses (`module.net.aws_vpc.main`, `module.net.var.cidr`, `module.net.output.vpc_id`, `module.net` call node); `deps` resolved per module scope (a reference `aws_vpc.main` inside `modules/net` resolves to `module.net.aws_vpc.main`; `var.cidr` inside the module to `module.net.var.cidr` which depends on the call's argument expression's references in the PARENT scope; `module.net.vpc_id` in the parent resolves to `module.net.output.vpc_id`); `order` (topological), `cycles` (reported across modules with the real format), `blocks` map for position/file lookup, and diagnostics using each module's own file names.
Diagnostics (real texts; verify in the spec): undeclared reference inside a module (`Reference to undeclared resource ... has not been declared in module.net`? — the real message says "in the root module" only for root; for child modules verify the exact text in Terraform source `internal/terraform/evaluate_valid.go`), `Reference to undeclared input variable`, `Missing required argument` for a module call that omits a variable without a default (`The argument "cidr" is required, but no definition was found.` at the module block), `Unsupported argument` for an unknown input (`An argument named "bogus" is not expected here.`), `Reference to undeclared module output`/`Unsupported attribute` for a missing output, duplicate declarations per module scope, cycles across the module boundary.

- [ ] **Step 1: Write failing tests**: first test = module refs parse and resolve (`module.net["a"].x` shape is Task-TF6b; here `module.net.vpc_id`); node set and addresses for a 2-module-level config; deps across the boundary in both directions; ordering; each diagnostic with exact text and file/line inside the module; root-only configs produce graphs `toEqual` to the old builder's output (snapshot a few existing fixtures' graphs from `tests/terraform-graph.test.ts` and assert unchanged); `__proto__` module name; self-referencing module output cycle.
- [ ] **Step 2 to 5:** run failing, implement, verify, commit — `feat: module-qualified dependency graph (TF6a)`.

---

### Task 4: Plan, refresh and apply over module resources (single instance)

**Files:** Modify `src/game/terraform/plan.ts`, `expand.ts` (none expected), `refresh.ts`, `render.ts` (headers/reasons), `apply.ts`, `predicates.ts`, `views.ts`, `cli.ts` (refresh lines, `-replace` handling in planConfig input, import declared check hook), `lab.ts`. Tests: `tests/terraform-modules-plan.test.ts`, `tests/terraform-modules-apply.test.ts` (new).

**Behavior:**
- `planConfig` takes the module tree (compat: a flat file list), evaluates module call arguments in the parent scope, module variables with defaults and type-less conversion as for the root, locals/outputs in module scope, `module.net.out` references, unknown propagation (an unknown input makes dependent attributes unknown), resource instances keyed by qualified address; `PlanItem` gains `module` and `resource` (unqualified) fields, `address` is the full qualified instance address; items sort with the shared comparator.
- Root outputs may reference module outputs. Module outputs are not shown by `terraform output` (root only).
- Orphan destroys for module resources: reason `destroyReason: 'module-gone'` when the whole module call no longer exists, with text `(because module.net is not in configuration)`; when only the resource is gone: `(because aws_vpc.main is not in configuration)`. Verify exact strings in the spec.
- The classic refactor: root `aws_vpc.main` in state, config moves it into `module.net` without `moved`: plan = destroy `aws_vpc.main` (reason `aws_vpc.main is not in configuration`... confirm which phrasing real Terraform uses for a root resource that is gone) + create `module.net.aws_vpc.main`; `prevent_destroy` inside module or on the root resource raises `Instance cannot be destroyed` with the right address and `on modules/net/main.tf line N`.
- Refresh/drift: `Drift`, `relevantDrift` and render `driftBlock` use the shared address helpers (no regex stripping of `[...]`); drift for module resources prints `# module.net.aws_x.y has changed`.
- Apply: `res()`, readiness tiers, `addInstance` create `StateResource` entries with `module`; progress lines `module.net.aws_vpc.main: Creating...`; boxed errors `with module.net.aws_vpc.main,` and `on modules/net/main.tf line N, in resource "aws_vpc" "main":` (line/file from the resource block, Task 3's `blocks`); faults match `module.net.aws_x.y` and resource-level `module.net.aws_x.y` addresses; `history` lines `create module.net.aws_x.y`; predicates (`state_has`, `applied`, `plan_has.no_destroy`) accept module addresses (`covers()` segment-aware from Task 1).
- `terraform state list` after apply shows module addresses; `state show module.net.aws_vpc.main`; `terraform output` unchanged; saved plans (`-out`) work with module configs (the saved record stores the whole tree's files).
- `terraform destroy` on a module config destroys in reverse dependency order across the boundary.
- `-replace=module.net.aws_vpc.main` and `taint module.net.aws_vpc.main` replace only that instance.

- [ ] **Step 1: Write failing tests** (concrete, using `planConfig`/`executeApply` and the CLI harness): (a) a root + one local module config creates network resources: plan text exact incl. `# module.net.aws_vpc.main will be created`, ordering of module resources vs root resources dependent on `module.net.vpc_id`; (b) apply creates them in dependency order across the boundary, state has `module: "module.net"`, `state list`/`state pull` as specified; (c) the refactor-without-moved plan (destroy + create + reasons) and with prevent_destroy; (d) module input from a root variable with and without default, unknown input propagation (`known after apply`), module output used by a root resource; (e) orphan destroy when the module call is removed (`module-gone` reason) and apply destroys dependents first across the boundary; (f) drift in a module resource printed correctly; (g) faults and errors with module addresses and in-module file locations; (h) `-replace`/`taint` on a module instance; (i) predicates (`state_has module.net.aws_vpc.main`, `applied create module.net.aws_vpc.main`, `plan_has no_destroy`); (j) saved plan with modules; (k) idempotent re-apply and deterministic ids (module address included in the id seed through the address).
- [ ] **Step 2 to 5:** run failing, implement, verify (full suite incl. every existing terraform test and incident test unchanged), commit — `feat: plan, refresh and apply over module resources (TF6a)`.

---

### Task 5: `moved`, `import` and `state mv` with module addresses; docs

**Files:** Modify `src/game/terraform/moves.ts`, `declarations.ts`, `addresses.ts`, `plan.ts` (moved/import/removed checks), `state-ops.ts` (`importObject` declared check against the module tree), `cli.ts` (`import` command declared logic), `AUTHORING.md`, `CONTENT_TODO.md`. Tests: extend `tests/terraform-moves.test.ts`, `terraform-declarations.test.ts`, add `tests/terraform-modules-moved.test.ts`.

**Behavior:**
- `moved { from = aws_vpc.main  to = module.net.aws_vpc.main }` (root → module), module → root, module → another module, and module rename (`from = module.net  to = module.network`) all rewrite state addresses; the plan shows `# aws_vpc.main has moved to module.net.aws_vpc.main` and `Plan: 0 to add, 0 to change, 0 to destroy.`; apply persists the move with no destroy; chained moves and cycle/conflict checks use the shared address helpers; the same diagnostics as for root addresses (`Moved object still exists`, `Invalid "moved" address` etc.).
- `import { to = module.net.aws_s3_bucket.b  id = "legacy" }` (import blocks live in the root module and may target module resources; verify real rules in the spec/memo) and the CLI `terraform import module.net.aws_s3_bucket.b legacy` work; the declared check looks in the module's configuration; undeclared → the existing error with the module-qualified address in the example block text (verify real text).
- `removed { from = module.net.aws_vpc.main ... }` and `removed { from = module.net }` if cheap; otherwise log as deferred.
- `terraform state mv aws_vpc.main module.net.aws_vpc.main` produces the same end state as the moved block; after either, the plan is clean (Review Focus 5).
- `AUTHORING.md`: document `module` blocks in `terraform.files`, `terraform.modules.installed`, module addresses in `state`/`faults`/`done_when`, how a module-refactor incident is authored (a worked example), and the limits (local sources only until TF6b). `CONTENT_TODO.md`: the TF6a section with every unverified (?) text, simulator limits (no count/for_each on modules, no nesting), and the open questions from the spec.

- [ ] **Step 1: Write failing tests**: all the moved variants above with exact plan text; state mv equivalence; import via block and CLI; error texts; interplay with `prevent_destroy` (the refactor with `prevent_destroy` on the resource fixed by `moved` plans clean and does not trip the guard); `done_when`: after the `moved` apply, `state_has module.net.aws_vpc.main` and `plan_clean` hold and `applied delete aws_vpc.main` does not appear in history.
- [ ] **Step 2 to 5:** run failing, implement, docs, verify (`npm test`, `npx tsc -b`, `npm run lint`, `npm run build`), commit — `feat: moved, import and state mv with module addresses; docs (TF6a)`.

---

## Self-review (done)

- **Spec coverage:** the module design's first milestone (T1, T2 local, T3, T4a, T5 single-instance) is covered; `count`/`for_each` on modules, nesting, registry versions, provider constraints, remote state and the incident batch are TF6b/TF6c.
- **Placeholders:** none in intent; where real-Terraform wording needs confirmation the task says to take it from the spec's verified sections or verify in the Terraform source and log unverified items.
- **Type consistency:** `ResAddr`/`ModStep`/`resourceKey`/`compareAddresses` (Task 1) are the identifiers Tasks 3 to 5 use; `ModuleTree` (Task 2) is the input of Task 3's `buildGraph` and Task 4's `planConfig`; `PlanItem.module/resource` (Task 4) are used by Task 5's checks.
- **Review Focus:** 1 → every task's "existing suite unchanged" gate; 2 → Tasks 1 and 4; 3 → Task 3; 4 → Tasks 3 and 4; 5 → Tasks 4 and 5.
