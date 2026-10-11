import { describe, expect, it } from 'vitest'
import { evidenceSeen } from '../src/game/engine.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-moved-block')
const { play, detectedAll } = playbook(scenario)

const NONE = { 'moved-block': false, 'state-mv': false, 'prevent-destroy': false, 'merge-with-snapshot': false }
const OLD = 'aws_db_instance.orders'
const NEW = 'module.database.aws_db_instance.orders'
const MOVED = (to = NEW) => `cat >> main.tf <<'EOF'\nmoved {\n  from = ${OLD}\n  to   = ${to}\n}\nEOF`
const PD = `cat > modules/database/main.tf <<'EOF'
resource "aws_db_instance" "orders" {
  identifier     = "orders-prod"
  engine         = "postgres"
  instance_class = "db.r6g.large"

  lifecycle {
    prevent_destroy = true
  }
}
EOF`
const A = 'terraform apply -auto-approve'
const DB_ID = 'db-ORDERSPROD7Q2X'

describe('terraform-moved-block on the simulator', () => {
  it('is backed by the simulator; only git diff is scripted; ids, kinds and the moved block as the only fix', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.map((c) => c.example ?? c.match)).toEqual(['git diff main'])
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.example ?? c.match!]).toBeDefined()
    expect(scenario.actions.map((a) => [a.id, a.kind])).toEqual([
      ['moved-block', 'fix'],
      ['state-mv', 'wrong'],
      ['prevent-destroy', 'wrong'],
      ['merge-with-snapshot', 'destructive'],
    ])
    expect(scenario.solution_paths).toEqual([['moved-block']])
    expect(scenario.key_evidence).toEqual(['plan-destroy', 'state-address', 'refactor-diff'])
  })

  it('(a) the untouched lab plans the destroy and create the PR plan CI posted, and the CI log is consistent with it', async () => {
    const { sh, out } = await play('cd ~/infra-prod', 'terraform plan', 'terraform state list')
    const plan = out[1].output
    expect(plan).toContain('# aws_db_instance.orders will be destroyed')
    expect(plan).toContain('# (because aws_db_instance.orders is not in configuration)')
    expect(plan).toContain('# module.database.aws_db_instance.orders will be created')
    expect(plan).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
    // every key row of the pipeline's plan log is a line of the real plan
    const stage = scenario.pipeline!.stages.find((s) => s.evidence === 'plan-destroy')!
    const rows = stage.log!.split('\n').map((l) => l.trim()).filter((l) => /^(#|Plan:|[-+] )/.test(l) && !l.startsWith('# ('))
    expect(rows.length).toBeGreaterThanOrEqual(5)
    for (const r of rows) expect(plan, r).toContain(r)
    expect(out[2].output).toContain(OLD)
    expect(out[2].hits).toContain('evidence:state-address')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b) git diff main is scripted and tags refactor-diff; state list tags state-address', async () => {
    expect(evidenceSeen(scenario, [{ type: 'RUN_COMMAND', input: 'git diff main', at: 0 }]).has('refactor-diff')).toBe(true)
  })

  it('(c) ideal: moved block, plan says has moved to and 0 to destroy, apply keeps the same database', async () => {
    const { sh, out } = await play('cd ~/infra-prod', MOVED(), 'terraform plan', A, 'terraform plan', 'terraform state list')
    expect(out[2].output).toContain('# aws_db_instance.orders has moved to module.database.aws_db_instance.orders')
    expect(out[2].output).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    expect(out[3].output).not.toContain('Destroying')
    expect(out[4].output).toContain('No changes.')
    expect(out[5].output).toContain(NEW)
    expect(out[5].output).not.toMatch(/^aws_db_instance\.orders$/m)
    expect(await sh.doneWhen({ reality_has: { type: 'aws_db_instance', id: DB_ID, attr: 'identifier', equals: 'orders-prod' } } as never)).toBe(true)
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'moved-block': true })
  })

  it('(c2) the moved block is credited from the PR plan alone, before any apply', async () => {
    const { sh } = await play('cd ~/infra-prod', MOVED(), 'terraform plan')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'moved-block': true })
  })

  it('(d) terraform state mv avoids the destroy for this state only: it is wrong, not the fix, not destructive', async () => {
    const { sh, out } = await play('cd ~/infra-prod', `terraform state mv ${OLD} ${NEW}`, 'terraform plan')
    expect(out[1].exitCode).toBe(0)
    expect(out[2].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'state-mv': true })
  })

  it('(d2) state mv followed by the moved block in code is the fix: the move is now in the PR', async () => {
    const { sh } = await play('cd ~/infra-prod', `terraform state mv ${OLD} ${NEW}`, MOVED(), 'terraform plan')
    const d = await detectedAll(sh)
    expect(d['moved-block']).toBe(true)
    expect(d['state-mv']).toBe(false)
  })

  it('(e) state rm of the old address then import at the new one is the same one-off surgery: wrong, not the fix', async () => {
    const { sh, out } = await play('cd ~/infra-prod', `terraform state rm ${OLD}`, `terraform import ${NEW} ${DB_ID}`, 'terraform plan')
    expect(out[2].exitCode).toBe(0)
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'state-mv': true })
  })

  it('(f) applying the untouched PR destroys the real database; neither fix is creditable afterwards', async () => {
    const { sh, out } = await play('cd ~/infra-prod', A)
    expect(out[1].output).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
    expect(await sh.doneWhen({ reality_has: { type: 'aws_db_instance', id: DB_ID, attr: 'identifier', equals: 'orders-prod' } } as never)).toBe(false)
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'merge-with-snapshot': true })
    await sh.run(MOVED(), scenario as never, new Set())
    await sh.run('terraform plan', scenario as never, new Set())
    const d = await detectedAll(sh)
    expect(d['moved-block']).toBe(false)
    expect(d['merge-with-snapshot']).toBe(true)
  })

  it('(g) prevent_destroy on the new module resource does not stop the destroy of the old address', async () => {
    const { sh, out } = await play('cd ~/infra-prod', PD, 'terraform plan', A)
    expect(out[2].output).toContain('# aws_db_instance.orders will be destroyed')
    expect(out[2].output).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
    expect(await sh.doneWhen({ reality_has: { type: 'aws_db_instance', id: DB_ID, attr: 'identifier', equals: 'orders-prod' } } as never)).toBe(false)
    expect(out[3].output).not.toContain('Instance cannot be destroyed')
    const d = await detectedAll(sh)
    expect(d['moved-block']).toBe(false)
    expect(d['prevent-destroy']).toBe(true)
  })

  it('(g2) prevent_destroy on the moved resource with the moved block is fine; the fix is still the moved block', async () => {
    const { sh, out } = await play('cd ~/infra-prod', PD, MOVED(), 'terraform plan')
    expect(out[3].output).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    const d = await detectedAll(sh)
    expect(d['moved-block']).toBe(true)
  })

  it('(h) a moved block with the wrong to address is an error or a destroy, and credits nothing', async () => {
    const { sh, out } = await play('cd ~/infra-prod', MOVED('module.database.aws_db_instance.orders_v2'), 'terraform plan')
    const text = out[2].output
    expect(out[2].exitCode !== 0 || text.includes('will be destroyed')).toBe(true)
    expect(await detectedAll(sh)).toEqual(NONE)
  })
})
