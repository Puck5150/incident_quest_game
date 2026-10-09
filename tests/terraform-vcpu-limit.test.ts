import { describe, expect, it } from 'vitest'
import { actionFor, engineHandles, evidenceSeen, newSession, step, terminalOutput, type GameEvent } from '../src/game/engine.ts'
import type { IncidentShell } from '../src/game/shell.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-vcpu-limit')
const { play, detectedAll } = playbook(scenario)

const QUOTA = new Set(['request-quota-increase'])
const PARTIAL = ['aws_instance.agent', 'aws_subnet.loadtest', 'aws_vpc.loadtest']
const LIMIT = 'api error VcpuLimitExceeded: You have requested more vCPU capacity than your current vCPU limit of 64 allows for the instance bucket that the specified instance type belongs to. Please visit http://aws.amazon.com/contact-us/ec2-request to request an adjustment to this limit.'
const NONE = { 'right-size': false, 'request-quota-increase': false, 'finish-apply': false, 'destroy-everything': false, 'switch-region': false }
const RIGHT_SIZED = { ...NONE, 'right-size': true }
const FINISHED = { ...NONE, 'finish-apply': true }
const TRAPPED = { ...NONE, 'destroy-everything': true }
const REQUEST = 'aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 128'
const SIZE = (t: string) => `sed -i 's/c5\\.24xlarge/${t}/' compute.tf`

const run = (sh: IncidentShell, line: string, taken = new Set<string>()) => sh.run(line, atStage(scenario, 0), taken)
const stateList = async (sh: IncidentShell) => (await run(sh, 'terraform state list')).output.split('\n').filter(Boolean)
const failedApply = () => play('cd ~/loadtest-infra', 'terraform apply -auto-approve')

