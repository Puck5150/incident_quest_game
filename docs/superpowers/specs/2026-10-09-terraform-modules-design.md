# Terraform simulator: module support, provider constraints and remote state (TF6 design)

Status: design for TF6, derived from a read-only code study of the simulator at `devops-sim` (commit `716afbf`). Real-Terraform texts were checked against hashicorp/terraform v1.9.8; items marked (?) are unverified. Parent spec: `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` (this extends its "Config and modules" candidates).

## Decisions

1. **Architecture:** a flattened, statically qualified graph (the memo's choice A). Module calls expand into the same graph as the root module; node addresses carry the `module.NAME[key].` prefix; module variables are bindings of the call's argument expressions evaluated in the parent scope; module outputs are values read as `module.NAME.output`. Recursive per-module evaluation (B) is rejected: it produces false cycles, wrong `dependsOn` for apply ordering, and needs the post-walk machinery merged across sub-plans.
2. **Sources:** local paths (`./modules/net`) and authored offline "registry" modules whose per-version file contents come from the scenario (`terraform.modules.registry`), installed by `terraform init` into `.terraform/modules/<key>/` with a generated `modules.json` manifest. Git/S3/HTTP sources are out of scope.
3. **Delivery order:** TF6a modules engine, first milestone = address model, local-module loader and `init`, graph flattening, single-instance plan evaluation, `moved` with module addresses. TF6b = module `count`/`for_each`, nested modules, registry modules with versions, provider version constraints vs lock file, `terraform_remote_state`. TF6c = the incident batch.
4. **Deferred:** provider alias passing, `moved`/`import` blocks inside child modules, sensitive-output propagation, module variable types/validation, `-target`, `terraform providers/graph/console`, git/S3/HTTP sources.

The study memo follows verbatim as the detailed reference (inventory of every address-handling site, loader/init/error text, state shape, task breakdown, feasibility notes, open questions).

---

# TF6 design memo: modules in the Terraform simulator

Branch devops-sim, src/game/terraform/ (4886 lines in 27 files). Read-only research. Real-Terraform texts verified against hashicorp/terraform tag v1.9.8 (the lab's default `version`) via raw.githubusercontent.com. Items marked (?) are from memory or not verified.

## 0. What exists today

- `parse.ts` already parses `module "x" { source = ... }` as a Block (labels ['x']). `parse.ts:303` `ref()` collects only dotted identifiers: `module.net.vpc_id` is ref path `['module','net','vpc_id']`; `module.net["a"].vpc_id` is `idx(ref['module','net'], "a")` then `attr(vpc_id)`. The same holds for resources, so no parser change is needed.
- `graph.ts:95-102` `DECL`/`PREFIX` make a `module` node `module.NAME`. `graph.ts:107-129` `resolve()` maps a ref to `module.NAME` only (the output name is dropped), so a dependency on a module is one node.
- `plan.ts:337-340` emits `Unsupported module` and sets UNKNOWN. `plan.ts:169` (scope `module` case) returns UNKNOWN.
- `graph.ts:126` already prints "No module call named X is declared in the root module." That text needs a module-aware variant.
- Scenario files can already sit at nested relative paths (`terraform.files[].path` is relative, no `..`; `scenario.ts:222-230`). `paths.ts:71-75` mounts them onto the virtual disk, so `modules/net/main.tf` already exists on disk. Nothing mounts `.terraform/`.
- `cli.ts:160-170` `loadConfig` calls `ctx.listFiles(dir)` (shell.ts:299, one directory, files only) and keeps `*.tf` in that directory. Subdirectories are never read.
- `cli.ts` never reads `required_providers` or `required_version`. `providersOf` (cli.ts:172) infers providers from resource type prefixes. `lockedProviders` (cli.ts:182) reads only `provider "x"` names from the lock text. `PROVIDER_VERSION='5.67.0'` is a global constant (layout.ts:5).

## 1. Inventory of address and key handling

The central problem: identity is `(mode, type, name, index_key)` everywhere, and `${type}.${name}` is the "resource address" used as a map key. Both need a module path in front.

### state.ts (87 lines)
- `StateResource` (L12-18): add `module?: string`, an instance-qualified path such as `module.net`, `module.net["a"]` or `module.net[0].module.sub`. This is exactly the tfstate v4 `"module"` field.
- `instanceAddress(r: Pick<StateResource,'mode'|'type'|'name'>, key?)` (L37): add `module` to the Pick and prefix `${module}.`. Every call site passing `{mode:'managed',type,name}` literals needs a `module` (see below). Counts: plan.ts 16 uses of instanceAddress/findInstance/res, state.ts 5, apply.ts 8, moves.ts 5, views.ts 3, state-ops.ts 16 (incl. `sameResource`), refresh.ts 2.
- `listAddresses` (L43): sort order. Real `AbsResourceInstance.Less` sorts the module instance path first, shorter path first (root before child), then name and key, then resource (verified in addrs/module_instance.go L315 and resource.go L379). A plain string sort puts `aws_*` before `module.*` and `data.*` in between. Use a comparator, not `.sort()`. The same applies to `showState` (views.ts:49) and `refreshLines` (cli.ts:~488).
- `findInstance` (L47) works unchanged once `instanceAddress` is module-aware.
- `stateJson` (L59-86): emit `...(r.module ? {module: r.module} : {})` before `mode`. Real key order is `module, mode, type, name, provider, instances`.

### lab.ts
- `buildState` (L41-77) finds a resource by `x.mode===mode && x.type===s.type && x.name===s.name` (L45): add `module`.
- The dependency derivation (L59-75) keys ids by `${r.type}.${r.name}`: use the static resource address, `module.net.aws_vpc.main` (module keys stripped). Real tfstate `dependencies` entries are module-qualified without instance keys (?).
- `Lab` (L20-38) needs `modules` (registry catalogue, section 3) and `remoteStates` (section 6b).

### scenario.ts (TfState, L214-222; checkState, L581-597)
- Add `module: z.string().regex(MODULE_PATH).optional()` to the state entry.
- The duplicate-key string (L592) and the `known` set need the module.
- The `faults[].at` regex (L270) rejects `module.x.aws_y.z`. Extend it with an optional `(module\.[\w-]+(\[...\])?\.)*` prefix.
- The `evidence[].command` enum, `done_when`/`state_has`/`applied` strings and `plan_has.no_destroy` are free strings (I did not check each).

### addresses.ts (HCL `moved`/`import`/`removed`, 20 lines)
- `Address {type,name,key}`, `parseAddress(Expr)` accepts exactly a 2-segment ref or an `idx` over one. `module.net.aws_x.y` is rejected because `NOT_RESOURCES` includes `module`.
- New shape: `Address { module: ModStep[]; type; name; key? }` with `ModStep {name; key?}`. Parse by flattening the attr/idx chain: `module`, NAME, optional idx, repeat, then TYPE, NAME, optional idx. Also support module-only addresses (`module.a` or `module.a[0]`) for module-to-module moves; they have no type.
- Add `formatAddress(a)`. `moves.ts:15` (`fmt`) and `declarations.ts:83` duplicate this formatting through `instanceAddress`.

### moves.ts (143 lines)
- `step()` (L55-66) matches `m.from.type/name/key`. It needs the module path:
  - A resource move across modules is a type/name/key match plus a module prefix match.
  - A module move (`from=module.old, to=module.new`) is a prefix rewrite of any state resource whose `module` path starts with `from`.
- `applyMoves` (L68-143):
  - `groups` key `gk` (L103) must include `module`.
  - `place` creates a new group `{mode,type,name,...}` (L106): add `module`.
  - `todo` builds `from = {type,name,key}` (L118): add the module.
  - `oldAddr`/`newAddr` use `instanceAddress({mode,type,name})` (L120-121): add the module.
- Real Terraform also applies a `moved` block declared inside a child module relative to that module. Defer (section 5).

### declarations.ts
- `removedOf` rejects keys (L36). `importsOf` builds `key` through `instanceAddress` (L83) and de-duplicates on type/name/key (L84). Both need the module in the identity.
- The error text in moves.ts:31 ("resource instance addresses such as aws_instance.web...") stays valid.

### graph.ts (242 lines)
Key signatures to change:
- `GNode { address; kind; file; pos; block?; value?; refs; deps }`. Add `module: string` (static path with no keys, `''` for root, `module.net.module.sub` for nested) and `local: string` (address inside the module).
- `buildGraph(files)` becomes `buildGraph(tree: ModuleTree)`. Keep a `files` overload for the hundreds of existing tests.
- `put()` (L153), `PREFIX`, `DECL`: node address is `prefix + local`. `duplicate()` (L133) rebuilds type/name by splitting the address: pass the local address.
- `resolve()`/`missing()` (L107-129): resolve in module-local terms, then prefix. A `module.X` ref from inside module M gives want = `M.module.X`.
- The import-block pass (L181-192) builds `${addr.type}.${addr.name}`: make it module-aware (root only for now).
- Cycle diagnostic (L238): works unchanged with qualified names.
- Reachability: `blockRefs(b, out, top)` (L75) already skips `provider`/`providers`.

### plan.ts (568 lines), where most of the work is
- `PlanItem` (L30-46): add `module?: string` (instance path) and `resource: string`, the static resource address. Add `Drift.type/name/resource`.
- `val(k)`/`values` (L102-104): keys must be instance-qualified, `module.net[0].var.cidr`.
- `scopeFor` (L148-184):
  - Add a `mod` prefix parameter.
  - `var`/`local`/`data`/default (resource) read `val(mod + key)`.
  - Case `module` (L169) assembles outputs.
  - The `shapes` lookup (L173) uses the static key.
  - `path.module` (L161) should return the module's directory (e.g. `./modules/net`). Today it is `'.'`.
- `declared()` (L122) = `g.nodes.has(type.name)` and `show()` (L123) take an `Address` with a module. The moved/import/removed checks (L125-130, L366-372) need the module-qualified static address plus instance expansion.
- `planResource` (L191-303):
  - `protectedBy`/`touched` are keyed by `${type}.${name}` (L213, L294) and need the static address.
  - The `count` 0↔unkeyed shift (L228-236) builds `instanceAddress({mode,type,name})`: add the module.
  - Import decl matching (L238) compares type/name/key: add the module.
  - `dependsOn` is `resourceDeps(g.nodes,node)` and works on static node addresses as is.
- Main loop (L306-355): `case 'module'` replaces the error with module expansion. `variable` (L317-328) reads `input.vars` for root and the call argument for modules. `output` (L341) pushes to `result.outputs` only for root.
- Orphan destroys (L373-394): `r.mode!=='managed'` loop. `destroyReason` is `!g.nodes.has(type.name)` (L390): use the static module-qualified address plus a module-instance existence test. The removal check at L379 is by type/name: add the module.
- `-replace` warnings (L396-413): `shapes.has(a)`/`${i.type}.${i.name}===a` compare static addresses. A replace address with a module path is matched by instance address, which works with a module-aware `ADDRESS`.
- prevent_destroy (L418-437): `res()` = `type.name` becomes the static address, so skipped/failing sets and `g.order` ancestors work through module boundaries. A destroyed resource in a module with prevent_destroy then reports `Resource module.net.aws_x.y has lifecycle.prevent_destroy set` (real text uses the instance address, which `preventDestroyError(i.address)` already prints).
- `relevantDrift` (L540-568): `${i.type}.${i.name}` seeds, `${path[0]}.${path[1]}` ref keys, and `d.address.replace(/\[.*$/,'')` all break. The regex also eats module keys, e.g. `module.net["a"].aws_x.y`. Carry resolved static targets on `Ref`/`Drift`, not reparsed strings.
- `planDestroy` (L479-534): `res(r)`, `nodes.get(type.name)` and `instanceAddress(r,..)`: module-aware.
- Sorting `byInstance` (L75): compare `module` path first (shorter first), then type/name/key.

### refresh.ts
- Only `instanceAddress(r, inst.index_key)` (L30) and `...structuredClone(r)` (module is preserved). Fine once `instanceAddress` is module-aware. The drift key of `Drift.address` is the instance address.

### apply.ts (239 lines)
- `res(i)` (L47) = `type.name`, used for `failed`, `pickNext` dependency checks (L73, L83), `faultFor` (L133), `fail` (L147). It must be the static resource address (`module.net.aws_x.y`): `PlanItem.resource`.
- `addInstance` (L93-105) finds/creates the StateResource by type/name: add `item.module`.
- `removeInstance` (L87) uses `instanceAddress` (fine).
- The context string at L146 (`resource "t" "n"`) stays the same as real Terraform.
- Fault `at` match (L133): `f.at === i.address || f.at === res(i)`. With modules, a fault on `module.net.aws_x.y` should match all module instances: static compare works.

### predicates.ts
- `covers(given, actual)` (L26) is a string-prefix test on `[`. For modules, `given = module.net.aws_x.y` must cover `module.net["a"].aws_x.y`, and `given = module.net` must cover everything under it. Parse both addresses and compare segments (the same parser as state-ops). `applied` history lines (`"OP ADDRESS"`, written at cli.ts:599) use instance addresses and work after the change. `listAddresses` in `state_has/state_lacks` works.

### state-ops.ts (162 lines)
- `ADDRESS` (L13) and `parseAddress(text)` (L16): rewrite with a module prefix group. `Parsed` gains `module?: string` (the instance path text). Whole-module addresses (`module.net`, `module.net[0]`) must parse as `{kind:'module'}` for `state mv/rm/list`. `NOT_RESOURCES` is checked on the type only.
- `sameResource` (L30): add module. `stateMove` (L33-83):
  - Moving across module paths is legal, e.g. `aws_vpc.main` → `module.net.aws_vpc.main`.
  - A module-to-module move rewrites the `module` of every matching StateResource (real TF supports `terraform state mv module.a module.b`).
  - The "oldBase/newBase" dependency rewrite at L77-81 maps static addresses, so it needs the static module-qualified form.
- `stateRemove` (L85): `terraform state rm module.net` removes everything under the module (real TF does).
- `withInstance` (taint/untaint, L103) → `findInstance(s, instanceAddress(a, a.key))`: add the module.
- `importObject` (L139): `declared` is computed by cli.ts:710 as a block with matching type/name. For `module.net.aws_x.y` it needs the module tree. The real "does not exist in the configuration" text mentions the module: `Resource address "module.net.aws_x.y" does not exist in the configuration.` and the example block says `Before importing this resource, please create its configuration in module.net. For example:` (?). Check against `internal/command/import.go`.

### cli.ts (960 lines)
- `ADDRESS` (L115) is a different, looser regex from state-ops' (no escapes, no module). Used at L446 (`-replace`), L761 (`state list`) and L773 (`state show`). Replace with one exported matcher from state-ops/addresses.
- `cmdStateMv` (L648), `cmdStateRm` (L665), `cmdTaint` (L683), `cmdImport` (L700):
  - `declared` (L710) and keyed-import `planConfig` check (L713-717) need the module path.
  - `kind` of `t.type` at L723 for the "Prepared X for import" line works with module-aware Parsed.
- `state list ADDR` (L752-770): `matches()` (L755) is a string-prefix test; fine for module prefixes (`module.net` matches `module.net.aws_x.y`). Module instance keys need `a.startsWith(w+'[')`, which is already there. L761 already allows a `module.` prefix.
- `refreshLines` (L484-495): one line per state instance; sorted by string. Needs the proper comparator. Real module resources print their full address, e.g. `module.net.aws_vpc.main: Refreshing state... [id=vpc-0abc]`.
- `worldPlan` (L476), `makePlan` (L497), `cmdImport`, `cmdApply` (L577) all pass `files: cfg.tf`. These become `tree: cfg.tree`. SavedPlan (lab.ts:10) stores `files`: store the tree.
- `sourcesOf(cfg.tf)` (L125, used for rendering snippets) is keyed by `f.name`: use the lab-relative path for every module file, so diagnostics read `on modules/net/main.tf line 3`.

### views.ts / render.ts / render-apply.ts
- `views.ts:42-44` `stateShow` prints `# ${addr}:` with the instance address, then `resource "type" "name" {` (real TF does the same: module-qualified header, unqualified block line). OK after `instanceAddress`.
- `render.ts:17,53` header uses `item.address` (fine) and the destroy reason `${item.type}.${item.name} is not in configuration`. Real (jsonformat/plan.go:433,442): `(because aws_x.y is not in configuration)` when the resource is gone but the module remains, and `(because module.net is not in configuration)` (ModuleAddress, instance-qualified) when the module instance itself is gone. New `destroyReason: 'module-gone'` carrying `item.module`.
- `render.ts:105,115,125` `driftBlock` splits `d.address` on `.` after stripping `[...]`: breaks for modules. Use `Drift.type/name`.
- `outputsText` prints root outputs only. Unchanged.

### layout.ts
- Add helpers: `modulesDir = '.terraform/modules'`, `modulesJson(manifest)`, and extend the mount to write `.terraform/modules/modules.json` (and registry module files) when the scenario is `initialized`. `paths.ts` is the eagerly loaded consumer, so layout.ts must stay dependency-free: author the manifest in the scenario (section 3), do not derive it by parsing HCL.

### lab.ts / shell.ts
- `shell.ts:299` `listFiles(dir)` lists one directory; the loader will call it per module directory (local modules) and once for `.terraform/modules`. No change except that it must handle a missing dir (it already `catch`es to `[]`).
- `ctx.write(dir, name, text)` (shell.ts:312) does `mkdir -p dir` then writes `dir/name`: usable for module files if called per directory.

## 2. Recommended architecture

### Choice: (A) a flattened, statically qualified graph, with a module-instance dimension handled by a key prefix in the evaluator

(B) Recursive evaluation per module instance (calling `planConfig` per child with its own `values`) fits `count`/`for_each` and scoping naturally but loses on:
1. The global dependency order. Real Terraform interleaves parent/child nodes. A module as a super-node produces false cycles (A → module.x → B where B only uses one output) and wrong `dependsOn` for apply ordering. `PlanItem.dependsOn` (resource addresses) is what `apply.pickNext` uses, so it must follow real edges across module boundaries.
2. The existing post-walk machinery (orphans, `consumed`, `touched`, `protectedBy`, prevent_destroy `skipped`, relevantDrift) assumes one flat items list and one graph. B forces merging results from N sub-plans.
3. The one-shot `errors` list with `broken` propagation (L305-355) would need re-threading.

A keeps one walk over `g.order`. Concrete mechanics:

1. **Graph.** Every object inside a module gets a static address `module.net.aws_vpc.main`, `module.net.var.cidr`, `module.net.local.x`, `module.net.output.vpc_id`, `module.net.data.aws_x.y`. The call is a node `module.net` (kind `module`).
   - Edges:
     - `module.net` depends on whatever its own block refers to: `count`, `for_each`, `depends_on`, and argument values that are not mapped to variables (all via `blockRefs` as today, resolved in the parent's namespace).
     - `module.net.var.X` depends on the call node and on the refs in the call's argument `X` (resolved in the parent's namespace). If the variable has no argument it uses its `default` (own refs in the child namespace).
     - Every other node inside the module also depends on the call node, to guarantee expansion first.
     - A parent ref to `module.net.out` (path `['module','net','out']`) or `module.net[...]...` depends on all `module.net.output.*` nodes; a ref `module.net.out` only on that output. Dependencies through `resourceDeps` then traverse var/output/module nodes to the real resources, as today (L451-465).
   - A cycle through modules is found by the same Kahn sort (graph.ts:207-240). The existing message `Cycle: a, b` stays valid (real Terraform labels some nodes `(expand)`, minor (?)).
2. **Instances.** Add `modInst: Map<staticModulePath, string[]>` (instance prefixes: `module.net[0].`, `module.net["a"].module.sub.`).
   - Root has `['']`.
   - Handling the call node: for each parent instance prefix `P`, call `expandInstances(callBlock, scopeFor({mod:P}))` (`expand.ts` takes a Block and works unchanged, including all count/for_each error text). Set `shapes` and `modInst`.
   - Nested modules multiply: child instances = parents × keys.
3. **Values.** Every node's value is stored under an instance-qualified key. Nodes inside a module are processed once per instance prefix of their `node.module`. A resource inside `module.net` with `count=2` inside the call `for_each={a,b}` produces `module.net["a"].aws_x.y[0]` and so on.
4. **Scope.** `scopeFor(ctx)` gets `mod: string`.
   - `var.X` → `val(mod + 'var.X')`.
   - `local.X` → `val(mod + 'local.X')`.
   - `data.T.N` and resources → `val(mod + addr)`.
   - `module.N` → assemble from `modInst.get(staticOf(mod)+'module.N')`: object of outputs (single), array (count), map (for_each). Unknown or failed outputs yield UNKNOWN, which then propagates as everywhere else.
   - `each`/`count` come from the nearest enclosing ctx. A module's own `each.key` is only legal in the call block's arguments, which are evaluated in the parent scope with that module instance's key, so the variable node evaluates its argument with `scopeFor({mod: parentPrefix, each, count})`. That is the one non-obvious step.
   - `path.module` returns the module's source directory.
   - `terraform.workspace` is unchanged.
5. **Variables.** `variable` node (plan.ts:317): for root, `input.vars`/default as now. For a module variable: evaluate the call argument if present, else the default, else the real error:
   ```
   Error: Missing required argument
     on main.tf line 5, in module "net":
   The argument "cidr" is required, but no definition was found.
   ```
   Real Terraform reports missing/unknown arguments at config load (validate and plan before anything runs), not mid-walk. Check these in a pre-pass over each module call. The unknown-argument text is `Unsupported argument ... An argument named "foo" is not expected here.` Type conversion via the variable `type` is NOT done today for root either (cli.ts `convertTo` is cli-side); defer module type constraints.
6. **Outputs.** `output` nodes inside a module store a value only (not in `result.outputs`). Root outputs behave as today. `sensitive` propagation is deferred.
7. **Errors and positions.** `GNode.file` is the lab-relative path of the module file. `fail(node.file, pos, ...)` then gives `on modules/net/main.tf line 3, in resource "aws_vpc" "main":`. `diag.ts:30` already prints `on FILE line N, in CONTEXT`. Only the `sources` map in `cli.ts:125` must contain every module file by lab-relative path. Registry-installed files show as `.terraform/modules/network/main.tf`, matching real Terraform.
8. **Plan ordering.** `byInstance` sorts by module path (shorter first, then name, then key), then type, name and key. Real plan output is graph-ordered in practice; this repo already approximates it with a sort (`plan.ts:72-77`), so keep that.
9. **Unknowns.** Known-after-apply values flow through var → resource arg → planned object → output → parent resource as `UNKNOWN` exactly as through locals today. A module `count`/`for_each` that is unknown gives the existing `Invalid count argument` text, which is what real Terraform prints for modules too (?).
10. **Destroy/orphans.** A state resource's `module` string is split into steps; its static form is looked up in the graph. If the call node is missing or a step's key is not in `modInst`, `destroyReason='module-gone'`. Otherwise existing logic applies.
11. **`count`/`for_each` toggles on a module call** (`module.net` ↔ `module.net[0]`) behave as for resources (plan.ts:228-236). Real Terraform handles it automatically for modules since 1.1 (?).
12. **providers.** `providers = {...}` on a call is ignored (already skipped in `blockRefs`). Passing provider aliases is deferred; the lab has one provider config.

Risk in A: the instance dimension touches every `values`/`shapes`/`touched` access. Keep the change mechanical: wrap in two helpers `key(mod, addr)` and `staticOf(prefix)`.

## 3. Module sources, loader, init, error text

### Representation
```ts
interface ModuleSource { key: string; callPath: string[]; source: string; version?: string; dir: string; files: File[] }
type ModuleTree = { files: File[]; calls: Map<string /*static path*/, ModuleSource>; missing: Diagnostic[] }
```
`File.name` is always the lab-relative path (`main.tf`, `modules/net/main.tf`, `.terraform/modules/network/main.tf`).

### Scenario schema proposal (`terraform.modules`)
```yaml
terraform:
  files: [ ... root and local module files, e.g. modules/net/main.tf ... ]
  initialized: true            # existing; now also implies modules are installed
  modules:
    registry:                  # authored, offline "registry.terraform.io"
      - source: acme/network/aws        # normalised to registry.terraform.io/acme/network/aws
        versions:
          "2.0.1": { files: [{ path: main.tf, content: "..." }, { path: variables.tf, content: "..." }] }
          "2.1.0": { files: [ ... ] }
    installed:                 # what .terraform/modules/modules.json holds when the scenario starts
      - { key: network, source: acme/network/aws, version: "2.0.1" }   # registry
      - { key: net, source: ./modules/net }                             # local; Dir = source
```
- Zod: `strictObject`, versions must be semver, files paths relative with no `..`, `installed[].version` must exist in `registry`. A scenario that is `initialized` with module calls must list them in `installed` (or `validate` errors with `Module not installed`). The content test should run `terraform validate` over every initialized scenario to catch authoring omissions.
- Mounting: `paths.ts` writes (a) `.terraform/modules/modules.json`, (b) `.terraform/modules/<key>/<path>` for each installed registry module at the installed version. That uses only the scenario data, so `paths.ts` stays parser-free.
- `modules.json` format (modsdir/manifest.go: `Key`, `Source`, `Version`, `Dir`, root record `{Key:"", Source:"", Dir:"."}`):
  ```json
  {"Modules":[{"Key":"","Source":"","Dir":"."},{"Key":"net","Source":"./modules/net","Dir":"modules/net"},{"Key":"network","Source":"registry.terraform.io/acme/network/aws","Version":"2.0.1","Dir":".terraform/modules/network"}]}
  ```
  Nested keys are dot-joined (`network.subnets`), per `Manifest.ModuleKey`.

### loadConfig changes (cli.ts:160)
1. List the lab dir; `tf` = `*.tf` at root (as today), plus `.terraform/modules/modules.json` via `ctx.readFile`.
2. Parse root with `parseHcl` (only the call blocks are needed: `source`, `version`, `count`...). Walk module calls depth-first. For each call, compute the key (dot-joined path), look it up in the manifest, and read its `Dir` with `ctx.listFiles(Dir)`, prefixing `File.name` with `Dir/`. Local-source `Dir` is the call source resolved against the parent module's Dir (`./modules/net` → `modules/net`; nested `../x` resolved by `resolvePath`). Reject any path escaping the lab dir (real TF: `Local module path escapes module package`).
3. The checks mirror configload `moduleWalkerLoad` (verified, loader_load.go:65-135):
   - Not in manifest → `Error: Module not installed` / `This module is not yet installed. Run "terraform init" to install all modules required by this configuration.` at the call range, rendered `on main.tf line 3, in module "net":` (context text `module "net"`).
   - Manifest `Source` ≠ call source → `Module source has changed` / `The source address was changed since this module was installed. Run "terraform init" to install all modules required by this configuration.`
   - Installed version fails the constraint → `Module version requirements have changed` / `The version requirements have changed since this module was installed and the installed version (2.0.1) is no longer acceptable. Run "terraform init" to install all modules required by this configuration.` If there is a constraint but no recorded version, use the variant without `(x)`.
   - Cache dir unreadable → `Module not installed` / `This module's local cache directory .terraform/modules/network could not be read. Run "terraform init" to install all modules required by this configuration.`
4. Where these appear: `validate`, `plan`, `apply`, `import`, `refresh`, `state` commands that load config. They happen at config load, before the lock check and before variable resolution. In `prepare` (cli.ts:462) put them with `g.diagnostics` (they stop everything). `init` and `get` are the commands that fix them.
5. `Config` gains `tree`, and `tf` stays for root files so existing callers and tests compile. `worldPlan` (cli.ts:476) must load the same tree (done_when predicates).

### `terraform init` output (init.go:336-394, hook_module_install.go)
Order: `Initializing modules...` comes first (before `Initializing the backend...`). It is printed only when the root has at least one module call. Lines from the install hooks:
- Local module: `- net in modules/net`.
- Registry module first install: `Downloading registry.terraform.io/acme/network/aws 2.1.0 for network...` then `- network in .terraform/modules/network`.
- Already installed and still satisfying the constraint: only the `- network in .terraform/modules/network` line (hooks.Install is called, Download is not).
- Nested keys: `- network.subnets in .terraform/modules/network/modules/subnets` (the local-dir form, ?).
- `init -upgrade` prints `Upgrading modules...` instead of `Initializing modules...` and re-resolves registry versions to the newest matching.
- Errors from installation (module_install.go): `Module not found` / `Module "x" (from main.tf:3) cannot be found in the module registry at registry.terraform.io.` ; `Unresolvable module version constraint` / `There is no available version of module "acme/network/aws" (main.tf:3) which matches the given version constraint. The newest available version is 3.0.0.` ; `Module has no versions` ; `Invalid version constraint`. The current `cmdInit` (cli.ts:224-268) would add a module-install step before the provider step, update `modules.json` with `ctx.write('.terraform/modules','modules.json',...)` and write registry files per directory.
- Existing trailing text ("If you ever set or change modules...", cli.ts:263-265) is already present.
- `terraform get` (internal/command/get.go): same install with `ShowLocalPaths: true` and no `Initializing modules...` header; `-update` = upgrade. `get` is in the help list (cli.ts:78) but currently falls to `notYet`; add a small `cmdGet`.
- Registry resolution uses the scenario's `modules.registry`: pick the highest version satisfying `version`, then copy files. If `version` is omitted, pick the newest. A semver constraint matcher is needed: `=`, `!=`, `>`, `>=`, `<`, `<=`, `~>`, comma-separated AND (about 50 lines; shared with the provider work in 6a).

### Interaction with the lock file
Registry modules can contain `required_providers` in the child. Provider constraints from the whole tree are merged for the lock check (see 6a); defer unless the incident needs it.

## 4. State and tfstate

- Resources in modules: `StateResource.module` (instance-qualified, e.g. `module.net["a"]`).
- `state list` shows the full address (`module.net.aws_vpc.main`); `state list module.net` lists all under it (matches() works); `state show module.net.aws_vpc.main` works once `ADDRESS` accepts the module prefix.
- `state mv`:
  - Resource into a module: `state mv aws_vpc.main module.net.aws_vpc.main` (the "refactor without moved block" fix). The move must create the target StateResource with `module` set, preserving `provider`.
  - Resource between instances of a module, and module rename (`state mv module.old module.new`).
  - Errors: wording for the module forms of "Cannot move to X: there is already a resource instance at that address" stays; the "resource types must match" check applies to the resource part.
- `state rm module.net` removes every resource instance in the module; `Removed module.net.aws_x.y` lines per instance, then `Successfully removed N resource instance(s).`
- `taint/untaint module.net.aws_x.y`, `-replace="module.net.aws_x.y"` (cli `parsePlanFlags` accepts the new matcher) and `terraform import module.net.aws_x.y id` work after the address change. Import into a module needs the call to be in config: if `module.net` is not declared the real error is `Resource address "module.net.aws_x.y" does not exist in the configuration.` Detail names the module (?).
- `moved` blocks: the root-module `moved { from = aws_vpc.main  to = module.net.aws_vpc.main }` is the natural refactor fix. With `from`/`to` module-qualified the plan shows `# aws_vpc.main has moved to module.net.aws_vpc.main` (`render.ts:46-57` uses `movedFrom`, which holds the old instance address). `moved` inside a child module (relative addresses, as a registry module author would ship across a version bump) is a second step.
- `terraform_version`/`lineage`/`serial` unchanged.
- `refresh`: no changes except address text.
- tfstate `dependencies` for module resources: static module-qualified addresses (?).

## 5. Task breakdown (dependency order)

Each task is independently testable and reviewable; the repo's style is a test file per task (`tests/terraform-*.test.ts`).

| # | Task | Core files | Tests | Difficulty / risk |
|---|------|-----------|-------|-------------------|
| T1 | Address model. Shared `ResAddr` parser/formatter (module steps, keys, module-only); `StateResource.module`; `instanceAddress`, `findInstance`, comparator for list/sort; `stateJson`; scenario `state[].module`, lab `buildState`; `state list/show/mv/rm/taint/untaint` with module addresses on a hand-written state | state.ts, addresses.ts, state-ops.ts, lab.ts, scenario.ts, views.ts, cli.ts (state commands, `-replace` regex) | State-only tests: no config needed. | Medium. Mechanical but wide. Refactor existing `sameResource`/`ADDRESS` first with no behaviour change (the existing suite must stay green). |
| T2 | Loader, manifest, `init`/`get`, `Module not installed` family; local sources only; `terraform.modules.installed` + mounting `modules.json` | cli.ts (loadConfig, cmdInit, cmdGet, prepare), layout.ts, paths.ts, scenario.ts | CLI tests: init output lines, not-installed errors, source-changed. Does not need graph support if the tree is only loaded and not planned (plan still says Unsupported module until T4). | Medium. |
| T3 | Graph flattening: `ModuleTree` input, qualified nodes, module variable/output/call nodes, resolve with prefixes, per-module duplicate and undeclared-reference text, missing/unsupported-argument checks, cycle across modules | graph.ts, plan.ts (types only) | graph tests: nodes, deps, order, diagnostics with `modules/net/main.tf` positions. | High: keystone. Keep `buildGraph(files)` for old tests. |
| T4 | Plan evaluation: `modInst`, instance-qualified `values`, scopeFor `mod`, module outputs, `count`/`for_each` on module calls, nested modules, orphan destroy with `module-gone` reason, `PlanItem.module/resource`, sort, relevantDrift/Drift fields, prevent_destroy in module, render changes | plan.ts, render.ts, expand.ts (none), apply.ts (`res`, `addInstance`), refresh/predicates | plan tests incl. "refactor into module without moved = destroy + create" and the count/for_each cases; apply tests with module resources and faults on module addresses. | High. Largest task; can split T4a (single instance, no count) / T4b (count, for_each, nested, orphan reason). |
| T5 | `moved` / `import` / `removed` with module addresses: `Address.module`, `step()` prefix rewrite, module-to-module moves, import `to = module.net.aws_x.y`, `cli import` declared check, `removed` from module | moves.ts, declarations.ts, plan.ts (checks), state-ops importObject | extend moves/declarations tests. | Medium. |
| T6 | Registry modules and versions: semver constraint matcher, scenario `modules.registry`, `init` download lines, `init -upgrade`, `Unresolvable module version constraint`, `Module version requirements have changed`, installation of files to `.terraform/modules/<key>` | cli.ts, layout.ts, new `versions.ts` (shared with 6a), scenario.ts, paths.ts | init tests; plan after upgrade shows forced replacement from the new module code. | Medium. The semver matcher is small. |
| T7 | Content: incident A (refactor into module: destroy/create, fix with `moved` block or `state mv`), incident B (module version upgrade changes a `ForceNew` argument; fix by pinning `version`, `init`, or `ignore_changes`/adjusting input), incident C (module `prevent_destroy` blocks; `-replace` / `taint` with module address) | content/iac/*.yaml, tests | Incident tests that resolve through the UI (existing pattern, e.g. terraform-sg-cycle). | Low-medium. |
| T8 | Polish: `path.module`, `terraform validate` for modules, cycle formatting, sensitive outputs, `terraform output` of module values? (root only), `terraform providers` (not simulated today) | various | | Low. |

### Minimal first milestone
T1 + T2 (local) + T3 + T4a + `moved` with a module `to` address (the single-instance part of T5). It delivers the refactor incident: after moving `aws_vpc.main` into `module.net` the plan shows destroy of `aws_vpc.main` (reason `aws_vpc.main is not in configuration`) and create of `module.net.aws_vpc.main`; fixes are `moved` or `state mv`. The version-upgrade incident additionally needs T6 (the minimum: exact and `~>` constraints plus authored registry versions plus `init -upgrade`). A cheaper stand-in before T6: a local module whose `source` string changes does not teach versions, so do not substitute.

### Defer
`providers = {}` / alias passing; module `depends_on` beyond ordinary refs; `moved` blocks inside child modules; `import` blocks inside child modules (illegal in real TF anyway); `removed { from = module.x }` (works in 1.7+, add with T5 if cheap); module output `sensitive` propagation; variable `type`/`validation`/`optional()` on module inputs; `-target module.x`; git/S3/HTTP sources (not offline); `terraform providers`/`graph`/`console`; `terraform test` runs of modules; test of lock-file hashes; `for_each` on module with unknown keys (just emit the existing error).

## 6. Feasibility notes

### (a) Provider version constraints vs lock file, `required_version`
Exists: the lock file is written as `provider "registry.terraform.io/hashicorp/aws" { version = "5.67.0"  hashes = [...] }` with no `constraints` line (layout.ts:18-22); `lockedProviders` reads provider names only (cli.ts:182); `lockError` (cli.ts:187-200) already produces the "no version is selected" form of `Inconsistent dependency lock file`. Nothing reads `terraform { required_providers { aws = { source, version } } }` or `required_version` (the scenario YAML already has `required_providers` text in 3 content files, only as dead HCL: content/iac/terraform-forgotten-taint.yaml:143, terraform-state-lost.yaml:117, terraform-count-to-for-each.yaml:275).
Must add:
1. Parse `terraform {}` blocks across the module tree (`parse.ts` already yields them as Blocks; `required_providers` is a nested block whose attrs are object literals; check `Expr` `obj` handling of `{source=..., version=...}`).
2. Shared semver constraint matcher (also used by T6).
3. Lock file with `constraints = "~> 5.0"` and per-lab version: scenario `terraform.providers: { aws: { lock: "5.31.0", available: ["5.31.0","5.50.0","5.67.0"] } }` replacing the global `PROVIDER_VERSION`. `Lab.version`/`cmdVersion` (cli.ts:218) print it.
4. Checks (verified texts, v1.9.8):
   - Plan/apply/validate, when the lock selection violates constraints (backend/local/backend_local.go:150-175, config.go:320-322): `Error: Inconsistent dependency lock file` / `The following dependency selections recorded in the lock file are inconsistent with the current configuration:\n  - provider registry.terraform.io/hashicorp/aws: locked version selection 5.31.0 doesn't match the updated version constraints "~> 5.50"\n\nTo update the locked dependency selections to match a changed configuration, run:\n  terraform init -upgrade`. If the lock's `constraints` line equals the current constraints the entry reads `version constraints "~> 5.50" don't match the locked version selection 5.31.0`. If the lock has no entry the suggestion is `terraform init` (the current form).
   - `init` with a lock pinning an old version: the provider installer fails with `locked provider registry.terraform.io/hashicorp/aws 5.31.0 does not match configured version constraint ~> 5.50; must use terraform init -upgrade to allow selection of new versions` (providercache/installer.go:253), wrapped by init as `Failed to query available provider packages` / `Could not retrieve the list of available versions for provider hashicorp/aws: <that error>` (init.go:621-641; the exact wrapper text/suggestion lines are (?)).
   - `init -upgrade`: choose the newest available satisfying version, rewrite the lock (version, constraints, new hash).
   - `init -lockfile=readonly` (init.go:855-910): with a change in providers: `Error: Provider dependency changes detected` / `Changes to the required provider dependencies were detected, but the lock file is read-only. To use and record these requirements, run "terraform init" without the "-lockfile=readonly" flag.`; `-upgrade` with it: `The -upgrade flag conflicts with -lockfile=readonly.`
   - `required_version`: `Error: Unsupported Terraform Core version` / `This configuration does not support Terraform version 1.9.8. To proceed, either choose another supported Terraform version or update this version constraint. Version constraints are normally set for good reason, so updating the constraint may lead to other errors or unexpected behavior.` at the `required_version` attribute (config/module.go:725-745); for a child module: `Module module.network (from registry.terraform.io/acme/network/aws) does not support Terraform version 1.9.8. ...`. It is raised at config load, so for `init`, `validate`, `plan` etc. `Lab.version` is the version compared.
   Difficulty: medium. Works naturally on top of the module tree because required_providers/required_version must be collected from all modules (this is exactly the "module upgrade bumps provider constraint" incident).

### (b) `data "terraform_remote_state"`
Today `data` nodes read only from `base.resources` (plan.ts:332-336) and `schemaFor` has no such type (`validate` would say `Invalid resource type`, cli.ts:278). To add:
- Scenario: `terraform.remote_states: { "<name or bucket/key>": { outputs: {...}, workspace?: ... } }` keyed by `backend-config.bucket + '/' + config.key` (so a wrong `key = ...` in the config gives the "unable to find" failure), or simply by `config.key`.
- Evaluation in the `data` case: if `type === 'terraform_remote_state'`, evaluate the `backend` attr (string) and `config` attr (object `{ bucket, key, region }`), look up the authored remote state, and set the value to `{ backend, config, outputs, workspace: 'default', defaults: null }` (so `data.terraform_remote_state.net.outputs.vpc_id` resolves through `walk()`). A missing output then fails with the existing `Unsupported attribute` error text (`This object does not have an attribute named "vpc_id".` from `eval.ts attribute()`), which matches real Terraform because `outputs` is an object value (?). If no remote state is found, the builtin provider's error is `Unable to find remote state` / `No stored state was found for the given workspace in the given backend.` (?: check terraform_remote_state.go in internal/builtin/providers/terraform). Unknown `bucket` values (known after apply) defer the read: plan prints the data as `known after apply` and downstream values are UNKNOWN.
- Refresh lines print `data.terraform_remote_state.net: Reading...` / `Read complete after 0s` already (cli.ts:~490 handles `mode==='data'`), no schema needed except to avoid the `Invalid resource type` check (cli.ts:273-286). Add `terraform_remote_state` to `unsupportedType`/validate skip. Remote-state data should be added to state in apply; the data case should write a state data resource (real Terraform records it).
- Difficulty: low-medium; independent of modules; data inside modules works via the same `mod` prefix.

## 7. Open questions / uncertainty

1. Exact order of `state list` and `plan` for module resources: derived from `Less` (module path first, shorter path first), good confidence for state list/plan sort; actual plan output order is graph-walk order in real Terraform, which this repo already approximates by sort.
2. Real `dependencies` in tfstate for module resources and the `(expand)` suffix in cycle errors: not verified.
3. The import-into-module error wording: not verified; check `internal/command/import.go`.
4. Whether `Initializing modules...` text is bold-coloured in the lab output: the existing init strings in cli.ts:224+ show no ANSI codes, so follow that.
5. HCL parse of `module.net["a"].x`: relies on `idx` then `attr` chains evaluating via `eval.ts` `attribute`/`index`; existing tests cover resources the same way, but a quick unit test for module refs should be the first test in T3.
6. Existing tests (~30 terraform-*.test.ts files) call `buildGraph(files)`/`planConfig({files...})` directly; keep a `files` compatibility path so T3 does not need a mass test rewrite.
