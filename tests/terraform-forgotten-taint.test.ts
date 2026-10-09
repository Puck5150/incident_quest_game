import { describe, expect, it } from 'vitest'
import { engineHandles, evidenceSeen, terminalOutput, type GameEvent } from '../src/game/engine.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-forgotten-taint')
const { play, detectedAll } = playbook(scenario)

const WEB_ID = 'i-0c3f7a9e5d1b2c846'
const NONE = { untaint: false, 'apply-the-pr': false, 'revert-the-tag': false }
const FIXED = { ...NONE, untaint: true }
const TRAPPED = { ...NONE, 'apply-the-pr': true }

describe('terraform-forgotten-taint on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
  })

  it('(a) the plan replaces the web instance because it is tainted, with the tag change in the diff', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform plan')
    const plan = out[1]
    expect(plan.exitCode).toBe(0)
    expect(plan.output).toContain('  # aws_instance.web is tainted, so must be replaced\n-/+ resource "aws_instance" "web" {')
    expect(plan.output).toContain('"CostCenter" = "1234"')
    expect(plan.output).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
    expect(plan.output).not.toContain('forces replacement')
    expect(plan.hits).toContain('evidence:replace-planned')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b) state show marks the instance tainted', async () => {
    const { out } = await play('cd ~/infra', 'terraform state show aws_instance.web')
    expect(out[1].output).toContain('# aws_instance.web: (tainted)')
    expect(out[1].hits).toContain('evidence:tainted-in-state')
  })

  it('(c) ideal path: untaint, the plan is an in-place tag update, apply changes it without a delete', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform untaint aws_instance.web', 'terraform plan')
    expect(out[1].exitCode).toBe(0)
    expect(out[1].output).toContain('Resource instance aws_instance.web has been successfully untainted.')
    const plan = out[2].output
    expect(plan).toContain('  # aws_instance.web will be updated in-place\n  ~ resource "aws_instance" "web" {')
    expect(plan).toContain('+ "CostCenter" = "1234"')
    expect(plan).not.toContain('must be replaced')
    expect(plan).toContain('Plan: 0 to add, 1 to change, 0 to destroy.')
    expect(await detectedAll(sh)).toEqual(FIXED)
    const apply = await sh.run('echo yes | terraform apply', atStage(scenario, 0), new Set())
    expect(apply.exitCode).toBe(0)
    expect(apply.output).toContain(`aws_instance.web: Modifying... [id=${WEB_ID}]`)
    expect(apply.output).toContain('Apply complete! Resources: 0 added, 1 changed, 0 destroyed.')
    expect(apply.output).not.toContain('Destroying')
    expect(await sh.doneWhen({ reality_has: { type: 'aws_instance', id: WEB_ID } })).toBe(true)
    expect((await sh.run('terraform plan', atStage(scenario, 0), new Set())).output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(d) trap: applying with the taint replaces production; untainting afterwards cannot earn the fix', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform apply -auto-approve')
    const apply = out[1].output
    expect(out[1].exitCode).toBe(0)
    expect(apply).toContain(`aws_instance.web: Destroying... [id=${WEB_ID}]`)
    expect(apply).toContain('Apply complete! Resources: 1 added, 0 changed, 1 destroyed.')
    expect(await sh.doneWhen({ reality_lacks: { type: 'aws_instance', id: WEB_ID } })).toBe(true)
    expect(await detectedAll(sh)).toEqual(TRAPPED)
    const untaint = await sh.run('terraform untaint aws_instance.web', atStage(scenario, 0), new Set())
    expect(untaint.exitCode).toBe(1)
    expect((await sh.run('terraform plan', atStage(scenario, 0), new Set())).output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('(e) -replace is the deliberate way: after untaint, plan -replace shows a requested replacement', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform untaint aws_instance.web', 'terraform plan -replace=aws_instance.web')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('  # aws_instance.web will be replaced, as requested\n-/+ resource "aws_instance" "web" {')
    expect(out[2].output).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
    // planning changes nothing: the fix still holds
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(f) untainting an instance that is not tainted is an error and changes nothing', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform untaint aws_instance.web', 'terraform untaint aws_instance.web')
    expect(out[2].exitCode).toBe(1)
    expect(out[2].output).toContain('Error: Resource instance is not tainted')
    expect(out[2].output).toContain('│ Resource instance aws_instance.web is not currently tainted, and so it\n│ cannot be untainted.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('state rm alone is not the fix: the plan creates a second web server', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform state rm aws_instance.web', 'terraform plan')
    expect(out[2].output).toContain('  # aws_instance.web will be created')
    expect(out[2].output).toContain('Plan: 1 to add, 0 to change, 0 to destroy.')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('state rm then apply launches a duplicate web server: destructive, not the fix', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform state rm aws_instance.web', 'terraform apply -auto-approve')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('aws_instance.web: Creating...')
    expect(out[2].output).toContain('Apply complete! Resources: 1 added, 0 changed, 0 destroyed.')
    expect(out[2].output).not.toContain('Destroying')
    // the old instance still runs, unmanaged, next to the new one
    expect(await sh.doneWhen({ reality_has: { type: 'aws_instance', id: WEB_ID } })).toBe(true)
    expect(await sh.doneWhen({ applied: { op: 'create', address: 'aws_instance.web' } })).toBe(true)
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('bonus route: state rm then import also leaves no destroy in the plan', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform state rm aws_instance.web', `terraform import aws_instance.web ${WEB_ID}`, 'terraform plan')
    expect(out[2].exitCode).toBe(0)
    expect(out[3].output).toContain('Plan: 0 to add, 1 to change, 0 to destroy.')
    expect(await detectedAll(sh)).toEqual(FIXED)
    const apply = await sh.run('terraform apply -auto-approve', atStage(scenario, 0), new Set())
    expect(apply.output).toContain('Apply complete! Resources: 0 added, 1 changed, 0 destroyed.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('the engine answers the history lookups with only the old matching lines, and they award taint-history', () => {
    const log: GameEvent[] = []
    for (const cmd of ['history | grep taint', 'history|grep taint', 'history | grep -i TAINT', "history | grep 'taint'", 'history | grep terraform']) {
      expect(engineHandles(scenario, cmd, []), cmd).toBe(true)
      const shown = terminalOutput(scenario, cmd, [])
      expect(shown, cmd).toContain(' 1874  2026-09-29 16:42:07 terraform taint aws_instance.web')
      expect(shown, cmd).not.toContain('grep')
      log.push({ type: 'RUN_COMMAND', input: cmd, at: 0 })
    }
    expect(terminalOutput(scenario, 'history | grep terraform', []).split('\n')).toEqual([
      ' 1872  2026-09-29 16:40:12 terraform plan',
      ' 1873  2026-09-29 16:41:30 terraform state show aws_instance.web',
      ' 1874  2026-09-29 16:42:07 terraform taint aws_instance.web',
    ])
    expect(evidenceSeen(scenario, [{ type: 'RUN_COMMAND', input: 'history | grep taint', at: 0 }]).has('taint-history')).toBe(true)
    // plain history is the session's own list, answered by the engine
    expect(terminalOutput(scenario, 'history', log)).not.toContain('terraform taint')
  })

  it('the scripted lookups answer and carry notes', async () => {
    const { out } = await play('cd ~/infra', 'git diff main -- web.tf', `aws ec2 describe-instances --instance-ids ${WEB_ID}`, 'grep taint ~/.bash_history')
    expect(out[1].output).toContain('+    CostCenter = "1234"')
    expect(out[2].output).toContain(`"InstanceId": "${WEB_ID}"`)
    expect(out[3].output).toContain('terraform taint aws_instance.web')
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.match ?? c.example!], c.match ?? c.example).toBeDefined()
  })

  it('(g) every key evidence tag is awarded before any fix', async () => {
    const shell = ['cd ~/infra', 'terraform plan', 'terraform state show aws_instance.web', 'git diff main -- web.tf']
    const { out } = await play(...shell)
    const hits = out.flatMap((r) => r.hits)
    // history is answered by the engine, not the shell: its tag comes from the game log.
    expect(engineHandles(scenario, 'history | grep taint', [])).toBe(true)
    const tags = new Set([
      ...hits.filter((h) => h.startsWith('evidence:')).map((h) => h.slice('evidence:'.length)),
      ...scenario.terminal!.commands.filter((c) => c.match && hits.includes(c.match)).map((c) => c.evidence),
      ...evidenceSeen(scenario, [{ type: 'RUN_COMMAND', input: 'history | grep taint', at: 0 }]),
    ])
    for (const t of scenario.key_evidence) expect(tags.has(t), t).toBe(true)
  })
})
