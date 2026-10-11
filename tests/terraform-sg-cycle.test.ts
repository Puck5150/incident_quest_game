import { describe, expect, it } from 'vitest'
import { engineHandles, evidenceSeen, terminalOutput, type GameEvent } from '../src/game/engine.ts'
import type { IncidentShell } from '../src/game/shell.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-sg-cycle')
const { play, detected, detectedAll } = playbook(scenario)

const NONE = { 'break-the-cycle': false, 'widen-callbacks-to-cidr': false, 'open-callbacks-to-internet': false, 'recreate-groups': false, 'add-depends-on': false, 'bump-provider': false }
const FIXED = { ...NONE, 'break-the-cycle': true }
const OPENED = { ...NONE, 'open-callbacks-to-internet': true }
const WIDENED = { ...NONE, 'widen-callbacks-to-cidr': true }
// Terraform 1.9's dag.Validate error, as format.Diagnostic boxes it: no location, a blank line after the summary.
const CYCLE = '╷\n│ Error: Cycle: aws_security_group.app, aws_security_group.web\n│ \n╵'
const STATE = ['aws_security_group.app', 'aws_security_group.web', 'aws_subnet.app', 'aws_subnet.web', 'aws_vpc.checkout']
const WEB = 'sg-0a4d7e21c9b3f5068'
const APP = 'sg-07c3e9a1d5b2f4e86'

// security.tf with every rule as its own resource. `clear` leaves ingress = [] / egress = [] in the groups (the transition step).
const RULES = (o: { clear?: boolean; web8443?: string; app8080?: string; omit?: string[] } = {}) => {
  const rules: [string, string][] = [
    ['aws_vpc_security_group_ingress_rule" "web_https', 'security_group_id = aws_security_group.web.id\n  cidr_ipv4         = "0.0.0.0/0"\n  from_port         = 443\n  to_port           = 443\n  ip_protocol       = "tcp"'],
    ['aws_vpc_security_group_ingress_rule" "web_callbacks', `security_group_id = aws_security_group.web.id\n  ${o.web8443 ?? 'referenced_security_group_id = aws_security_group.app.id'}\n  from_port         = 8443\n  to_port           = 8443\n  ip_protocol       = "tcp"`],
    ['aws_vpc_security_group_egress_rule" "web_all', 'security_group_id = aws_security_group.web.id\n  cidr_ipv4         = "0.0.0.0/0"\n  ip_protocol       = "-1"'],
    ['aws_vpc_security_group_ingress_rule" "app_api', `security_group_id = aws_security_group.app.id\n  ${o.app8080 ?? 'referenced_security_group_id = aws_security_group.web.id'}\n  from_port         = 8080\n  to_port           = 8080\n  ip_protocol       = "tcp"`],
    ['aws_vpc_security_group_egress_rule" "app_all', 'security_group_id = aws_security_group.app.id\n  cidr_ipv4         = "0.0.0.0/0"\n  ip_protocol       = "-1"'],
  ]
  const group = (n: string) => `resource "aws_security_group" "${n}" {\n  name        = "checkout-${n}"\n  description = "checkout ${n} tier"\n  vpc_id      = aws_vpc.checkout.id\n${o.clear ? '  ingress     = []\n  egress      = []\n' : ''}\n  tags = {\n    Name = "checkout-${n}"\n  }\n}\n`
  const body = [group('web'), group('app'), ...rules.filter(([n]) => !o.omit?.some((x) => n.endsWith(x))).map(([n, b]) => `resource "${n}" {\n  ${b}\n}\n`)].join('\n')
  return `cat > security.tf <<'EOF'\n${body}EOF`
}
const FIRST = 'Plan: 5 to add, 2 to change, 0 to destroy.'

