import { describe, expect, it } from 'vitest'
import { evidenceSeen } from '../src/game/engine.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-state-in-git')
const { play, detectedAll } = playbook(scenario)

const NONE = { 'remote-backend': false, rotate: false, 'gitignore-only': false, 'make-private': false }
const A = 'terraform apply -auto-approve'
const CD = 'cd ~/analytics-infra'
const BACKEND = (extra = '  use_lockfile = true\n', enc = '  encrypt      = true\n') =>
  `cat > backend.tf <<'EOF'\nterraform {\n  backend "s3" {\n    bucket = "acme-tfstate"\n    key    = "analytics-infra/terraform.tfstate"\n    region = "us-east-1"\n${enc}${extra}  }\n}\nEOF`
const IGNORE = `printf '*.tfstate\\n*.tfstate.*\\n' >> .gitignore`
const INIT = 'echo yes | terraform init'
const RM_BACKUP = 'rm -f terraform.tfstate.backup'
const ROTATE = 'terraform apply -auto-approve -replace=random_password.db'
const FIX = [BACKEND(), INIT, IGNORE, RM_BACKUP]

describe('terraform-state-in-git on the simulator', () => {
  it('is backed by the simulator; only git is scripted; ids, kinds and solution path', () => {
    expect(scenario.terraform?.state_file).toBe(true)
    expect(scenario.terminal!.commands.every((c) => /^git /.test(c.match ?? c.example ?? ''))).toBe(true)
    expect(scenario.actions.map((a) => [a.id, a.kind])).toEqual([
      ['remote-backend', 'fix'],
      ['rotate', 'fix'],
      ['gitignore-only', 'wrong'],
      ['make-private', 'wrong'],
    ])
    expect(scenario.solution_paths).toEqual([['remote-backend', 'rotate']])
    expect(scenario.key_evidence).toEqual(['password-in-state', 'state-tracked', 'no-backend'])
  })

  it('(a) the password is in the state file and in state pull; state show hides it; the plan is clean', async () => {
    const { sh, out } = await play(CD, "grep -c '\"result\"' terraform.tfstate", 'terraform state show random_password.db', 'terraform state pull', 'terraform plan')
    expect(out[1].output.trim()).toBe('1')
    expect(out[2].output).toContain('(sensitive value)')
    expect(out[3].output).toContain('"result"')
    expect(out[3].hits).toContain('evidence:password-in-state')
    expect(out[4].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b) git ls-files shows the tracked state and tags state-tracked', async () => {
    const { out } = await play(CD, 'git ls-files | grep tfstate')
    expect(out[1].output).toContain('terraform.tfstate.backup')
    expect(evidenceSeen(scenario, [{ type: 'RUN_COMMAND', input: 'git ls-files | grep tfstate', at: 0 }]).has('state-tracked')).toBe(true)
  })

  it('(c) ideal: backend + init (yes) + .gitignore + rm backup credits remote-backend; rotate credits rotate', async () => {
    const { sh, out } = await play(CD, ...FIX)
    expect(out[2].output).toContain('Successfully configured the backend "s3"')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'remote-backend': true })
    const r = await play(CD, ...FIX, ROTATE, 'terraform plan')
    expect(r.out[FIX.length + 2].output).toContain('No changes.')
    expect(await detectedAll(r.sh)).toEqual({ ...NONE, 'remote-backend': true, rotate: true })
  })

  it('(d) rotate first, then migrate: both credited; rotation changes the password', async () => {
    const { sh, out } = await play(CD, 'terraform state pull', ROTATE, 'terraform state pull', ...FIX)
    const pw = (t: string) => /"result": "([^"]+)"/.exec(t)![1]
    expect(pw(out[3].output)).not.toBe(pw(out[1].output))
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'remote-backend': true, rotate: true })
  })

  it('(e) rotate alone credits only rotate', async () => {
    const { sh } = await play(CD, ROTATE)
    expect(await detectedAll(sh)).toEqual({ ...NONE, rotate: true })
  })

  it('(f) holes: editing the backend config without init credits nothing, plan demands init', async () => {
    const { sh, out } = await play(CD, BACKEND(), IGNORE, RM_BACKUP, 'terraform plan')
    expect(out[4].output).toContain('Backend initialization required')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(g) holes: .gitignore alone, or with rm of the files, credits nothing', async () => {
    const { sh } = await play(CD, IGNORE, 'terraform plan')
    expect(await detectedAll(sh)).toEqual(NONE)
    const r = await play(CD, IGNORE, 'rm -f terraform.tfstate terraform.tfstate.backup', 'terraform plan')
    expect(await detectedAll(r.sh)).toEqual(NONE)
  })

  it('(h) holes: migrating but leaving the backup, or the .gitignore, or without encryption or locking, does not credit', async () => {
    for (const [name, lines] of [
      ['backup left behind', [BACKEND(), INIT, IGNORE]],
      ['no .gitignore', [BACKEND(), INIT, RM_BACKUP]],
      ['no encryption', [BACKEND('  use_lockfile = true\n', ''), INIT, IGNORE, RM_BACKUP]],
      ['no locking', [BACKEND(''), INIT, IGNORE, RM_BACKUP]],
    ] as const) {
      const { sh } = await play(CD, ...lines)
      expect(await detectedAll(sh), name).toEqual(NONE)
    }
  })

  it('(i) holes: init -reconfigure drops the state: plan wants to recreate everything, nothing credited, apply makes a second database', async () => {
    const { sh, out } = await play(CD, BACKEND(), 'echo no | terraform init -reconfigure', IGNORE, RM_BACKUP, 'terraform plan')
    expect(out[5].output).toContain('Plan: 2 to add, 0 to change, 0 to destroy.')
    expect(await detectedAll(sh)).toEqual(NONE)
    await sh.run(A, (await import('../src/schema/stages.ts')).atStage(scenario, 0), new Set())
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(j) holes: init answering no starts empty, nothing credited', async () => {
    const { sh } = await play(CD, BACKEND(), 'echo no | terraform init', IGNORE, RM_BACKUP, 'terraform plan')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(k) destroying the database to rotate does not credit rotate', async () => {
    const { sh } = await play(CD, 'terraform destroy -auto-approve', A)
    expect((await detectedAll(sh)).rotate).toBe(false)
  })

  it('(l) fixes survive a later unrelated apply; the migrated state is still the same database', async () => {
    const { sh, out } = await play(CD, ...FIX, ROTATE, A, 'terraform state list')
    expect(out[out.length - 1].output).toContain('aws_db_instance.analytics')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'remote-backend': true, rotate: true })
  })

  it('(m) a deleted state file counts as not containing the password', async () => {
    const { sh } = await play(CD, ...FIX)
    expect(await sh.read('/home/you/analytics-infra/terraform.tfstate.backup')).toBeUndefined()
  })

  it('(n) remount replays the same world', async () => {
    const first = await play(CD, ...FIX, ROTATE)
    const again = await play(CD, ...FIX, ROTATE)
    expect(await detectedAll(again.sh)).toEqual(await detectedAll(first.sh))
  })

  it('(o) the backend may live in main.tf, or lock with dynamodb_table instead of use_lockfile', async () => {
    const MAIN = `cat >> main.tf <<'EOF'\nterraform {\n  backend "s3" {\n    bucket = "acme-tfstate"\n    key    = "a/terraform.tfstate"\n    region = "us-east-1"\n    encrypt = true\n    use_lockfile = true\n  }\n}\nEOF`
    const a = await play(CD, MAIN, INIT, IGNORE, RM_BACKUP)
    expect(await detectedAll(a.sh)).toEqual({ ...NONE, 'remote-backend': true })
    const b = await play(CD, BACKEND('  dynamodb_table = "tf-locks"\n'), INIT, IGNORE, RM_BACKUP)
    expect(await detectedAll(b.sh)).toEqual({ ...NONE, 'remote-backend': true })
  })

  it('(p) taint then apply rotates the password and credits rotate', async () => {
    const { sh } = await play(CD, 'terraform taint random_password.db', A)
    expect(await detectedAll(sh)).toEqual({ ...NONE, rotate: true })
  })

  it('(q) .gitignore must cover the state file itself and the backup', async () => {
    const ONLY = (lines: string) => `printf '${lines}' >> .gitignore`
    for (const [name, lines, ok] of [
      ['backup only', 'terraform.tfstate.backup\\n', false],
      ['state only', 'terraform.tfstate\\n', false],
      ['*.tfstate*', '*.tfstate*\\n', true],
      ['both globs', '*.tfstate\\n*.tfstate.*\\n', true],
      ['commented out', '# *.tfstate*\\n', false],
    ] as const) {
      const { sh } = await play(CD, BACKEND(), INIT, ONLY(lines), RM_BACKUP)
      expect((await detectedAll(sh))['remote-backend'], name).toBe(ok)
    }
  })

  it('(r) the lab runs a Terraform that supports use_lockfile (1.10 or later), and git ls-files keeps listing the tracked state', async () => {
    const { out } = await play(CD, 'terraform version', ...FIX, 'git ls-files | grep tfstate')
    expect(out[1].output).toMatch(/Terraform v1\.11\.0/)
    expect(out[out.length - 1].output).toContain('terraform.tfstate.backup')
  })
})
