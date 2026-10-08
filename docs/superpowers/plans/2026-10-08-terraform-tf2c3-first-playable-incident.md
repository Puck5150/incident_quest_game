# Terraform TF2c-3: the first playable Terraform incident Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the Terraform simulator end to end in the real game by converting one existing incident, `terraform-forces-replacement` ("Turning on encryption fails: Terraform says the database can't be destroyed"), from scripted `terraform plan` output to the simulator, and document the `terraform:` block for incident authors. The player runs a real `terraform plan`, reads the real `Instance cannot be destroyed` error, finds why with real commands, edits `db.tf`, and sees a clean plan.

**Architecture:** The incident gains a `terraform:` block (files, state, variables, one evidence rule) and loses its three scripted `terraform plan` entries; the fix becomes a file-edit action (`file:` on the existing `revert-and-migrate` action) so reverting `storage_encrypted` in `db.tf` is detected from the disk. One validator rule that insists a scripted command changes after a fix is relaxed for incidents with a `terraform:` block (the plan changes by itself). A new test plays the ideal path and the traps through the real shell. `AUTHORING.md` documents the block.

**Tech Stack:** YAML content, TypeScript (tests, one validator rule), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` ("Incident authoring", "Fixes and scoring"). Builds on TF1 to TF2c-2 (complete). Out of scope: converting the other eight Terraform incidents and `done_when` predicates (TF3/TF7), `terraform apply` (TF3).

## Global Constraints

- Content is data: the only code change is the validator rule in `src/schema/scenario.ts`. The incident keeps its id, title, ticket, hypotheses, actions, hints, debrief, concepts and sources (player progress is saved by id); only the terminal, files and evidence plumbing change.
- Every fact in the incident stays as sourced in the file today; no new factual claims beyond what the simulator prints.
- The incident must still pass every content test (`npm test`): schema, cross-field checks, `terminal-content` (scripted commands agree with the real shell), solution paths reachable, key evidence findable before the fix.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The ideal path works typed, start to finish: `terraform plan` shows the error and awards `prevent-destroy`; editing `db.tf` to `storage_encrypted = false` (with `sed -i`, a redirect, or the editor) takes the `revert-and-migrate` action once the root cause is named; `terraform plan` then says "No changes." (Task 2 test).
2. The traps teach: removing `prevent_destroy` and planning shows the replacement plan (`-/+`, `storage_encrypted … # forces replacement`) rather than letting the player destroy anything; `ignore_changes = [storage_encrypted]` makes the plan clean WITHOUT satisfying the fix regex (Task 2 test).
3. Evidence: `prevent-destroy` comes from the simulator, `unencrypted` from either the scripted AWS command or `terraform state show`, `force-new` from the provider-docs file, `encryption-change` from the scripted `git diff` (Task 2 test).
4. The relaxed validator rule applies only to incidents with a `terraform:` block (Task 1 test).

---

### Task 1: Validator rule and author documentation

**Files:**
- Modify: `src/schema/scenario.ts` (the "players can verify the fix" check)
- Modify: `tests/schemas.test.ts` or the content-validation test that already covers that check (find it with `grep -rn "so players can verify the fix" tests src`) — append
- Modify: `AUTHORING.md` (new section)

**Interfaces:** the existing check reads: for each stage, some terminal command must have a `when_actions` containing one of that stage's fix action ids, error text `no terminal command changes after this stage's fixes: add one with when_actions so players can verify the fix`. Change: skip it when the scenario has a `terraform` block (the simulator's output changes by itself when the player fixes the files).

- [ ] **Step 1: Write the failing test**

Find the existing test for that message. Add two cases next to it, built the same way the existing case builds its scenario: (a) a scenario without a `terraform` block and without a command that has `when_actions` for the fix still fails with the message; (b) the same scenario WITH a minimal valid `terraform` block (`files: [{ path: 'main.tf', content: '' }]`) passes that check (no issue with that message). If the existing test constructs scenarios from `loadContent`, copy its approach.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run <that test file>`
Expected: FAIL on case (b).

- [ ] **Step 3: Implement the rule change and the docs**

In `src/schema/scenario.ts`, in the per-stage loop where the message is issued, wrap the check in `if (!s.terraform) { … }` (keep the stage-level structure; `s` is the top-level scenario). Do not change any other check.

