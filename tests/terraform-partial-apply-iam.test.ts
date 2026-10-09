import { describe, expect, it } from 'vitest'
import { actionFor, engineHandles, evidenceSeen, newSession, step, terminalOutput, type GameEvent } from '../src/game/engine.ts'
import type { IncidentShell } from '../src/game/shell.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-partial-apply-iam')
const { play, detectedAll } = playbook(scenario)

const GRANTED = new Set(['grant-rds-permission'])
const NETWORK = ['aws_security_group.db', 'aws_subnet.data_a', 'aws_subnet.data_b', 'aws_vpc.main']
const IDS = { aws_vpc: 'vpc-0a4c7e2f91b3d5068', aws_subnet: 'subnet-03e9b1d7a5c2f4806', aws_security_group: 'sg-05d1f3b7a9c2e4681' }
const DENIED = 'not authorized to perform: rds:CreateDBInstance on resource: arn:aws:rds:us-east-1:123456789012:db:orders-db because no identity-based policy allows the rds:CreateDBInstance action'
// The detected actions are the world-based ones; the grant is a typed command or a button.
const NONE = { 'grant-rds-permission': false, 'finish-apply': false, 'destroy-and-retry': false, 'edit-state': false }
const FIXED = { ...NONE, 'finish-apply': true }
const TRAPPED = { ...NONE, 'destroy-and-retry': true }
const GRANT = 'aws iam put-role-policy --profile platform-admin --role-name orders-ci-deploy --policy-name orders-rds --policy-document file://orders-rds.json'

const run = (sh: IncidentShell, line: string, taken = new Set<string>()) => sh.run(line, atStage(scenario, 0), taken)
const serial = async (sh: IncidentShell) => JSON.parse((await run(sh, 'terraform state pull')).output).serial as number
const stateList = async (sh: IncidentShell) => (await run(sh, 'terraform state list')).output.split('\n').filter(Boolean)
const networkInCloud = async (sh: IncidentShell) =>
  (await sh.doneWhen({ reality_has: { type: 'aws_vpc', id: IDS.aws_vpc } })) &&
  (await sh.doneWhen({ reality_has: { type: 'aws_subnet', id: IDS.aws_subnet } })) &&
  (await sh.doneWhen({ reality_has: { type: 'aws_security_group', id: IDS.aws_security_group } }))

