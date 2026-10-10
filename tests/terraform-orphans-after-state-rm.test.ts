import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { evidenceSeen } from '../src/game/engine.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-orphans-after-state-rm')
const { play, detectedAll } = playbook(scenario)

const NONE = { 'unlock-and-import': false, 'destroy-environment': false, 'bypass-lock': false, 'apply-recreate': false, 'state-rm-rest': false, 'lock-timeout': false }
const LOCK_ID = '7e3b9d41-5c2a-8f06-b1d7-a94e2c60f385'
const CD = 'cd ~/reports-infra'
const UNLOCK = `terraform force-unlock -force ${LOCK_ID}`
const IMP_W = 'terraform import aws_instance.worker i-0c7f3a9d1e5b24680'
const IMP_D = 'terraform import aws_db_instance.reports reports-db'
const D = 'terraform destroy -auto-approve'
const A = 'terraform apply -auto-approve'
const ran = (cmd: string) => evidenceSeen(scenario, [{ type: 'RUN_COMMAND', input: cmd, at: 0 }])

describe('terraform-orphans-after-state-rm', () => {
  it('lock blocks plan/destroy/import/state rm; read-only commands work', async () => {
    const { sh, out } = await play(CD, 'terraform plan', D, IMP_W, 'terraform state rm aws_vpc.main', 'terraform state list')
    for (const i of [1, 2, 3, 4]) {
      expect(out[i].exitCode, `${i}`).toBe(1)
      expect(out[i].output).toContain('Error acquiring the state lock')
    }
    expect(out[1].hits).toContain('evidence:lock-holder')
    expect(out[5].output.trim().split('\n').sort()).toEqual(['aws_security_group.app', 'aws_subnet.app', 'aws_vpc.main'])
    expect(out[5].hits).toContain('evidence:orphans-not-in-state')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('evidence is obtainable before any change, in several spellings', () => {
    for (const c of ['cat marta-destroy.txt', 'less marta-destroy.txt', 'tail -n 20 marta-destroy.txt']) expect(ran(c).has('marta-dead'), c).toBe(true)
    expect(ran('cat NOTES.md').has('sprint-notes')).toBe(true)
    for (const c of ['aws ec2 describe-instances --instance-ids i-0c7f3a9d1e5b24680', 'aws ec2 describe-instances --output json --instance-ids i-0c7f3a9d1e5b24680 --region us-east-1', "aws ec2 describe-instances --filters 'Name=tag:Name,Values=worker'"]) expect(ran(c).has('worker-running'), c).toBe(true)
    for (const c of ['aws rds describe-db-instances', 'aws rds describe-db-instances --db-instance-identifier reports-db --output json']) expect(ran(c).has('db-running'), c).toBe(true)
    expect(ran('aws sts get-caller-identity').has('admin-role')).toBe(true)
  })

  it('plan -lock=false only reads: not a trap', async () => {
    const { sh, out } = await play(CD, 'terraform plan -lock=false')
    expect(out[1].exitCode).toBe(0)
    expect(out[1].output).toContain('Plan: 2 to add, 0 to change, 0 to destroy.')
    expect(out[1].hits).toContain('evidence:plan-wants-create')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('after unlocking: plan wants two creates, destroy stops on dependencies and deletes nothing', async () => {
    const { sh, out } = await play(CD, UNLOCK, 'terraform plan', D, 'terraform state list', 'terraform apply -auto-approve -lock=false')
    expect(out[2].output).toContain('# aws_instance.worker will be created')
    expect(out[2].output).toContain('# aws_db_instance.reports will be created')
    expect(out[3].exitCode).toBe(1)
    expect(out[3].output).toContain('DependencyViolation')
    expect(out[3].hits).toContain('evidence:destroy-blocked')
    expect(out[4].output.trim().split('\n').sort()).toEqual(['aws_security_group.app', 'aws_subnet.app', 'aws_vpc.main'])
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'apply-recreate': true })
  })

  for (const imports of [[IMP_W, IMP_D], [IMP_D, IMP_W]])
    it(`ideal path (${imports[0].split(' ')[2]} first): unlock, import both, destroy; cloud empty, idempotent`, async () => {
      const { sh, out } = await play(CD, 'terraform plan', 'cat marta-destroy.txt', `echo yes | terraform force-unlock ${LOCK_ID}`, ...imports, 'terraform state list', D, D, 'terraform state list')
      expect(out[3].output).toContain('Terraform state has been successfully unlocked!')
      expect(out[4].output).toContain('Import successful!')
      expect(out[5].output).toContain('Import successful!')
      expect(out[6].output).toContain('aws_instance.worker')
      expect(out[7].exitCode).toBe(0)
      expect(out[7].output).toContain('Destroy complete! Resources: 5 destroyed.')
      expect(out[8].output).toContain('Destroy complete! Resources: 0 destroyed.')
      expect(out[9].output.trim()).toBe('')
      // unlock-and-import is a state_has check: the engine latches it once seen, the helper re-reads the final (empty) world
      expect(await detectedAll(sh)).toEqual({ ...NONE, 'destroy-environment': true })
      // the scripted describes follow the world
      const r = await sh.run('aws rds describe-db-instances', atStage(scenario, 0), new Set(['destroy-environment']))
      expect(r.output).toContain('"DBInstances": []')
    })

  it('imports credit the first fix step before the destroy', async () => {
    const { sh } = await play(CD, UNLOCK, IMP_W, IMP_D)
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'unlock-and-import': true })
    const half = await play(CD, UNLOCK, IMP_W)
    expect(await detectedAll(half.sh)).toEqual(NONE)
  })

  it('import blocks work as a spelling of the import step', async () => {
    const add = `printf 'import {\\n  to = aws_instance.worker\\n  id = "i-0c7f3a9d1e5b24680"\\n}\\nimport {\\n  to = aws_db_instance.reports\\n  id = "reports-db"\\n}\\n' >> main.tf`
    const { sh, out } = await play(CD, UNLOCK, add, A, D)
    expect(out[3].exitCode).toBe(0)
    expect(out[4].exitCode).toBe(0)
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'destroy-environment': true })
  })

  it('trap: -lock=false on import, state rm or destroy-that-succeeds is a recorded bypass and the fix is never credited', async () => {
    const { sh, out } = await play(CD, `${IMP_W} -lock=false`, `${IMP_D} -lock=false`, UNLOCK, D)
    expect(out[1].exitCode).toBe(0)
    expect(out[4].output).toContain('Destroy complete! Resources: 5 destroyed.')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'bypass-lock': true })
    const rm = await play(CD, 'terraform state rm -lock=false aws_vpc.main')
    expect(await detectedAll(rm.sh)).toEqual({ ...NONE, 'bypass-lock': true, 'state-rm-rest': true })
  })

  it('a failed destroy -lock=false deletes nothing', async () => {
    const { sh, out } = await play(CD, `${D} -lock=false`, 'terraform state list')
    expect(out[1].exitCode).toBe(1)
    expect(out[2].output.trim().split('\n')).toHaveLength(3)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('trap: apply after unlock duplicates the worker, db create fails; recovery by targeted destroy + import is possible', async () => {
    const { sh, out } = await play(CD, UNLOCK, A, 'terraform state list')
    expect(out[2].exitCode).toBe(1)
    expect(out[2].output).toContain('aws_instance.worker: Creation complete')
    expect(out[2].output + (out[2] as { stderr?: string }).stderr).toContain('DBInstanceAlreadyExists')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'apply-recreate': true })
    const more = await play(CD, UNLOCK, A, 'terraform destroy -target=aws_instance.worker -auto-approve', IMP_W, IMP_D, D)
    expect(more.out[3].exitCode).toBe(0)
    expect(more.out[6].exitCode).toBe(0)
    expect(await detectedAll(more.sh)).toEqual({ ...NONE, 'destroy-environment': true, 'apply-recreate': true })
  })

  it('trap: state rm of the network after unlock orphans it', async () => {
    const { sh, out } = await play(CD, UNLOCK, 'terraform state rm aws_vpc.main aws_subnet.app aws_security_group.app', D, IMP_W, IMP_D, D)
    expect(out[2].exitCode).toBe(0)
    expect(out[3].exitCode).toBe(0)
    // the worker and db are gone but the network stays in AWS, unmanaged: the fix is not earned
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'state-rm-rest': true })
    // recoverable: import the network back, destroy again
    const back = await play(CD, UNLOCK, 'terraform state rm aws_vpc.main aws_subnet.app aws_security_group.app', 'terraform import aws_vpc.main vpc-07c1e4a9d2b36f850', 'terraform import aws_subnet.app subnet-0a5d9c3f7e12b8460', 'terraform import aws_security_group.app sg-0b8e2d6a4c1f97350', IMP_W, IMP_D, D)
    expect(back.out[7].exitCode).toBe(0)
    expect(await detectedAll(back.sh)).toEqual({ ...NONE, 'destroy-environment': true })
  })

  it('unlock alone, or import without unlock, is not the whole fix', async () => {
    const a = await play(CD, UNLOCK)
    expect(await detectedAll(a.sh)).toEqual(NONE)
    const b = await play(CD, IMP_W)
    expect(b.out[1].exitCode).toBe(1)
    expect(await detectedAll(b.sh)).toEqual(NONE)
  })

  it('every key evidence tag is awarded before any unlock', () => {
    const seen = evidenceSeen(scenario, [
      { type: 'RUN_COMMAND', input: 'cat marta-destroy.txt', at: 0 },
      { type: 'RUN_COMMAND', input: 'aws ec2 describe-instances', at: 1 },
      { type: 'RUN_COMMAND', input: 'aws rds describe-db-instances', at: 2 },
      { type: 'RUN_COMMAND', input: 'aws sts get-caller-identity', at: 3 },
      { type: 'SHELL_RAN', commands: ['evidence:lock-holder', 'evidence:orphans-not-in-state'], at: 4 },
    ])
    for (const t of scenario.key_evidence) expect(seen.has(t), t).toBe(true)
  })
})