Append to `AUTHORING.md` a section `## Terraform incidents (the `terraform:` block)` that explains, in the same plain style as the rest of the file:
- what the block does (the player gets a real `terraform` command working on real `.tf` files; output comes from the simulator, not from scripted text), and that you then do NOT script `terraform …` commands in `terminal.commands`;
- each field (`dir`, `version`, `initialized`, `files`, `vars`, `state`, `outputs`, `cloud`, `evidence`) with a short example and the rules the schema enforces (relative file paths; state `attrs` need a string `id`; the cloud defaults to exactly what state says and `cloud.patch/delete/add` describe drift, deletions and unmanaged objects; evidence matches a subcommand and a substring of its output);
- which commands work (`init`, `validate`, `plan`, `show`, `state list|show|pull`, `output`, `workspace show|list`, `version`) and that writing commands (`apply`, `import`, …) answer "not simulated yet";
- how to make a fix detectable: use a `file:` action on the `.tf` file (`matches` regex on the edited file, `after` full content for the button), because verification is the player running `terraform plan` again — and that supported resource types are the ones in `src/game/terraform/resources.ts`;
- the known gaps authors must keep in mind: sensitive values are not tracked through expressions, lists/sets render as the AWS provider's attributes, `terraform apply` is not available, only top-level (not per-stage) blocks.
Keep it under ~80 lines, with one small complete example block.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run <that test file> && npm test 2>&1 | grep -E "Test Files|Tests " && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schema/scenario.ts <the test file> AUTHORING.md
git commit -m "feat: terraform incidents verify fixes through the simulator; authoring docs (TF2c-3)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Convert the incident and play it