describe('terraform-partial-apply-iam on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
  })

  it('(a) state holds the network from the CI run and the plan only adds the database', async () => {
    const { sh, out } = await play('cd ~/orders-infra', 'terraform state list', 'terraform plan', 'terraform validate')
    expect(out[1].output.split('\n').filter(Boolean)).toEqual(NETWORK)
    expect(out[1].hits).toContain('evidence:network-in-state')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('  # aws_db_instance.orders will be created\n  + resource "aws_db_instance" "orders" {')
    expect(out[2].output).toContain('Plan: 1 to add, 0 to change, 0 to destroy.')
    expect(out[2].hits).toContain('evidence:partial-apply')
    expect(out[3].output).toContain('Success! The configuration is valid.')
    expect(scenario.terraform!.files.find((f) => f.path === 'main.tf')!.content).toContain('backend "s3" {')
    expect(await networkInCloud(sh)).toBe(true)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b) apply reproduces the AccessDenied box, exits 1, changes nothing, and fails the same way again', async () => {
    const { sh: fresh } = await play('cd ~/orders-infra')
    const before = await serial(fresh)
    const { sh, out } = await play('cd ~/orders-infra', 'terraform apply -auto-approve', 'terraform apply -auto-approve')
    // nothing changed, so the state is not rewritten with a new serial
    expect(await serial(sh)).toBe(before)
    for (const r of [out[1], out[2]]) {
      expect(r.exitCode).toBe(1)
      expect(r.output).toContain('aws_db_instance.orders: Creating...\n╷\n│ Error: creating RDS DB Instance (orders-db): operation error RDS: CreateDBInstance, https response error StatusCode: 403')
      expect(r.output).toContain(`api error AccessDenied: User: arn:aws:sts::123456789012:assumed-role/orders-ci-deploy/you-laptop is ${DENIED}`)
      expect(r.output).toContain('│   with aws_db_instance.orders,\n│   on db.tf line 6, in resource "aws_db_instance" "orders":')
      expect(r.output).not.toContain('Apply complete!')
      expect(r.hits).toContain('evidence:access-denied')
    }
    expect(await stateList(sh)).toEqual(NETWORK)
    expect(await sh.doneWhen({ state_lacks: 'aws_db_instance.orders' })).toBe(true)
    expect(await sh.doneWhen({ reality_lacks: { type: 'aws_db_instance', id: 'orders-db' } })).toBe(true)
    expect(await networkInCloud(sh)).toBe(true)
    expect((await run(sh, 'terraform plan')).output).toContain('Plan: 1 to add, 0 to change, 0 to destroy.')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(c) once the permission is granted, apply creates only the database and the fix is detected', async () => {
    const { sh } = await play('cd ~/orders-infra', 'terraform apply -auto-approve')
    const apply = await run(sh, 'terraform apply -auto-approve', GRANTED)
    expect(apply.exitCode).toBe(0)
    expect(apply.output).toContain('aws_db_instance.orders: Creation complete after 2m10s [id=orders-db]')
    expect(apply.output).toContain('Apply complete! Resources: 1 added, 0 changed, 0 destroyed.')
    expect(apply.output).not.toContain('Destroying')
    expect(await stateList(sh)).toEqual(['aws_db_instance.orders', ...NETWORK])
    expect(await networkInCloud(sh)).toBe(true)
    expect((await run(sh, 'terraform plan', GRANTED)).output).toContain('No changes. Your infrastructure matches the configuration.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(c2) granting before ever reproducing the failure works in one apply', async () => {
    const { sh } = await play('cd ~/orders-infra')
    const apply = await run(sh, 'terraform apply -auto-approve', GRANTED)
    expect(apply.exitCode).toBe(0)
    expect(apply.output).toContain('Apply complete! Resources: 1 added, 0 changed, 0 destroyed.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(d) trap: destroying the partial network to start clean is destructive, and the fix cannot be earned afterwards', async () => {
    const { sh, out } = await play('cd ~/orders-infra', 'terraform apply -auto-approve', 'terraform destroy -auto-approve')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain(`aws_vpc.main: Destroying... [id=${IDS.aws_vpc}]`)
    expect(out[2].output).toContain('Destroy complete! Resources: 4 destroyed.')
    expect(await sh.doneWhen({ reality_lacks: { type: 'aws_vpc', id: IDS.aws_vpc } })).toBe(true)
    expect(await detectedAll(sh)).toEqual(TRAPPED)
    // granting and re-creating everything still leaves the destroy on record
    const again = await run(sh, 'terraform apply -auto-approve', GRANTED)
    expect(again.output).toContain('Apply complete! Resources: 5 added, 0 changed, 0 destroyed.')
    expect((await run(sh, 'terraform plan', GRANTED)).output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('(d2) destroying before the grant then retrying still fails at the database', async () => {
    const { sh } = await play('cd ~/orders-infra', 'terraform destroy -auto-approve')
    const before = await serial(sh)
    const apply = await run(sh, 'terraform apply -auto-approve')
    // a failed apply that did create other objects saves them: the serial moves
    expect(await serial(sh)).toBe(before + 1)
    expect(apply.exitCode).toBe(1)
    expect(apply.output).toContain('Plan: 5 to add, 0 to change, 0 to destroy.')
    expect(apply.output).toContain(DENIED)
    expect(await stateList(sh)).toEqual(NETWORK)
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('(e) the typed put-role-policy with the admin profile takes the grant; mistyped or as the pipeline role it does not', () => {
    const grant = scenario.actions.find((a) => a.id === 'grant-rds-permission')!
    for (const cmd of [
      GRANT,
      'aws iam put-role-policy --role-name orders-ci-deploy --policy-name orders-rds --policy-document file://orders-rds.json --profile platform-admin',
      'aws iam put-role-policy --role-name=orders-ci-deploy --policy-name=orders-rds --policy-document=file://orders-rds.json --profile=platform-admin',
      'AWS_PROFILE=platform-admin aws iam put-role-policy --role-name orders-ci-deploy --policy-name orders-rds --policy-document file://orders-rds.json',
      'aws --profile platform-admin iam put-role-policy --role-name orders-ci-deploy --policy-name orders-rds --policy-document file://orders-rds.json',
    ])
      expect(actionFor(scenario, cmd), cmd).toBe(grant)
    for (const cmd of [
      'aws iam put-role-policy --role-name orders-ci-deploy --policy-name orders-rds --policy-document file://orders-rds.json',
      'aws iam put-role-policy --profile platform-admin --role-name orders-ci-deployer --policy-name orders-rds --policy-document file://orders-rds.json',
      'aws iam put-role-policy --profile platform-admin --role-name orders-ci-deploy --policy-name orders-rds',
      'aws iam put-role-policy --profile platform-admins --role-name orders-ci-deploy --policy-name orders-rds --policy-document file://orders-rds.json',
      'aws iam put-role-policy --profile platform-admin-x --role-name orders-ci-deploy --policy-name orders-rds --policy-document file://orders-rds.json',
      'aws --profile platform-admin-x iam put-role-policy --role-name orders-ci-deploy --policy-name orders-rds --policy-document file://orders-rds.json',
      'aws iam put-role-policy --profile platform-admin --role-name orders-ci-deploy-x --policy-name orders-rds --policy-document file://orders-rds.json',
    ])
      expect(actionFor(scenario, cmd), cmd).toBeUndefined()
    // the scripted denial never answers a command that takes the grant, and vice versa
    const deny = scenario.terminal!.commands.find((c) => c.match_regex?.includes('put-role-policy'))!
    for (const cmd of [GRANT, 'aws --profile platform-admin iam put-role-policy --role-name orders-ci-deploy --policy-name orders-rds --policy-document file://orders-rds.json'])
      expect(new RegExp(deny.match_regex!).test(cmd), cmd).toBe(false)
    for (const cmd of ['aws --profile orders-ci iam put-role-policy --role-name orders-ci-deploy --policy-name x --policy-document file://x.json', 'aws iam put-role-policy --profile platform-admin-x --role-name orders-ci-deploy --policy-name x --policy-document file://x.json'])
      expect(new RegExp(deny.match_regex!).test(cmd), cmd).toBe(true)
    // as the pipeline role the call itself is denied
    expect(terminalOutput(scenario, 'aws iam put-role-policy --role-name orders-ci-deploy --policy-name orders-rds --policy-document file://orders-rds.json', [])).toContain(
      'is not authorized to perform: iam:PutRolePolicy on resource: role orders-ci-deploy because no identity-based policy allows the iam:PutRolePolicy action',
    )
  })

  it('(e2) through the engine the typed grant is held until the root cause is named, then taken', () => {
    let s = step(scenario, newSession(), { type: 'START', at: 0 })
    s = step(scenario, s, { type: 'RUN_COMMAND', input: GRANT, at: 1 })
    expect(s.log.some((e) => e.type === 'TAKE_ACTION')).toBe(false)
    s = step(scenario, s, { type: 'DECLARE_HYPOTHESIS', id: 'ci-role-lacks-rds-create', at: 2 })
    s = step(scenario, s, { type: 'RUN_COMMAND', input: GRANT, at: 3 })
    expect(s.log.at(-1)).toEqual({ type: 'TAKE_ACTION', id: 'grant-rds-permission', at: 3 })
  })

  it('the scripted lookups answer, match the files on disk, and carry notes', async () => {
    const { out } = await play('cd ~/orders-infra', 'cat ci-apply.log', 'aws sts get-caller-identity', 'aws iam get-role-policy --role-name orders-ci-deploy --policy-name terraform-deploy')
    expect(out[1].output).toContain('aws_subnet.data_b: Creation complete after 1s [id=subnet-07f2a8c4e6b1d3950]')
    expect(out[1].output).toContain(`assumed-role/orders-ci-deploy/GitHubActions is ${DENIED}`)
    expect(out[1].output).toContain('│   with aws_db_instance.orders,')
    expect(out[2].output).toContain('"Arn": "arn:aws:sts::123456789012:assumed-role/orders-ci-deploy/you-laptop"')
    // the engine answers these exact lines before the shell sees them (the shell itself ignores AWS_PROFILE)
    for (const cmd of ['AWS_PROFILE=platform-admin aws sts get-caller-identity', 'aws --profile platform-admin sts get-caller-identity', 'aws sts get-caller-identity --profile platform-admin']) {
      expect(engineHandles(scenario, cmd, []), cmd).toBe(true)
      expect(terminalOutput(scenario, cmd, []), cmd).toContain('assumed-role/AWSReservedSSO_PlatformAdmin_5f2c8e1a9b3d7c40/you@acme.example')
    }
    expect(out[3].output).toContain('"rds:Describe*"')
    expect(out[3].output).not.toContain('rds:CreateDBInstance')
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.match ?? c.example!], c.match ?? c.example).toBeDefined()
  })

  it('(f) every key evidence tag is awarded on the ideal path before any fix', async () => {
    const shell = ['cd ~/orders-infra', 'terraform plan', 'terraform apply -auto-approve', 'aws sts get-caller-identity']
    const { out } = await play(...shell)
    const hits = out.flatMap((r) => r.hits)
    const log: GameEvent[] = [{ type: 'RUN_COMMAND', input: 'cat ci-apply.log', at: 0 }]
    const tags = new Set([
      ...hits.filter((h) => h.startsWith('evidence:')).map((h) => h.slice('evidence:'.length)),
      ...scenario.terminal!.commands.filter((c) => c.match && hits.includes(c.match)).map((c) => c.evidence),
    ])
    for (const t of scenario.key_evidence) expect(tags.has(t), t).toBe(true)
    // the CI log on its own also shows the denial
    expect(evidenceSeen(scenario, log).has('access-denied')).toBe(true)
  })
})
