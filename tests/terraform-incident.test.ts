import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-forces-replacement')
const fix = scenario.actions.find((a) => a.id === 'revert-and-migrate')!
const { play, detected, detectedAll } = playbook(scenario)
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
    // The partial plan comes first: the replacement prevent_destroy refused, then the error.
    expect(out[1].output).toContain('Terraform planned the following actions, but then encountered a problem:\n\n  # aws_db_instance.orders must be replaced\n-/+ resource "aws_db_instance" "orders" {')
    expect(out[1].output).toContain('~ storage_encrypted   = false -> true # forces replacement')
    expect(out[1].output).toContain('Plan: 1 to add, 0 to change, 1 to destroy.\n╷\n│ Error: Instance cannot be destroyed')
    expect(out[1].hits).toContain('evidence:prevent-destroy')
  })

  it('shows the database as unencrypted in state and awards that evidence', async () => {
    const { out } = await play('cd ~/infra', 'terraform state show aws_db_instance.orders')
    expect(out[1].output).toMatch(/storage_encrypted\s+= false/)
    expect(out[1].hits).toContain('evidence:unencrypted')
  })

  it('the ideal path: revert the setting, plan is clean, the fix is detected from the file', async () => {
    const { sh, out } = await play('cd ~/infra', "sed -i 's/storage_encrypted   = true/storage_encrypted   = false/' db.tf", 'terraform plan', 'terraform validate')
    const [, , plan, validate] = out
    expect(plan.output).toContain('No changes.')
    expect(plan.exitCode).toBe(0)
    expect(validate.output).toContain('Success!')
    expect(new RegExp(fix.file!.matches, 'm').test((await sh.read(db()))!)).toBe(true)
  })

  it('the fix button writes a file that satisfies the same check and plans clean', async () => {
    expect(new RegExp(fix.file!.matches, 'm').test(fix.file!.after)).toBe(true)
    const { out } = await play('cd ~/infra', `cat > db.tf <<'EOF'\n${fix.file!.after}\nEOF`, 'terraform plan')
    expect(out[2].output).toContain('No changes.')
  })

  it('removing prevent_destroy shows the replacement instead: the trap teaches', async () => {
    const { sh, out } = await play('cd ~/infra', "sed -i 's/prevent_destroy = true/prevent_destroy = false/' db.tf", 'terraform plan')
    const plan = out[2].output
    expect(plan).toContain('# aws_db_instance.orders must be replaced')
    expect(plan).toContain('-/+ resource "aws_db_instance" "orders" {')
    expect(plan).toMatch(/storage_encrypted\s+= false -> true # forces replacement/)
    expect(plan).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
    expect(new RegExp(fix.file!.matches, 'm').test((await sh.read(db()))!)).toBe(false)
  })

  it('ignore_changes makes the plan quiet without fixing anything', async () => {
    const { sh, out } = await play('cd ~/infra', `sed -i 's/prevent_destroy = true/prevent_destroy = true\\n    ignore_changes = [storage_encrypted]/' db.tf`, 'terraform plan')
    expect(out[2].output).toContain('No changes.')
    expect(new RegExp(fix.file!.matches, 'm').test((await sh.read(db()))!)).toBe(false)
  })

  it('done_when, ideal path: reverting without ever applying is the fix, and nothing else', async () => {
    const { sh } = await play('cd ~/infra')
    expect(await detectedAll(sh)).toEqual({ 'revert-and-migrate': false, 'remove-guard': false, 'ignore-encryption': false, 'modify-console': false })
    await sh.run("sed -i 's/storage_encrypted   = true/storage_encrypted   = false/' db.tf", atStage(scenario, 0), new Set())
    expect((await sh.run('terraform plan', atStage(scenario, 0), new Set())).output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual({ 'revert-and-migrate': true, 'remove-guard': false, 'ignore-encryption': false, 'modify-console': false })
  })

  it('done_when, trap path: applying the replacement is the destructive action, and a later revert is no fix', async () => {
    const { sh, out } = await play('cd ~/infra', `sed -i '/prevent_destroy/d' db.tf`, 'terraform apply -auto-approve')
    expect(out[2].output).toContain('Apply complete! Resources: 1 added, 0 changed, 1 destroyed.')
    expect(await detectedAll(sh)).toEqual({ 'revert-and-migrate': false, 'remove-guard': true, 'ignore-encryption': false, 'modify-console': false })

    const run = (l: string) => sh.run(l, atStage(scenario, 0), new Set())
    await run("sed -i 's/storage_encrypted   = true/storage_encrypted   = false/' db.tf")
    expect(new RegExp(fix.file!.matches, 'm').test((await sh.read(db()))!)).toBe(true) // the file looks fixed
    const plan = (await run('terraform plan')).output
    expect(plan).toContain('# aws_db_instance.orders must be replaced') // the new instance is encrypted now
    expect(plan).toMatch(/storage_encrypted\s+= true -> false # forces replacement/)
    expect(await detected(sh, 'revert-and-migrate')).toBe(false)

    await run(`sed -i 's/^  lifecycle {$/  lifecycle {\\n    prevent_destroy = true/' db.tf`) // the guard back, too
    expect(await sh.read(db())).toMatch(/lifecycle \{\n\s+prevent_destroy = true\n/)
    expect(await detectedAll(sh)).toEqual({ 'revert-and-migrate': false, 'remove-guard': true, 'ignore-encryption': false, 'modify-console': false })
  })

  it('done_when, state rm path: a second orders-db is refused like in AWS, and the revert is no fix', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform state rm aws_db_instance.orders', "sed -i 's/storage_encrypted   = true/storage_encrypted   = false/' db.tf", 'terraform apply -auto-approve')
    expect(out[3].exitCode).toBe(1)
    expect(out[3].output).toContain('creating RDS DB Instance (orders-db): operation error RDS: CreateDBInstance')
    expect(out[3].output).toContain('DBInstanceAlreadyExists')
    expect(new RegExp(fix.file!.matches, 'm').test((await sh.read(db()))!)).toBe(true)
    expect(await detectedAll(sh)).toEqual({ 'revert-and-migrate': false, 'remove-guard': false, 'ignore-encryption': false, 'modify-console': false })
  })

  it('done_when: ignore_changes on storage_encrypted is detected as that wrong action only', async () => {
    const { sh } = await play('cd ~/infra', `sed -i 's/prevent_destroy = true/prevent_destroy = true\\n    ignore_changes = [storage_encrypted]/' db.tf`)
    expect(await detectedAll(sh)).toEqual({ 'revert-and-migrate': false, 'remove-guard': false, 'ignore-encryption': true, 'modify-console': false })
  })

  it('the other evidence is findable: the provider docs file, the scripted git diff and AWS command', () => {
    const tags = new Set([...(scenario.files ?? []).map((f) => f.evidence), ...scenario.terminal!.commands.map((c) => c.evidence), ...(scenario.terraform!.evidence ?? []).map((e) => e.evidence)])
    for (const t of scenario.key_evidence) expect(tags.has(t), t).toBe(true)
  })
})