describe('terraform-vcpu-limit on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
  })

  it('the first apply creates the network and the agent, then fails at loadgen with VcpuLimitExceeded; state is partial', async () => {
    const { sh, out } = await failedApply()
    const apply = out[1]
    expect(apply.exitCode).toBe(1)
    expect(apply.output).toContain('Plan: 4 to add, 0 to change, 0 to destroy.')
    expect(apply.output).toContain('aws_instance.agent: Creation complete after 13s')
    expect(apply.output).toContain('aws_instance.loadgen: Creating...\n╷\n│ Error: creating EC2 Instance: operation error EC2: RunInstances, https response error StatusCode: 400')
    expect(apply.output).toContain(LIMIT)
    expect(apply.output).toContain('│   with aws_instance.loadgen,\n│   on compute.tf line')
    expect(apply.output).not.toContain('Apply complete!')
    expect(apply.hits).toContain('evidence:quota-error')
    const list = await run(sh, 'terraform state list')
    expect(list.output.split('\n').filter(Boolean)).toEqual(PARTIAL)
    expect(list.hits).toContain('evidence:partial')
    expect(await sh.doneWhen({ state_lacks: 'aws_instance.loadgen' })).toBe(true)
    const plan = await run(sh, 'terraform plan')
    expect(plan.output).toContain('  # aws_instance.loadgen will be created')
    expect(plan.output).toContain('Plan: 1 to add, 0 to change, 0 to destroy.')
    // retrying unchanged fails the same way
    const again = await run(sh, 'terraform apply -auto-approve')
    expect(again.exitCode).toBe(1)
    expect(again.output).toContain(LIMIT)
    expect(await stateList(sh)).toEqual(PARTIAL)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('route A: right-size loadgen in compute.tf, apply creates only loadgen, right-size detected', async () => {
    const { sh } = await failedApply()
    await run(sh, SIZE('c5.12xlarge'))
    const apply = await run(sh, 'terraform apply -auto-approve')
    expect(apply.exitCode).toBe(0)
    expect(apply.output).toContain('Apply complete! Resources: 1 added, 0 changed, 0 destroyed.')
    expect(apply.output).not.toContain('Destroying')
    expect(await stateList(sh)).toEqual(['aws_instance.agent', 'aws_instance.loadgen', 'aws_subnet.loadtest', 'aws_vpc.loadtest'])
    expect((await run(sh, 'terraform plan')).output).toContain('No changes. Your infrastructure matches the configuration.')
    expect(await detectedAll(sh)).toEqual(RIGHT_SIZED)
  })

  it('route B: once the quota increase is taken, apply creates loadgen at c5.24xlarge, finish-apply detected', async () => {
    const { sh } = await failedApply()
    const apply = await run(sh, 'terraform apply -auto-approve', QUOTA)
    expect(apply.exitCode).toBe(0)
    expect(apply.output).toContain('Apply complete! Resources: 1 added, 0 changed, 0 destroyed.')
    expect((await run(sh, 'terraform plan', QUOTA)).output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FINISHED)
  })

  it('near miss: another type still over the quota (c5.18xlarge, c5.metal) fails the same way and earns nothing', async () => {
    for (const t of ['c5.18xlarge', 'c5.metal']) {
      const { sh } = await failedApply()
      await run(sh, SIZE(t))
      const apply = await run(sh, 'terraform apply -auto-approve')
      expect(apply.exitCode, t).toBe(1)
      expect(apply.output, t).toContain(LIMIT)
      expect(await stateList(sh)).toEqual(PARTIAL)
      expect(await detectedAll(sh)).toEqual(NONE)
    }
  })

  it('after the increase, another over-quota c5 size (c5.18xlarge) applies and counts as finishing the quota route, not as right-sizing', async () => {
    const { sh } = await failedApply()
    await run(sh, SIZE('c5.18xlarge'))
    const apply = await run(sh, 'terraform apply -auto-approve', QUOTA)
    expect(apply.exitCode).toBe(0)
    expect(await detectedAll(sh)).toEqual(FINISHED)
  })

  it('a type outside the scripted faults that is still over the quota is not credited as right-sizing even if the simulator lets it through', async () => {
    const { sh } = await failedApply()
    await run(sh, SIZE('m5.24xlarge'))
    await run(sh, 'terraform apply -auto-approve')
    expect(await detectedAll(sh)).toEqual(NONE)
    // fixing it properly afterwards is still credited
    await run(sh, "sed -i 's/m5\\.24xlarge/m5.12xlarge/' compute.tf")
    const apply = await run(sh, 'terraform apply -auto-approve')
    expect(apply.exitCode).toBe(0)
    expect(await detectedAll(sh)).toEqual(RIGHT_SIZED)
  })

  it('the fault `if` matches only the over-quota types: a within-quota c5 applies without the action', async () => {
    for (const t of ['c5.9xlarge', 'c5.4xlarge']) {
      const { sh } = await failedApply()
      await run(sh, SIZE(t))
      expect((await run(sh, 'terraform apply -auto-approve')).exitCode, t).toBe(0)
    }
  })

  it('trap: destroying the partial environment is destructive, and no fix is credited afterwards', async () => {
    const { sh, out } = await play('cd ~/loadtest-infra', 'terraform apply -auto-approve', 'terraform destroy -auto-approve')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('Destroy complete! Resources: 3 destroyed.')
    expect(await detectedAll(sh)).toEqual(TRAPPED)
    await run(sh, SIZE('c5.12xlarge'))
    expect((await run(sh, 'terraform apply -auto-approve')).output).toContain('Apply complete! Resources: 4 added, 0 changed, 0 destroyed.')
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('the typed quota request takes the action; wrong quota, too small a value or another region does not', () => {
    const req = scenario.actions.find((a) => a.id === 'request-quota-increase')!
    for (const cmd of [
      REQUEST,
      'aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 98',
      'aws service-quotas request-service-quota-increase --quota-code L-1216C47A --service-code ec2 --desired-value 256 --region us-east-1',
      'aws service-quotas request-service-quota-increase --service-code=ec2 --quota-code=L-1216C47A --desired-value=128.0',
    ])
      expect(actionFor(scenario, cmd), cmd).toBe(req)
    for (const cmd of [
      'aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 96',
      'aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 64',
      'aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-34B43A08 --desired-value 128',
      'aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 128 --region us-west-2',
      'aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A',
    ])
      expect(actionFor(scenario, cmd), cmd).toBeUndefined()
    // no scripted command answers a line that takes the action
    for (const c of scenario.terminal!.commands)
      if (c.match_regex) expect(new RegExp(c.match_regex).test(REQUEST), c.match_regex).toBe(false)
      else expect(c.match).not.toBe(REQUEST)
  })

  it('through the engine the typed request is held until the root cause is named, then taken', () => {
    let s = step(scenario, newSession(), { type: 'START', at: 0 })
    s = step(scenario, s, { type: 'RUN_COMMAND', input: REQUEST, at: 1 })
    expect(s.log.some((e) => e.type === 'TAKE_ACTION')).toBe(false)
    s = step(scenario, s, { type: 'DECLARE_HYPOTHESIS', id: 'vcpu-quota', at: 2 })
    s = step(scenario, s, { type: 'RUN_COMMAND', input: REQUEST, at: 3 })
    expect(s.log.at(-1)).toEqual({ type: 'TAKE_ACTION', id: 'request-quota-increase', at: 3 })
  })

  it('the scripted lookups answer through the engine and carry notes', () => {
    const quota = 'aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A'
    for (const cmd of [quota, `${quota} --region us-east-1`]) {
      expect(engineHandles(scenario, cmd, []), cmd).toBe(true)
      expect(terminalOutput(scenario, cmd, []), cmd).toContain('"QuotaName": "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances",\n        "Value": 64.0,')
    }
    const vcpus = 'aws ec2 describe-instance-types --instance-types c5.24xlarge --query "InstanceTypes[].VCpuInfo.DefaultVCpus"'
    expect(engineHandles(scenario, vcpus, [])).toBe(true)
    expect(terminalOutput(scenario, vcpus, [])).toBe('[\n    96\n]')
    expect(terminalOutput(scenario, 'aws ec2 describe-instance-types --instance-types c5.12xlarge --query "InstanceTypes[].VCpuInfo.DefaultVCpus"', [])).toBe('[\n    48\n]')
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.match ?? c.example!], c.match ?? c.example).toBeDefined()
  })

  it('every key evidence tag is awarded on the ideal path before any fix', async () => {
    const { out } = await play('cd ~/loadtest-infra', 'terraform apply -auto-approve', 'terraform state list')
    const log: GameEvent[] = [
      { type: 'SHELL_RAN', commands: out.flatMap((r) => r.hits), at: 0 },
      { type: 'RUN_COMMAND', input: 'aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A', at: 1 },
      { type: 'RUN_COMMAND', input: 'aws ec2 describe-instance-types --instance-types c5.24xlarge --query "InstanceTypes[].VCpuInfo.DefaultVCpus"', at: 2 },
    ]
    const seen = evidenceSeen(scenario, log)
    for (const t of scenario.key_evidence) expect(seen.has(t), t).toBe(true)
  })
})
