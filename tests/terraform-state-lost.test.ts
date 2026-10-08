import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-state-lost')
const { play, detectedAll } = playbook(scenario)

const ADDRS = ['aws_cloudwatch_log_group.api', 'aws_iam_role.task', 'aws_s3_bucket.app_logs', 'aws_sqs_queue.jobs']
const IMPORTS = [
  'terraform import aws_s3_bucket.app_logs acme-app-logs',
  'terraform import aws_cloudwatch_log_group.api /acme/api',
  'terraform import aws_iam_role.task acme-task-role',
  'terraform import aws_sqs_queue.jobs https://sqs.us-east-1.amazonaws.com/123456789012/acme-jobs',
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
  to = aws_sqs_queue.jobs
  id = "https://sqs.us-east-1.amazonaws.com/123456789012/acme-jobs"
}
EOF`
const NONE = { 'import-resources': false, 'apply-anyway': false, 'delete-and-recreate': false }
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
    expect(apply.output).toContain('BucketAlreadyOwnedByYou')
    expect(apply.output).toContain('EntityAlreadyExists: Role with name acme-task-role already exists.')
    expect(apply.output).toContain('ResourceAlreadyExistsException: The specified log group already exists')
    expect(apply.output).toContain('QueueNameExists')
    expect(out[2].output).not.toMatch(/aws_/)
    expect(await detectedAll(sh)).toEqual(NONE)
    // the fix is still reachable afterwards
    for (const l of IMPORTS) expect((await sh.run(l, atStage(scenario, 0), new Set())).exitCode).toBe(0)
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(c) route A: four terraform import commands, then a clean plan', async () => {
    const { sh, out } = await play('cd ~/infra', ...IMPORTS, 'terraform state list', 'terraform plan')
    for (const r of out.slice(1, 5)) {
      expect(r.exitCode).toBe(0)
      expect(r.output).toContain('Import successful!')
    }
    expect(out[5].output.trim().split('\n')).toEqual(ADDRS)
    expect(out[6].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(d) route B: import blocks, apply with yes, then a clean plan', async () => {
    const { sh, out } = await play('cd ~/infra', IMPORT_BLOCKS, 'terraform plan', 'echo yes | terraform apply', 'terraform state list', 'terraform plan')
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
    const { sh, out } = await play('cd ~/infra', 'terraform import aws_sqs_queue.jobs acme-jobs', 'terraform state list')
    expect(out[1].exitCode).toBe(1)
    expect(out[1].output).toContain('Cannot import non-existent remote object')
    expect(out[2].output).toContain('No state file was found!')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(g) after the fix, a further apply is a no-op', async () => {
    const { sh, out } = await play('cd ~/infra', ...IMPORTS, 'terraform apply -auto-approve')
    expect(out[5].exitCode).toBe(0)
    expect(out[5].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('trap: import, destroy and recreate is the destructive action, and the clean plan afterwards is no fix', async () => {
    const { sh, out } = await play('cd ~/infra', ...IMPORTS, 'terraform destroy -auto-approve', 'terraform apply -auto-approve', 'terraform plan')
    expect(out[5].output).toContain('Destroy complete! Resources: 4 destroyed.')
    expect(out[6].output).toContain('Apply complete! Resources: 4 added, 0 changed, 0 destroyed.')
    expect(out[7].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'delete-and-recreate': true })
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
