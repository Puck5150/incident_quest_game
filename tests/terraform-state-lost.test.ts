import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-state-lost')
const { play, detectedAll } = playbook(scenario)

const ADDRS = ['aws_cloudwatch_log_group.api', 'aws_cloudwatch_log_group.worker', 'aws_iam_role.task', 'aws_s3_bucket.app_logs']
const IMPORTS = [
  'terraform import aws_s3_bucket.app_logs acme-app-logs',
  'terraform import aws_cloudwatch_log_group.api /acme/api',
  'terraform import aws_iam_role.task acme-task-role',
  'terraform import aws_cloudwatch_log_group.worker /acme/worker',
]
const IMPORT_BLOCKS = `cat > imports.tf <<'EOF'
import {
  to = aws_s3_bucket.app_logs
  id = "acme-app-logs"
}

import {
  to = aws_cloudwatch_log_group.api
  id = "/acme/api"
}

import {
  to = aws_iam_role.task
  id = "acme-task-role"
}

import {
  to = aws_cloudwatch_log_group.worker
  id = "/acme/worker"
}
EOF`
const BACKEND = (extra = '  use_lockfile = true\n  encrypt      = true\n') => `cat > backend.tf <<'EOF'
terraform {
  backend "s3" {
    bucket = "acme-tf-state"
    key    = "api/terraform.tfstate"
    region = "us-east-1"
${extra.replace(/^/gm, '  ')}  }
}
EOF`
const MIGRATE = 'terraform init -migrate-state -force-copy'
const NONE = { 'import-resources': false, 'weak-backend': false, 'apply-anyway': false, 'delete-and-recreate': false }
const FIXED = { ...NONE, 'import-resources': true }

