import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { runCommand } from '../src/game/engine.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-remote-state-rename')
const { play, detectedAll } = playbook(scenario)

const PRIV_A = 'subnet-0e1f7a3c5b9d24680'
const PUB_A = 'subnet-09c3a7e1b5d84026f'
// One-line forms the terminal UI can take (repeated spaces collapse).
const FIX = "sed -i 's/private_subnets/private_subnet_ids/' main.tf"
const PUBLIC = "sed -i 's/private_subnets/public_subnet_ids/' main.tf"
const SECOND = "sed -i 's/private_subnets\\[0\\]/private_subnet_ids[1]/' main.tf"
const HARD = `sed -i 's/data.terraform_remote_state.network.outputs.private_subnets\\[0\\]/"${PRIV_A}"/' main.tf`
const DEFAULTS = (id: string) => `sed -i 's/backend = "s3"/backend = "s3"\\n  defaults = { private_subnets = ["${id}"] }/' main.tf`
const NONE = { 'use-the-new-output': false, 'hard-code-the-ids': false, 'fake-the-old-output': false, 'point-at-another-output': false, 'apply-the-replacement': false }
const FIXED = { ...NONE, 'use-the-new-output': true }
const stage0 = atStage(scenario, 0)

describe('terraform-remote-state-rename on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
  })

  it('nothing is credited before the first command', async () => {
    const { sh } = await play('ls')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(a) the first plan fails exactly at the reference with Unsupported attribute; nothing credited', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform plan', 'terraform apply -auto-approve')
    expect(out[1].exitCode).toBe(1)
    expect(out[1].output).toBe(
      '╷\n│ Error: Unsupported attribute\n│ \n│   on main.tf line 27, in resource "aws_instance" "app":\n│   27:   subnet_id     = data.terraform_remote_state.network.outputs.private_subnets[0]\n│ \n│ This object does not have an attribute named "private_subnets".\n╵',
    )
    expect(out[1].hits).toContain('evidence:unsupported-attribute')
    for (const o of out.slice(2)) {
      expect(o.exitCode).toBe(1)
      expect(o.output).toContain('This object does not have an attribute named "private_subnets".')
    }
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b) key evidence is obtainable before the fix; validate does not check remote-state arguments', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform plan', 'git status', 'git log --oneline', 'cat ../network/outputs.tf', 'git -C ../network log --oneline', 'git -C ../network log -p -- outputs.tf', 'terraform state list', 'terraform state show data.terraform_remote_state.network', 'terraform validate')
    expect(out[3].output).toContain('8d02f3b app: read private subnets from the network state')
    expect(out[4].output).toContain('output "private_subnet_ids" {')
    expect(out[4].output).not.toContain('"private_subnets"')
    expect(out[6].output).toContain('-output "private_subnets" {\n+output "private_subnet_ids" {')
    expect(out[7].output).toBe('aws_instance.app\ndata.terraform_remote_state.network')
    expect(out[8].output).toContain('"private_subnets"   = [')
    expect(out[9].exitCode).toBe(0)
    expect(out[9].output).toContain('Success! The configuration is valid.')
    const lines = ['terraform plan', 'git status', 'cat ../network/outputs.tf', 'git -C ../network log -p -- outputs.tf', 'terraform state show data.terraform_remote_state.network']
    const tags = new Set([
      ...out.flatMap((o) => o.hits).filter((h) => h.startsWith('evidence:')).map((h) => h.slice(9)),
      ...lines.map((l) => runCommand(atStage(scenario, 0), l, new Set()).evidence),
    ])
    for (const tag of scenario.key_evidence!) expect(tags.has(tag), tag).toBe(true)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(c) the fix: the new output name gives a clean plan, the server is untouched, the data entry is in state', async () => {
    const { sh, out } = await play('cd ~/infra', FIX, 'terraform plan', 'terraform apply -auto-approve', 'terraform state list', 'terraform state show aws_instance.app', 'terraform plan')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('data.terraform_remote_state.network: Reading...\ndata.terraform_remote_state.network: Read complete after 0s')
    expect(out[2].output).toContain('No changes.')
    expect(out[3].output).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.')
    expect(out[4].output).toBe('aws_instance.app\ndata.terraform_remote_state.network')
    expect(out[5].output).toContain(`subnet_id         = "${PRIV_A}"`)
    expect(out[5].output).toContain('id                = "i-0a7c3e5f9b1d28460"')
    expect(out[6].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(c1) the bracket spelling is credited the same way', async () => {
    const { sh, out } = await play('cd ~/infra', "sed -i 's/outputs.private_subnets\\[0\\]/outputs[\"private_subnet_ids\"][0]/' main.tf", 'terraform plan')
    expect(out[2].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(d) hard-coding the subnet id clears the error but is the wrong action, not a fix', async () => {
    const { sh, out } = await play('cd ~/infra', HARD, 'terraform plan')
    expect(out[2].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'hard-code-the-ids': true })
  })

  it('(e) defaults that supply the old name clear the error but are the wrong action; a wrong id shows a replacement', async () => {
    const same = await play('cd ~/infra', DEFAULTS(PRIV_A), 'terraform plan')
    expect(same.out[2].output).toContain('No changes.')
    expect(await detectedAll(same.sh)).toEqual({ ...NONE, 'fake-the-old-output': true })
    const other = await play('cd ~/infra', DEFAULTS(PUB_A), 'terraform plan')
    expect(other.out[2].output).toContain(`~ subnet_id         = "${PRIV_A}" -> "${PUB_A}" # forces replacement`)
    expect(other.out[2].output).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
  })

  it('(f) another output: the plan shows the replacement before any apply; applying it deletes the server (destructive)', async () => {
    const { sh, out } = await play('cd ~/infra', PUBLIC, 'terraform plan')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('# aws_instance.app must be replaced')
    expect(out[2].output).toContain(`~ subnet_id         = "${PRIV_A}" -> "${PUB_A}" # forces replacement`)
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'point-at-another-output': true })
    const applied = await play('cd ~/infra', PUBLIC, 'terraform apply -auto-approve', 'terraform plan')
    expect(applied.out[2].output).toContain('aws_instance.app: Destruction complete')
    expect(applied.out[3].output).toContain('No changes.')
    expect(await detectedAll(applied.sh)).toEqual({ ...NONE, 'point-at-another-output': true, 'apply-the-replacement': true })
  })

  it('(f1) after the server was replaced, the fix is no longer credited even with the right reference', async () => {
    const { sh } = await play('cd ~/infra', PUBLIC, 'terraform apply -auto-approve', 'sed -i "s/public_subnet_ids/private_subnet_ids/" main.tf', 'terraform plan')
    expect((await detectedAll(sh))['use-the-new-output']).toBe(false)
  })

  it('(f2) the second private subnet also replaces the server, but is not the named mistake', async () => {
    const { sh, out } = await play('cd ~/infra', SECOND, 'terraform plan')
    expect(out[2].output).toContain('# forces replacement')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('is idempotent: the fix twice, plan twice, nothing changes', async () => {
    const { sh, out } = await play('cd ~/infra', FIX, 'terraform plan', 'terraform plan', FIX, 'terraform plan')
    expect(out[3].output).toBe(out[2].output)
    expect(out[5].output).toBe(out[2].output)
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('the engine path: the fix is a fix, the destructive one is flagged', () => {
    expect(stage0.actions.find((a) => a.id === 'use-the-new-output')!.kind).toBe('fix')
    expect(stage0.actions.find((a) => a.id === 'apply-the-replacement')!.kind).toBe('destructive')
    expect(scenario.solution_paths).toEqual([['use-the-new-output']])
  })
})
