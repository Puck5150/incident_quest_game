import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { evidenceSeen } from '../src/game/engine.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-import-existing')
const { play, detectedAll } = playbook(scenario)

const NONE = { 'import-block': false, rename: false, 'ignore-error': false, 'delete-recreate': false }
const FIXED = { ...NONE, 'import-block': true }
const BLOCK = (id = 'acme-analytics-raw') => `cat > import.tf <<'EOF'
import {
  to = aws_s3_bucket.analytics_raw
  id = "${id}"
}
EOF`
const IMPORT = 'terraform import aws_s3_bucket.analytics_raw acme-analytics-raw'
const A = 'terraform apply -auto-approve'

describe('terraform-import-existing on the simulator', () => {
  it('is backed by the simulator; only head-bucket is scripted; ids, kinds and evidence tags kept', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.map((c) => c.match ?? c.example)).toEqual(['aws s3api head-bucket --bucket acme-analytics-raw'])
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.match ?? c.example!]).toBeDefined()
    expect(scenario.actions.map((a) => [a.id, a.kind])).toEqual([
      ['import-block', 'fix'],
      ['rename', 'wrong'],
      ['delete-recreate', 'destructive'],
      ['ignore-error', 'wrong'],
    ])
    expect(scenario.solution_paths).toEqual([['import-block']])
    expect(scenario.key_evidence).toEqual(['already-owned', 'not-in-state', 'plan-create', 'exists'])
  })

  it('never names BucketAlreadyOwnedByYou (us-east-1 answers BucketAlreadyExists)', () => {
    const raw = fs.readFileSync(path.resolve(import.meta.dirname, '../content/iac/terraform-import-existing.yaml'), 'utf8')
    expect(raw).not.toContain('BucketAlreadyOwnedByYou')
  })

  it('(a) apply on the untouched lab fails with the real error, and the CI log carries exactly that line', async () => {
    const { sh, out } = await play('cd ~/infra', A)
    expect(out[1].exitCode).toBe(1)
    const tail = out[1].output.slice(out[1].output.indexOf('aws_s3_bucket.analytics_raw: Creating...'))
    expect(tail).toContain('│ Error: creating S3 Bucket (acme-analytics-raw): BucketAlreadyExists')
    // The CI log is the tail of that real run, so the wording cannot drift.
    const log = scenario.logs!.find((l) => l.evidence === 'already-owned')!
    expect(log.lines.trimEnd()).toBe(tail.trimEnd())
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b) evidence: not in state, plan creates, bucket exists', async () => {
    const { out } = await play('cd ~/infra', 'terraform state show aws_s3_bucket.analytics_raw', 'terraform plan', 'aws s3api head-bucket --bucket acme-analytics-raw')
    expect(out[1].output).toContain('No instance found for the given address')
    expect(out[1].hits).toContain('evidence:not-in-state')
    expect(out[2].output).toContain('will be created')
    expect(out[2].hits).toContain('evidence:plan-create')
    expect(out[3].output).toContain('us-east-1')
    expect(evidenceSeen(scenario, [{ type: 'RUN_COMMAND', input: 'aws s3api head-bucket --bucket acme-analytics-raw', at: 0 }]).has('exists')).toBe(true)
  })

  it('(c) ideal: import block, plan says 1 to import, apply imports, plan clean', async () => {
    const { sh, out } = await play('cd ~/infra', BLOCK(), 'terraform plan', A, 'terraform plan', 'terraform state list')
    expect(out[2].output).toContain('Plan: 1 to import, 0 to add, 0 to change, 0 to destroy.')
    expect(out[3].output).toContain('Apply complete!')
    expect(out[3].output).toContain('1 imported')
    expect(out[4].output).toContain('No changes.')
    expect(out[5].output.trim()).toBe('aws_s3_bucket.analytics_raw')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(d) CLI terraform import is detected without an apply', async () => {
    const { sh, out } = await play('cd ~/infra', IMPORT, 'terraform plan')
    expect(out[1].exitCode).toBe(0)
    expect(out[2].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(e) a wrong id or a bucket that is not in the cloud gives the real error and credits nothing', async () => {
    const wrong = await play('cd ~/infra', 'terraform import aws_s3_bucket.analytics_raw acme-analytics-raw-2', 'terraform state list')
    expect(wrong.out[1].exitCode).toBe(1)
    expect(wrong.out[1].output).toContain('Error')
    expect(wrong.out[2].output).not.toContain('aws_s3_bucket')
    expect(await detectedAll(wrong.sh)).toEqual(NONE)
    const block = await play('cd ~/infra', BLOCK('acme-analytics-raw-2'), 'terraform plan')
    expect(block.out[2].exitCode).toBe(1)
    expect(await detectedAll(block.sh)).toEqual(NONE)
  })

  it('(f) rename: apply creates a second, empty bucket; reality has both; nothing credited', async () => {
    const { sh, out } = await play('cd ~/infra', "sed -i 's/acme-analytics-raw\"/acme-analytics-raw-2\"/' main.tf", A)
    expect(out[2].output).toContain('Apply complete! Resources: 1 added')
    expect(await sh.doneWhen({ reality_has: { type: 'aws_s3_bucket', id: 'acme-analytics-raw', attr: 'bucket', equals: 'acme-analytics-raw' } } as never)).toBe(true)
    expect(await sh.doneWhen({ reality_has: { type: 'aws_s3_bucket', id: 'acme-analytics-raw-2', attr: 'bucket', equals: 'acme-analytics-raw-2' } } as never)).toBe(true)
    const d = await detectedAll(sh)
    expect(d['import-block']).toBe(false)
    expect(d['delete-recreate']).toBe(false)
  })

  it('(g) delete-recreate: the bucket is not empty; only force_destroy then destroy removes it, and that is destructive, not the fix', async () => {
    const { sh, out } = await play('cd ~/infra', IMPORT, 'terraform destroy -auto-approve')
    expect(out[2].exitCode).toBe(1)
    expect(out[2].output).toContain('BucketNotEmpty')
    expect(await detectedAll(sh)).toEqual(FIXED)
    await sh.run("sed -i 's/bucket = \"acme-analytics-raw\"/&\\n  force_destroy = true/' main.tf", scenario as never, new Set())
    await sh.run(A, scenario as never, new Set())
    await sh.run('terraform destroy -auto-approve', scenario as never, new Set())
    const d = await detectedAll(sh)
    expect(d['delete-recreate']).toBe(true)
    expect(d['import-block']).toBe(false)
  })

  it('(h) plan -generate-config-out is not simulated', async () => {
    const { out } = await play('cd ~/infra', BLOCK(), 'terraform plan -generate-config-out=generated.tf')
    expect(out[2].exitCode).not.toBe(0)
    expect(out[2].output).toContain('flag provided but not defined: -generate-config-out')
  })
})
