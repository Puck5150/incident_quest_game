# Terraform TF3b: `apply`, `destroy`, saved plans, faults, the confirm prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The player can run `terraform apply` and `terraform destroy` in the simulated terminal: the real plan is shown, the real `Do you want to perform these actions?` prompt is answered (typed into the terminal, or `-auto-approve`, or piped), resources are created/changed/destroyed with real-format progress lines, failures print real-format boxed errors and leave a half-applied world, and the next `plan`/`state list`/`output` shows the new world. `-out` saved plans work and go stale when state moves on. Scenarios can script faults.

**Architecture:** `executeApply` (TF3a) does the work; this plan adds (1) a `destroy` mode to the planner, (2) scenario `faults` and a mutable `Lab` (state, reality, fault attempt counts, saved plans), (3) a renderer turning an `ApplyResult` into Terraform's progress text, (4) the `apply`/`destroy` commands in `cli.ts` with a pluggable confirmation source (`-auto-approve` > piped stdin > interactive `confirm` hook > "cancelled"), (5) shell wiring so the world is replayed deterministically when the terminal remounts, (6) the interactive prompt in the terminal UI, recorded as an `ANSWERED` event exactly the way editor saves are recorded as `EDITED`.

**Tech Stack:** TypeScript (strict), vitest, React 19 (one small component), zod 4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md`. TF1 to TF3a are complete (`src/game/terraform/apply.ts`, `provider.ts`). Out of scope here (TF3c/d): state locks and `force-unlock`, `import`/`state mv|rm`/`taint`/`untaint`/`refresh` commands, workspaces, `done_when` predicates, `-target`, `-refresh-only`, `show <planfile>`.

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, `import type` for types, `.ts` import extensions.
- No new npm dependencies. No randomness and no clock anywhere: replaying the same command history (with the same recorded edits and answers) must rebuild the same world.
- Own-property discipline: never `in` / `obj[userKey] = ...` on user-keyed objects (`Object.hasOwn`, `Map`, `Object.fromEntries`).
- Nothing throws on player input; failures are boxed diagnostics or plain messages with a non-zero exit code. `runTerraform` keeps its catch-all.
- The world (state, reality, attempts, saved plans) changes only for a run in the lab directory on the scenario's main host. Anywhere else apply works on an empty throwaway world and nothing is kept.
- Terraform wording not verified against real Terraform output is logged in `CONTENT_TODO.md` (Task 7).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A declined or unanswered prompt changes nothing: state, cloud, fault counts and serial are untouched, exit code 1, message `Apply cancelled.` (Task 4 tests).
2. Replaying the same commands on a fresh shell (same edits, same answers) rebuilds an identical world; fault `times` counts do not double-count on replay (Task 5 test).
3. A failed apply prints the progress lines for what happened, then the boxed error(s) with `with ADDR,`, no `Apply complete!`, exit 1; the half-applied state is what `terraform state list` then shows (Tasks 3, 4).
4. A saved plan applies exactly what was planned, without a prompt, and is refused as stale once state has changed (Task 4).
5. `terraform destroy` honours `prevent_destroy` with the real error and does not touch anything when it errors (Tasks 1, 4).

---

### Task 1: Planner destroy mode

**Files:**
- Modify: `src/game/terraform/plan.ts`
- Test: `tests/terraform-plan.test.ts` (append)

**Interfaces (produces):** `PlanInput.destroy?: boolean`. When true, after refresh (and moves) every managed state instance becomes a `destroy` item (`destroyReason: 'not-in-config'` is fine; `dependsOn` from the configured resource if it still exists in the configuration, else `inst.dependencies ?? []`; `block` when configured), data-source instances are dropped, `import`/`removed`/`moved` blocks and `replace` are ignored, every output is planned for removal (existing output-change logic), and `prevent_destroy` on a still-configured resource is an error with the same text/diagnostic the planner already gives for an orphan or replace destroy. The configuration must still parse and the graph must build (diagnostics are returned as usual) but resource arguments are not evaluated, so a destroy works even when the configuration references unset variables.

- [ ] **Step 1: Write the failing tests** (append to `tests/terraform-plan.test.ts`, reusing its helpers `plan`, `stateOf`, `NETWORK`, `VPC`, `SUBNET`; check how the file's `plan` helper passes extra `PlanInput` fields and extend it with a `destroy` option if needed)

```ts
describe('planConfig: destroy mode', () => {
  it('destroys everything in state, dependents first by dependsOn, ignoring the configuration values', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC }, { type: 'aws_subnet', name: 'a', attrs: SUBNET })
    const r = plan(NETWORK('10.9.9.0/24'), { state, destroy: true })
    expect(r.diagnostics).toEqual([])
    expect(r.items.map((i) => `${i.action} ${i.address}`).sort()).toEqual(['destroy aws_subnet.a', 'destroy aws_vpc.main'])
    expect(r.items.find((i) => i.address === 'aws_subnet.a')!.dependsOn).toEqual(['aws_vpc.main'])
  })
  it('works with an empty configuration and drops outputs', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC })
    state.outputs = { id: { value: 'vpc-1', sensitive: false } }
    const r = plan('# none\n', { state, destroy: true })
    expect(r.items.map((i) => i.action)).toEqual(['destroy'])
    expect(r.outputs.find((o) => o.name === 'id')).toBeUndefined()
  })
  it('refuses prevent_destroy resources', () => {
    const state = stateOf({ type: 'aws_db_instance', name: 'orders', attrs: { id: 'orders', arn: 'a', identifier: 'orders', engine: 'postgres', instance_class: 'db.t3.micro', storage_encrypted: false } })
    const tf = 'resource "aws_db_instance" "orders" {\n  identifier = "orders"\n  engine = "postgres"\n  instance_class = "db.t3.micro"\n  storage_encrypted = false\n  lifecycle {\n    prevent_destroy = true\n  }\n}\n'
    const r = plan(tf, { state, destroy: true })
    expect(r.diagnostics[0].summary).toBe('Instance cannot be destroyed')
  })
  it('ignores moved/import/removed blocks and -replace', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: VPC })
    const r = plan(NETWORK('10.0.0.0/16') + 'moved {\n  from = aws_vpc.old\n  to = aws_vpc.main\n}\n', { state, destroy: true, replace: ['aws_vpc.main'] })
    expect(r.diagnostics).toEqual([])
    expect(r.items.map((i) => `${i.action} ${i.address}`)).toEqual(['destroy aws_vpc.main'])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/terraform-plan.test.ts` → FAIL (`destroy` ignored: no destroy items).
- [ ] **Step 3: Implement** in `planConfig`: read `src/game/terraform/plan.ts` first; add the `destroy` branch after refresh/base state is built, reusing the orphan-destroy item construction and the existing `prevent_destroy` check. Keep every existing code path byte-identical when `destroy` is unset.
- [ ] **Step 4: Verify** — `npx vitest run tests/terraform-plan.test.ts && npm test 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npm run lint 2>&1 | tail -5`.
- [ ] **Step 5: Commit** — `git add src tests && git commit -m "feat: planner destroy mode (TF3b)"` (with the Co-Authored-By trailer).

---

### Task 2: Scenario `faults` and a mutable Lab

**Files:**
- Modify: `src/schema/scenario.ts`, `schemas/incident.json` (run `npm run schemas`), `src/game/terraform/lab.ts`
- Test: `tests/terraform-lab.test.ts` (append), `tests/scenario-schema.test.ts` (append; use the existing file that tests terraform-block validation — find it with `grep -ln "terraform" tests/*.test.ts`)

**Interfaces (produces):**
- `TerraformSchema.faults?: { at: string; on: 'create'|'update'|'delete'; error: string; times?: number (int ≥1); if?: { attr: string; equals: json }; until_actions?: string[] }[]` — strict object; `at` must match `/^[a-z][\w]*\.[\w-]+(\[(\d+|"[^"]*")\])?$/`; `error` non-empty. Cross-field check: every `until_actions` entry is an action id of the scenario or one of its stages (find how other `*_actions` fields are validated in the same file and do the same).
- `Lab.faults: Fault[]` (type from `apply.ts`), `Lab.attempts: Map<number, number>` (empty), `Lab.savedPlans: Map<string, SavedPlan>` (empty), and
```ts
export interface SavedPlan { files: { name: string; text: string }[]; vars: Record<string, Value>; replace: string[]; destroy: boolean; serial: number; lineage: string }
```
  exported from `lab.ts`.

- [ ] **Step 1: Write failing tests**: schema accepts a valid fault list (`at: 'aws_s3_bucket.b', on: 'create', error: 'AccessDenied', times: 1, if: {attr:'bucket', equals:'x'}, until_actions: ['<a real action id in the fixture>']`) and rejects: bad `at`, unknown `on`, `times: 0`, empty `error`, unknown `until_actions` id, extra keys. `labFromScenario` copies faults (deep clone), starts `attempts` and `savedPlans` empty.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (mirror the style of the neighbouring `cloud`/`evidence` schema entries; `Lab` stays a plain mutable object).
- [ ] **Step 4: Verify** — targeted tests, `npm run schemas`, `npm test`, `npx tsc -b`, `npm run lint`; confirm `git diff --stat schemas/incident.json` shows only the faults addition.
- [ ] **Step 5: Commit** — `feat: scenario faults and mutable lab fields (TF3b)`.

---

### Task 3: Rendering an apply

**Files:**
- Create: `src/game/terraform/render-apply.ts`
- Test: `tests/terraform-render-apply.test.ts`

**Interfaces (consumes):** `ApplyResult`, `ApplyStep` from `apply.ts`; `formatDuration` from `provider.ts`; `outputsText` from `views.ts`; `formatDiagnostic` from `diag.ts`.
**Interfaces (produces):**
```ts
export function renderProgress(r: ApplyResult): string   // the streaming lines, stdout
export function renderApplyEnd(r: ApplyResult, mode: 'apply' | 'destroy'): string // "Apply complete! …" + Outputs (stdout), '' when errors
export function renderApplyErrors(r: ApplyResult, sources: Record<string, string>): string // boxed errors, stderr
```

Formats (all exact):
- create step ok: `ADDR: Creating...` then `ADDR: Creation complete after Ns [id=ID]`; update: `ADDR: Modifying... [id=ID]` then `ADDR: Modifications complete after Ns [id=ID]`; delete: `ADDR: Destroying... [id=ID]` then `ADDR: Destruction complete after Ns`; import: `ADDR: Importing... [id=ID]` then `ADDR: Import complete [id=ID]`; forget produces no line. `N` via `formatDuration(step.seconds)`. The `id` is `step.id` (for delete/update/import it is the object's id; apply sets it, see Step 3).
- a failed step prints only its start line (`ADDR: Creating...` / `Modifying... [id=ID]` / `Destroying... [id=ID]`) and no completion.
- Long operations: for each full 10 seconds `k*10 < seconds` print `ADDR: Still creating... [10s elapsed]` (`Still modifying... [id=ID] [20s elapsed]`, `Still destroying... [id=ID] [30s elapsed]`) between start and completion lines. Elapsed text is `${k*10}s`, or `1m0s`-style via `formatDuration` at 60s and over.
- Steps are printed in execution order, one block per step, joined with `\n`.
- `renderApplyEnd`: apply → `\nApply complete! Resources: ${imported ? `${imported} imported, ` : ''}${added} added, ${changed} changed, ${destroyed} destroyed.`; destroy → `\nDestroy complete! Resources: ${destroyed} destroyed.`. If the final state has outputs (apply only) append `\n\nOutputs:\n\n` + `outputsText(state.outputs, undefined, 'hcl').stdout`. Returns `''` when `r.errors.length`.
- `renderApplyErrors`: the errors boxed with `formatDiagnostic(d, sources[d.file] ?? '')`, joined by `\n\n`.

- [ ] **Step 1: Write failing tests**: build `ApplyResult` literals by hand (`steps`, `errors`, `counts`, a `state` with outputs) and assert exact text for: a create+update+delete mix with ids; a 130s DB create showing `Still creating... [10s elapsed]` … `[120s elapsed]` (12 lines) then `Creation complete after 2m10s [id=orders]`; a failed create (only the start line); a failed delete; `Apply complete! Resources: 1 imported, 0 added, 0 changed, 0 destroyed.`; destroy end text; outputs section with a sensitive output rendering `<sensitive>`; empty string when errors; boxed error containing `with aws_s3_bucket.b,` and `on main.tf line 1, in resource "aws_s3_bucket" "b":`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Also set `ApplyStep.id` for delete/update steps in `apply.ts` if TF3a left it unset for them (small change; tests in `tests/terraform-apply.test.ts` must keep passing).
- [ ] **Step 4: Verify** — targeted tests, full suite, `npx tsc -b`, lint.
- [ ] **Step 5: Commit** — `feat: render apply progress, completion and errors (TF3b)`.

---

### Task 4: The `apply` and `destroy` commands

**Files:**
- Modify: `src/game/terraform/cli.ts`
- Test: `tests/terraform-apply-cli.test.ts` (new; copy the harness style from `tests/terraform-cli.test.ts`: look at how it builds a `CliContext` with an in-memory file map and a `Lab`)

**Interfaces (consumes):** `executeApply`/`ApplyContext` (TF3a), `planConfig({destroy})` (Task 1), `Lab.faults/attempts/savedPlans/SavedPlan` (Task 2), `render-apply.ts` (Task 3).
**Interfaces (produces):** `CliContext` gains
```ts
taken: Set<string>                                   // actions the player has taken (fault gating)
stdin?: string                                       // piped input, if any
confirm?: (prompt: string) => Promise<string | undefined> // interactive answer; undefined = no way to ask
```
`NOT_YET` loses `apply` and `destroy`. `runTerraform` returns `CliResult` as before; the `ran` list (`verifies`) gains `apply` and `destroy`.

Behavior (`terraform apply [-auto-approve] [-var …] [-var-file …] [-replace …] [-refresh=false] [-out …?no] [PLANFILE]`, `terraform destroy [-auto-approve] [-var …] [-var-file …] [-refresh=false]`; reuse `parsePlanFlags`/`resolveVars`; `apply` rejects `-out`, `destroy` rejects `-replace`; accepted but ignored: `-input=false`, `-no-color`, `-lock`, `-lock-timeout`, `-parallelism`, `-compact-warnings`; `-target`/`-refresh-only` keep answering "not available in this lab yet"):

1. Setup is the same as `plan` (no-config error, graph diagnostics, lock error, variable resolution); a configuration/plan error prints exactly what `plan` prints, exit 1, world untouched.
2. Without a plan file: print the refresh lines + `renderPlan` (as `plan` does). If the plan is `No changes.` print it, then the end line (`Apply complete! Resources: 0 added, 0 changed, 0 destroyed.`; destroy: `Destroy complete! Resources: 0 destroyed.`), exit 0, nothing is written. Otherwise ask for confirmation (unless `-auto-approve`):
   - apply prompt: `\nDo you want to perform these actions?\n  Terraform will perform the actions described above.\n  Only 'yes' will be accepted to approve.\n\n  Enter a value: `
   - destroy prompt: `\nDo you really want to destroy all resources?\n  Terraform will destroy all your managed infrastructure, as shown above.\n  There is no undo. Only 'yes' will be accepted to confirm.\n\n  Enter a value: `
   - Answer source, first that exists: piped `ctx.stdin` (first line, trimmed), else `ctx.confirm(prompt)`, else none. The command output includes the prompt text and the answer on the same line (`  Enter a value: yes`), then a blank line. Anything other than exactly `yes` (or no source) prints `\nApply cancelled.` (destroy: `\nDestroy cancelled.`) to stdout, exit 1, **no world change**.
3. With a plan file argument (`terraform apply tfplan`): no prompt. The file must exist in the working directory and start with the marker line `TFPLAN1` followed by an id; a missing file prints `Error: Failed to load "tfplan" as a plan file` boxed with detail `Error: stat tfplan: no such file or directory`; a file without the marker boxed `Failed to load "NAME" as a plan file` detail `Error: zip: not a valid zip file`; an unknown id the same as "not a valid zip file". If `savedPlans.get(id).serial !== lab.state.serial` (or lineage differs): boxed `Saved plan is stale` / `The given plan file can no longer be applied because the state was changed by another operation after the plan was created.`, exit 1. Otherwise apply using the SAVED `files`, `vars`, `replace`, `destroy` (not the files on disk).
4. `terraform plan -out=NAME` (Task of the existing `cmdPlan`): when the plan has changes, write file `NAME` into the working directory with content `TFPLAN1\n<id>\n` where `<id>` = `p` + the 8-hex `hex(`${lineage}:${serial}:${NAME}`, 8)` (import `hex` from `provider.ts`) and store the `SavedPlan` (`files` = the .tf files and tfvars as read now, resolved `vars`, `replace`, `destroy:false`, `serial`, `lineage`) in `lab.savedPlans` — only when run in the lab directory on the main host. `-out` on a no-change plan writes nothing.
5. Execution: `executeApply({files, state: lab.state, reality: lab.reality, vars, replace, refresh, destroy}, { faults: lab.faults, taken: ctx.taken, attempts: lab.attempts, seed: String(lab.state.serial) })` — add `destroy?: boolean` pass-through to `executeApply`'s `PlanInput` (it already spreads the input into `planConfig`). Stdout = plan text + prompt/answer + `renderProgress` + `renderApplyEnd`; stderr = `renderApplyErrors`; exit 1 when `errors` is non-empty.
6. Commit to the world: only when the run is in the lab directory on the main host: `lab.state = result.state; lab.reality = result.reality; lab.hasState = true`. When not in the lab directory, execute on the throwaway empty world and keep nothing (so `terraform apply` in `/tmp` creates things nobody sees, as real Terraform would create a fresh state there).
7. Evidence: apply/destroy go through the same `command`/evidence matching as other commands (`command` = `apply` / `destroy`).

- [ ] **Step 1: Write failing tests** (full spec in the bullets below; write them as concrete code against the harness)
  - apply with `-auto-approve` on a two-resource network: exact stdout (refresh lines none, plan text, `aws_vpc.main: Creating...` lines, `Apply complete! Resources: 2 added, 0 changed, 0 destroyed.`), exit 0; afterwards `terraform plan` prints `No changes.` and `terraform state list` lists both.
  - piped `stdin: 'yes\n'` applies; `'no\n'`, `''`, and `'Yes\n'` print `Apply cancelled.`, exit 1, `lab.state.serial` unchanged, `lab.attempts.size === 0`.
  - `confirm` hook: called with the exact prompt text; `yes` applies; `undefined`-returning hook (no way to ask) cancels.
  - no changes: `terraform apply` prints `No changes. …` and `Apply complete! Resources: 0 added, 0 changed, 0 destroyed.`, exit 0, no prompt (hook/stdin never consulted).
  - failure: a fault on the second resource's create → stdout has the first resource's lines and the second's `Creating...` only, stderr has the boxed error containing `with aws_subnet.a,`, no `Apply complete!`, exit 1, `state list` shows only the first. A second `apply -auto-approve` (fault `times: 1`) completes.
  - prevent_destroy: `terraform destroy -auto-approve` on a protected DB prints the `Instance cannot be destroyed` box, exit 1, state untouched; after removing `prevent_destroy` from the file it destroys: stdout contains `Destroy complete! Resources: 1 destroyed.` and `state list` is empty.
  - destroy prompt text and `Destroy cancelled.`.
  - saved plan: `plan -out=tfplan` prints the existing `Saved the plan to: tfplan` footer and writes `tfplan` (marker line); `apply tfplan` applies with no prompt even after the player edits the `.tf` file in between (saved files win); after another `apply -auto-approve` has moved the serial, `apply tfplan` is refused with `Saved plan is stale`; a garbage file and a missing file give the load errors above.
  - outside the lab directory (`-chdir=/tmp`) apply changes nothing in the lab world.
  - `apply -target=x` and `-refresh-only` still say not available; `destroy -replace=x` is a flag error.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** in `cli.ts` (extract the shared refresh-lines code from `cmdPlan` into a helper used by both; keep `cmdPlan` output unchanged — existing CLI tests must pass byte-for-byte).
- [ ] **Step 4: Verify** — targeted tests, full suite, `npx tsc -b`, lint.
- [ ] **Step 5: Commit** — `feat: terraform apply and destroy with confirm, saved plans, faults (TF3b)`.

---

### Task 5: Shell wiring and deterministic replay

**Files:**
- Modify: `src/game/shell.ts`
- Test: `tests/terraform-shell-apply.test.ts` (new; model on the existing shell-level terraform tests — find them with `grep -ln "IncidentShell" tests/*.test.ts`)

**Interfaces (produces):** `IncidentShell.onConfirm?: (prompt: string) => Promise<string | undefined>` (set by the terminal session, like `onEdit`). The `terraform` command passes `taken: this.context.taken`, `stdin` (just-bash passes piped input as `ctx.stdin`; read it as a string, empty string → `undefined`), and `confirm: this.onConfirm` into `runTerraform`.

- [ ] **Step 1: Write failing tests**
  - Through `new IncidentShell(scenario)` with a terraform scenario (build one inline from the fixtures the existing shell tests use): `terraform apply -auto-approve` then `terraform state list` shows the created resources; `echo yes | terraform apply` applies; `terraform apply` with no `onConfirm` set prints `Apply cancelled.`; with `onConfirm = async () => 'yes'` applies.
  - Replay determinism (Review Focus 2): scenario with a fault `{ at, on:'create', error, times: 1 }`; shell A runs `terraform apply -auto-approve` twice (first fails, second succeeds). A fresh shell B runs the same two commands → identical `terraform state pull` output and identical outputs of both commands; B's run count of the fault is 1, not 2.
  - Fault gating: a fault with `until_actions: ['fix']` fails while `taken` lacks `fix`, passes after `shell.update(scenario, new Set(['fix']))`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the three context fields; nothing else changes in `shell.ts`.
- [ ] **Step 4: Verify** — targeted, full suite, tsc, lint.
- [ ] **Step 5: Commit** — `feat: shell passes actions, stdin and the confirm hook to terraform (TF3b)`.

---

### Task 6: The interactive prompt in the terminal

**Files:**
- Modify: `src/game/engine.ts` (event type + reducer case), `src/components/terminal/session.ts`, `src/components/terminal/XtermTerminal.tsx`, `src/screens/IncidentScreen.tsx`
- Create: `src/components/terminal/ConfirmPrompt.tsx`
- Test: `tests/engine-answered.test.ts` (new)

**Interfaces (produces):** `GameEvent` gains `{ type: 'ANSWERED'; value: string; at: number }` (record it exactly where `EDITED` is handled in `engine.ts`'s reducer/log code — read lines near `EDITED` at `engine.ts:24` and `:75` and mirror them; it must not affect scoring or timeline). `useTerminalSession(…, onAnswered?)` returns `prompting?: { prompt: string; done(value: string): void }`.

Behavior:
- `getShell()` sets `sh.onConfirm = (prompt) => …`: when `replayAnswers.current` is set (during replay of a logged command) it resolves with the next recorded `ANSWERED` value (FIFO; `undefined` if none left — same shape as `replayEdits`), otherwise it sets `prompting` state and resolves when the dialog calls `done(value)`; the session also calls `onAnswered(value)` (which sends the `ANSWERED` event) before resolving.
- In the replay loop (`session.ts`, where `replayEdits` is filled from the events between a command and the next), also collect `ANSWERED` events into `replayAnswers`.
- `ConfirmPrompt.tsx`: an overlay like `FileEditor` (same classes) showing the prompt text (`<pre>`), a single-line text input labelled `Enter a value`, Enter submits the value, Esc submits `''` (declines). Rendered by `XtermTerminal` when `session.prompting` is set; terminal refocuses when it clears (same effect as for `editing`).
- `IncidentScreen` passes `onAnswered={(value) => send({ type: 'ANSWERED', value })}`.

- [ ] **Step 1: Write failing test** `tests/engine-answered.test.ts`: an `ANSWERED` event in a log leaves `evidenceSeen`, scoring and the timeline derivation unchanged compared to the same log without it (copy the assertion style of the existing `EDITED` engine test; find it with `grep -ln EDITED tests/*.test.ts`), and a replay helper test if the session logic is extractable; otherwise cover the FIFO behavior by a small exported pure helper `takeAnswer(queue)` unit test.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Run `npm run build 2>&1 | tail` and `npx tsc -b`; then start `npm run dev` in the background and, with the Chrome tools, open a Terraform incident (`terraform-forces-replacement`), edit away `prevent_destroy`, run `terraform apply`, confirm the dialog appears with the real prompt, answer `yes`, confirm the transcript shows the progress lines, reload the page and confirm the transcript is rebuilt identically with no second dialog. Report what you saw. (If the browser tools are unavailable, say so and rely on the unit tests.)
- [ ] **Step 4: Verify** — full suite, tsc, lint, build.
- [ ] **Step 5: Commit** — `feat: interactive terraform confirm prompt, recorded for replay (TF3b)`.

---

### Task 7: Docs and honesty log

**Files:**
- Modify: `AUTHORING.md` (the `terraform:` block section: add `faults` with a worked example and the rules — gated by `until_actions`, `times` counts across the whole play session, update faults never fire for an item the plan makes a replacement, apply/destroy now work and what they print), `CONTENT_TODO.md`
- Modify: `src/game/engine.ts` `help` text if it lists Terraform commands as read-only (find the line with `grep -n "terraform" src/game/engine.ts`; apply/destroy now work, `import/taint/…` still do not)

**CONTENT_TODO.md** — append a section `## terraform simulator (apply/destroy commands, TF3b)` with unchecked items: the confirm prompt wording and cancel messages (real Terraform 1.9 prints `Apply cancelled.` / `Destroy cancelled.` with exit 1; unverified), `Still creating... [10s elapsed]` cadence, progress/complete line wording for import, saved-plan file marker and the stale/load error wording, refresh-line behaviour on apply with `-refresh=false`, the `Outputs:` section after apply, and that saved plans are kept in memory per session (a page reload replays the commands, so they come back).

- [ ] **Step 1:** make the doc edits; `npm test` (the authoring docs may be covered by a content test), `npx tsc -b`, `npm run lint`.
- [ ] **Step 2: Commit** — `docs: authoring faults and apply/destroy (TF3b)`.

---

## Self-review (done)

- **Spec coverage:** spec "Apply" (commands, output, prompt, saved plans, partial failure) and "faults" (scripted failures) are covered; locks, `import`/`state`/`taint` commands, workspaces and `done_when` are TF3c/d.
- **Placeholders:** none; where a test depends on a harness the task names the existing test file to copy from.
- **Type consistency:** `Fault`, `ApplyContext`, `ApplyResult`, `ApplyStep.id`, `Lab.faults/attempts/savedPlans`, `SavedPlan`, `CliContext.taken/stdin/confirm`, `IncidentShell.onConfirm`, `ANSWERED` match across tasks.
- **Review Focus:** each line has a test (1: Task 4 cancel tests; 2: Task 5 replay test; 3: Task 4 failure test + Task 3 renderer; 4: Task 4 saved-plan tests; 5: Tasks 1 and 4).
