import { describe, expect, it } from 'vitest'
import { evidenceSeen } from '../src/game/engine.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-ignore-changes-autoscaling')
const { play, detectedAll } = playbook(scenario)

const NONE = { 'ignore-desired': false, 'set-12': false, 'remove-autoscaling': false, 'apply-at-night': false }
const FIXED = { ...NONE, 'ignore-desired': true }
const TRAPPED = { ...NONE, 'apply-at-night': true }
const ID = 'arn:aws:ecs:us-east-1:123456789012:service/prod/checkout'

const ECS = (extra = '', count = '2') => `cat > ecs.tf <<'EOF'
resource "aws_ecs_service" "checkout" {
  name            = "checkout"
  cluster         = "prod"
  task_definition = "checkout:42"
  desired_count   = ${count}
${extra}}
EOF`
const LC = (list: string) => `\n  lifecycle {\n    ignore_changes = ${list}\n  }\n`
const COUNT = (sh: { doneWhen: (d: never) => Promise<boolean> }, n: number) =>
  sh.doneWhen({ reality_has: { type: 'aws_ecs_service', id: ID, attr: 'desired_count', equals: n } } as never)

describe('terraform-ignore-changes-autoscaling on the simulator', () => {
  it('is backed by the simulator; only the aws commands are scripted', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.map((c) => (c.match ?? c.example)!.split(' ').slice(0, 3).join(' '))).toEqual(['aws application-autoscaling describe-scalable-targets', 'aws ecs describe-services'])
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.match ?? c.example!]).toBeDefined()
  })

  it('keeps the old action ids, kinds, solution path and evidence tags', () => {
    expect(scenario.actions.map((a) => [a.id, a.kind])).toEqual([
      ['ignore-desired', 'fix'],
      ['set-12', 'wrong'],
      ['remove-autoscaling', 'destructive'],
      ['apply-at-night', 'wrong'],
    ])
    expect(scenario.solution_paths).toEqual([['ignore-desired']])
    expect(scenario.key_evidence).toEqual(['plan-reset', 'autoscaling', 'desired-fixed'])
  })

  it('(a) the real plan resets 12 to 2; evidence plan-reset and desired-fixed; nothing credited', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform plan')
    expect(out[1].output).toContain('# aws_ecs_service.checkout will be updated in-place')
    expect(out[1].output).toContain('~ desired_count   = 12 -> 2')
    expect(out[1].output).toContain('Plan: 0 to add, 1 to change, 0 to destroy.')
    expect(out[1].hits).toContain('evidence:plan-reset')
    expect(out[1].hits).toContain('evidence:desired-fixed')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b) the scripted autoscaling command earns its evidence and the service reads 12', async () => {
    const cmd = 'aws application-autoscaling describe-scalable-targets --service-namespace ecs --resource-ids service/prod/checkout --query ScalableTargets[0].[MinCapacity,MaxCapacity]'
    const { out } = await play(cmd, 'aws ecs describe-services --cluster prod --services checkout --query services[0].desiredCount')
    expect(out[0].output).toContain('20')
    expect(evidenceSeen(scenario, [{ type: 'RUN_COMMAND', input: cmd, at: 0 }]).has('autoscaling')).toBe(true)
    expect(out[1].output.trim()).toBe('12')
  })

  it('(c) ideal: ignore_changes via heredoc; the plan is clean; apply changes nothing; reality stays 12', async () => {
    const { sh, out } = await play('cd ~/infra', ECS(LC('[desired_count]')), 'terraform plan')
    expect(out[2].output).toContain('No changes. Your infrastructure matches the configuration.')
    expect(await detectedAll(sh)).toEqual(FIXED)
    const apply = await sh.run('terraform apply -auto-approve', scenario as never, new Set())
    expect(apply.output).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.')
    expect(await COUNT(sh, 12)).toBe(true)
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(d) ideal via sed on the checked-out file', async () => {
    const { sh, out } = await play('cd ~/infra', `sed -i 's|^  desired_count.*|&\\n  lifecycle {\\n    ignore_changes = [desired_count]\\n  }|' ecs.tf`, 'terraform plan')
    expect(out[2].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(e) list spellings: one line, multi-line, with other attributes, spacing', async () => {
    for (const list of ['[desired_count]', '[ desired_count ]', '[\n      desired_count,\n    ]', '["desired_count"]', '[desired_count,]']) {
      const { sh, out } = await play('cd ~/infra', ECS(LC(list)), 'terraform plan')
      expect(out[2].output, list).toContain('No changes.')
      expect(await detectedAll(sh), list).toEqual(FIXED)
    }
  })

  it('(e1) ignoring more than desired_count (task_definition, tags) is a clean plan but not credited: it hides drift', async () => {
    for (const list of ['[desired_count, task_definition]', '[task_definition, desired_count]', '[desired_count, tags]', '[tags, desired_count]']) {
      const { sh, out } = await play('cd ~/infra', ECS(LC(list)), 'terraform plan')
      expect(out[2].output, list).toContain('No changes.')
      expect(await detectedAll(sh), list).toEqual(NONE)
    }
  })

  it('(f) ignore_changes = all is a clean plan but not credited (too broad)', async () => {
    const { sh, out } = await play('cd ~/infra', ECS(LC('all')), 'terraform plan')
    expect(out[2].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(g) ignoring another attribute still resets the count: not credited', async () => {
    const { sh, out } = await play('cd ~/infra', ECS(LC('[tags]')), 'terraform plan')
    expect(out[2].output).toContain('12 -> 2')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(h) typo ignore_change fails the plan and no credit', async () => {
    const { sh, out } = await play('cd ~/infra', ECS('\n  lifecycle {\n    ignore_change = [desired_count]\n  }\n'), 'terraform plan')
    expect(out[2].exitCode).toBe(1)
    expect(out[2].output).toContain('Error:') // the engine reports the stray name as an Invalid reference
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(i) set-12: the plan is clean but hard-coding the autoscaler number is not the fix', async () => {
    const { sh, out } = await play('cd ~/infra', ECS('', '12'), 'terraform plan')
    expect(out[2].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(j) trap: apply first resets reality to 2; ignore_changes afterwards never earns the fix', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform apply -auto-approve')
    expect(out[1].output).toContain('Apply complete! Resources: 0 added, 1 changed, 0 destroyed.')
    expect(await COUNT(sh, 2)).toBe(true)
    expect(await detectedAll(sh)).toEqual(TRAPPED)
    await sh.run(ECS(LC('[desired_count]')), scenario as never, new Set())
    expect((await sh.run('terraform plan', scenario as never, new Set())).output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('(k) trap spelling: answering yes to a plain apply is the same damage', async () => {
    const { sh } = await play('cd ~/infra', 'echo yes | terraform apply')
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('(l) stuck: a broken ecs.tf credits nothing; state rm of the service is not the fix', async () => {
    const broken = await play('cd ~/infra', 'echo "resource {" >> ecs.tf', 'terraform plan')
    expect(broken.out[2].exitCode).toBe(1)
    expect(await detectedAll(broken.sh)).toEqual(NONE)
    const rm = await play('cd ~/infra', ECS(LC('[desired_count]')), 'terraform state rm aws_ecs_service.checkout', 'terraform plan')
    expect(await detectedAll(rm.sh)).toEqual(NONE)
  })
})