describe('terraform-state-lost on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terraform!.state ?? []).toEqual([])
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
  })

  it('(a) the first plan wants to create all four, and state list finds no state', async () => {
    const { out } = await play('cd ~/infra', 'terraform plan', 'terraform state list')
    expect(out[1].exitCode).toBe(0)
    expect(out[1].output).toContain('Plan: 4 to add, 0 to change, 0 to destroy.')
    for (const a of ADDRS) expect(out[1].output).toContain(`# ${a} will be created`)
    expect(out[1].hits).toContain('evidence:wants-to-create')
    expect(out[2].output).toContain('No state file was found!')
    expect(out[2].hits).toContain('evidence:no-state')
  })

  it('(b) applying anyway fails on all four with the AWS already-exists errors and leaves state empty', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform apply -auto-approve', 'terraform state list')
    const apply = out[1]
    expect(apply.exitCode).toBe(1)
    expect(apply.output).toContain('Error: creating S3 Bucket (acme-app-logs): BucketAlreadyExists')
    expect(apply.output).toContain('EntityAlreadyExists: Role with name acme-task-role already exists.')
    expect(apply.output).toContain('creating CloudWatch Logs Log Group (/acme/api)')
    expect(apply.output).toContain('creating CloudWatch Logs Log Group (/acme/worker)')
    expect(apply.output.match(/ResourceAlreadyExistsException: The specified log group already exists/g)).toHaveLength(2)
    expect(apply.output).not.toContain('SQS')
    expect(out[2].output).not.toMatch(/aws_/)
    expect(await detectedAll(sh)).toEqual(NONE)
    // the fix is still reachable afterwards
    for (const l of IMPORTS) expect((await sh.run(l, atStage(scenario, 0), new Set())).exitCode).toBe(0)
    expect(await detectedAll(sh)).toEqual(NONE)
    for (const l of [BACKEND(), MIGRATE]) await sh.run(l, atStage(scenario, 0), new Set())
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(c) route A: four terraform import commands, the backend, then a clean plan', async () => {
    const { sh, out } = await play('cd ~/infra', ...IMPORTS, 'terraform state list', 'terraform plan')
    expect(await detectedAll(sh)).toEqual(NONE) // imports alone leave the state on the laptop: not the fix
    await sh.run(BACKEND(), atStage(scenario, 0), new Set())
    await sh.run(MIGRATE, atStage(scenario, 0), new Set())
    for (const r of out.slice(1, 5)) {
      expect(r.exitCode).toBe(0)
      expect(r.output).toContain('Import successful!')
    }
    expect(out[5].output.trim().split('\n')).toEqual(ADDRS)
    expect(out[6].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(d) route B: import blocks, apply with yes, the backend, then a clean plan', async () => {
    const { sh, out } = await play('cd ~/infra', IMPORT_BLOCKS, 'terraform plan', 'echo yes | terraform apply', 'terraform state list', 'terraform plan')
    expect(await detectedAll(sh)).toEqual(NONE)
    await sh.run(BACKEND(), atStage(scenario, 0), new Set())
    await sh.run(MIGRATE, atStage(scenario, 0), new Set())
    expect(out[2].output).toContain('Plan: 4 to import, 0 to add, 0 to change, 0 to destroy.')
    expect(out[3].exitCode).toBe(0)
    expect(out[3].output).toContain('Apply complete! Resources: 4 imported, 0 added, 0 changed, 0 destroyed.')
    expect(out[4].output.trim().split('\n')).toEqual(ADDRS)
    expect(out[5].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(e) three of four imported is not the fix', async () => {
    const { sh, out } = await play('cd ~/infra', ...IMPORTS.slice(0, 3), 'terraform plan')
    expect(out[4].output).toContain('Plan: 1 to add, 0 to change, 0 to destroy.')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(f) importing with a wrong id fails and changes nothing', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform import aws_cloudwatch_log_group.worker acme/worker', 'terraform state list')
    expect(out[1].exitCode).toBe(1)
    expect(out[1].output).toContain('Cannot import non-existent remote object')
    expect(out[2].output).toContain('No state file was found!')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  const RAW = (block: string, name = 'backend.tf') => `cat > ${name} <<'EOF'\nterraform {\n${block}}\nEOF`
  const BE = (inner: string) => `  backend "s3" {\n    bucket = "acme-tf-state"\n    key    = "api/terraform.tfstate"\n${inner}  }\n`

  it('(c1) weak backends are not the fix and get their own wrong action once initialised: unencrypted, no locking, comment, tag or heredoc spoofs', async () => {
    const WEAK = { ...NONE, 'weak-backend': true }
    const weak = [
      BACKEND('  use_lockfile = true\n'),
      BACKEND('  encrypt = true\n'),
      BACKEND('  use_lockfile = true\n  encrypt = false # encrypt = true\n'),
      BACKEND('  # use_lockfile = true\n  encrypt = true\n'),
      BACKEND('  encrypt = true\n  /* use_lockfile = true */\n'),
      RAW(BE('    encrypt = false\n    tags = {\n      encrypt = true\n      use_lockfile = true\n    }\n')),
      RAW(BE('    encrypt = false\n    note = <<-EOT\n    encrypt = true\n    use_lockfile = true\n    EOT\n')),
      RAW(BE('    encrypt = false\n    assume_role {\n      encrypt = true\n      use_lockfile = true\n    }\n')),
    ]
    for (const [i, w] of weak.entries()) {
      const { sh } = await play('cd ~/infra', ...IMPORTS, w, MIGRATE)
      expect(await detectedAll(sh), String(i)).toEqual(WEAK)
    }
    const declined = await play('cd ~/infra', ...IMPORTS, BACKEND(), 'echo no | terraform init -migrate-state')
    expect((await declined.sh.run('terraform plan', atStage(scenario, 0), new Set())).output).toContain('to add')
    expect(await detectedAll(declined.sh)).toEqual(NONE)
    // a backend declared but never initialised: the state is still the local file
    const noInit = await play('cd ~/infra', ...IMPORTS, BACKEND())
    expect(await detectedAll(noInit.sh)).toEqual(NONE)
  })

  it('(c2) the backend may live in any .tf file, with a nested block first or all on one line; a good one in a comment does not count', async () => {
    const BLOCK = 'terraform {\n  backend "s3" {\n    bucket = "acme-tf-state"\n    key = "api/terraform.tfstate"\n    encrypt = true\n    use_lockfile = true\n  }\n}\n'
    for (const [name, how] of [['versions.tf', '>'], ['main.tf', '>>'], ['backend.tf', '>']] as const) {
      const { sh } = await play('cd ~/infra', ...IMPORTS, `printf '${BLOCK.replace(/\n/g, '\\n')}' ${how} ${name}`, MIGRATE)
      expect(await detectedAll(sh), name).toEqual(FIXED)
    }
    const nested = await play('cd ~/infra', ...IMPORTS, RAW(BE('    assume_role {\n      role_arn = "arn:aws:iam::123456789012:role/state"\n    }\n    encrypt = true\n    use_lockfile = true\n')), MIGRATE)
    expect(await detectedAll(nested.sh)).toEqual(FIXED)
    const dynamo = await play('cd ~/infra', ...IMPORTS, RAW(BE('    encrypt = true\n    dynamodb_table = "terraform-locks"\n')), MIGRATE)
    expect(await detectedAll(dynamo.sh)).toEqual(FIXED)
    const commented = await play('cd ~/infra', ...IMPORTS, `printf '${BLOCK.replace(/^/gm, '# ').replace(/\n/g, '\\n')}' > backend.tf`, MIGRATE)
    expect(await detectedAll(commented.sh)).toEqual(NONE)
  })

  it('(c3) two backend blocks are an error at init and on every command, like Terraform; a weak and a good pair credits nothing', async () => {
    const good = RAW(BE('    encrypt = true\n    use_lockfile = true\n'))
    const weakOne = RAW(BE('    encrypt = false\n'), 'extra.tf')
    const { sh, out } = await play('cd ~/infra', ...IMPORTS, good, weakOne, MIGRATE, 'terraform plan')
    expect(out[7].exitCode).toBe(1)
    expect(out[7].output).toContain('Duplicate backend configuration')
    expect(out[8].output).toContain('Duplicate backend configuration')
    expect(await detectedAll(sh)).toEqual(NONE)
    // removing the extra block lets init go ahead
    await sh.run("rm -f extra.tf", atStage(scenario, 0), new Set())
    await sh.run(MIGRATE, atStage(scenario, 0), new Set())
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(c4) a hostile file with fifty thousand backend openers is judged in well under a second', async () => {
    const { backendOf } = await import('../src/game/terraform/statefile.ts')
    const { evalPredicate } = await import('../src/game/terraform/predicates.ts')
    const big = 'terraform {\n' + 'backend "s3" {\n'.repeat(50000)
    const t = Date.now()
    expect(backendOf([{ name: 'big.tf', text: big }])).toBeUndefined()
    const w = { state: { version: 4 } as never, reality: {}, history: [], plan: () => undefined, readFile: async () => undefined, listFiles: async () => [{ name: 'big.tf', text: big }] }
    expect(await evalPredicate({ config_matches: { dir: '/x', matches: 'backend\\s+"s3"\\s*\\{(?=[^}]*?^encrypt)' } } as never, w as never)).toBe(false)
    expect(Date.now() - t).toBeLessThan(500)
  })

  it('(g) after the fix, a further apply is a no-op', async () => {
    const { sh, out } = await play('cd ~/infra', ...IMPORTS, BACKEND(), MIGRATE, 'terraform apply -auto-approve')
    expect(out[7].exitCode).toBe(0)
    expect(out[7].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('trap: import, destroy and recreate is the destructive action, and the clean plan afterwards is no fix', async () => {
    const { sh, out } = await play('cd ~/infra', ...IMPORTS, 'terraform destroy -auto-approve', 'terraform apply -auto-approve', 'terraform plan')
    expect(out[5].output).toContain('Destroy complete! Resources: 4 destroyed.')
    expect(out[6].output).toContain('Apply complete! Resources: 4 added, 0 changed, 0 destroyed.')
    expect(out[7].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'delete-and-recreate': true })
  })

  it('exists-in-aws can be earned from the bucket, the role or the log groups', () => {
    const cmds = scenario.terminal!.commands.filter((c) => c.evidence === 'exists-in-aws').map((c) => c.match)
    expect(cmds).toEqual([
      'aws s3api head-bucket --bucket acme-app-logs',
      'aws s3api head-bucket --bucket acme-app-logs --region us-east-1',
      'aws iam get-role --role-name acme-task-role',
      'aws logs describe-log-groups --log-group-name-prefix /acme',
    ])
  })

  it('(h) every key evidence tag is awarded on the ideal path', async () => {
    const { out } = await play('cd ~/infra', 'terraform state list', 'terraform plan', 'aws s3api head-bucket --bucket acme-app-logs', 'aws sts get-caller-identity', ...IMPORTS, 'terraform plan')
    // terraform evidence arrives as `evidence:TAG`; a scripted command arrives as its match and carries its own tag
    const hits = out.flatMap((r) => r.hits)
    const tags = new Set([
      ...hits.filter((h) => h.startsWith('evidence:')).map((h) => h.slice('evidence:'.length)),
      ...scenario.terminal!.commands.filter((c) => c.match && hits.includes(c.match)).map((c) => c.evidence),
    ])
    for (const t of scenario.key_evidence) expect(tags.has(t), t).toBe(true)
  })
})
