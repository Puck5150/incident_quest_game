import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { runCommand } from '../src/game/engine.ts'
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
const NONE = { 'keep-the-database': false, 'edit-the-cached-module': false, 'upgrade-again': false, 'unguard-and-apply': false }
const FIXED = { ...NONE, 'keep-the-database': true }
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
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(b1) pinning with = and init -upgrade stays inside the pin; get -update does too', async () => {
    for (const re of ['init -upgrade', 'get -update']) {
      const { sh, out } = await play('cd ~/infra', "sed -i 's/~> 2.0/= 2.0.1/' main.tf", `terraform ${re}`, 'terraform plan')
      expect(out[2].output).toContain(`Downloading ${REG} 2.0.1 for db...`)
      expect(out[3].output).toContain('No changes.')
      expect(await detectedAll(sh)).toEqual(FIXED)
    }
  })

  it('(b2) a pin that only excludes 2.1.0 (~> 2.0.1) is also a fix; a pin to 2.1.0 is not', async () => {
    const ok = await play('cd ~/infra', "sed -i 's/~> 2.0/~> 2.0.1/' main.tf", 'terraform init', 'terraform plan')
    expect(ok.out[3].output).toContain('No changes.')
    expect(await detectedAll(ok.sh)).toEqual(FIXED)
    const no = await play('cd ~/infra', "sed -i 's/~> 2.0/2.1.0/' main.tf", 'terraform init', 'terraform plan')
    expect(no.out[3].exitCode).toBe(1)
    expect(await detectedAll(no.sh)).toEqual(NONE)
  })

  it('(b3) pinning without init is not the fix, and neither is init alone', async () => {
    const pinOnly = await play('cd ~/infra', PIN)
    expect(await detectedAll(pinOnly.sh)).toEqual(NONE)
    const initOnly = await play('cd ~/infra', 'terraform init', 'terraform plan')
    expect(initOnly.out[2].exitCode).toBe(1)
    expect(await detectedAll(initOnly.sh)).toEqual(NONE)
  })

  it('(c) route B: keep 2.1.0 and set the input that restores the old behaviour; the plan is clean and the version stays', async () => {
    const { sh, out } = await play('cd ~/infra', INPUT, 'cat main.tf', 'terraform plan', 'terraform state show module.db.aws_db_instance.main')
    expect(out[2].output).toContain('  storage_encrypted = false')
    expect(out[3].exitCode).toBe(0)
    expect(out[3].output).toContain('No changes.')
    expect(out[4].output).toContain(`"${DB}"`)
    expect(await manifestVersion(sh)).toBe('2.1.0')
    expect(await detectedAll(sh)).toEqual(FIXED)
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
    for (const route of [[PIN, 'terraform init'], [INPUT]]) {
      const { sh, out } = await play('cd ~/infra', ...route, 'terraform apply -auto-approve', 'terraform apply -auto-approve', 'terraform state show module.db.aws_db_instance.main')
      expect(out.at(-3)!.output).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.')
      expect(out.at(-2)!.output).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.')
      expect(out.at(-1)!.output).toContain(`"${DB}"`)
      expect(await sh.doneWhen({ reality_has: { type: 'aws_db_instance', id: DB, attr: 'storage_encrypted', equals: false } })).toBe(true)
      expect(await detectedAll(sh)).toEqual(FIXED)
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
})
