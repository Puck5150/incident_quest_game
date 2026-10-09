import { describe, expect, it } from 'vitest'
import { engineHandles, evidenceSeen, terminalOutput, type GameEvent } from '../src/game/engine.ts'
import type { IncidentShell } from '../src/game/shell.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-cancelled-ci-lock')
const { play, detectedAll } = playbook(scenario)

const LOCK_ID = '4c2e8f17-9a3b-d605-7e1c-b28f5a0d93e4'
const NETWORK = ['aws_security_group.workers', 'aws_subnet.workers', 'aws_vpc.ledger']
const NONE = { 'unlock-and-finish': false, 'apply-without-lock': false, 'wait-for-lock-timeout': false, 'rebuild-state': false }
const FIXED = { ...NONE, 'unlock-and-finish': true }
const TRAPPED = { ...NONE, 'apply-without-lock': true }
const INFO = [
  'Lock Info:',
  `  ID:        ${LOCK_ID}`,
  '  Path:      acme-terraform-state/ledger/terraform.tfstate',
  '  Operation: OperationTypeApply',
  '  Who:       ci@runner-17',
  '  Version:   1.9.8',
  '  Created:   2026-10-08 07:42:24.613205871 +0000 UTC',
  '  Info:      ',
]
// The S3 backend's DynamoDB lock error as the simulator boxes it (lines, so the "│ " blanks keep their space).
const LOCK_BOX = [
  '╷',
  '│ Error: Error acquiring the state lock',
  '│ ',
  '│ Error message: operation error DynamoDB: PutItem, https response error',
  '│ StatusCode: 400, RequestID:',
  '│ UJZDE8GXD6NCF10EPF91DHODZDOC9IS0J8HT9LGMXG9EDN581U33,',
  '│ ConditionalCheckFailedException: The conditional request failed',
  ...INFO.map((l) => `│ ${l}`),
  '│ ',
  '│ ',
  '│ Terraform acquires a state lock to protect the state from being written',
  '│ by multiple users at the same time. Please resolve the issue above and try',
  '│ again. For most commands, you can disable locking with the "-lock=false"',
  '│ flag, but this is not recommended.',
  '╵',
].join('\n')
const PROMPT =
  "Do you really want to force-unlock?\n  Terraform will remove the lock on the remote state.\n  This will allow local Terraform commands to modify this state, even though it\n  may still be in use. Only 'yes' will be accepted to confirm.\n\n  Enter a value: "
const UNLOCKED = 'Terraform state has been successfully unlocked!'

const run = (sh: IncidentShell, line: string) => sh.run(line, atStage(scenario, 0), new Set())
const stateList = async (sh: IncidentShell) => (await run(sh, 'terraform state list')).output.split('\n').filter(Boolean)
const locked = (sh: IncidentShell) => sh.doneWhen({ lock_free: true }).then((free) => !free)