const sh0 = async (sh: IncidentShell) => (await detected(sh, 'break-the-cycle'))
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

  it('ideal path: every rule its own resource by group id; clear the old inline rules, apply, drop the clearing, plan clean', async () => {
    const { sh, out } = await play('cd ~/checkout-infra', 'terraform plan', RULES({ clear: true }), 'terraform validate', 'terraform plan')
    expect(out[3].output).toBe('Success! The configuration is valid.')
    const plan = out[4].output
    expect(out[4].exitCode).toBe(0)
    expect(plan).toContain('# aws_security_group.app will be updated in-place')
    expect(plan).toContain('# aws_vpc_security_group_ingress_rule.app_api will be created')
    expect(plan).toContain(FIRST)
    expect(plan).not.toContain('must be replaced')
    expect(await detectedAll(sh)).toEqual(NONE) // not until it's applied
    const applied = await run(sh, 'terraform apply -auto-approve')
    expect(applied.exitCode).toBe(0)
    expect(applied.output).toContain('Apply complete! Resources: 5 added, 2 changed, 0 destroyed.')
    // the groups were updated before any rule was created
    const o = applied.output
    expect(o.indexOf('aws_security_group.app: Modifications complete')).toBeLessThan(o.indexOf('aws_vpc_security_group_ingress_rule.app_api: Creating...'))
    // the old inline rules are gone and the new ones are live; but rules in both styles on one group is not finished
    const mixed = await run(sh, 'terraform plan')
    expect(mixed.output).toContain('Security group rules are managed twice')
    expect(mixed.output).toContain('aws_security_group.web defines ingress or egress rules inline')
    expect(await detectedAll(sh)).toEqual(NONE)
    await run(sh, "sed -i '/^  ingress     = \\[\\]$/d;/^  egress      = \\[\\]$/d' security.tf")
    const clean = await run(sh, 'terraform plan')
    expect(clean.output).toContain('No changes. Your infrastructure matches the configuration.')
    expect(clean.output).not.toContain('managed twice')
    expect(await detectedAll(sh)).toEqual(FIXED)
    expect(await stateList(sh)).toContain('aws_vpc_security_group_ingress_rule.web_callbacks')
    expect((await run(sh, 'terraform state show aws_security_group.web')).output).toContain(`id          = "${WEB}"`)
  })

  it('stuck state: rules split without clearing the groups is refused as duplicates and leaves the old CIDR rule open; clearing finishes it', async () => {
    const { sh, out } = await play('cd ~/checkout-infra', RULES(), 'terraform plan', 'terraform apply -auto-approve')
    expect(out[2].output).toContain('Plan: 5 to add, 0 to change, 0 to destroy.')
    expect(out[3].exitCode).toBe(1)
    expect(out[3].output).toContain('api error InvalidPermission.Duplicate: the specified rule "peer: 0.0.0.0/0, TCP, from port: 443, to port: 443, ALLOW" already exists')
    expect(out[3].output).toContain('creating VPC Security Group Egress Rule')
    expect(await detectedAll(sh)).toEqual(NONE)
    // the callbacks rule and the new API rule did get created, so the old CIDR rule sits next to it
    expect(await sh.doneWhen({ sg_rule: { group_id: APP, direction: 'ingress', port: 8080, cidr: '10.60.1.0/24' } })).toBe(true)
    expect(await sh.doneWhen({ sg_rule: { group_id: APP, direction: 'ingress', port: 8080, source_group_id: WEB } })).toBe(true)
    // clear the groups, finish, then drop the clearing
    await run(sh, RULES({ clear: true }))
    const second = await run(sh, 'terraform apply -auto-approve')
    expect(second.exitCode).toBe(0)
    expect(second.output).toContain('Apply complete! Resources: 3 added, 2 changed, 0 destroyed.')
    expect(await sh.doneWhen({ sg_rule: { group_id: APP, direction: 'ingress', port: 8080, cidr: '10.60.1.0/24' } })).toBe(false)
    expect(await detectedAll(sh)).toEqual(NONE) // still two management styles on one group
    await run(sh, RULES())
    expect((await run(sh, 'terraform plan')).output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('aws_security_group_rule is an accepted way to write the same rules', async () => {
    const rule = (n: string, body: string) => `resource "aws_security_group_rule" "${n}" {\n  ${body}\n}\n`
    const tf = [
      rule('web_https', 'type = "ingress"\n  security_group_id = aws_security_group.web.id\n  cidr_blocks = ["0.0.0.0/0"]\n  from_port = 443\n  to_port = 443\n  protocol = "tcp"'),
      rule('web_callbacks', 'type = "ingress"\n  security_group_id = aws_security_group.web.id\n  source_security_group_id = aws_security_group.app.id\n  from_port = 8443\n  to_port = 8443\n  protocol = "tcp"'),
      rule('web_out', 'type = "egress"\n  security_group_id = aws_security_group.web.id\n  cidr_blocks = ["0.0.0.0/0"]\n  from_port = 0\n  to_port = 0\n  protocol = "-1"'),
      rule('app_api', 'type = "ingress"\n  security_group_id = aws_security_group.app.id\n  source_security_group_id = aws_security_group.web.id\n  from_port = 8080\n  to_port = 8080\n  protocol = "tcp"'),
      rule('app_out', 'type = "egress"\n  security_group_id = aws_security_group.app.id\n  cidr_blocks = ["0.0.0.0/0"]\n  from_port = 0\n  to_port = 0\n  protocol = "-1"'),
    ].join('\n')
    const group = (n: string, extra: string) => `resource "aws_security_group" "${n}" {\n  name = "checkout-${n}"\n  description = "checkout ${n} tier"\n  vpc_id = aws_vpc.checkout.id\n${extra}  tags = { Name = "checkout-${n}" }\n}\n`
    const file = (extra: string) => `cat > security.tf <<'EOF'\n${group('web', extra)}\n${group('app', extra)}\n${tf}EOF`
    const { sh, out } = await play('cd ~/checkout-infra', file('  ingress = []\n  egress = []\n'), 'terraform apply -auto-approve', file(''), 'terraform plan')
    expect(out[2].exitCode).toBe(0)
    expect(out[4].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('keeping web\'s 443 and egress inline next to rule resources is the documented conflict: warned and not credited', async () => {
    const { sh, out } = await play('cd ~/checkout-infra', RULES({ clear: true, omit: ['web_https', 'web_all', 'app_all'] }), "sed -i 's/^  ingress     = \\[\\]$/  ingress {\\n    from_port = 443\\n    to_port = 443\\n    protocol = \"tcp\"\\n    cidr_blocks = [\"0.0.0.0\\/0\"]\\n  }/' security.tf", 'terraform plan')
    expect(out[3].output).toContain('Security group rules are managed twice')
    await run(sh, 'terraform apply -auto-approve')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('the Cycle comes back if the rules stay inline, even when written with comments or self = true', async () => {
    const self = await play('cd ~/checkout-infra', "sed -i 's/^    security_groups = \\[aws_security_group\\.app\\.id\\]$/    self            = true/' security.tf", 'terraform apply -auto-approve', 'terraform plan')
    expect(self.out[2].exitCode).toBe(0)
    expect(self.out[3].output).not.toContain('Cycle')
    expect(await detectedAll(self.sh)).toEqual(NONE) // self = true lets web's own members in, not the app tier
    const commented = await play('cd ~/checkout-infra', "sed -i 's/^    security_groups = \\[aws_security_group\\.web\\.id\\]$/    # security_groups = [aws_security_group.web.id]/' security.tf", 'terraform validate')
    expect(commented.out[2].output).not.toContain('Cycle')
    expect(await detectedAll(commented.sh)).toEqual(NONE)
  })

  it('dropping the callbacks rule, the 443 rule, or an egress rule is not credited; nor is a wider peer rule', async () => {
    for (const omit of [['web_callbacks'], ['web_https'], ['app_all']]) {
      const x = await play('cd ~/checkout-infra', RULES({ clear: true, omit }), 'terraform apply -auto-approve', "sed -i '/^  ingress     = \\[\\]$/d;/^  egress      = \\[\\]$/d' security.tf", 'terraform plan')
      expect(x.out[2].exitCode, omit.join()).toBe(0)
      expect(x.out[4].output).toContain('No changes.')
      expect(await detectedAll(x.sh), omit.join()).toEqual(NONE)
    }
    // every protocol and port from the web group is still by group id, but it is not the narrow rule
    const wide = await play('cd ~/checkout-infra', RULES({ clear: true, app8080: 'referenced_security_group_id = aws_security_group.web.id' }).replace('from_port         = 8080\n  to_port           = 8080\n  ip_protocol       = "tcp"', 'ip_protocol       = "-1"'), 'terraform apply -auto-approve', "sed -i '/^  ingress     = \\[\\]$/d;/^  egress      = \\[\\]$/d' security.tf", 'terraform plan')
    expect(wide.out[2].exitCode).toBe(0)
    expect(wide.out[4].output).toContain('No changes.')
    expect(await detectedAll(wide.sh)).toEqual(NONE)
  })

  it('trap: a subnet or VPC CIDR instead of the peer group is scope creep: flagged wrong, never the fix', async () => {
    const finish = "sed -i '/^  ingress     = \\[\\]$/d;/^  egress      = \\[\\]$/d' security.tf"
    for (const o of [{ web8443: 'cidr_ipv4         = "10.60.11.0/24"' }, { web8443: 'cidr_ipv4         = "10.60.0.0/16"' }, { app8080: 'cidr_ipv4         = "10.60.0.0/16"' }]) {
      const x = await play('cd ~/checkout-infra', RULES({ clear: true, ...o }), 'terraform plan', 'terraform apply -auto-approve', finish, 'terraform plan')
      expect(x.out[3].exitCode).toBe(0)
      expect(x.out[5].output).toContain('No changes.')
      expect(await detectedAll(x.sh), JSON.stringify(o)).toEqual(WIDENED)
    }
    // the trap is only recorded by the session; closing it by group id earns the fix
    const x = await play('cd ~/checkout-infra', RULES({ clear: true, web8443: 'cidr_ipv4         = "10.60.11.0/24"' }), 'terraform apply -auto-approve', finish)
    await run(x.sh, RULES())
    expect((await run(x.sh, 'terraform apply -auto-approve')).exitCode).toBe(0)
    expect(await sh0(x.sh)).toBe(true)
  })

  it('trap: opening a rule to the internet is destructive once applied, and is never the fix', async () => {
    const finish = "sed -i '/^  ingress     = \\[\\]$/d;/^  egress      = \\[\\]$/d' security.tf"
    for (const o of [{ web8443: 'cidr_ipv4         = "0.0.0.0/0"' }, { web8443: 'cidr_ipv6         = "::/0"' }, { app8080: 'cidr_ipv4         = "0.0.0.0/0"' }, { app8080: 'cidr_ipv6         = "::/0"' }]) {
      const x = await play('cd ~/checkout-infra', RULES({ clear: true, ...o }), 'terraform plan')
      expect(await detectedAll(x.sh)).toEqual(NONE) // not until it's applied
      expect((await run(x.sh, 'terraform apply -auto-approve')).exitCode).toBe(0)
      await run(x.sh, finish)
      expect(await detectedAll(x.sh), JSON.stringify(o)).toEqual(OPENED)
    }
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

    const { sh, out } = await play('cd ~/checkout-infra', RULES({ clear: true }), 'terraform destroy -auto-approve', 'terraform apply -auto-approve -replace=aws_security_group.web')
    expect(out[2].exitCode).toBe(1)
    expect(out[2].output).toContain('Plan: 0 to add, 0 to change, 5 to destroy.')
    expect(out[2].output).toContain('api error DependencyViolation: resource sg-07c3e9a1d5b2f4e86 has a dependent object')
    expect(out[2].output).toContain("api error DependencyViolation: The subnet 'subnet-04e7a1c9d3b5f2068' has dependencies and cannot be deleted.")
    expect(out[3].exitCode).toBe(1)
    expect(out[3].output).toContain('aws_security_group.web: Destroying... [id=sg-0a4d7e21c9b3f5068]')
    expect(out[3].output).toContain('│ Error: deleting Security Group (sg-0a4d7e21c9b3f5068): operation error EC2: DeleteSecurityGroup, https response error StatusCode: 400')
    // the groups and the network are untouched (independent rules may have been created before the refusal)
    expect(await stateList(sh)).toEqual(expect.arrayContaining(STATE))
    expect(await ids(sh)).toBe(true)
    expect(await detectedAll(sh)).toEqual(NONE)
    // the failed attempts cost nothing: the plain apply still finishes it
    expect((await run(sh, 'terraform apply -auto-approve')).exitCode).toBe(0)
    await run(sh, "sed -i '/^  ingress     = \\[\\]$/d;/^  egress      = \\[\\]$/d' security.tf")
    expect(await detectedAll(sh)).toEqual(FIXED)

    const forgotten = await play('cd ~/checkout-infra', RULES({ clear: true }), 'terraform state rm aws_security_group.web', 'terraform apply -auto-approve')
    expect(forgotten.out[3].exitCode).toBe(1)
    expect(forgotten.out[3].output).toContain("api error InvalidGroup.Duplicate: The security group 'checkout-web' already exists for VPC 'vpc-0f2b8d4e61a9c7035'")
    expect(await detectedAll(forgotten.sh)).toEqual(NONE) // web is out of state until it's imported back
    await run(forgotten.sh, 'terraform import aws_security_group.web sg-0a4d7e21c9b3f5068')
    expect((await run(forgotten.sh, 'terraform apply -auto-approve')).exitCode).toBe(0)
    await run(forgotten.sh, "sed -i '/^  ingress     = \\[\\]$/d;/^  egress      = \\[\\]$/d' security.tf")
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
