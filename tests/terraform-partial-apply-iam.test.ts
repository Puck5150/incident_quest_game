import { describe, expect, it } from 'vitest'
import { actionFor, engineHandles, evidenceSeen, newSession, step, terminalOutput, type GameEvent } from '../src/game/engine.ts'
import type { IncidentShell } from '../src/game/shell.ts'
import { ScenarioSchema } from '../src/schema/scenario.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-partial-apply-iam')
const { play, detectedAll } = playbook(scenario)

const GRANTED = new Set(['grant-rds-permission'])
const WILD_GRANTED = new Set(['grant-wildcard'])
const NETWORK = ['aws_security_group.db', 'aws_subnet.data_a', 'aws_subnet.data_b', 'aws_vpc.main']
const IDS = { aws_vpc: 'vpc-0a4c7e2f91b3d5068', aws_subnet: 'subnet-03e9b1d7a5c2f4806', aws_security_group: 'sg-05d1f3b7a9c2e4681' }
const DENIED = 'not authorized to perform: rds:CreateDBInstance on resource: arn:aws:rds:us-east-1:123456789012:db:orders-db because no identity-based policy allows the rds:CreateDBInstance action'
// The detected actions are the world-based ones; the grant is a typed command or a button.
const NONE = { 'grant-rds-permission': false, 'finish-apply': false, 'destroy-and-retry': false, 'edit-state': false, 'grant-wildcard': false, 'overwrite-deploy-policy': false }
const FIXED = { ...NONE, 'finish-apply': true }
const TRAPPED = { ...NONE, 'destroy-and-retry': true }
const ARN = 'arn:aws:rds:us-east-1:123456789012:db:orders-db'
const doc = (action: string, resource: string, effect = 'Allow') => `'{"Version":"2012-10-17","Statement":[{"Effect":"${effect}","Action":${action},"Resource":${resource}}]}'`
const GOOD_DOC = doc('["rds:CreateDBInstance","rds:AddTagsToResource"]', `"${ARN}"`)
const put = (document: string, over = '', name = 'orders-rds') => `aws iam put-role-policy --profile platform-admin --role-name orders-ci-deploy --policy-name ${name} --policy-document ${document}${over}`
const GRANT = put(GOOD_DOC)

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

  it('(e) the typed put-role-policy takes the grant only as the admin profile, as an additional policy, with the specific action on the specific database; mistyped or as the pipeline role it does not', () => {
    const ok = [
      GRANT,
      put(GOOD_DOC, ' --profile platform-admin').replace('--profile platform-admin --role', '--role'),
      put(doc('"rds:CreateDBInstance"', `"${ARN}"`)),
      put(doc('["rds:CreateDBInstance"]', `["${ARN}"]`)),
      put(GOOD_DOC.replace('"Effect":"Allow"', '"Effect": "Allow"').replace('"Action":', '"Action" :')),
      put(GOOD_DOC, '', 'ci-rds-create'),
      // reachability: another key order, double-quoted JSON, a Condition that only narrows, case-insensitive action names
      put(`'{"Statement":[{"Resource":"${ARN}","Action":["rds:CreateDBInstance"],"Effect":"Allow"}],"Version":"2012-10-17"}'`),
      put(`"{\\"Version\\":\\"2012-10-17\\",\\"Statement\\":[{\\"Effect\\":\\"Allow\\",\\"Action\\":[\\"rds:CreateDBInstance\\"],\\"Resource\\":\\"${ARN}\\"}]}"`),
      put(`'{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["rds:CreateDBInstance"],"Resource":"${ARN}","Condition":{"StringEquals":{"aws:RequestedRegion":"us-east-1"}}}]}'`),
      put(doc('["RDS:createdbinstance","rds:AddTagsToResource"]', `"${ARN}"`)),
      `AWS_PROFILE=platform-admin aws iam put-role-policy --role-name orders-ci-deploy --policy-name orders-rds --policy-document ${GOOD_DOC}`,
      `aws --profile platform-admin iam put-role-policy --role-name orders-ci-deploy --policy-name orders-rds --policy-document ${GOOD_DOC}`,
      `aws iam put-role-policy --role-name=orders-ci-deploy --policy-name=orders-rds --policy-document=${GOOD_DOC} --profile=platform-admin`,
    ]
    for (const cmd of ok) expect(actionFor(scenario, cmd)?.id, cmd).toBe('grant-rds-permission')
    const stmt = (action: string, resource: string) => `{"Effect":"Allow","Action":${action},"Resource":${resource}}`
    const two = (a: string, b: string) => `'{"Version":"2012-10-17","Statement":[${a},${b}]}'`
    const none = [
      // as the pipeline role, mistyped role or profile
      put(GOOD_DOC).replace('--profile platform-admin ', ''),
      put(GOOD_DOC).replace('orders-ci-deploy', 'orders-ci-deployer'),
      put(GOOD_DOC).replace('platform-admin', 'platform-admins'),
      put(GOOD_DOC).replace('platform-admin', 'platform-admin-x'),
      put(GOOD_DOC).replace('--role-name orders-ci-deploy', '--role-name orders-ci-deploy-x'),
      put(GOOD_DOC).replace(/ --policy-document .*/, ''),
      // the action is missing, misspelt, or only a read
      put(doc('"rds:DescribeDBInstances"', `"${ARN}"`)),
      put(doc('"rds:CreateDBCluster"', `"${ARN}"`)),
      put(doc('["rds:AddTagsToResource"]', `"${ARN}"`)),
      // more than the least privilege, however it is spelt
      put(doc('["rds:CreateDBInstance","rds:DeleteDBInstance"]', `"${ARN}"`)),
      put(doc('["rds:CreateDBInstance","rds:ModifyDBInstance"]', `"${ARN}"`)),
      put(doc('["rds:CreateDBInstance","iam:PassRole"]', `"${ARN}"`)),
      put(doc('["rds:CreateDBInstance","iam:AttachRolePolicy"]', `"${ARN}"`)),
      put(two(stmt('["rds:CreateDBInstance"]', `"${ARN}"`), stmt('["iam:*"]', `"${ARN}"`))),
      put(two(stmt('["rds:CreateDBInstance"]', `"${ARN}"`), stmt('["rds:DeleteDBInstance"]', '"arn:aws:rds:us-east-1:123456789012:db:prod-orders"'))),
      put(two(stmt('["rds:CreateDBInstance"]', `"${ARN}"`), stmt('["iam:AttachRolePolicy"]', `"${ARN}"`))),
      // the resource is unbounded or another database / account / list
      put(doc('["rds:CreateDBInstance"]', '"arn:aws:rds:us-east-1:123456789012:db:orders-*"')),
      put(doc('["rds:CreateDBInstance"]', '"arn:aws:rds:us-east-1:123456789012:db:other-db"')),
      put(doc('["rds:CreateDBInstance"]', '"arn:aws:rds:us-east-1:999999999999:db:orders-db"')),
      put(doc('["rds:CreateDBInstance"]', `["${ARN}","arn:aws:rds:us-east-1:123456789012:db:other-db"]`)),
      put(two(stmt('["rds:CreateDBInstance"]', `"${ARN}"`), stmt('["rds:CreateDBInstance"]', '"arn:aws:rds:us-east-1:123456789012:db:other-db"'))),
      // not an Allow, or Not*
      put(doc('["rds:CreateDBInstance"]', `"${ARN}"`, 'Deny')),
      put(`'{"Version":"2012-10-17","Statement":[{"Effect":"Allow","NotAction":["rds:DeleteDBInstance"],"Resource":"${ARN}"}]}'`),
      put(`'{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["rds:CreateDBInstance"],"NotResource":"${ARN}"}]}'`),
      // a second command on the line
      `${GRANT} && aws iam attach-role-policy --profile platform-admin --role-name orders-ci-deploy --policy-arn arn:aws:iam::aws:policy/AdministratorAccess`,
      `${GRANT}; aws iam attach-role-policy --role-name orders-ci-deploy --policy-arn arn:aws:iam::aws:policy/AdministratorAccess`,
      `${GRANT} | cat`,
      `${GRANT} || true`,
      `${GRANT} $(whoami)`,
      `${GRANT} \`whoami\``,
      // names a real shell would rewrite, and repeated JSON keys
      put(GOOD_DOC).replace('--policy-name orders-rds', '--policy-name $N'),
      put(GOOD_DOC).replace('orders-rds', 'terraform-\\deploy'),
      put(GOOD_DOC).replace('orders-rds', 'terraform-{deploy,x}'),
      put(GOOD_DOC).replace('orders-rds', "$'terraform-deploy'"),
      put(GOOD_DOC).replace('orders-rds', 'terraform-d*'),
      put(`'{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"rds:DeleteDBInstance","Action":"rds:CreateDBInstance","Resource":"${ARN}"}]}'`),
      put(`'{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Effect":"Allow","Action":"rds:CreateDBInstance","Resource":"${ARN}"}]}'`),
      // a file the lab cannot read
      put('file://orders-rds.json'),
    ]
    for (const cmd of none) expect(actionFor(scenario, cmd)?.id, cmd).not.toBe('grant-rds-permission')
    // the scripted denial never answers a command that takes the grant, and vice versa
    const deny = scenario.terminal!.commands.find((c) => c.match_regex?.includes('put-role-policy') && c.output.includes('AccessDenied'))!
    for (const cmd of [GRANT, `aws --profile platform-admin iam put-role-policy --role-name orders-ci-deploy --policy-name orders-rds --policy-document ${GOOD_DOC}`])
      expect(new RegExp(deny.match_regex!).test(cmd.replace(/\s+/g, ' ')), cmd).toBe(false)
    for (const cmd of ['aws --profile orders-ci iam put-role-policy --role-name orders-ci-deploy --policy-name x --policy-document file://x.json', 'aws iam put-role-policy --profile platform-admin-x --role-name orders-ci-deploy --policy-name x --policy-document file://x.json'])
      expect(new RegExp(deny.match_regex!).test(cmd), cmd).toBe(true)
    // as the pipeline role the call itself is denied
    expect(terminalOutput(scenario, put(GOOD_DOC).replace('--profile platform-admin ', ''), [])).toContain(
      'is not authorized to perform: iam:PutRolePolicy on resource: role orders-ci-deploy because no identity-based policy allows the iam:PutRolePolicy action',
    )
    // a policy file is not read in the lab: the answer says so and nothing is credited
    expect(terminalOutput(scenario, put('file://orders-rds.json'), [])).toMatch(/inline/)
  })

  it('(e1) wildcards are wrong, never the fix: rds:*, Action *, Resource * and rds:Create* are flagged and teach least privilege', () => {
    const wild = scenario.actions.find((a) => a.id === 'grant-wildcard')!
    expect(wild.kind).toBe('wrong')
    expect(scenario.solution_paths.flat()).not.toContain('grant-wildcard')
    expect(wild.feedback).toMatch(/least privilege|only what/i)
    for (const cmd of [
      put(doc('"rds:*"', `"${ARN}"`)),
      put(doc('["rds:*"]', '"*"')),
      put(doc('"*"', '"*"')),
      put(doc('["rds:CreateDBInstance"]', '"*"')),
      put(doc('["rds:CreateDBInstance","rds:*"]', `"${ARN}"`)),
      put(doc('"rds:Create*"', `"${ARN}"`)),
      put(doc('["rds:CreateDBInstance"]', '["*"]')),
      put(doc('["rds:CreateDBInstance"]', `["${ARN}","*"]`)),
      put(doc('"RDS:*"', `"${ARN}"`)),
      put(doc('["rds:CreateDBInstance","rds:Delete*"]', `"${ARN}"`)),
      put(doc('["rds:CreateDBInstance","iam:*"]', `"${ARN}"`)),
    ])
      expect(actionFor(scenario, cmd)?.id, cmd).toBe('grant-wildcard')
    // a compound line earns nothing, not even the wrong-action penalty
    expect(actionFor(scenario, `${put(doc('"rds:*"', '"*"'))} && echo done`)).toBeUndefined()
    // reusing the existing policy's name replaces it: flagged wrong, whatever the document
    const over = scenario.actions.find((a) => a.id === 'overwrite-deploy-policy')!
    expect(over.kind).toBe('wrong')
    for (const n of ['terraform-deploy', 'Terraform-Deploy']) expect(actionFor(scenario, put(GOOD_DOC, '', n))?.id, n).toBe('overwrite-deploy-policy')
    expect(['grant-wildcard', 'overwrite-deploy-policy']).toContain(actionFor(scenario, put(doc('"rds:*"', '"*"'), '', 'terraform-deploy'))?.id)
  })

  it('(e3) a wildcard grant does not lift the denial or complete the incident: the least-privilege grant is still needed', async () => {
    const { sh } = await play('cd ~/orders-infra')
    const apply = await run(sh, 'terraform apply -auto-approve', WILD_GRANTED)
    expect(apply.exitCode).toBe(1)
    expect(apply.output).toContain(DENIED)
    const d = await detectedAll(sh)
    expect(d['finish-apply']).toBe(false)
    expect(d['grant-rds-permission']).toBe(false)
    expect(scenario.solution_paths).toEqual([['grant-rds-permission', 'finish-apply']])
  })

  it('(e4) overwriting the existing terraform-deploy policy does not lift the denial', async () => {
    const { sh } = await play('cd ~/orders-infra')
    const apply = await run(sh, 'terraform apply -auto-approve', new Set(['overwrite-deploy-policy']))
    expect(apply.exitCode).toBe(1)
    expect(apply.output).toContain(DENIED)
  })

  it('(e2) through the engine the typed grant is held until the root cause is named, then taken', () => {
    let s = step(scenario, newSession(), { type: 'START', at: 0 })
    s = step(scenario, s, { type: 'RUN_COMMAND', input: GRANT, at: 1 })
    expect(s.log.some((e) => e.type === 'TAKE_ACTION')).toBe(false)
    s = step(scenario, s, { type: 'DECLARE_HYPOTHESIS', id: 'ci-role-lacks-rds-create', at: 2 })
    s = step(scenario, s, { type: 'RUN_COMMAND', input: GRANT, at: 3 })
    expect(s.log.at(-1)).toEqual({ type: 'TAKE_ACTION', id: 'grant-rds-permission', at: 3 })
    // a wildcard typed after naming the cause is taken as the wrong action
    const w = step(scenario, s, { type: 'RUN_COMMAND', input: put(doc('"rds:*"', '"*"')), at: 4 })
    expect(w.log.at(-1)).toEqual({ type: 'TAKE_ACTION', id: 'grant-wildcard', at: 4 })
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

  it('the iam_policy specs are validated: the example must earn its verdict and the specs must match', () => {
    const bad = structuredClone(scenario)
    bad.actions.find((a) => a.id === 'grant-rds-permission')!.iam_policy!.example = put(doc('"rds:*"', '"*"'))
    expect(ScenarioSchema.safeParse(bad).success).toBe(false)
    const drift = structuredClone(scenario)
    drift.actions.find((a) => a.id === 'grant-wildcard')!.iam_policy!.resource = 'arn:aws:rds:us-east-1:123456789012:db:other'
    expect(ScenarioSchema.safeParse(drift).success).toBe(false)
    expect(ScenarioSchema.safeParse(scenario).success).toBe(true)
  })
  describe('finish-apply persists once earned (history based)', () => {
    const fixedRun = async (...after: string[]) => {
      const { sh } = await play('cd ~/orders-infra')
      expect((await run(sh, 'terraform apply -auto-approve', GRANTED)).exitCode).toBe(0)
      for (const l of after) await run(sh, l, GRANTED)
      return sh
    }

    it('survives an unrelated state change before the cause is named', async () => {
      const sh = await fixedRun('terraform apply -auto-approve -replace=aws_db_instance.orders')
      expect(await sh.doneWhen({ plan_clean: true })).toBe(true)
      expect((await detectedAll(sh))['finish-apply']).toBe(true)
    })

    it('survives a comment edit in db.tf after the fix', async () => {
      const sh = await fixedRun("echo '# note' >> db.tf")
      expect((await detectedAll(sh))['finish-apply']).toBe(true)
    })

    it('the destroy-dependencies trap never credits it, nor does a later recreate', async () => {
      const { sh } = await play('cd ~/orders-infra', 'terraform destroy -auto-approve')
      await run(sh, 'terraform apply -auto-approve', GRANTED)
      expect((await detectedAll(sh))['finish-apply']).toBe(false)
      for (const addr of ['aws_vpc.main', 'aws_subnet.data_a']) {
        const { sh: s2 } = await play('cd ~/orders-infra')
        await run(s2, 'terraform apply -auto-approve', GRANTED)
        await run(s2, `terraform apply -auto-approve -replace=${addr}`, GRANTED)
        expect((await detectedAll(s2))['finish-apply'], addr).toBe(false)
      }
    })

    it('editing state by hand or state rm of the database credits nothing', async () => {
      const { sh } = await play('cd ~/orders-infra', 'terraform state pull')
      expect((await detectedAll(sh))['finish-apply']).toBe(false)
      const sh2 = await fixedRun('terraform state rm aws_db_instance.orders')
      expect((await detectedAll(sh2))['finish-apply']).toBe(false)
    })

    it('the wrong policies never lift the denial, so nothing is credited', async () => {
      for (const taken of [WILD_GRANTED, new Set(['overwrite-deploy-policy'])]) {
        const { sh } = await play('cd ~/orders-infra')
        expect((await run(sh, 'terraform apply -auto-approve', taken)).exitCode).toBe(1)
        expect((await detectedAll(sh))['finish-apply']).toBe(false)
      }
    })

    it('stopgap flags on the applying run do not credit it', async () => {
      for (const flags of ['-target=aws_db_instance.orders', '-lock=false', '-refresh=false', '-var=x=1']) {
        const { sh } = await play('cd ~/orders-infra')
        await run(sh, `terraform apply -auto-approve ${flags}`, GRANTED)
        expect((await detectedAll(sh))['finish-apply'], flags).toBe(false)
      }
    })

    it('wording agrees: label, hint and ideal path all say a plain apply', () => {
      const fa = scenario.actions.find((a) => a.id === 'finish-apply')!
      expect(fa.label).toMatch(/no -target/)
      expect(scenario.hints.answer).toMatch(/no -target/)
      expect(scenario.debrief.ideal_path.join(' ')).toMatch(/no -target/)
    })
  })

})
