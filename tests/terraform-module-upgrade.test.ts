import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { actionFor, runCommand } from '../src/game/engine.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-module-upgrade')
const { play, detectedAll } = playbook(scenario)

const REG = 'registry.terraform.io/acme/database/aws'
const DB = 'orders-db'
const MODS = '/home/you/infra/.terraform/modules'
// One-line forms the terminal UI can take (repeated spaces collapse).
const PIN = "sed -i 's/~> 2.0/2.0.1/' main.tf"
const INPUT = "sed -i 's/identifier.*/&\\n  storage_encrypted = false/' main.tf"
const UNGUARD = "sed -i '/prevent_destroy/d' .terraform/modules/db/main.tf"
const IGNORE = "sed -i 's/^  lifecycle {$/  lifecycle {\\n    ignore_changes = [storage_encrypted]/' .terraform/modules/db/main.tf"
const NONE = { 'pin-the-module': false, 'override-the-input': false, 'edit-the-cached-module': false, 'upgrade-again': false, 'unguard-and-apply': false }
const PINNED = { ...NONE, 'pin-the-module': true }
const OVERRIDDEN = { ...NONE, 'override-the-input': true }
const TRAPPED = { ...NONE, 'unguard-and-apply': true }
const CACHE_EDITED = { ...NONE, 'edit-the-cached-module': true }

const manifestVersion = async (sh: { read(p: string): Promise<string | undefined> }) => (JSON.parse((await sh.read(`${MODS}/modules.json`))!).Modules as { Key: string; Version?: string }[]).find((m) => m.Key === 'db')?.Version

