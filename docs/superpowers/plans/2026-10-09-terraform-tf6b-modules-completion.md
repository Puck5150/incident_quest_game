# Terraform TF6b: keyed and nested modules, registry modules, provider constraints, remote state Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the simulator features the config-and-modules incident batch (TF6c) needs: module calls with `count`/`for_each` (`module.net["a"].aws_vpc.main`), nested modules (`module.app.module.db...`), authored offline "registry" modules with versions (`source = "acme/network/aws"`, `version = "~> 2.0"`, `terraform init -upgrade`), provider version constraints checked against the dependency lock file (`required_providers`, `required_version`, `Inconsistent dependency lock file`, `init -upgrade`), and `data "terraform_remote_state"` coupling. Each builds on TF6a (local single-instance modules); root-only configurations and everything TF6a shipped must keep behaving byte-identically.

**Architecture:** The TF6a design stays: one flattened graph with statically qualified node addresses, instance-qualified values at plan time. TF6b adds (1) module-call expansion through the existing `expandInstances`, with instance-qualified module paths in state and addresses and static key-less names in dependencies; (2) a recursive `ModuleTree` (loader, installer, graph); (3) a registry layer on top of the loader with a small semver matcher shared with (4) provider constraints; (5) a built-in data type for remote state. The TF6a review listed the resistance points; each task below names the ones it must address.

**Tech Stack:** TypeScript (strict), vitest, zod 4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-terraform-modules-design.md` (read it in full: sections 2 to 6 and "Open questions"; section 6a/6b have the verified provider-constraint and remote-state texts). TF1 to TF6a are complete; the TF6a final review's "places the design will resist" (instance-keyed module paths in dependencies, module-level move handling, one-level nested loading, keyed-instance checks in CLI/import, local-only installer/schema) are the starting checklist. Out of scope: git/S3/HTTP module sources, provider aliases and `providers = {}` passing, module variable types/validation, `-target`, `moved`/`removed`/`import` blocks inside child modules, `terraform providers`/`graph`/`console`.

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, `import type` for types, `.ts` import extensions.
- No new npm dependencies. No randomness and no clock.
- Own-property discipline: never `in` / `obj[userKey] = ...` on user-keyed objects (module names, module keys, version strings, output names): `Map` / `Object.hasOwn` / `Object.fromEntries`. `__proto__` must be safe everywhere.
- **Zero behavior change** for configurations that do not use the new features: all existing tests (incl. TF6a's and every incident's) pass unchanged at the end of every task; a test may be edited only when a task says so and the reason goes in the commit message.
- Real-Terraform texts: use the verified ones in the spec verbatim; verify the rest against hashicorp/terraform v1.9.8 source on GitHub (WebFetch `raw.githubusercontent.com`) and log anything unverified or invented in `CONTENT_TODO.md` under `## terraform modules engine (TF6b)`.
- Models: Tasks 1 and 2 touch the evaluator/graph/moves and are the hard ones: use the most capable model available. Others can use a mid-tier model.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (exactly this model name).

## Review Focus

