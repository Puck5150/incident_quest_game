import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-module-key-removed')
const { play, detectedAll } = playbook(scenario)

const WEST_DB = 'orders-west'
const WEST_VPC = 'vpc-04e9b7d1a3c5f2860'
const BOTH = [
  'module.stack["east"].aws_vpc.main',
  'module.stack["west"].aws_vpc.main',
  'module.stack["east"].module.data.aws_db_instance.main',
  'module.stack["west"].module.data.aws_db_instance.main',
]
const RESTORE = `sed -i 's/default = \\["east"\\]/default = ["east", "west"]/' variables.tf`
const RM = `terraform state rm 'module.stack["west"]'`
const UNGUARD = "sed -i '/prevent_destroy/d' modules/stack/data/main.tf"
const NONE = { 'restore-the-key': false, 'stop-managing-west': false, 'remove-guard-and-apply': false, 'destroy-everything': false }
const RESTORED = { ...NONE, 'restore-the-key': true }
const FORGOTTEN = { ...NONE, 'stop-managing-west': true }
const TRAPPED = { ...NONE, 'remove-guard-and-apply': true }

describe('terraform-module-key-removed on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
  })

  it('(a) the first plan is a partial plan: west is destroyed because its key is not in configuration, then prevent_destroy fails; nothing is credited', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform plan', 'terraform state list')
    const plan = out[1]
    expect(plan.exitCode).toBe(1)
    expect(plan.output).toContain('Terraform planned the following actions, but then encountered a problem:')
    expect(plan.output).toContain('  # module.stack["west"].aws_vpc.main will be destroyed\n  # (because module.stack["west"] is not in configuration)')
    expect(plan.output).toContain('  # module.stack["west"].module.data.aws_db_instance.main will be destroyed')
    expect(plan.output).not.toContain('module.stack["east"].aws_vpc.main will')
    expect(plan.output).toContain('Plan: 0 to add, 0 to change, 2 to destroy.\n╷\n│ Error: Instance cannot be destroyed')
    expect(plan.output).toContain('Resource module.stack["west"].module.data.aws_db_instance.main has')
    expect(plan.hits).toEqual(expect.arrayContaining(['evidence:prevent-destroy-saved-you', 'evidence:west-not-in-config']))
    expect(out[2].output.trim().split('\n')).toEqual(BOTH)
    expect(out[2].hits).toContain('evidence:west-in-state')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b) fix A: restore west in var.regions, plan is clean, nothing destroyed', async () => {
    const { sh, out } = await play('cd ~/infra', RESTORE, 'terraform plan', 'terraform state list')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('No changes.')
    expect(out[3].output.trim().split('\n')).toEqual(BOTH)
    expect(await detectedAll(sh)).toEqual(RESTORED)
    for (const [type, id] of [['aws_db_instance', WEST_DB], ['aws_vpc', WEST_VPC]]) expect(await sh.doneWhen({ reality_has: { type, id } })).toBe(true)
  })

  it('(b1) restoring through a different spelling of the set also counts (world-based)', async () => {
    const { sh, out } = await play('cd ~/infra', `sed -i 's/default = \\["east"\\]/default = ["west", "east"]/' variables.tf`, 'terraform apply -auto-approve')
    expect(out[2].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(RESTORED)
  })

  it('(c) fix B: state rm of the west module instance (single-quoted, double-quoted, escaped), plan clean, AWS untouched', async () => {
    for (const rm of [RM, `terraform state rm "module.stack[\\"west\\"]"`, 'terraform state rm module.stack\\[\\"west\\"\\]']) {
      const { sh, out } = await play('cd ~/infra', rm, 'terraform state list', 'terraform plan')
      expect(out[1].exitCode, rm).toBe(0)
      expect(out[1].output).toContain('Successfully removed 2 resource instance(s).')
      expect(out[2].output.trim().split('\n')).toEqual([BOTH[0], BOTH[2]])
      expect(out[3].output).toContain('No changes.')
      expect(await detectedAll(sh)).toEqual(FORGOTTEN)
      expect(await sh.doneWhen({ reality_has: { type: 'aws_db_instance', id: WEST_DB } })).toBe(true)
    }
  })

  it('(c1) state rm of a single object, or of the nested module only, is not enough', async () => {
    const one = await play('cd ~/infra', `terraform state rm 'module.stack["west"].module.data'`, 'terraform plan')
    expect(one.out[2].exitCode).toBe(0)
    expect(one.out[2].output).toContain('# module.stack["west"].aws_vpc.main will be destroyed')
    expect(await detectedAll(one.sh)).toEqual(NONE)
    // the vpc has no guard: applying now would delete the west VPC; the fix needs west fully forgotten
    const half = await play('cd ~/infra', `terraform state rm 'module.stack["west"].aws_vpc.main'`, 'terraform plan')
    expect(half.out[2].exitCode).toBe(1)
    expect(await detectedAll(half.sh)).toEqual(NONE)
  })

  it('(d) trap: removing prevent_destroy and applying destroys the west database and VPC; no fix can be earned afterwards', async () => {
    const { sh, out } = await play('cd ~/infra', UNGUARD, 'terraform apply -auto-approve')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('module.stack["west"].module.data.aws_db_instance.main: Destroying... [id=orders-west]')
    expect(out[2].output).toContain('Apply complete! Resources: 0 added, 0 changed, 2 destroyed.')
    expect(await sh.doneWhen({ reality_lacks: { type: 'aws_db_instance', id: WEST_DB } })).toBe(true)
    expect(await detectedAll(sh)).toEqual(TRAPPED)
    for (const l of [RESTORE, 'terraform apply -auto-approve']) await sh.run(l, atStage(scenario, 0), new Set())
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('(d1) removing the guard without applying is neither fix nor trap', async () => {
    const { sh, out } = await play('cd ~/infra', UNGUARD, 'terraform plan')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('Plan: 0 to add, 0 to change, 2 to destroy.')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(e) -target east: a no-op for west that warns; the next plain plan is as dangerous; world is untouched', async () => {
    const { sh, out } = await play('cd ~/infra', `terraform apply -target='module.stack["east"]' -auto-approve`, 'terraform plan', 'terraform plan -target=module.stack[\\"east\\"]')
    expect(out[1].exitCode).toBe(0)
    expect(out[1].output).toContain('Warning: Applied changes may be incomplete')
    expect(out[1].output).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.')
    expect(out[2].exitCode).toBe(1)
    expect(out[2].output).toContain('Error: Instance cannot be destroyed')
    expect(out[3].output).toContain('Warning: Resource targeting is in effect')
    expect(await detectedAll(sh)).toEqual(NONE)
    expect(await sh.doneWhen({ reality_has: { type: 'aws_db_instance', id: WEST_DB } })).toBe(true)
    // still fixable afterwards
    await sh.run(RESTORE, atStage(scenario, 0), new Set())
    expect(await detectedAll(sh)).toEqual(RESTORED)
  })

  it('(f) targeting west for destroy is refused by the guard (no way around it through -target)', async () => {
    const { sh, out } = await play('cd ~/infra', `terraform apply -target='module.stack["west"]' -auto-approve`)
    expect(out[1].exitCode).toBe(1)
    expect(out[1].output).toContain('Error: Instance cannot be destroyed')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(g) terraform destroy is refused by the guard; the button-only wrong action is never detected', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform destroy -auto-approve')
    expect(out[1].exitCode).toBe(1)
    expect(await detectedAll(sh)).toEqual(NONE)
    expect(await sh.doneWhen({ reality_has: { type: 'aws_db_instance', id: 'orders-east' } })).toBe(true)
  })

  it('(h) the scripted git and AWS lookups answer and carry notes', async () => {
    const { out } = await play('cd ~/infra', 'git diff main', 'git log --oneline', 'cat variables.tf', 'cat modules/stack/data/main.tf', 'aws rds describe-db-instances')
    expect(out[1].output).toContain('-  default = ["east", "west"]')
    expect(out[2].output).toContain('cleanup: drop the west region')
    expect(out[3].output).toContain('default = ["east"]')
    expect(out[4].output).toContain('prevent_destroy = true')
    expect(out[5].output).toContain('"DBInstanceIdentifier": "orders-west"')
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.match!], c.match).toBeDefined()
  })

  it('(i) every key evidence tag is awarded before the fix', async () => {
    const { out } = await play('cd ~/infra', 'terraform plan', 'terraform state list', 'git diff main', 'aws rds describe-db-instances')
    const hits = out.flatMap((r) => r.hits)
    const tags = new Set([
      ...hits.filter((h) => h.startsWith('evidence:')).map((h) => h.slice('evidence:'.length)),
      ...scenario.terminal!.commands.filter((c) => c.match && hits.includes(c.match)).map((c) => c.evidence),
    ])
    for (const t of scenario.key_evidence) expect(tags.has(t), t).toBe(true)
  })
})