describe('terraform-cancelled-ci-lock on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
    expect(scenario.terraform!.files.find((f) => f.path === 'main.tf')!.content).toContain('dynamodb_table = "terraform-locks"')
  })

  it('plan, apply, destroy and refresh are blocked with the exact lock box and change nothing', async () => {
    const { sh, out } = await play('cd ~/ledger-infra', 'terraform plan', 'terraform apply -auto-approve', 'terraform destroy -auto-approve', 'terraform refresh', 'terraform plan -lock-timeout=30s')
    for (const r of out.slice(1)) {
      expect(r.exitCode).toBe(1)
      expect(r.output).toBe(LOCK_BOX)
    }
    expect(out[1].hits).toEqual(expect.arrayContaining(['evidence:ci-lock-error', 'evidence:ci-lock-holder']))
    expect(await stateList(sh)).toEqual(NETWORK)
    expect(await locked(sh)).toBe(true)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('the read-only commands still work while it is locked', async () => {
    const { out } = await play('cd ~/ledger-infra', 'terraform state list', 'terraform state show aws_subnet.workers', 'terraform output', 'terraform show', 'terraform validate')
    expect(out[1].exitCode).toBe(0)
    expect(out[1].output.split('\n')).toEqual(NETWORK)
    expect(out[1].hits).toContain('evidence:ci-network-in-state')
    expect(out[2].output).toContain('# aws_subnet.workers:\nresource "aws_subnet" "workers" {')
    expect(out[2].output).toContain('id                      = "subnet-0b6d2f8e41a7c9035"')
    for (const r of out.slice(3)) expect(r.exitCode).toBe(0)
    expect(out[4].output).not.toContain('aws_instance.reconciler')
    expect(out[5].output).toContain('Success! The configuration is valid.')
  })

  it('a wrong lock ID, a declined answer and no answer all leave the lock in place', async () => {
    const { sh, out } = await play(
      'cd ~/ledger-infra',
      'terraform force-unlock -force abc',
      'echo yes | terraform force-unlock 4c2e8f17',
      `echo no | terraform force-unlock ${LOCK_ID}`,
      `terraform force-unlock ${LOCK_ID}`,
      'terraform force-unlock',
    )
    expect(out[1]).toMatchObject({ exitCode: 1, output: [`Failed to unlock state: lock ID "abc" does not match existing lock ("${LOCK_ID}")`, ...INFO].join('\n') })
    expect(out[2].exitCode).toBe(1)
    expect(out[2].output).toBe([`${PROMPT}yes`, '', `Failed to unlock state: lock ID "4c2e8f17" does not match existing lock ("${LOCK_ID}")`, ...INFO].join('\n'))
    expect(out[3]).toMatchObject({ exitCode: 1, output: `${PROMPT}no\n\nforce-unlock cancelled.` })
    // no dialog hook in this harness: unanswered, like an empty reply
    expect(out[4]).toMatchObject({ exitCode: 1, output: `${PROMPT}\n\nforce-unlock cancelled.` })
    expect(out[5]).toMatchObject({ exitCode: 1, output: 'Expected a single argument: LOCK_ID' })
    expect(await locked(sh)).toBe(true)
    expect((await run(sh, 'terraform plan')).output).toBe(LOCK_BOX)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  for (const unlock of [`echo yes | terraform force-unlock ${LOCK_ID}`, `terraform force-unlock -force ${LOCK_ID}`])
    it(`ideal path with "${unlock}": the plan shows only the reconciler, apply finishes it, the fix is detected`, async () => {
      const { sh, out } = await play('cd ~/ledger-infra', 'terraform plan', unlock, 'terraform plan', 'terraform apply -auto-approve', 'terraform plan')
      expect(out[2].exitCode).toBe(0)
      expect(out[2].output).toContain(UNLOCKED)
      expect(out[2].output.startsWith(PROMPT)).toBe(unlock.startsWith('echo'))
      expect(out[3].exitCode).toBe(0)
      expect(out[3].output).toContain('  # aws_instance.reconciler will be created\n  + resource "aws_instance" "reconciler" {')
      expect(out[3].output).toContain('      + subnet_id         = "subnet-0b6d2f8e41a7c9035"')
      expect(out[3].output).toContain('Plan: 1 to add, 0 to change, 0 to destroy.')
      expect(out[3].hits).toContain('evidence:ci-partial-plan')
      expect(out[4].exitCode).toBe(0)
      expect(out[4].output).toContain('aws_instance.reconciler: Creating...')
      expect(out[4].output).toContain('Apply complete! Resources: 1 added, 0 changed, 0 destroyed.')
      expect(out[4].output).not.toContain('Destroying')
      expect(out[5].output).toContain('No changes. Your infrastructure matches the configuration.')
      expect(await stateList(sh)).toEqual(['aws_instance.reconciler', ...NETWORK])
      expect(await locked(sh)).toBe(false)
      expect(await detectedAll(sh)).toEqual(FIXED)
    })

  it('unlocking alone is not the fix: the reconciler still has to be applied', async () => {
    const { sh } = await play('cd ~/ledger-infra', `terraform force-unlock -force ${LOCK_ID}`)
    expect(await locked(sh)).toBe(false)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('trap: apply -lock=false while the lock is held is destructive, and the fix is never credited afterwards', async () => {
    const { sh, out } = await play('cd ~/ledger-infra', 'terraform apply -auto-approve -lock=false')
    expect(out[1].exitCode).toBe(0)
    expect(out[1].output).toContain('Apply complete! Resources: 1 added, 0 changed, 0 destroyed.')
    // the bypass doesn't remove the lock: everyone else is still blocked
    expect(await locked(sh)).toBe(true)
    expect((await run(sh, 'terraform plan')).output).toBe(LOCK_BOX)
    expect(await detectedAll(sh)).toEqual(TRAPPED)
    // unlocking afterwards leaves a clean plan and the instance, but the bypass is on record
    expect((await run(sh, `terraform force-unlock -force ${LOCK_ID}`)).output).toContain(UNLOCKED)
    expect((await run(sh, 'terraform plan')).output).toContain('No changes. Your infrastructure matches the configuration.')
    expect(await stateList(sh)).toEqual(['aws_instance.reconciler', ...NETWORK])
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('trap: the same with the question answered yes, or a destroy -lock=false, is destructive too', async () => {
    const piped = await play('cd ~/ledger-infra', 'echo yes | terraform apply -lock=false')
    expect(piped.out[1].output).toContain('Apply complete! Resources: 1 added')
    expect(await detectedAll(piped.sh)).toEqual(TRAPPED)
    const destroy = await play('cd ~/ledger-infra', 'terraform destroy -auto-approve -lock=false')
    expect(destroy.out[1].output).toContain('Destroy complete! Resources: 3 destroyed.')
    expect(await detectedAll(destroy.sh)).toEqual(TRAPPED)
  })

  it('a -lock=false plan only reads: not a trap, and the ideal path still earns the fix', async () => {
    const { sh, out } = await play('cd ~/ledger-infra', 'terraform plan -lock=false', 'echo no | terraform apply -lock=false')
    expect(out[1].exitCode).toBe(0)
    expect(out[1].output).toContain('Plan: 1 to add, 0 to change, 0 to destroy.')
    expect(out[2].output).toContain('Apply cancelled.')
    expect(await locked(sh)).toBe(true)
    expect(await detectedAll(sh)).toEqual(NONE)
    await run(sh, `terraform force-unlock -force ${LOCK_ID}`)
    await run(sh, 'terraform apply -auto-approve')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('-lock=false once the lock is gone is an ordinary apply, not a bypass', async () => {
    const { sh, out } = await play('cd ~/ledger-infra', `terraform force-unlock -force ${LOCK_ID}`, 'terraform apply -auto-approve -lock=false')
    expect(out[2].output).toContain('Apply complete! Resources: 1 added')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('destroying the network after unlocking and rebuilding it is not credited', async () => {
    const { sh } = await play('cd ~/ledger-infra', `terraform force-unlock -force ${LOCK_ID}`, 'terraform destroy -auto-approve', 'terraform apply -auto-approve')
    expect(await stateList(sh)).toEqual(['aws_instance.reconciler', ...NETWORK])
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('the CI log and the gh lookups answer, in every common spelling, and carry notes', async () => {
    const { out } = await play('cd ~/ledger-infra', 'cat ci-pipeline.log', 'tail -n 5 ci-pipeline.log', 'less ci-pipeline.log', 'gh run list', 'gh run view 11823046571')
    expect(out[1].output).toContain("Runner name: 'runner-17'")
    expect(out[1].output).toContain('aws_subnet.workers: Creation complete after 1s [id=subnet-0b6d2f8e41a7c9035]')
    expect(out[1].output).toMatch(/Interrupt received\.\n.*Please wait for Terraform to exit or data loss may occur\.\n.*Gracefully shutting down\.\.\./)
    expect(out[1].output).toMatch(/Two interrupts received\. Exiting immediately\. Note that data loss may have\n.*occurred\./)
    expect(out[1].output).toContain('##[error]The operation was canceled.')
    expect(out[1].output).not.toContain('aws_instance.reconciler: Creation complete')
    expect(out[2].output.split('\n')).toHaveLength(5)
    expect(out[2].output).toContain('Cleaning up orphan processes')
    expect(out[3].output).toBe(out[1].output)
    expect(out[4].output).toContain('X       Ledger network and reconciler worker (#212)  terraform-apply  main    push               11823046571  48s      about 3 hours ago')
    expect(out[4].output).not.toMatch(/^\*/m)
    expect(out[5].output).toContain('X The run was canceled by @dmitri-k.')

    const ran = (cmd: string) => evidenceSeen(scenario, [{ type: 'RUN_COMMAND', input: cmd, at: 0 }])
    for (const cmd of [
      'cat ci-pipeline.log',
      'less ci-pipeline.log',
      'more ci-pipeline.log',
      'tail ci-pipeline.log',
      'tail -n 20 ci-pipeline.log',
      'tail -20 ci-pipeline.log',
      'head -n 80 ci-pipeline.log',
      'grep -i interrupt ci-pipeline.log',
      'grep -n "Interrupt" ci-pipeline.log',
      "grep -i 'cancel' ci-pipeline.log",
      'grep error ci-pipeline.log',
      'gh run list',
      'gh run list --limit 5',
      'gh run list -L 3',
      'gh run list --workflow terraform-apply.yml',
      'gh run list -w terraform-apply --branch main',
      'gh run list --status in_progress',
      'gh run list -s queued',
      'gh run view 11823046571',
    ])
      expect(ran(cmd).has('ci-run-dead'), cmd).toBe(true)
    // a grep for something unrelated earns nothing
    expect(ran('grep runner ci-pipeline.log').has('ci-run-dead')).toBe(false)
    // the engine answers the gh and less lines; the real shell reads the file for tail and grep
    expect(engineHandles(scenario, 'gh run list --limit 5', [])).toBe(true)
    expect(terminalOutput(scenario, 'gh run list --status in_progress', [])).toBe('no runs found')
    expect(terminalOutput(scenario, 'gh run view 11823519084', [])).toContain('X Run terraform apply -auto-approve -input=false')
    expect(engineHandles(scenario, 'tail -n 5 ci-pipeline.log', [])).toBe(false)
    for (const cmd of ['aws ec2 describe-instances', 'aws ec2 describe-instances --filters Name=tag:Name,Values=ledger-reconciler', 'aws ec2 describe-instances --filters "Name=tag:Name,Values=ledger-reconciler" --region us-east-1']) {
      expect(terminalOutput(scenario, cmd, []), cmd).toBe('{\n    "Reservations": []\n}')
      expect(ran(cmd).has('ci-no-orphan'), cmd).toBe(true)
    }
    expect(terminalOutput(scenario, "aws ec2 describe-instances --query 'Reservations[].Instances[].InstanceId'", [])).toBe('[]')
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.match ?? c.example!], c.match ?? c.example).toBeDefined()
  })

  it('every key evidence tag is awarded on the ideal path', async () => {
    const shell = ['cd ~/ledger-infra', 'terraform plan', `terraform force-unlock -force ${LOCK_ID}`, 'terraform plan']
    const { out } = await play(...shell)
    const log: GameEvent[] = [
      { type: 'RUN_COMMAND', input: 'cat ci-pipeline.log', at: 0 },
      { type: 'RUN_COMMAND', input: 'gh run list', at: 1 },
      { type: 'SHELL_RAN', commands: out.flatMap((r) => r.hits), at: 2 },
    ]
    const seen = evidenceSeen(scenario, log)
    for (const t of scenario.key_evidence) expect(seen.has(t), t).toBe(true)
  })
})
