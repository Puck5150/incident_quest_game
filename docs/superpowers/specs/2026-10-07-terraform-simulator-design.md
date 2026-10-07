# Terraform simulator and troubleshooting incidents: design

Date: 2026-10-07. Branch: `devops-sim`.

## Goal

Teach real-world Terraform troubleshooting (state, drift, failed deployments, config and module
problems, destroy problems) with as much realism as is practical. The player types real
`terraform` commands and edits real `.tf` text in the terminal, and the output follows from the
files, the state and the simulated cloud. Output is not hand-scripted per incident.

Same sim principles as the rest of the game: realistic but fair, facts sourced from the Terraform
docs, no invented data that could mislead a diagnosis, action buttons kept as an accessible
fallback.

## Context

- The `iac` track has 9 Terraform incidents (state lock, drift, import, `moved`, count-index shift,
  forces-replacement, `ignore_changes`, secrets in state, wrong workspace). They use scripted
  `terraform plan`/`apply` output with `when_actions` switching the text after a fix.
- `terraform` is already a custom command in `src/game/shell.ts` (`TOOLS`), answering from scripted
  commands. Files on disk, hosts, `ssh`, nano/vi and file-edit fixes exist (PLAN_TERMINAL.md T1-T5).
- `content/commands/terraform.yaml` holds the command breakdowns.

## Decisions (from brainstorming)

1. Scope: all four gap clusters. State recovery, failed applies, config and modules, destroy
   problems.
2. Engine: a real Terraform simulator, not scripted output.
3. Config: a real HCL-subset parser. The player edits actual `.tf` text.
4. Providers: AWS first, then Azure, then GCP, as incidents need them.

## Architecture

New module `src/game/terraform/`, lazy-loaded with the shell chunk, no UI. Four units, each
testable alone:

- `hcl.ts` parses a subset of HCL into an AST.
  - Blocks: `terraform`, `provider`, `resource`, `data`, `variable`, `locals`, `output`, `module`,
    `moved`, `import`, `removed`.
  - `lifecycle`: `prevent_destroy`, `ignore_changes`, `create_before_destroy`,
    `replace_triggered_by`.
  - Expressions: literals, references, `count`/`for_each`/`each.*`/`count.index`, `var.*`,
    `local.*`, string interpolation, and a function allowlist (`lookup`, `merge`, `format`,
    `toset`, `cidrsubnet`, ...).
  - Anything else gives `Error: Unsupported ...`, never a crash. Syntax errors give the line and
    column.
- `graph.ts` resolves references into a dependency graph, detects cycles (`Error: Cycle:`).
- `engine.ts` computes config + state + reality into a plan, and applies it.
- `cli.ts` implements the commands: `init`, `validate`, `fmt`, `plan` (`-refresh-only`, `-out`,
  `-target`, `-replace`, `-var`), `apply`, `destroy`, `import`, `state list/show/mv/rm/pull`,
  `taint`/`untaint`, `force-unlock`, `workspace new/select/list/show`, `output`, `show`, `version`.

## Three worlds

| World | What it is | Where it lives |
|---|---|---|
| Config | The `.tf`/`.tfvars` files, parsed fresh on every command | The player's simulated disk |
| State | Terraform's recorded view, real tfstate JSON shape (`version`, `serial`, `lineage`, resources, instances) | Local file or a remote backend with a lock |
| Reality | The simulated cloud: map of resource type + id to attributes | Seeded by the author, mutated by apply |

Drift is reality differing from state. Out-of-band changes are authored directly into `reality`.

## Plan algorithm

1. Refresh each state resource from reality. Gone: removed from the plan view. Changed: recorded as
   drift. `-refresh-only` stops here.
2. Evaluate config into desired instances, expanding `count` and `for_each`.
3. Apply `moved`, `import` and `removed` blocks.
4. Diff by address. In config only: create. In state only: destroy. In both: compare attributes. A
   changed attribute marked `forces_replacement` in the resource schema gives replace (`-/+`, with
   `# forces replacement`); any other change is an in-place update (`~`).
5. Enforce `ignore_changes` and `prevent_destroy` (the real `Instance cannot be destroyed` error).
6. Render in the real CLI format, including `(known after apply)`, `(sensitive value)`, hidden
   attribute counts and the `Plan: X to add, Y to change, Z to destroy.` summary.

## Apply

Walks the graph in dependency order, one resource at a time. Each step changes reality and state,
or fails from an authored fault. A failure stops the run and leaves state holding what was done so
far, so the next `plan` shows what is left (the real partial-apply experience). The state lock is
held during apply, and a crashed run leaves it held (`force-unlock` scenarios).

