import { describe, expect, it } from 'vitest'
import { engineHandles, evidenceSeen, terminalOutput, type GameEvent } from '../src/game/engine.ts'
import type { IncidentShell } from '../src/game/shell.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-sg-cycle')
const { play, detectedAll } = playbook(scenario)

const NONE = { 'break-the-cycle': false, 'recreate-groups': false, 'add-depends-on': false, 'bump-provider': false }
const FIXED = { ...NONE, 'break-the-cycle': true }
// Terraform 1.9's dag.Validate error, as format.Diagnostic boxes it: no location, a blank line after the summary.
const CYCLE = '╷\n│ Error: Cycle: aws_security_group.app, aws_security_group.web\n│ \n╵'
const STATE = ['aws_security_group.app', 'aws_security_group.web', 'aws_subnet.app', 'aws_subnet.web', 'aws_vpc.checkout']
// The fixes: one direction stays by group id, the other comes from the source subnet's CIDR.
const WEB_BY_CIDR = "sed -i 's/security_groups = \\[aws_security_group\\.app\\.id\\]/cidr_blocks     = [aws_subnet.app.cidr_block]/' security.tf"
const APP_BY_CIDR = "sed -i 's/security_groups = \\[aws_security_group\\.web\\.id\\]/cidr_blocks     = [aws_subnet.web.cidr_block]/' security.tf"
const IN_PLACE = 'Plan: 0 to add, 2 to change, 0 to destroy.'

const run = (sh: IncidentShell, line: string) => sh.run(line, atStage(scenario, 0), new Set())
const stateList = async (sh: IncidentShell) => (await run(sh, 'terraform state list')).output.split('\n').filter(Boolean)
const ids = (sh: IncidentShell) => sh.doneWhen({ all: [{ reality_has: { type: 'aws_security_group', id: 'sg-0a4d7e21c9b3f5068' } }, { reality_has: { type: 'aws_security_group', id: 'sg-07c3e9a1d5b2f4e86' } }] })

