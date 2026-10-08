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

  it('the other evidence is findable: the provider docs file, the scripted git diff and AWS command', () => {
    const tags = new Set([...(scenario.files ?? []).map((f) => f.evidence), ...scenario.terminal!.commands.map((c) => c.evidence), ...(scenario.terraform!.evidence ?? []).map((e) => e.evidence)])
    for (const t of scenario.key_evidence) expect(tags.has(t), t).toBe(true)
  })
})
