import { describe, expect, it } from 'vitest'
import { evidenceSeen } from '../src/game/engine.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('wrong-workspace-major')
const { play, detectedAll } = playbook(scenario)

const NONE = { 'prod-apply': false, 'workspace-guard': false, 'select-staging': false, 'state-rm': false, 'destroy-prod': false, 'console-resize': false }
const PROD = 'terraform apply -auto-approve -var-file=prod.tfvars'
const STG = 'terraform apply -auto-approve -var-file=staging.tfvars'
const DONE = { 'prod-apply': true }
const reality = (sh: Awaited<ReturnType<typeof play>>['sh'], id: string, equals: string) =>
  sh.doneWhen({ reality_has: { type: 'aws_db_instance', id, attr: 'instance_class', equals } } as never)

describe('wrong-workspace-major on the simulator', () => {
  it('ids, kinds, stages and the scripted aws commands are kept', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.actions.map((a) => [a.id, a.kind])).toEqual([
      ['prod-apply', 'fix'], ['workspace-guard', 'fix'], ['select-staging', 'wrong'], ['state-rm', 'destructive'], ['destroy-prod', 'destructive'], ['console-resize', 'wrong'],
    ])
    expect(atStage(scenario, 0).solution_paths).toEqual([['prod-apply', 'workspace-guard']])
    expect(scenario.stages!.map((s) => s.id)).toEqual(['pending', 'sync-failed'])
    expect(scenario.terminal!.commands.some((c) => c.match === 'terraform workspace show')).toBe(false)
    const aws = scenario.terminal!.commands.filter((c) => c.match!.startsWith('aws rds describe'))
    expect(aws.map((c) => c.when_actions ?? [])).toEqual([['prod-apply', 'apply-now'], ['prod-apply'], []])
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.example ?? c.match!]).toBeDefined()
  })

  it('(a) workspace show / list: prod is selected, staging exists, evidence ws-prod', async () => {
    const { sh, out } = await play('cd ~/infra/data', 'terraform workspace show', 'terraform workspace list')
    expect(out[1].output.trim()).toBe('prod')
    expect(out[1].hits).toContain('evidence:ws-prod')
    expect(out[2].output).toContain('* prod')
    expect(out[2].output).toContain('  staging')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b) three plans: no var-file errors, staging.tfvars sees nothing to do, prod.tfvars resizes back', async () => {
    const { sh, out } = await play('cd ~/infra/data', 'terraform plan', 'terraform plan -var-file=staging.tfvars', 'terraform plan -var-file=prod.tfvars')
    expect(out[1].exitCode).not.toBe(0)
    expect(out[1].output).toContain('No value for required variable')
    expect(out[2].output).toContain('No changes.')
    expect(out[3].output).toMatch(/~ instance_class\s+= "db\.t4g\.medium" -> "db\.r6g\.xlarge"/)
    expect(out[3].output).toContain('Plan: 0 to add, 1 to change, 0 to destroy.')
    expect(out[3].output).not.toContain('forces replacement')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(c) ideal: prod.tfvars applied in prod credits prod-apply; plan afterwards is clean; the scripted aws commands follow', async () => {
    const { sh, out } = await play('cd ~/infra/data', PROD, 'terraform plan -var-file=prod.tfvars')
    expect(out[1].output).toContain('Apply complete! Resources: 0 added, 1 changed, 0 destroyed.')
    expect(out[2].output).toContain('No changes.')
    expect(await reality(sh, 'orders-prod', 'db.r6g.xlarge')).toBe(true)
    expect(await detectedAll(sh)).toEqual({ ...NONE, ...DONE })
  })

  it('(c2) spellings: -var-file prod.tfvars and an explicit -var also fix prod; the plan-then-apply flow too', async () => {
    for (const cmd of ['terraform apply -auto-approve -var-file prod.tfvars', 'terraform apply -auto-approve -var-file=prod.tfvars -var-file=prod.tfvars']) {
      const { sh } = await play('cd ~/infra/data', cmd)
      expect((await detectedAll(sh))['prod-apply'], cmd).toBe(true)
    }
    const { sh } = await play('cd ~/infra/data', 'terraform plan -var-file=prod.tfvars -out=p', 'terraform apply p')
    expect((await detectedAll(sh))['prod-apply']).toBe(true)
  })

  it('(d) staging.tfvars in prod credits nothing: prod is already a db.t4g.medium', async () => {
    const { sh } = await play('cd ~/infra/data', STG)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(e) select staging and apply staging.tfvars: only staging changes, flagged wrong, prod untouched', async () => {
    const { sh, out } = await play('cd ~/infra/data', 'terraform workspace select staging', STG, 'terraform workspace select prod', 'terraform plan -var-file=prod.tfvars')
    expect(out[2].output).toContain('1 changed')
    expect(out[4].output).toContain('db.t4g.medium" -> "db.r6g.xlarge"')
    expect(await reality(sh, 'orders-prod', 'db.t4g.medium')).toBe(true)
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'select-staging': true })
  })

  it('(f) prod.tfvars applied while in staging changes staging only: no credit for prod-apply', async () => {
    const { sh } = await play('cd ~/infra/data', 'terraform workspace select staging', PROD)
    expect(await reality(sh, 'orders-staging', 'db.r6g.xlarge')).toBe(true)
    expect(await reality(sh, 'orders-prod', 'db.t4g.medium')).toBe(true)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(g) state rm: destructive, plan wants a second database, the prod apply then cannot be credited', async () => {
    const { sh, out } = await play('cd ~/infra/data', 'terraform state rm aws_db_instance.orders', 'terraform plan -var-file=prod.tfvars', PROD)
    expect(out[2].output).toContain('Plan: 1 to add, 0 to change, 0 to destroy.')
    expect(out[3].exitCode).not.toBe(0)
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'state-rm': true })
  })

  it('(g2) the fix first, then state rm: sticky, prod-apply is lost and the trap is flagged', async () => {
    const { sh } = await play('cd ~/infra/data', PROD, 'terraform state rm aws_db_instance.orders')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'state-rm': true })
  })

  it('(h) destroy then apply prod.tfvars rebuilds an empty database: destroy-prod flagged, no credit, even though the class matches', async () => {
    const { sh } = await play('cd ~/infra/data', 'terraform destroy -auto-approve', PROD)
    expect(await reality(sh, 'orders-prod', 'db.r6g.xlarge')).toBe(true)
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'destroy-prod': true })
  })

  it('(i) destroy only: nothing credited', async () => {
    const { sh } = await play('cd ~/infra/data', 'terraform destroy -auto-approve')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'destroy-prod': true })
  })

  it('(j) stopgaps never credit prod-apply: -target, -lock=false, -refresh=false, -var, edited tfvars', async () => {
    const P = 'terraform apply -auto-approve'
    const cases: [string, string[]][] = [
      ['-target with prod.tfvars', [`${P} -target=aws_db_instance.orders -var-file=prod.tfvars`]],
      ['-lock=false', [`${P} -lock=false -var-file=prod.tfvars`]],
      ['-refresh=false', [`${P} -refresh=false -var-file=prod.tfvars`]],
      ['-var override of prod.tfvars', [`${P} -var-file=prod.tfvars -var db_instance_class=db.r6g.xlarge`]],
      ['-var only, no tfvars', [`${P} -var db_instance_class=db.r6g.xlarge -var db_apply_immediately=false`]],
      ['staging.tfvars with -var class', [`${P} -var-file=staging.tfvars -var db_instance_class=db.r6g.xlarge`]],
      ['staging.tfvars edited to prod values', ["sed -i 's/db.t4g.medium/db.r6g.xlarge/' staging.tfvars", `${P} -var-file=staging.tfvars`]],
      ['prod.tfvars edited to another class', ["sed -i 's/db.r6g.xlarge/db.r6g.2xlarge/' prod.tfvars", `${P} -var-file=prod.tfvars`]],
      ['two var-files', [`${P} -var-file=staging.tfvars -var-file=prod.tfvars`]],
      ['a copy of the prod values', ['cp -f prod.tfvars other.tfvars', `${P} -var-file=other.tfvars`]],
      ['saved plan made with -target', ['terraform plan -target=aws_db_instance.orders -var-file=prod.tfvars -out=p', 'terraform apply p']],
    ]
    for (const [name, cmds] of cases) {
      const { sh } = await play('cd ~/infra/data', ...cmds)
      expect((await detectedAll(sh))['prod-apply'], name).toBe(false)
    }
  })

  it('(j2) a stopgap apply is sticky: the clean apply afterwards has nothing left to change, so no credit', async () => {
    const { sh } = await play('cd ~/infra/data', `${PROD} -lock=false`.replace('-auto-approve -var-file=prod.tfvars', '-auto-approve -var-file=prod.tfvars'), PROD)
    expect((await detectedAll(sh))['prod-apply']).toBe(false)
  })

  it('(j3) clean spellings still credit: plan -out then apply, ./prod.tfvars, absolute path, -var-file prod.tfvars', async () => {
    for (const cmds of [
      ['terraform plan -var-file=prod.tfvars -out=p', 'terraform apply p'],
      ['terraform apply -auto-approve -var-file=./prod.tfvars'],
      ['terraform apply -auto-approve -var-file=/home/you/infra/data/prod.tfvars'],
      ['terraform workspace select prod', 'terraform apply -auto-approve -var-file prod.tfvars'],
    ]) {
      const { sh } = await play('cd ~/infra/data', ...cmds)
      expect((await detectedAll(sh))['prod-apply'], cmds.join(';')).toBe(true)
    }
  })

  it('(j4) the config passes apply_immediately, and the prod plan shows it going back to false', async () => {
    const { out } = await play('cd ~/infra/data', 'cat main.tf', 'terraform plan -var-file=prod.tfvars')
    expect(out[1].output).toContain('apply_immediately   = var.db_apply_immediately')
    expect(out[2].output).toMatch(/~ apply_immediately\s+= true -> false/)
  })

  it('(k) the guard in main.tf is advice only: editing it in credits nothing (the lab does not simulate preconditions)', async () => {
    const guard = `sed -i '/skip_final_snapshot/a\\\n  lifecycle {\\n    precondition {\\n      condition     = var.environment == terraform.workspace\\n      error_message = "tfvars environment does not match the workspace"\\n    }\\n  }' main.tf`
    const { sh, out } = await play('cd ~/infra/data', guard, 'terraform plan -var-file=staging.tfvars')
    expect(out[2].exitCode).not.toBe(0) // preconditions are not simulated: the guard stays advice, taught in the debrief
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(l) evidence: tfvars grep and db-small are scripted, history is a log', () => {
    const seen = (input: string) => evidenceSeen(scenario, [{ type: 'RUN_COMMAND', input, at: 0 }])
    expect(seen("grep -E 'instance_class|apply_immediately' staging.tfvars prod.tfvars").has('tfvars')).toBe(true)
    expect(seen('aws rds describe-db-instances --db-instance-identifier orders-prod --query "DBInstances[0].[DBInstanceClass,PendingModifiedValues,PreferredMaintenanceWindow]"').has('db-small')).toBe(true)
  })

  it('(m) the scripted grep matches the real tfvars files', async () => {
    const { out } = await play('cd ~/infra/data', "grep -E 'instance_class|apply_immediately' staging.tfvars prod.tfvars", 'cat prod.tfvars')
    const c = scenario.terminal!.commands.find((x) => x.match!.startsWith('grep'))!
    for (const l of c.output.trim().split('\n')) expect(out[2].output + '\n' + out[1].output).toContain(l.split(':')[1])
  })
})
