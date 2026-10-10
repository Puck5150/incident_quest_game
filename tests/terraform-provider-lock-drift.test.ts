import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { runCommand } from '../src/game/engine.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-provider-lock-drift')
const { play, detectedAll } = playbook(scenario)

const AWS = 'registry.terraform.io/hashicorp/aws'
const H67 = 'h1:Zq0uB8Zc1nS5eYpR3m7KpTz2W0k6YV3d8J4bN1xQwLs='
// One-line forms the terminal UI can take (repeated spaces collapse).
const REVERT = "sed -i 's/~> 5.50/~> 5.31/' main.tf"
const HAND50 = "sed -i 's/5.31.0/5.50.0/' .terraform.lock.hcl"
const HAND67 = "sed -i 's/5.31.0/5.67.0/' .terraform.lock.hcl"
const NONE = { 'refresh-lock': false, 'revert-the-bump': false, 'hand-edit-lock': false, 'ignore-the-lock': false }
const stage0 = atStage(scenario, 0)
const FIXED = { ...NONE, 'refresh-lock': true }

describe('terraform-provider-lock-drift on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
  })

  it('(a) the first plan fails on the lock file before looking at the bucket; the exact box; nothing credited', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform plan')
    const plan = out[1]
    expect(plan.exitCode).toBe(1)
    expect(plan.output).toBe(
      `╷\n│ Error: Inconsistent dependency lock file\n│ \n│ The following dependency selections recorded in the lock file are\n│ inconsistent with the current configuration:\n│   - provider ${AWS}: locked version selection 5.31.0 doesn't match the updated version constraints "~> 5.50"\n│ \n│ To update the locked dependency selections to match a changed configuration,\n│ run:\n│   terraform init -upgrade\n╵`,
    )
    expect(plan.hits).toContain('evidence:lock-mismatch')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('apply, destroy and refresh stop the same way', async () => {
    const { out } = await play('cd ~/infra', 'terraform apply -auto-approve', 'terraform destroy -auto-approve', 'terraform refresh')
    for (const o of out.slice(1)) {
      expect(o.exitCode).toBe(1)
      expect(o.output).toContain('Error: Inconsistent dependency lock file')
    }
  })

  it('(b) key evidence is obtainable before the fix with commands that work while the lock is inconsistent', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform version', 'terraform providers', 'terraform validate', 'terraform state list', 'git diff origin/main', 'git diff --stat origin/main', 'git status', 'git log --oneline', 'cat .terraform.lock.hcl', 'terraform plan')
    expect(out[1].output).toContain(`+ provider ${AWS} v5.31.0`)
    expect(out[1].hits).toContain('evidence:lock-selects-old')
    expect(out[2].output).toContain(`└── provider[${AWS}] ~> 5.50`)
    expect(out[2].hits).toContain('evidence:config-wants-new')
    expect(out[3].output).toContain('Success! The configuration is valid.')
    expect(out[4].output.trim()).toBe('aws_s3_bucket.artifacts')
    expect(out[5].output).toContain('-      version = "~> 5.31"\n+      version = "~> 5.50"')
    expect(out[6].output).toBe(' main.tf | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)')
    expect(out[7].output).toContain('nothing to commit, working tree clean')
    expect(out[9].output).toContain('version     = "5.31.0"\n  constraints = "~> 5.31"')
    const lines = ['terraform plan', 'terraform version', 'git diff origin/main', 'git diff --stat origin/main']
    const tags = new Set([
      ...out.flatMap((o) => o.hits).filter((h) => h.startsWith('evidence:')).map((h) => h.slice(9)),
      ...lines.map((l) => runCommand(atStage(scenario, 0), l, new Set()).evidence),
    ])
    for (const tag of scenario.key_evidence!) expect(tags.has(tag), tag).toBe(true)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('a plain terraform init does not help: it keeps the lock and fails to query', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform init', 'terraform plan')
    expect(out[1].exitCode).toBe(1)
    expect(out[1].output.replace(/\n│ /g, ' ')).toContain(`Error: Failed to query available provider packages  Could not retrieve the list of available versions for provider hashicorp/aws: locked provider ${AWS} 5.31.0 does not match configured version constraint ~> 5.50; must use terraform init -upgrade to allow selection of new versions`)
    expect(out[2].exitCode).toBe(1)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(c) the fix: init -upgrade selects 5.67.0, rewrites the lock, the plan is clean, git shows the lock modified', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform init -upgrade', 'cat .terraform.lock.hcl', 'terraform plan', 'terraform version', 'terraform init -upgrade')
    expect(out[1].exitCode).toBe(0)
    expect(out[1].output).toContain('- Finding hashicorp/aws versions matching "~> 5.50"...\n- Installing hashicorp/aws v5.67.0...\n- Installed hashicorp/aws v5.67.0 (signed by HashiCorp)')
    expect(out[1].output).toContain('Terraform has made some changes to the provider dependency selections recorded\nin the .terraform.lock.hcl file.')
    expect(out[2].output).toBe(`# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\nprovider "${AWS}" {\n  version     = "5.67.0"\n  constraints = "~> 5.50"\n  hashes = [\n    "${H67}",\n  ]\n}`)
    expect(out[3].exitCode).toBe(0)
    expect(out[3].output).toContain('No changes.')
    expect(out[4].output).toContain(`+ provider ${AWS} v5.67.0`)
    // the scripted git lookups switch once the fix is taken
    const taken = new Set(['refresh-lock'])
    expect((await sh.run('git status', stage0, taken)).output).toContain('modified:   .terraform.lock.hcl')
    expect((await sh.run('git diff --stat origin/main', stage0, taken)).output).toBe(' .terraform.lock.hcl | 6 +++---\n main.tf             | 2 +-\n 2 files changed, 4 insertions(+), 4 deletions(-)')
    expect(out[5].output).toContain('- Using previously-installed hashicorp/aws v5.67.0')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(c1) the fix is credited by the world: init -upgrade after a cap that selects 5.50.0 also counts; the bump must stay', async () => {
    const cap = await play('cd ~/infra', "sed -i 's/~> 5.50/~> 5.50, < 5.60/' main.tf", 'terraform init -upgrade', 'terraform plan', 'cat .terraform.lock.hcl')
    expect(cap.out[2].output).toContain('- Installing hashicorp/aws v5.50.0...')
    expect(cap.out[3].output).toContain('No changes.')
    expect(cap.out[4].output).toContain('version     = "5.50.0"\n  constraints = "~> 5.50, < 5.60"')
    expect(await detectedAll(cap.sh)).toEqual(FIXED)
    const loose = await play('cd ~/infra', "sed -i 's/~> 5.50/>= 5.50/' main.tf", 'terraform init -upgrade', 'terraform plan')
    expect(loose.out[3].exitCode).toBe(0)
    expect(await detectedAll(loose.sh)).toEqual(FIXED)
  })

  it('(d) hand-editing the lock version: plan refuses with Required plugins are not installed, init refuses with the checksum error; wrong, not a fix', async () => {
    const { sh, out } = await play('cd ~/infra', HAND50, 'terraform plan', 'terraform init', 'terraform state list')
    expect(out[2].exitCode).toBe(1)
    expect(out[2].output).toContain('Error: Required plugins are not installed')
    expect(out[2].output).toContain(`there is no package for ${AWS} 5.50.0 cached in .terraform/providers`)
    expect(out[3].exitCode).toBe(1)
    expect(out[3].output.replace(/\n│ /g, ' ')).toContain(`Error: Failed to install provider  Error while installing hashicorp/aws v5.50.0: the current package for ${AWS} 5.50.0 doesn't match any of the checksums previously recorded in the dependency lock file`)
    expect(out[4].exitCode).toBe(1)
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'hand-edit-lock': true })
  })

  it('(d1) after a hand edit, init -upgrade repairs it when it picks another version (the fix is still earnable); the mistake stays recorded by the engine', async () => {
    const { sh, out } = await play('cd ~/infra', HAND50, 'terraform init -upgrade', 'terraform plan')
    expect(out[2].exitCode).toBe(0)
    expect(out[3].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(d2) editing to the version init -upgrade would pick (5.67.0) is not repaired by init -upgrade; deleting the lock and init is', async () => {
    const { sh, out } = await play('cd ~/infra', HAND67, 'terraform plan', 'terraform init -upgrade', 'rm -f .terraform.lock.hcl', 'terraform init', 'terraform plan')
    expect(out[1].exitCode).toBe(0)
    expect(out[2].output).toContain(`there is no package for ${AWS} 5.67.0 cached`)
    expect(out[3].exitCode).toBe(1)
    expect(out[3].output).toContain('Error: Failed to install provider')
    const stuck = await play('cd ~/infra', HAND67)
    expect(await detectedAll(stuck.sh)).toEqual({ ...NONE, 'hand-edit-lock': true })
    expect(out[5].output).toContain('Terraform has created a lock file .terraform.lock.hcl')
    expect(out[6].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(d3) hand-editing the version AND the constraints line is still wrong: no package is cached', async () => {
    const { sh, out } = await play('cd ~/infra', "sed -i 's/5.31.0/5.67.0/;s/~> 5.31/~> 5.50/' .terraform.lock.hcl", 'terraform plan')
    expect(out[2].output).toContain('Error: Required plugins are not installed')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'hand-edit-lock': true })
  })

  it('(e) reverting the constraint makes the plan clean but is the wrong action, not a fix', async () => {
    const { sh, out } = await play('cd ~/infra', REVERT, 'terraform plan', 'git diff --stat origin/main')
    expect(out[2].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'revert-the-bump': true })
  })

  it('(e1) reverting and then upgrading again is not credited; re-raising and init -upgrade is the fix', async () => {
    const { sh } = await play('cd ~/infra', REVERT, 'terraform init -upgrade', "sed -i 's/~> 5.31/~> 5.50/' main.tf", 'terraform init -upgrade', 'terraform plan')
    expect((await detectedAll(sh))['refresh-lock']).toBe(true)
  })

  it('(f) gitignoring the lock file is wrong and changes nothing about the failure', async () => {
    const { sh, out } = await play('cd ~/infra', 'echo .terraform.lock.hcl >> .gitignore', 'terraform plan')
    expect(out[2].exitCode).toBe(1)
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'ignore-the-lock': true })
  })

  it('(f1) a negation or comment line naming the lock file is not the mistake', async () => {
    const { sh } = await play('cd ~/infra', "printf '!.terraform.lock.hcl\\n# terraform.lock.hcl is committed\\n' >> .gitignore")
    expect(await detectedAll(sh)).toEqual(NONE)
    const bare = await play('cd ~/infra', "echo 'terraform.lock.hcl' >> .gitignore")
    expect((await detectedAll(bare.sh))['ignore-the-lock']).toBe(true)
  })

  it('(d4) git checkout / git restore put the committed (stale) lock back: the original error returns and the fix is still reachable', async () => {
    for (const undo of ['git checkout -- .terraform.lock.hcl', 'git checkout .terraform.lock.hcl', 'git restore .terraform.lock.hcl', 'git restore --source=HEAD .terraform.lock.hcl']) {
      const { sh, out } = await play('cd ~/infra', HAND50, 'terraform plan', undo, 'terraform plan', 'git status', 'terraform init -upgrade', 'terraform plan')
      expect(out[2].output, undo).toContain('Required plugins are not installed')
      expect(out[3].exitCode, undo).toBe(0)
      expect(out[3].output, undo).toBe('')
      expect(out[4].output, undo).toContain('Error: Inconsistent dependency lock file')
      expect(out[5].output, undo).toContain('working tree clean')
      expect(out[7].output, undo).toContain('No changes.')
      expect(await detectedAll(sh), undo).toEqual(FIXED)
    }
    const other = await play('cd ~/infra', 'git checkout -b x', 'git checkout -- nothere.tf')
    expect(other.out[1].output).toContain('no simulated output')
  })

  it('(g) -lockfile=readonly: conflicts with -upgrade, and fails (without changing the lock) on the stale lock', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform init -upgrade -lockfile=readonly', 'terraform init -lockfile=readonly', 'cat .terraform.lock.hcl')
    expect(out[1].exitCode).toBe(1)
    expect(out[1].output).toContain('Error: The -upgrade flag conflicts with -lockfile=readonly.')
    expect(out[2].exitCode).toBe(1)
    expect(out[3].output).toContain('version     = "5.31.0"')
    // after the fix, a readonly init in CI passes
    const ok = await play('cd ~/infra', 'terraform init -upgrade', 'terraform init -lockfile=readonly')
    expect(ok.out[2].exitCode).toBe(0)
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('is idempotent: the fix twice, plan twice, nothing changes', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform init -upgrade', 'cat .terraform.lock.hcl', 'terraform init -upgrade', 'cat .terraform.lock.hcl', 'terraform plan', 'terraform plan')
    expect(out[4].output).toBe(out[2].output)
    expect(out[6].output).toBe(out[5].output)
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('the fix action is the only solution path', () => {
    const stage = atStage(scenario, 0)
    expect(stage.actions.find((a) => a.id === 'refresh-lock')!.kind).toBe('fix')
    expect(scenario.solution_paths).toEqual([['refresh-lock']])
  })
})