**Files:**
- Modify: `content/iac/terraform-forces-replacement.yaml`
- Test: `tests/terraform-incident.test.ts`
- Modify: `CONTENT_TODO.md` (move the incident's scripted-output items, if any, to a note that the simulator now prints them)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-incident.test.ts` (use the same loading approach as `tests/shell.test.ts`: `loadContent(path.resolve(import.meta.dirname, '../content'))`, find the scenario by id). Helper `play(...lines)` builds `new IncidentShell(scenario)` and runs each line with `sh.run(line, scenario, new Set())`, returning the results.

```ts
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { IncidentShell } from '../src/game/shell.ts'
import { atStage } from '../src/schema/stages.ts'

const scenario = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.id === 'terraform-forces-replacement')!
const fix = scenario.actions.find((a) => a.id === 'revert-and-migrate')!
const play = async (...lines: string[]) => {
  const sh = new IncidentShell(scenario)
  const out = []
  for (const l of lines) out.push(await sh.run(l, atStage(scenario, 0), new Set()))
  return { sh, out }
}
const db = () => `/home/you/infra/db.tf`

describe('terraform-forces-replacement on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
  })

  it('the first plan fails with the real error and awards the evidence', async () => {
    const { out } = await play('cd ~/infra', 'terraform plan')
    expect(out[1].exitCode).toBe(1)
    expect(out[1].output).toContain('Error: Instance cannot be destroyed')
    expect(out[1].output).toContain('on db.tf line 1')
    expect(out[1].output).toContain('Resource aws_db_instance.orders has lifecycle.prevent_destroy set')
    expect(out[1].hits).toContain('evidence:prevent-destroy')
  })

  it('shows the database as unencrypted in state and awards that evidence', async () => {
    const { out } = await play('terraform state show aws_db_instance.orders')
    expect(out[0].output).toMatch(/storage_encrypted\s+= false/)
    expect(out[0].output).toContain('password            = (sensitive value)'.replace(/ {12}=/, ' ='))
    expect(out[0].hits).toContain('evidence:unencrypted')
  })

  it('the ideal path: revert the setting, plan is clean, the fix is detected from the file', async () => {
    const { sh, out } = await play("sed -i 's/storage_encrypted = true/storage_encrypted = false/' db.tf", 'terraform plan', 'terraform validate')
    const [, plan, validate] = out
    expect(plan.output).toContain('No changes.')
    expect(plan.exitCode).toBe(0)
    expect(validate.output).toContain('Success!')
    expect(new RegExp(fix.file!.matches, 'm').test((await sh.read(db()))!)).toBe(true)
  })

  it('the fix button writes a file that satisfies the same check and plans clean', async () => {
    expect(new RegExp(fix.file!.matches, 'm').test(fix.file!.after)).toBe(true)
    const { out } = await play(`cat > db.tf <<'EOF'\n${fix.file!.after}\nEOF`, 'terraform plan')
    expect(out[1].output).toContain('No changes.')
  })

  it('removing prevent_destroy shows the replacement instead: the trap teaches', async () => {
    const { sh, out } = await play("sed -i 's/prevent_destroy = true/prevent_destroy = false/' db.tf", 'terraform plan')
    const plan = out[1].output
    expect(plan).toContain('# aws_db_instance.orders must be replaced')
    expect(plan).toContain('-/+ resource "aws_db_instance" "orders" {')
    expect(plan).toMatch(/storage_encrypted\s+= false -> true # forces replacement/)
    expect(plan).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
    expect(new RegExp(fix.file!.matches, 'm').test((await sh.read(db()))!)).toBe(false)
  })

  it('ignore_changes makes the plan quiet without fixing anything', async () => {
    const { sh, out } = await play(`sed -i 's/prevent_destroy = true/prevent_destroy = true\\n    ignore_changes = [storage_encrypted]/' db.tf`, 'terraform plan')
    expect(out[1].output).toContain('No changes.')
    expect(new RegExp(fix.file!.matches, 'm').test((await sh.read(db()))!)).toBe(false)
  })

  it('the other evidence is findable: the provider docs file, the scripted git diff and AWS command', () => {
    const tags = new Set([...(scenario.files ?? []).map((f) => f.evidence), ...scenario.terminal!.commands.map((c) => c.evidence), ...(scenario.terraform!.evidence ?? []).map((e) => e.evidence)])
    for (const t of scenario.key_evidence) expect(tags.has(t), t).toBe(true)
  })
})
```

(The one `.replace(/ {12}=/, ' =')` trick above is only a placeholder: compute the real aligned `state show` line from the final attribute set and write it out literally, or drop the assertion if it duplicates the `evidence:unencrypted` hit.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-incident.test.ts`
Expected: FAIL (the incident still has scripted terraform commands and no terraform block).

- [ ] **Step 3: Convert the incident**

Edit `content/iac/terraform-forces-replacement.yaml` (keep everything not listed here exactly as it is):

1. `environment:` append one sentence: `The Terraform for it lives in ~/infra.`
2. `terminal.commands`: delete the three `terraform plan` entries (keep `git diff main -- db.tf` and the `aws rds describe-db-instances …` entry unchanged).
3. Add a top-level `terraform:` block:
   - `dir: "~/infra"`.
   - `files`: `main.tf` and `db.tf`.
     - `main.tf`: a `terraform { required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } } }` block, `provider "aws" { region = "us-east-1" }`, and `variable "db_password" { type = string, sensitive = true }` (written as normal multi-line HCL).
     - `db.tf` (exactly this, the PR's state of the file):
```
resource "aws_db_instance" "orders" {
  identifier          = "orders-db"
  engine              = "postgres"
  engine_version      = "15.4"
  instance_class      = "db.r6g.large"
  allocated_storage   = 100
  db_name             = "orders"
  username            = "orders_admin"
  password            = var.db_password
  multi_az            = true
  storage_encrypted   = true
  skip_final_snapshot = false

  lifecycle {
    prevent_destroy = true
  }
}
```
   - `vars: { db_password: "orders-admin-secret" }`.
   - `state`: one managed `aws_db_instance.orders` with attrs `id: db-ORDERS1234`, `arn: arn:aws:rds:us-east-1:123456789012:db:orders-db`, `identifier: orders-db`, `engine: postgres`, `engine_version: "15.4"`, `instance_class: db.r6g.large`, `allocated_storage: 100`, `db_name: orders`, `username: orders_admin`, `password: orders-admin-secret`, `multi_az: true`, `skip_final_snapshot: false`, `storage_encrypted: false`, `endpoint: orders-db.cxyz.us-east-1.rds.amazonaws.com:5432`.
   - `evidence`: `{ evidence: prevent-destroy, command: plan, contains: "Instance cannot be destroyed" }` and `{ evidence: unencrypted, command: state show, contains: <the exact text `state show` prints for the unencrypted setting, e.g. "storage_encrypted   = false"> }` (run the command in the shell to get the exact aligned text).
4. The `revert-and-migrate` action: add `file: { path: "/home/you/infra/db.tf", matches: "storage_encrypted\\s*=\\s*false", after: <the full db.tf above with storage_encrypted = false and everything else identical> }` (YAML block scalar for `after`).
5. `key_evidence` and the rest unchanged. In `command_notes` nothing changes.

If the content validator rejects anything (the file path rules, the verification rule — Task 1 relaxes it — or the `unencrypted` tag now being produced in two places), read the message and fix the content, not the validator, unless the message shows a genuine validator gap; if it is a validator gap, stop and report it instead of working around it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-incident.test.ts && npm test 2>&1 | grep -E "Test Files|Tests " && npm run lint 2>&1 | tail -15 && npx tsc -b && npm run build 2>&1 | grep -E "error|built in"`
Expected: PASS everywhere; the existing content tests (`content.test.ts`, `terminal-content.test.ts`, UI tests) stay green.

- [ ] **Step 5: Commit**

```bash
git add content/iac/terraform-forces-replacement.yaml tests/terraform-incident.test.ts CONTENT_TODO.md
git commit -m "content: terraform-forces-replacement runs on the Terraform simulator (TF2c-3)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done)

- **Spec coverage:** "Incident authoring" and "Fixes and scoring" (fix as a file edit, evidence from observed outcomes) are demonstrated end to end on one incident; `done_when` predicates remain TF3.
- **Placeholders:** none except the one `.replace` placeholder in the test, which the task tells the implementer to replace.
- **Risks:** the content validator may reject a combination nobody has used yet (`file:` action path rules for Terraform files, the same evidence tag from two sources); Task 2 says to stop and report a genuine validator gap. `terminal-content.test.ts` replays scripted commands through the real shell — the remaining scripted commands (git, aws) are unchanged.