Faults: `AccessDenied`, `LimitExceeded`, `AlreadyExists`, `DependencyViolation` and similar, each
with its real message text, triggered by an address, an action, or a nth apply.

## Resource schemas

A shared library of resource types with `forces_replacement`, `computed`, `sensitive` and provider
default values. Incidents can extend it. AWS types first; Azure and GCP types are added as
incidents need them. A type not in the library gives `Error: Unsupported resource type` plus a one
line note that this lab does not model it.

## Incident authoring

An incident gains an optional `terraform:` block. Everything else (ticket, hypotheses, hints,
debrief, sources) is unchanged. The block holds:

- `files`: starting `.tf` and `.tfvars` text.
- `state`: compact starting state, expanded to tfstate JSON by the sim.
- `reality`: the cloud as it actually is, including drift.
- `backend`: local or remote, lock state and holder.
- `faults`: scripted API failures.
- `env`: workspace, Terraform version, `TF_VAR_*`, and whether `.terraform.lock.hcl` matches.

Authors write real HCL and the real state shape. They do not write plan output.

## Fixes and scoring

A fix action gets a `done_when` predicate checked against the simulated world after every command
and file save:

- `plan_clean`, or `plan_has: { no_destroy: [address] }`
- `state_has` / `state_lacks: address`
- `lock_free`
- `reality_has: { type, id, attr: value }`
- `file_contains`

Any route that produces the outcome counts: a `moved` block, `terraform state mv`, or a `removed`
block plus an import can all satisfy "the database is not destroyed". The action buttons stay as
an accessible fallback and apply the same change.

Wrong fixes have real consequences. Applying a destructive plan removes the resource from
`reality` and counts as a mistake in the existing scoring. Good practice is rewarded: running
`plan` before `apply`, saving a plan with `-out`, checking the workspace. Evidence attaches to
observed outcomes (ran `state show` on the instance, saw the `forces replacement` line) and reuses
the existing `key_evidence` flow.

## Errors and honesty

- Real error shapes with the formats in the Terraform docs: `Error: Invalid reference`,
  `Error: Unsupported argument`, `Error acquiring the state lock` (with the Lock Info block),
  `Error: Cycle:`, `Error: Missing required provider`, `Error: Inconsistent dependency lock file`,
  `Error: Instance cannot be destroyed`.
- Where the docs do not print exact text, log it in `CONTENT_TODO.md`.
- Anything outside the HCL subset or resource library gives `Error: Unsupported ...` and a one-line
  note. The sim never invents behavior.
- Nothing leaves the sim: no network, no credentials, no real Terraform binary.

## Testing

- Parser: table-driven valid and invalid HCL, with line and column in errors.
- Engine: golden plan and apply output for each failure class (replace, drift, move, import,
  cycle, partial apply, lock).
- Every incident has an ideal-path test (real commands and edits reach resolved) and a wrong-path
  test (e.g. applying the destructive plan has the consequence).
- `npm test` content validation checks the `terraform:` block (files parse, addresses resolve,
  fixes reachable).
- All existing tests keep passing. The 9 current Terraform incidents stay on scripted output until
  they are migrated at the end.

## Build order

Each step is its own plan and commit cycle.

1. TF1: HCL parser and graph, no UI.
2. TF2: state, plan and render engine; `terraform` wired into the shell.
3. TF3: apply, faults, locks, state subcommands, `done_when` predicates, schema block and
   validation.
4. TF4: batch 1, state recovery incidents.
5. TF5: batch 2, failed applies.
6. TF6: batch 3, config and modules (modules are the hardest part, so they come last).
7. TF7: batch 4, destroy problems, then migrate the 9 existing incidents.

## Incident candidates

- State recovery: lost or corrupt state, backend migration, `state rm`/`state mv`, tainted
  resources and `-replace`, backend or lock file mismatch.
- Failed applies: partial apply, IAM denied mid-apply, quota and rate limits, eventual
  consistency, dependency cycle, stale saved plan in CI.
- Config and modules: provider version and lock file drift, `for_each` with unknown values, module
  upgrade changes, `prevent_destroy`, `terraform_remote_state` coupling.
- Destroy problems: destroy stuck on dependencies, non-empty bucket, resources deleted
  out-of-band, orphans after `state rm`.

## Out of scope

`terraform console`, workspaces beyond `new`/`select`/`list`/`show`, provisioners, the Terraform
Cloud API, and provider attribute coverage beyond the types the incidents use.