describe('terraform-module-upgrade on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
  })

  it('(a) the first plan is a partial plan: the database is replaced because the module now encrypts it, then prevent_destroy fails; nothing is credited yet', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform plan', 'terraform state list')
    const plan = out[1]
    expect(plan.exitCode).toBe(1)
    expect(plan.output).toContain('Terraform planned the following actions, but then encountered a problem:')
    expect(plan.output).toContain('# module.db.aws_db_instance.main must be replaced')
    expect(plan.output).toMatch(/~ storage_encrypted\s+= false -> true # forces replacement/)
    expect(plan.output).toContain('Plan: 1 to add, 0 to change, 1 to destroy.\n╷\n│ Error: Instance cannot be destroyed')
    expect(plan.output).toContain('Resource module.db.aws_db_instance.main has lifecycle.prevent_destroy set,')
    expect(plan.hits).toEqual(expect.arrayContaining(['evidence:prevent-destroy-blocked', 'evidence:encryption-forces-replacement']))
    expect(out[2].output.trim()).toBe('module.db.aws_db_instance.main')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('the manifest and the cached module show 2.1.0, which the config never named', async () => {
    const { sh, out } = await play('cd ~/infra', 'cat .terraform/modules/modules.json', 'cat .terraform/modules/db/main.tf', 'grep -n version main.tf', 'terraform init')
    expect(JSON.parse(out[1].output).Modules).toEqual([
      { Key: '', Source: '', Dir: '.' },
      { Key: 'db', Source: REG, Version: '2.1.0', Dir: '.terraform/modules/db' },
    ])
    expect(out[2].output).toContain('storage_encrypted   = var.storage_encrypted')
    expect(out[2].output).toContain('default = true')
    expect(out[3].output).toContain('version = "~> 2.0"')
    // a plain init keeps the installed 2.1.0: it still satisfies ~> 2.0
    expect(out[4].output).toContain('Initializing modules...\n\nInitializing the backend...')
    expect(out[4].output).not.toContain('Downloading')
    expect(await manifestVersion(sh)).toBe('2.1.0')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b) route A: pin the version. Planning before init fails with Module version requirements have changed; init installs 2.0.1; the plan is clean', async () => {
    const { sh, out } = await play('cd ~/infra', PIN, 'grep -n version main.tf', 'terraform plan')
    expect(out[2].output).toContain('version = "2.0.1"')
    const early = out[3]
    expect(early.exitCode).toBe(1)
    expect(early.output).toContain('Error: Module version requirements have changed')
    expect(early.output).toContain('on main.tf line')
    expect(early.output.replace(/\n│ /g, ' ')).toContain('the installed version (2.1.0) is no longer acceptable. Run "terraform init" to install all modules required by this configuration.')
    expect(await detectedAll(sh)).toEqual(NONE)
    const init = await sh.run('terraform init', atStage(scenario, 0), new Set())
    expect(init.output).toContain(`Downloading ${REG} 2.0.1 for db...`)
    expect(init.output).toContain('- db in .terraform/modules/db')
    expect(await manifestVersion(sh)).toBe('2.0.1')
    const plan = await sh.run('terraform plan', atStage(scenario, 0), new Set())
    expect(plan.exitCode).toBe(0)
    expect(plan.output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(PINNED)
  })

  it('(b1) pinning with = and init -upgrade stays inside the pin; get -update does too', async () => {
    for (const re of ['init -upgrade', 'get -update']) {
      const { sh, out } = await play('cd ~/infra', "sed -i 's/~> 2.0/= 2.0.1/' main.tf", `terraform ${re}`, 'terraform plan')
      expect(out[2].output).toContain(`Downloading ${REG} 2.0.1 for db...`)
      expect(out[3].output).toContain('No changes.')
      expect(await detectedAll(sh)).toEqual(PINNED)
    }
  })

  it('(b2) only an exact pin to a 2.0.x release is the fix; ranges that merely happen to resolve to 2.0.1 plan clean but are not credited; the manifest bytes are the real compact JSON', async () => {
    for (const v of ['= 2.0.1', '2.0.1', '=2.0.1', ' 2.0.1 ']) {
      const { sh, out } = await play('cd ~/infra', `sed -i 's/version = "~> 2.0"/version = "${v}"/' main.tf`, 'terraform init', 'terraform plan', 'cat .terraform/modules/modules.json')
      expect(out[3].output, v).toContain('No changes.')
      expect(out[4].output, v).toBe(`{"Modules":[{"Key":"","Source":"","Dir":"."},{"Key":"db","Source":"${REG}","Version":"2.0.1","Dir":".terraform/modules/db"}]}`)
      expect(await detectedAll(sh), v).toEqual(PINNED)
    }
    // an optional trailing comment after the exact pin is fine
    for (const c of ['# last known good', '// last known good']) {
      const { sh } = await play('cd ~/infra', `sed -i 's|version = "~> 2.0"|version = "2.0.1" ${c}|' main.tf`, 'terraform init', 'terraform plan')
      expect(await detectedAll(sh), c).toEqual(PINNED)
    }
    // floating or range constraints still resolve to 2.0.1 and plan clean, but a range is not a pin: no credit
    for (const v of ['~> 2.0.0', '~> 2.0.1', '>= 2.0.0, < 2.1.0', '< 2.1', '!= 2.1.0, ~> 2.0', '<2.1.0']) {
      const { sh, out } = await play('cd ~/infra', `sed -i 's/version = "~> 2.0"/version = "${v}"/' main.tf`, 'terraform init', 'terraform plan', 'cat .terraform/modules/modules.json')
      expect(out[3].output, v).toContain('No changes.')
      expect(out[4].output, v).toContain('"Version":"2.0.1"')
      expect(await detectedAll(sh), v).toEqual(NONE)
    }
    // a constraint that still allows 2.1.0 plus init -upgrade lands on 2.1.0: nothing credited
    const no = await play('cd ~/infra', "sed -i 's/~> 2.0/~> 2.0/' main.tf", 'terraform init -upgrade', 'terraform plan')
    expect(no.out[3].exitCode).toBe(1)
    expect(await detectedAll(no.sh)).toEqual(NONE)
    // pinning to 2.1.0 is not a fix
    const to210 = await play('cd ~/infra', "sed -i 's/~> 2.0/2.1.0/' main.tf", 'terraform init', 'terraform plan')
    expect(to210.out[3].exitCode).toBe(1)
    expect(await detectedAll(to210.sh)).toEqual(NONE)
  })

  it('(b2a) override and pin together do not plan: 2.0.1 has no storage_encrypted input, so the pin is not credited (the override is still flagged wrong)', async () => {
    const { sh, out } = await play('cd ~/infra', INPUT, PIN, 'terraform init', 'terraform plan')
    expect(out[4].exitCode).toBe(1)
    expect(out[4].output).toContain('Unsupported argument')
    expect(await detectedAll(sh)).toEqual(OVERRIDDEN)
  })

  it('(b2b) changing the cached module default to false quiets the plan but is the wrong action, not a fix', async () => {
    const { sh, out } = await play('cd ~/infra', "sed -i 's/default = true/default = false/' .terraform/modules/db/main.tf", 'terraform plan')
    expect(out[2].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(CACHE_EDITED)
  })

  it('(b3) pinning without init is not the fix, and neither is init alone', async () => {
    const pinOnly = await play('cd ~/infra', PIN)
    expect(await detectedAll(pinOnly.sh)).toEqual(NONE)
    const initOnly = await play('cd ~/infra', 'terraform init', 'terraform plan')
    expect(initOnly.out[2].exitCode).toBe(1)
    expect(await detectedAll(initOnly.sh)).toEqual(NONE)
  })

  it('(c) disabling encryption: keeping 2.1.0 and setting storage_encrypted = false plans clean, but it is a wrong action and never the fix', async () => {
    const { sh, out } = await play('cd ~/infra', INPUT, 'cat main.tf', 'terraform plan', 'terraform state show module.db.aws_db_instance.main')
    expect(out[2].output).toContain('  storage_encrypted = false')
    expect(out[3].exitCode).toBe(0)
    expect(out[3].output).toContain('No changes.')
    expect(out[4].output).toContain(`"${DB}"`)
    expect(await manifestVersion(sh)).toBe('2.1.0')
    expect(await detectedAll(sh)).toEqual(OVERRIDDEN)
    // the weak route is flagged wrong, is not a solution path, and its feedback teaches the secure route
    const weak = scenario.actions.find((a) => a.id === 'override-the-input')!
    expect(weak.kind).toBe('wrong')
    expect(scenario.solution_paths.flat()).not.toContain('override-the-input')
    expect(scenario.solution_paths).toEqual([['pin-the-module']])
    expect(weak.feedback).toMatch(/unencrypted/i)
    // other spellings of switching it off are flagged too; setting it true is not
    const spaced = await play('cd ~/infra', "sed -i 's/identifier.*/&\\n  storage_encrypted   =   false/' main.tf")
    expect((await detectedAll(spaced.sh))['override-the-input']).toBe(true)
    const on = await play('cd ~/infra', "sed -i 's/identifier.*/&\\n  storage_encrypted = true/' main.tf")
    expect((await detectedAll(on.sh))['override-the-input']).toBe(false)
  })

  it('(c2) the pin must be in main.tf: an unchanged floating constraint with a manually edited manifest is not credited', async () => {
    const { sh } = await play('cd ~/infra', "sed -i 's/2.1.0/2.0.1/' .terraform/modules/modules.json", 'terraform plan')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(d) init -upgrade and get -update on the floating constraint pick 2.1.0 again, so they are not the fix', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform init -upgrade', 'terraform get -update', 'terraform plan')
    expect(out[1].output).toContain('Upgrading modules...')
    expect(out[1].output).toContain(`Downloading ${REG} 2.1.0 for db...`)
    expect(out[3].exitCode).toBe(1)
    expect(out[3].output).toContain('Error: Instance cannot be destroyed')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(e) trap: removing the guard from the cached module and applying destroys the production database and builds an empty encrypted one; the fix cannot be earned afterwards', async () => {
    const { sh, out } = await play('cd ~/infra', UNGUARD, 'terraform plan', 'terraform apply -auto-approve')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('# module.db.aws_db_instance.main must be replaced')
    const apply = out[3].output
    expect(out[3].exitCode).toBe(0)
    expect(apply).toContain(`module.db.aws_db_instance.main: Destroying... [id=${DB}]`)
    expect(apply).toContain('Apply complete! Resources: 1 added, 0 changed, 1 destroyed.')
    expect(await detectedAll(sh)).toEqual(TRAPPED)
    // Pinning back and re-initialising cannot earn the fix now.
    for (const l of [PIN, 'terraform init']) await sh.run(l, atStage(scenario, 0), new Set())
    // the new database is already encrypted, so the old pin even plans clean: still not credited
    expect((await sh.run('terraform plan', atStage(scenario, 0), new Set())).output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('(f) wrong: ignore_changes in the cached module quiets the plan but is not the fix; init -upgrade throws the edit away and the problem returns', async () => {
    const { sh, out } = await play('cd ~/infra', IGNORE, 'terraform plan')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(CACHE_EDITED)
    await sh.run('terraform init -upgrade', atStage(scenario, 0), new Set())
    const again = await sh.run('terraform plan', atStage(scenario, 0), new Set())
    expect(again.exitCode).toBe(1)
    expect(again.output).toContain('Error: Instance cannot be destroyed')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(g) -target does not get around the guard: the module is the target', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform apply -target=module.db -auto-approve')
    expect(out[1].exitCode).toBe(1)
    expect(out[1].output).toContain('Error: Instance cannot be destroyed')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(h) both fix routes keep the same database; re-applying is a no-op', async () => {
    for (const [route, want] of [[[PIN, 'terraform init'], PINNED]] as const) {
      const { sh, out } = await play('cd ~/infra', ...route, 'terraform apply -auto-approve', 'terraform apply -auto-approve', 'terraform state show module.db.aws_db_instance.main')
      expect(out.at(-3)!.output).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.')
      expect(out.at(-2)!.output).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.')
      expect(out.at(-1)!.output).toContain(`"${DB}"`)
      expect(await sh.doneWhen({ reality_has: { type: 'aws_db_instance', id: DB, attr: 'storage_encrypted', equals: false } })).toBe(true)
      expect(await detectedAll(sh)).toEqual(want)
    }
  })

  it('(i) the provider did not change: terraform version and git agree', async () => {
    const { out } = await play('cd ~/infra', 'terraform version', 'git status', 'git log -p -- main.tf')
    expect(out[1].output).toContain('provider registry.terraform.io/hashicorp/aws v5.67.0')
    expect(out[1].hits).toContain('evidence:provider-unchanged')
    expect(out[2].output).toContain('nothing to commit, working tree clean')
    expect(out[3].output).toContain('+  version = "~> 2.0"')
  })

  it('the scripted lookups answer, carry notes and mount the real files', async () => {
    const { out } = await play('cd ~/infra', 'git log --oneline', 'git status', 'git log -p -- main.tf')
    expect(out[1].output).toContain('adopt acme/database/aws for the orders database')
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.match!], c.match).toBeDefined()
  })

  it('(j) every key evidence tag is awarded before the fix', async () => {
    const lines = ['cd ~/infra', 'terraform plan', 'terraform version', 'git status', 'git log -p -- main.tf', 'cat .terraform/modules/modules.json', 'cat .terraform/modules/db/main.tf']
    const { out } = await play(...lines)
    const hits = out.flatMap((r) => r.hits)
    const tags = new Set([
      ...hits.filter((h) => h.startsWith('evidence:')).map((h) => h.slice('evidence:'.length)),
      ...scenario.terminal!.commands.filter((c) => c.match && hits.includes(c.match)).map((c) => c.evidence),
      // scripted reads of files on disk are answered by the real shell; the engine still counts them as evidence
      ...lines.map((l) => runCommand(atStage(scenario, 0), l, new Set()).evidence),
    ])
    for (const t of scenario.key_evidence) expect(tags.has(t), t).toBe(true)
  })

  it('the pin is only interim: stage 2 requires the ordered snapshot, encrypted copy and restore (unencrypted restore wrong, deleting the old instance destructive)', () => {
    expect(scenario.actions.find((a) => a.id === 'pin-the-module')!.label).toMatch(/interim/)
    expect(scenario.stages).toHaveLength(1)
    const two = atStage(scenario, 1)
    expect(two.solution_paths).toEqual([['create-snapshot', 'copy-encrypted', 'restore-encrypted']])
    const by = (id: string) => two.actions.find((a) => a.id === id)!
    expect(by('copy-encrypted').after).toEqual(['create-snapshot'])
    expect(by('restore-encrypted').after).toEqual(['copy-encrypted'])
    expect(by('restore-unencrypted').kind).toBe('wrong')
    expect(by('delete-old-first').kind).toBe('destructive')
    const id = (cmd: string) => actionFor(two, cmd)?.id
    expect(id('aws rds create-db-snapshot --db-instance-identifier orders-db --db-snapshot-identifier orders-db-pre-2-1')).toBe('create-snapshot')
    expect(id('aws rds copy-db-snapshot --source-db-snapshot-identifier orders-db-pre-2-1 --target-db-snapshot-identifier orders-db-enc-2-1 --kms-key-id alias/orders-db')).toBe('copy-encrypted')
    expect(id('aws rds copy-db-snapshot --source-db-snapshot-identifier orders-db-pre-2-1 --target-db-snapshot-identifier orders-db-enc-2-1')).toBeUndefined()
    expect(id('aws rds restore-db-instance-from-db-snapshot --db-instance-identifier orders-db-v2 --db-snapshot-identifier orders-db-enc-2-1')).toBe('restore-encrypted')
    expect(id('aws rds restore-db-instance-from-db-snapshot --db-instance-identifier orders-db-v2 --db-snapshot-identifier orders-db-pre-2-1')).toBe('restore-unencrypted')
    expect(id('aws rds delete-db-instance --db-instance-identifier orders-db --skip-final-snapshot')).toBe('delete-old-first')
  })

  it('stage 2 typed commands accept = forms, quotes, harmless flags and global flags before the service; the AWS-managed default key and extra flags are not credited', () => {
    const two = atStage(scenario, 1)
    const id = (cmd: string) => actionFor(two, cmd)?.id
    expect(id('aws rds create-db-snapshot --db-instance-identifier=orders-db --db-snapshot-identifier=orders-db-pre-2-1 --no-cli-pager')).toBe('create-snapshot')
    expect(id('aws --region us-east-1 rds create-db-snapshot --db-instance-identifier "orders-db" --db-snapshot-identifier orders-db-pre-2-1 --output json')).toBe('create-snapshot')
    expect(id('aws rds copy-db-snapshot --source-db-snapshot-identifier=orders-db-pre-2-1 --target-db-snapshot-identifier=orders-db-enc-2-1 --kms-key-id=alias/orders-db --region=us-east-1')).toBe('copy-encrypted')
    expect(id("aws rds copy-db-snapshot --source-db-snapshot-identifier 'orders-db-pre-2-1' --target-db-snapshot-identifier orders-db-enc-2-1 --kms-key-id 'alias/orders-db'")).toBe('copy-encrypted')
    expect(id('aws rds copy-db-snapshot --source-db-snapshot-identifier orders-db-pre-2-1 --target-db-snapshot-identifier orders-db-enc-2-1 --kms-key-id alias/aws/rds')).toBe('copy-default-key')
    expect(id('aws rds copy-db-snapshot --source-db-snapshot-identifier orders-db-pre-2-1 --target-db-snapshot-identifier orders-db-enc-2-1 --kms-key-id=alias/aws/rds')).toBe('copy-default-key')
    expect(id('aws rds copy-db-snapshot --source-db-snapshot-identifier orders-db-pre-2-1 --target-db-snapshot-identifier orders-db-enc-2-1 --kms-key-id alias/orders-db --copy-tags')).toBeUndefined()
    expect(id('aws rds restore-db-instance-from-db-snapshot --db-instance-identifier=orders-db-v2 --db-snapshot-identifier=orders-db-enc-2-1 --no-cli-pager')).toBe('restore-encrypted')
    expect(id('aws rds restore-db-instance-from-db-snapshot --db-instance-identifier=orders-db-v2 --db-snapshot-identifier=orders-db-pre-2-1')).toBe('restore-unencrypted')
    expect(id('aws --region us-east-1 rds delete-db-instance --db-instance-identifier "orders-db" --skip-final-snapshot')).toBe('delete-old-first')
    expect(id("aws rds delete-db-instance --db-instance-identifier='orders-db'")).toBe('delete-old-first')
    expect(id('aws rds create-db-snapshot --db-instance-identifier orders-db --db-snapshot-identifier orders-db-pre-2-1 --region us-west-2')).toBeUndefined()
    expect(two.actions.find((a) => a.id === 'copy-default-key')!.kind).toBe('wrong')
  })
})