describe('terraform-sg-cycle on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
    const sec = scenario.terraform!.files.find((f) => f.path === 'security.tf')!.content
    expect(sec).toContain('security_groups = [aws_security_group.app.id]')
    expect(sec).toContain('security_groups = [aws_security_group.web.id]')
  })

  it('validate, plan, apply and destroy all stop with the Cycle error alone: no refresh, no plan, nothing changed', async () => {
    const { sh, out } = await play('cd ~/checkout-infra', 'terraform validate', 'terraform plan', 'terraform apply -auto-approve', 'terraform destroy -auto-approve', 'terraform plan -refresh=false')
    for (const r of out.slice(1)) {
      expect(r.exitCode).toBe(1)
      expect(r.output).toBe(CYCLE)
    }
    expect(out[1].hits).toContain('evidence:sgc-cycle-offline')
    expect(out[2].hits).toContain('evidence:sgc-cycle-error')
    expect(await stateList(sh)).toEqual(STATE)
    expect(await ids(sh)).toBe(true)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('state list and state show still read the state while the configuration has a cycle', async () => {
    const { out } = await play('cd ~/checkout-infra', 'terraform state list', 'terraform state show aws_security_group.app', 'terraform show')
    for (const r of out.slice(1)) expect(r.exitCode).toBe(0)
    expect(out[1].output.split('\n')).toEqual(STATE)
    expect(out[2].output).toContain('id          = "sg-07c3e9a1d5b2f4e86"')
    expect(out[2].output).toContain('"10.60.1.0/24",')
    expect(out[3].output).toContain('# aws_security_group.web:')
  })

  it('ideal path: web takes callbacks from the app subnet CIDR; plan is two in-place updates; apply fixes it', async () => {
    const { sh, out } = await play('cd ~/checkout-infra', 'terraform plan', WEB_BY_CIDR, 'terraform validate', 'terraform plan')
    expect(out[3].output).toBe('Success! The configuration is valid.')
    const plan = out[4].output
    expect(out[4].exitCode).toBe(0)
    expect(plan).toContain('# aws_security_group.app will be updated in-place')
    expect(plan).toContain('# aws_security_group.web will be updated in-place')
    expect(plan).toContain('+ "10.60.11.0/24",')
    expect(plan).toContain('+ "sg-0a4d7e21c9b3f5068",')
    expect(plan).not.toContain('must be replaced')
    expect(plan).toContain(IN_PLACE)
    expect(await detectedAll(sh)).toEqual(NONE) // not until it's applied
    const applied = await run(sh, 'terraform apply -auto-approve')
    expect(applied.exitCode).toBe(0)
    expect(applied.output).toContain('aws_security_group.web: Modifications complete after 2s [id=sg-0a4d7e21c9b3f5068]')
    expect(applied.output).toContain('Apply complete! Resources: 0 added, 2 changed, 0 destroyed.')
    expect((await run(sh, 'terraform plan')).output).toContain('No changes. Your infrastructure matches the configuration.')
    expect(await ids(sh)).toBe(true)
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('the other direction works too: app takes the API from the web subnet CIDR, web keeps the group rule', async () => {
    const { sh, out } = await play('cd ~/checkout-infra', APP_BY_CIDR, 'terraform plan', 'terraform apply -auto-approve')
    expect(out[2].output).toContain(IN_PLACE)
    expect(out[2].output).not.toContain('must be replaced')
    expect(out[3].exitCode).toBe(0)
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('removing both cross-references is not credited, nor is dropping the callbacks rule, nor opening it to the internet', async () => {
    const both = await play('cd ~/checkout-infra', WEB_BY_CIDR, APP_BY_CIDR, 'terraform apply -auto-approve', 'terraform plan')
    expect(both.out[3].exitCode).toBe(0)
    expect(both.out[4].output).toContain('No changes.')
    expect(await detectedAll(both.sh)).toEqual(NONE)

    const dropped = await play('cd ~/checkout-infra', "sed -i '/# Order-status/,/^  }$/d' security.tf", 'terraform apply -auto-approve', 'terraform plan')
    expect(dropped.out[2].exitCode).toBe(0)
    expect(dropped.out[3].output).toContain('No changes.')
    expect(await detectedAll(dropped.sh)).toEqual(NONE)

    const open = await play('cd ~/checkout-infra', "sed -i 's/security_groups = \\[aws_security_group\\.app\\.id\\]/cidr_blocks     = [\"0.0.0.0\\/0\"]/' security.tf", 'terraform apply -auto-approve', 'terraform plan')
    expect(open.out[2].exitCode).toBe(0)
    expect(open.out[3].output).toContain('No changes.')
    expect(await detectedAll(open.sh)).toEqual(NONE)
  })

  it('adding depends_on still gives the Cycle error', async () => {
    const { sh, out } = await play('cd ~/checkout-infra', "sed -i 's/^  description = \"checkout app tier\"$/&\\n  depends_on  = [aws_security_group.web]/' security.tf", 'grep -c depends_on security.tf', 'terraform validate', 'terraform plan')
    expect(out[2].output).toBe('1')
    expect(out[3].output).toBe(CYCLE)
    expect(out[4].output).toBe(CYCLE)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('recreating the groups is refused by AWS from every terminal route, so the trap is button-only and the fix is still earnable', async () => {
    const trap = scenario.actions.find((x) => x.id === 'recreate-groups')!
    expect(trap.kind).toBe('destructive')
    expect(trap.done_when).toBeUndefined()

    const { sh, out } = await play('cd ~/checkout-infra', WEB_BY_CIDR, 'terraform destroy -auto-approve', 'terraform apply -auto-approve -replace=aws_security_group.web')
    expect(out[2].exitCode).toBe(1)
    expect(out[2].output).toContain('Plan: 0 to add, 0 to change, 5 to destroy.')
    expect(out[2].output).toContain('api error DependencyViolation: resource sg-07c3e9a1d5b2f4e86 has a dependent object')
    expect(out[2].output).toContain("api error DependencyViolation: The subnet 'subnet-04e7a1c9d3b5f2068' has dependencies and cannot be deleted.")
    expect(out[3].exitCode).toBe(1)
    expect(out[3].output).toContain('aws_security_group.web: Destroying... [id=sg-0a4d7e21c9b3f5068]')
    expect(out[3].output).toContain('│ Error: deleting Security Group (sg-0a4d7e21c9b3f5068): operation error EC2: DeleteSecurityGroup, https response error StatusCode: 400')
    expect(await stateList(sh)).toEqual(STATE)
    expect(await ids(sh)).toBe(true)
    expect(await detectedAll(sh)).toEqual(NONE)
    // the failed attempts changed nothing: the plain apply still fixes it
    expect((await run(sh, 'terraform apply -auto-approve')).output).toContain(IN_PLACE)
    expect(await detectedAll(sh)).toEqual(FIXED)

    const forgotten = await play('cd ~/checkout-infra', WEB_BY_CIDR, 'terraform state rm aws_security_group.web', 'terraform apply -auto-approve')
    expect(forgotten.out[3].exitCode).toBe(1)
    expect(forgotten.out[3].output).toContain("api error InvalidGroup.Duplicate: The security group 'checkout-web' already exists for VPC 'vpc-0f2b8d4e61a9c7035'")
    expect(await detectedAll(forgotten.sh)).toEqual(NONE) // web is out of state until it's imported back
    await run(forgotten.sh, 'terraform import aws_security_group.web sg-0a4d7e21c9b3f5068')
    expect((await run(forgotten.sh, 'terraform apply -auto-approve')).exitCode).toBe(0)
    expect(await detectedAll(forgotten.sh)).toEqual(FIXED)
  })

  it('scripted commands: the PR diff and its variants, the live groups, a note for each', () => {
    const ran = (cmd: string) => evidenceSeen(scenario, [{ type: 'RUN_COMMAND', input: cmd, at: 0 }])
    for (const cmd of ['git diff main', 'git diff origin/main', 'git diff main...HEAD', 'git diff main -- security.tf', 'git diff origin/main...callbacks-8443 -- security.tf', 'git diff main security.tf', 'gh pr diff 318', 'gh pr diff']) {
      expect(engineHandles(scenario, cmd, []), cmd).toBe(true)
      expect(terminalOutput(scenario, cmd, []), cmd).toContain('+    security_groups = [aws_security_group.app.id]')
      expect(ran(cmd).has('sgc-pr-diff'), cmd).toBe(true)
    }
    expect(terminalOutput(scenario, 'git diff main --stat', [])).toContain('1 file changed')
    expect(terminalOutput(scenario, 'git diff', [])).toBe('')
    expect(terminalOutput(scenario, 'git log --oneline -3', [])).toContain('(#318)')
    expect(terminalOutput(scenario, 'aws ec2 describe-security-groups --group-ids sg-0a4d7e21c9b3f5068 sg-07c3e9a1d5b2f4e86', [])).toContain('"CidrIp": "10.60.1.0/24"')
    expect(engineHandles(scenario, 'aws ec2 describe-security-groups --filters Name=group-name,Values=checkout-web,checkout-app', [])).toBe(true)
    expect(terminalOutput(scenario, 'aws ec2 describe-security-groups --group-ids sg-0a4d7e21c9b3f5068', [])).not.toContain('sg-07c3e9a1d5b2f4e86')
    expect(terminalOutput(scenario, 'aws ec2 describe-security-groups --group-ids sg-07c3e9a1d5b2f4e86', [])).toContain('"GroupName": "checkout-app"')
    expect(terminalOutput(scenario, 'git status', [])).toContain('On branch callbacks-8443')
    expect(terminalOutput(scenario, 'gh pr diff 318 --name-only', [])).toBe('security.tf')
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.match ?? c.example!], c.match ?? c.example).toBeDefined()
  })

  it('every key evidence tag is awarded on the failing configuration, before any edit', async () => {
    const { out } = await play('cd ~/checkout-infra', 'terraform plan')
    const log: GameEvent[] = [
      { type: 'RUN_COMMAND', input: 'git diff main', at: 0 },
      { type: 'SHELL_RAN', commands: out.flatMap((r) => r.hits), at: 1 },
    ]
    const seen = evidenceSeen(scenario, log)
    for (const t of scenario.key_evidence) expect(seen.has(t), t).toBe(true)
  })
})