1. A module call with `for_each = toset(["a","b"])` or `count = 2` produces separate resources at `module.net["a"].aws_x.y` / `module.net[0].aws_x.y` everywhere (plan lines, state, apply progress, errors, faults, history, predicates, state commands), and key removal/shrink plans destroy exactly the removed instances with the right reason text (Task 1).
2. Dependencies and ordering are correct across keyed module instances, including destroy order after a `moved`/rename and after an instance is removed: stale or collapsed dependency names must not cause a `DependencyViolation` (Task 1; this is the TF6a B2 failure class).
3. Nested modules resolve inputs/outputs through two levels, installs and `modules.json` are right, and addresses/moves work with nested paths (Task 2).
4. A registry module's version selection is deterministic and honest: constraints match semver rules, `init` picks the newest satisfying authored version, changing `version =` without `init -upgrade`/`init` gives the real error, and the plan after `init -upgrade` reflects the new module code (Task 3).
5. Provider constraints: a lock file that no longer satisfies the configuration (any module's `required_providers`) blocks plan/apply with the real error, `init -upgrade` fixes it, `-lockfile=readonly` and `required_version` behave as documented (Task 4).
6. `data.terraform_remote_state` reads authored upstream outputs; a missing output fails like real Terraform; changing the upstream (scenario-authored) outputs changes the plan (Task 5).

---

### Task 1: Module `count` and `for_each` (keyed module instances)

**Files:** Modify `src/game/terraform/graph.ts`, `plan.ts`, `expand.ts` (reuse), `moves.ts`, `declarations.ts`, `apply.ts`, `predicates.ts`, `state-ops.ts`, `cli.ts` (keyed-instance checks, declared checks), `render.ts`, `address.ts` (if gaps), `src/schema/scenario.ts` (module keys in `state`, `faults.at`, `done_when` — already accepted keyed steps), `AUTHORING.md`. Tests: `tests/terraform-modules-keyed.test.ts` (new) plus extensions.

**Behavior:**
- A `module` call with `count`/`for_each` expands into instances `module.net[0]`, `module.net["a"]` exactly like resource instances (reuse `expandInstances`, same unknown/for_each errors). The TF6a `Unsupported module argument` diagnostic for count/for_each on a module call is removed. Each module instance is evaluated with `count.index` / `each.key` / `each.value` available to the call's argument expressions only (not inside the child).
- Plan values and instances are keyed by the instance-qualified module path: module variables bind per module instance; child resources, locals, outputs exist per instance; `module.net["a"].vpc_id` from the parent reads that instance's output; a bare `module.net` reference is the object/list of all instances' outputs (follow how resources behave in this simulator: `module.net[*]` splat if supported by the evaluator, otherwise unsupported error — match the resource implementation).
- State: `StateResource.module` holds the instance-qualified path (`module.net["a"]`); `planConfig` finds prior instances by that path; removed keys destroy their instances with `(because module.net["b"] is not in for_each map)` / `(because module.net[1] is out of range for count)` — verify the exact reason strings in Terraform v1.9.8 `jsonformat/plan.go` (`NoModule`/`NoResourceConfig`/`WrongRepetition...` cases: the orphan reasons for module instances) and use them; switching a module from `count` to `for_each` (or the reverse, or adding/removing repetition) reuses the existing wrong-repetition logic at module level.
- **Dependencies:** `dependsOn`, `priorDeps` and state `dependencies` stay static key-less names (`module.net.aws_vpc.main`); fix the collapse risk (TF6a review): apply readiness and destroy ordering must treat "a dependent of resource R" as depending on ALL instances of R across module instances; add tests where `for_each` module instances' resources are destroyed/created in the right order and where a removed module key destroys dependents-of-that-key first with no DependencyViolation (build the failing configuration first).
- `moved`: `module.net` → `module.net["a"]` (adding for_each), `module.net[0]` → `module.net["a"]`, `module.net` → `module.network` with keyed instances (all keys move), resource moves inside a keyed module; `applyMoves`/`step()` carry keyed module steps; state `dependencies` rewritten as in TF6a (static names only change on renames).
- CLI/state: `state list` ordering (compareAddresses already orders keys), `state show module.net["a"].aws_x.y`, `state mv`/`rm`/`taint`/`-replace`/`import` with keyed module steps (the TF6a code refuses keyed instances in import "declared" checks (`cli.ts` ~L750): replace by checking the module call exists and the key exists in its current expansion; verify the key against the call's expansion at import time), `terraform import 'module.net["a"].aws_s3_bucket.b' id`.
- Faults and predicates already parse keyed module steps (address.ts); add tests that a fault at `module.net["a"].aws_x.y` fires only for that instance and at `module.net.aws_x.y` for all.
- Render: `# module.net["a"].aws_vpc.main will be created`, apply progress lines, boxed errors `with module.net["a"].aws_vpc.main,`.

- [ ] **Step 1: Write failing tests** (`tests/terraform-modules-keyed.test.ts`): for_each module of two instances: plan text exact (`Plan: N to add...`), apply order, state list/pull (`module` field `module.net["a"]`), per-instance outputs read from the parent (`module.net["a"].vpc_id`), `count = 2` equivalent, the unknown for_each error, key removal destroy plan with reason text, count shrink, count→for_each switch (all instances destroyed/created, fixable with `moved` blocks key by key), `moved` adding for_each (`module.net` → `module.net["a"]`), module rename with keyed instances, import into a keyed instance, `-replace`/`taint` of one instance only, faults at instance vs resource level, the dependency/destroy-order scenarios above, history lines and predicates with keyed addresses, two keyed module calls to the same directory.
- [ ] **Step 2: Run to verify failure.** Then **Step 3: implement** in this order: graph/plan expansion (new feature behind the same code path), state/apply/predicates, moves, CLI checks, render; run the whole suite after each part.
- [ ] **Step 4: Verify** — targeted tests, `npm test` (twice if loaded), `npx tsc -b`, `npm run lint`, `npm run build`.
- [ ] **Step 5: Commit** — `feat: module count and for_each with keyed instances (TF6b)`.

---

### Task 2: Nested modules

**Files:** Modify `src/game/terraform/modules.ts` (recursive `ModuleTree`, loader, manifest), `cli.ts` (`loadConfig`, `cmdInit`, `cmdGet`, `installModules`), `graph.ts`, `plan.ts`, `moves.ts` (relative paths), `state-ops.ts`, `address.ts` (checks), `src/schema/scenario.ts` (`modules.installed` nested keys), `AUTHORING.md`. Tests: `tests/terraform-modules-nested.test.ts` (new).

**Behavior:**
- A child module may itself contain `module` calls with local sources (relative to the CHILD module's directory); the loader recurses (cycle guard: a module that calls itself directly or indirectly gives the real error `Module cycle`... verify the exact diagnostic text or use a lab-specific error and log it). Depth limit generous (e.g. 8) with a clear error beyond.
- `modules.json` keys are dotted paths (`net`, `net.inner`) with `Dir` lab-relative; `terraform init` prints `- inner in modules/net/inner`-style lines for nested calls (verify format in `hook_module_install.go`/`init.go`: the key printed is the dotted path, e.g. `- net.inner in modules/net/inner`; use the verified form); `terraform get` the same; `Module not installed` for a nested call names the nested module block and file.
- Graph: nested nodes `module.net.module.inner.aws_x.y`, variables/outputs chained through two levels (parent arg → child var → grandchild var; grandchild output → child output → parent), cycle detection through the chain, diagnostics located in the right file with module path context (`in module.net.module.inner`? verify the real undeclared-reference wording for nested paths: `...has not been declared in module.net.module.inner.`).
- Plan/apply/state: addresses and `StateResource.module` use the full path (`module.net.module.inner`), instance keys at any level (`module.net["a"].module.inner[0]`) — combine with Task 1; orphan reasons for gone nested modules (`module.net.module.inner is not in configuration`); `path.module` of nested children.
- Moves/state mv: moving a resource between nested modules; renaming a nested module call via `moved { from = module.net.module.inner ... }` is INSIDE the child (ignored in TF6a/b): at the ROOT the supported forms are full paths from the root (`module.net.module.inner` → `module.net.module.core`): real Terraform allows root `moved` blocks to address nested modules by full path — verify and support; log what is deferred.
- The TF6a placeholders (`Unsupported nested module`, unloaded nested call node handling) are replaced by real behavior.

- [ ] **Step 1: Write failing tests**: loader (two levels, three levels, relative source paths from the child dir, missing nested dir error, module cycle error, depth limit), `init` lines and `modules.json` content exact, not-installed error for a nested call, graph nodes/deps/order through two levels, plan/apply/destroy across three levels with exact plan lines and ordering, state shape, outputs bubbling up, a keyed module containing a nested non-keyed module and vice versa, `state mv`/`moved` between nested modules, nested orphan destroy reason, errors located in the grandchild file with the module path.
- [ ] **Step 2 to 5:** failing, implement, verify (full suite incl. every TF6a test unchanged), commit — `feat: nested modules (TF6b)`.

---

### Task 3: Registry modules, versions and a semver matcher

**Files:** Create `src/game/terraform/versions.ts` (semver parse/compare/constraint matcher; also used by Task 4), modify `modules.ts`, `cli.ts` (init/get/`-upgrade`), `layout.ts`, `src/schema/scenario.ts`, `src/game/paths.ts`, `AUTHORING.md`. Tests: `tests/terraform-versions.test.ts`, `tests/terraform-modules-registry.test.ts` (new).

**Interfaces (produces):**
```ts
// versions.ts
export interface Version { major: number; minor: number; patch: number; pre?: string }
export function parseVersion(s: string): Version | undefined
export function compareVersions(a: Version, b: Version): number
export function satisfies(v: Version, constraint: string): { ok: boolean; error?: string }   // ">= 1.2, < 2.0", "~> 5.40", "~> 5", "= 1.2.3", "!= 1.2.3", "1.2.3"; pre-releases excluded unless the constraint names one
export function newestSatisfying(versions: string[], constraint: string): string | undefined
```
**Scenario schema:** `terraform.modules.registry`: list of `{ source: "acme/network/aws", versions: [{ version: "2.0.1", files: [{ path, content }] }, ...] }` (module file contents per version; `path` relative to the module dir); validation: sources look like `NAMESPACE/NAME/PROVIDER` (optionally `HOST/NAMESPACE/NAME/PROVIDER`), versions are valid semver, files are `.tf` paths, no duplicates. `terraform.modules.installed` entries gain optional `version`.
**Behavior (verify texts in the spec section 3 and Terraform source; `init.go`, `module_install.go`, `getmodules`, `registry` client):**
- `module "network" { source = "acme/network/aws"  version = "~> 2.0" }` resolves against the authored registry: `terraform init` selects the newest satisfying version, prints `Downloading registry.terraform.io/acme/network/aws 2.1.0 for network...` and `- network in .terraform/modules/network`, installs the files into `.terraform/modules/network/` on the simulated disk, writes `modules.json` with `Version` and `Dir: ".terraform/modules/network"` (registry modules install under `.terraform/modules/<key>`; verify the exact Dir for a module with a subdirectory).
- Errors: no authored version satisfies → `Error: Unresolvable module version constraint` (verify text) at init; `version` missing on a registry source: allowed (newest); `version` on a local source: `Invalid version constraint` (TF6a left this unverified: fix it now, verify the text); `terraform plan/validate` when the manifest's recorded version no longer satisfies the config: `Module version requirements have changed` with the real detail (`The version requirements have changed since this module was installed and the installed version (2.1.0) is no longer acceptable. Run "terraform init" to install all modules required by this configuration.` — verify); source changed → existing `Module source has changed`.
- `terraform init` (no flags) keeps an installed version that still satisfies the constraint (prints `- network in .terraform/modules/network` without downloading); `terraform init -upgrade` and `terraform get -update` re-resolve to the newest satisfying version (`Upgrading modules...` header; verify), re-downloading when it changes.
- A lab can start with a registry module already installed at an older version (`modules.installed` with `version` + files mounted from the registry data), which is exactly the "module upgrade changes the plan" incident: bumping the constraint in the config without `init` errors; `init -upgrade` installs the new version and the next plan shows the new module code's effect (e.g. a forced replacement).
- Registry modules count as modules in every other feature (addresses, state, keyed instances, nested calls inside registry modules (registry module calls local-relative or other registry modules: support registry→registry calls with their own version constraint; local-path calls inside a registry module resolve relative to its install dir)).

- [ ] **Step 1: Write failing tests**: semver matcher table (all operators, `~>` with 1/2/3 components, pre-releases, ranges with commas, invalid constraints with a clear error, `newestSatisfying`); schema validation (valid/invalid registry data); init flows: first install picks newest satisfying, exact output lines, files on disk, manifest with Version; keep-installed on plain `init`; `-upgrade` upgrades; constraint bumped without init → `Module version requirements have changed`; unresolvable constraint error; local source with `version` error; the "module upgrade forces replacement" end to end: v1 module has `cidr_block = var.cidr`, v2 changes a forceNew argument (e.g. `availability_zone`) → plan after `init -upgrade` shows the replacement with `# forces replacement`; registry→registry nesting; plan/apply with a registry module's resources and module address in state.
- [ ] **Step 2 to 5:** failing, implement, docs, verify, commit — `feat: registry modules, versions and semver constraints (TF6b)`.

---

### Task 4: Provider constraints, the dependency lock file, and `required_version`

**Files:** Modify `src/game/terraform/layout.ts` (lock file with `constraints`, per-lab provider version replacing the global `PROVIDER_VERSION`), `cli.ts` (`providersOf`, `lockedProviders`, `lockError`, `cmdInit`, `cmdVersion`, new checks), `lab.ts`, `src/schema/scenario.ts` (`terraform.providers`), `parse.ts` only if `required_providers` nested object literals do not parse, `AUTHORING.md`. Uses `versions.ts` from Task 3. Tests: `tests/terraform-provider-lock.test.ts` (new).

**Behavior (texts verified in the spec section 6a; verify any remaining against Terraform v1.9.8 `backend_local.go`, `config.go`, `providercache/installer.go`, `init.go`):**
- Collect `terraform { required_providers { aws = { source = "hashicorp/aws", version = "~> 5.40" } } required_version = ">= 1.5" }` across the root module AND every loaded child module (registry modules included); combine constraints per provider (comma-joined) and report conflicts (`Failed to query available provider packages`... when no version satisfies all — only if the authored `available` list makes it unsatisfiable).
- Scenario `terraform.providers: { aws: { lock: "5.31.0", available: ["5.31.0", "5.50.0", "5.67.0"] } }` (all optional; default behavior unchanged: one provider version `5.67.0`, available only that). The lock file text written by `init` and mounted at start gets `version`, `constraints` (the combined constraint string) and hashes (invented stable hashes per version, deterministic).
- `terraform version` prints the locked provider version(s) (`+ provider registry.terraform.io/hashicorp/aws v5.31.0`).
- `plan`/`apply`/`destroy`/`validate`/`refresh`/`import`: when the lock selection violates the combined constraints (or the lock has no entry): the real `Error: Inconsistent dependency lock file` with `locked version selection 5.31.0 doesn't match the updated version constraints "~> 5.50"` ... `terraform init -upgrade` suggestion; when the lock's recorded `constraints` equals the current ones the entry reads `version constraints "..." don't match the locked version selection ...` (use the verified forms). Keep the existing "no version is selected" form for a missing entry.
- `terraform init`: with a satisfied lock: reuse (`- Reusing previous version of hashicorp/aws from the dependency lock file`, `- Using previously-installed hashicorp/aws v5.31.0`); with a lock pinning a version that no longer satisfies the config: the installer error `Failed to query available provider packages` / `Could not retrieve the list of available versions for provider hashicorp/aws: locked provider registry.terraform.io/hashicorp/aws 5.31.0 does not match configured version constraint ~> 5.50; must use terraform init -upgrade to allow selection of new versions` (use the verified wrapper text from the spec; log the uncertain parts); `terraform init -upgrade`: selects the newest `available` version satisfying the constraints, rewrites the lock (version, constraints, hashes) and prints `- Finding hashicorp/aws versions matching "~> 5.50"...`, `- Installing hashicorp/aws v5.67.0...`, `- Installed hashicorp/aws v5.67.0 (signed by HashiCorp)`, `Terraform has made some changes to the provider dependency selections recorded in the .terraform.lock.hcl file...`; no satisfying version available: `Failed to query available provider packages` with `no available releases match the given constraints ~> 9.0`.
- `terraform init -lockfile=readonly`: with a lock that needs changes: `Error: Provider dependency changes detected` (spec text); `-upgrade` together: `The -upgrade flag conflicts with -lockfile=readonly.`
- `required_version`: `Error: Unsupported Terraform Core version` (spec text) at config load for init/validate/plan/apply when the lab's Terraform version does not satisfy; for a child/registry module the message names the module (`Module module.network (from registry.terraform.io/acme/network/aws) does not support Terraform version 1.9.8. ...`).
- **Honesty rule:** the simulator's providers do not behave differently by version (no schema changes per provider version), so the only world effect of provider versions is the lock/constraint errors and the installed version shown. Do not invent per-version resource behavior. (Provider upgrades that change defaults are out of scope.)

- [ ] **Step 1: Write failing tests**: constraint collection across root + child + registry module; lock files exact text (with `constraints`); every error text above with exit codes; init flows (reuse, upgrade, no match, readonly, readonly+upgrade); `terraform version` output; default scenarios unchanged byte-for-byte (the existing lock/init tests); a registry-module upgrade whose new version raises the provider constraint (module v2 requires `~> 5.50`) makes the existing lock inconsistent → fixed by `init -upgrade`; `required_version` root and child; `__proto__` provider names; `validate` behavior with an inconsistent lock (real Terraform's validate does check the lock: verify).
- [ ] **Step 2 to 5:** failing, implement, docs, verify, commit — `feat: provider constraints, lock file consistency and required_version (TF6b)`.

---

### Task 5: `data "terraform_remote_state"`

**Files:** Modify `src/game/terraform/plan.ts` (the `data` case), `resources.ts`/`cli.ts` (the `Invalid resource type` validate check), `lab.ts`, `src/schema/scenario.ts` (`terraform.remote_states`), `refresh.ts`/state handling (data in state), `AUTHORING.md`. Tests: `tests/terraform-remote-state.test.ts` (new).

**Behavior (spec section 6b; verify the builtin provider's texts in `internal/builtin/providers/terraform/data_source_state.go` and the backend not-found errors):**
- Scenario `terraform.remote_states: [{ backend: "s3", config: { bucket: "acme-tf-state", key: "network/terraform.tfstate", region: "us-east-1" }, workspace?: "default", outputs: { vpc_id: "vpc-0abc", subnet_ids: ["subnet-1","subnet-2"] } }]` (matched by backend type + the config's bucket/key (and workspace)); validation of shapes.
- `data "terraform_remote_state" "net" { backend = "s3"  config = { bucket = "...", key = "...", region = "..." } }`: planning reads it (refresh lines `data.terraform_remote_state.net: Reading...` / `Read complete after 0s` — the existing data handling), value `{ backend, config, outputs, workspace: "default", defaults: null }`; `data.terraform_remote_state.net.outputs.vpc_id` flows into resources; a missing output → the existing `Unsupported attribute` error (`This object does not have an attribute named "vpc_id".`) located at the reference; no matching remote state authored (wrong `key`) → the builtin provider's error (verify text; e.g. `Unable to find remote state` / `No stored state was found for the given workspace in the given backend.`); unknown config values defer the read (`known after apply`).
- State: the data resource is recorded in state (mode `data`) after apply/refresh like other data sources; `terraform state list` shows `data.terraform_remote_state.net`; `terraform validate` accepts the type (no `Invalid resource type`); `terraform_remote_state` inside modules works with the module prefix.
- **Coupling incidents need the upstream to change:** support the scenario changing remote outputs over the session via an authored action effect? NOT in this task: instead provide a lab-level `Lab.remoteStates` that apply/CLI can read, and let a scenario start in a state where the downstream config references an output that the upstream (authored) no longer has — the classic "upstream renamed an output" break. Log "mutable upstream" as a deferred simulator item.

- [ ] **Step 1: Write failing tests**: plan flows (output used by a resource, listed in state after apply), missing output error text and location, missing remote state error, unknown config values, module-scoped data, `terraform state list`/`show data.terraform_remote_state.net`, validate accepts the type, refresh lines, schema validation, `-refresh=false` plan.
- [ ] **Step 2 to 5:** failing, implement, docs, verify, commit — `feat: terraform_remote_state data source (TF6b)`.

---

### Task 6: Wrap-up, docs, honesty log

**Files:** Modify `AUTHORING.md`, `CONTENT_TODO.md`, tests as needed.

- [ ] **Step 1:** `AUTHORING.md`: document keyed/nested/registry modules, `terraform.modules.registry` and `installed`, `terraform.providers`, `terraform.remote_states`, the new commands/flags (`init -upgrade`, `get -update`, `-lockfile=readonly`), predicates with keyed/nested module addresses, and worked examples (a module-upgrade incident; a lock-file drift incident; a remote-state coupling incident); limits and deferred items.
- [ ] **Step 2:** `CONTENT_TODO.md`: finish the `## terraform modules engine (TF6b)` section (verified vs invented/unverified texts, simulator limits, TF6c prerequisites); remove fixed TF6a items (`version` on local sources, nested/keyed placeholders).
- [ ] **Step 3: Verify** — full suite twice, `npx tsc -b`, `npm run lint`, `npm run build`, `npm run schemas` (git diff empty).
- [ ] **Step 4: Commit** — `docs: modules completion (TF6b)`.

---

## Self-review (done)

- **Spec coverage:** the spec's TF6 candidates map to engine features here (module upgrade changes → Task 3; provider version and lock file drift → Task 4; `for_each` with unknown values already works in the simulator and is extended to module calls in Task 1; `terraform_remote_state` coupling → Task 5; `prevent_destroy` in modules works since TF6a); the incident batch itself is TF6c.
- **Placeholders:** none in intent; real-Terraform wordings not yet verified are explicitly assigned to the implementer to verify in Terraform v1.9.8 source and log.
- **Review Focus:** 1, 2 → Task 1; 3 → Task 2; 4 → Task 3; 5 → Task 4; 6 → Task 5.
