import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-destroy-nonempty-bucket')
const { play, detectedAll } = playbook(scenario)

const NONE = { 'force-destroy-route': false, 'empty-bucket': false, 'destroy-after-emptying': false, 'state-rm-bucket': false, 'grant-more-permissions': false, 'retry-without-lock': false }
const SED = "sed -i 's/force_destroy = false/force_destroy = true/' main.tf"
const RM = 'aws s3 rm s3://acme-reports-logs --recursive'
const D = 'terraform destroy -auto-approve'
const A = 'terraform apply -auto-approve'

// Typed-command actions are taken by the engine, not the shell: mimic it.
const withTaken = async (lines: (string | { take: string })[]) => {
  const { sh } = await play('cd ~/reporting-infra')
  const taken = new Set<string>()
  const out = []
  for (const l of lines) {
    if (typeof l !== 'string') {
      taken.add(l.take)
      await sh.update(scenario, taken)
      continue
    }
    out.push(await sh.run(l, atStage(scenario, 0), taken))
  }
  return { sh, out, taken }
}

describe('terraform-destroy-nonempty-bucket', () => {
  it('destroy stops on BucketNotEmpty and everything else is gone', async () => {
    const { sh, out } = await play('cd ~/reporting-infra', D, 'terraform state list')
    expect(out[1].exitCode).toBe(1)
    expect(out[1].output).toContain('BucketNotEmpty')
    expect(out[1].output).toContain('aws_sqs_queue.jobs: Destruction complete')
    expect(out[1].hits).toContain('evidence:bucket-not-empty')
    expect(out[2].output.trim()).toBe('aws_s3_bucket.logs')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('evidence is obtainable before any change', async () => {
    const { out } = await play('cd ~/reporting-infra', 'terraform state show aws_s3_bucket.logs', 'aws s3 ls s3://acme-reports-logs --recursive', 'aws s3 ls s3://acme-reports-logs/', 'aws sts get-caller-identity')
    expect(out[1].output).toMatch(/force_destroy\s*=\s*false/)
    expect(out[1].hits).toContain('evidence:force-destroy-false')
    expect(out[2].output.trim().split('\n')).toHaveLength(3)
    expect(out[3].output).toContain('PRE logs/')
    expect(out[4].output).toContain('PlatformAdmin')
    const tags = new Set(scenario.terminal!.commands.filter((c) => out.some((r) => r.hits.includes(c.match ?? c.example ?? ''))).map((c) => c.evidence))
    expect(tags.has('bucket-has-objects') && tags.has('admin-role')).toBe(true)
  })

  it('route A: editing alone does not help, apply then destroy does', async () => {
    const { sh, out } = await play('cd ~/reporting-infra', SED, D, 'terraform state show aws_s3_bucket.logs')
    expect(out[2].exitCode).toBe(1)
    expect(out[2].output).toContain('BucketNotEmpty')
    expect(await detectedAll(sh)).toEqual(NONE)
    const r = [await sh.run(A, atStage(scenario, 0), new Set()), await sh.run('terraform state show aws_s3_bucket.logs', atStage(scenario, 0), new Set())]
    expect(r[0].exitCode).toBe(0)
    expect(r[1].output).toMatch(/force_destroy\s*=\s*true/)
    expect(await detectedAll(sh)).toEqual(NONE) // applied only: not credited
    const d = await sh.run(D, atStage(scenario, 0), new Set())
    expect(d.exitCode).toBe(0)
    expect(d.output).toContain('Destroy complete!')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'force-destroy-route': true })
    expect((await sh.run(D, atStage(scenario, 0), new Set())).exitCode).toBe(0)
  })

  it('route A with spelling variants of the edit', async () => {
    for (const edit of ["sed -i 's/false/true/' main.tf", "sed -i 's/force_destroy *= *false/force_destroy = true/' main.tf"]) {
      const { sh } = await play('cd ~/reporting-infra', edit, A, D)
      expect((await detectedAll(sh))['force-destroy-route'], edit).toBe(true)
    }
  })

  it('route B: empty the bucket, then destroy', async () => {
    const { sh, out } = await withTaken([RM_LS(), { take: 'empty-bucket' }, 'aws s3 ls s3://acme-reports-logs --recursive', D])
    expect(out[0].output).toContain('2026-08-29')
    expect(out[1].output.trim()).toBe('')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('Destroy complete! Resources: 3 destroyed.')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'destroy-after-emptying': true })
  })

  it('emptying alone is not the whole fix', async () => {
    const { sh } = await withTaken([{ take: 'empty-bucket' }, 'terraform plan'])
    expect(await detectedAll(sh)).toEqual({ ...NONE })
  })

  it('the empty-bucket command regex accepts spellings and refuses partial deletes', () => {
    const rx = new RegExp(scenario.actions.find((a) => a.id === 'empty-bucket')!.match_regex!)
    for (const ok of [RM, 'aws s3 rm s3://acme-reports-logs/ --recursive', 'aws s3 rm s3://acme-reports-logs --recursive --quiet', 'aws s3 rm s3://acme-reports-logs --recursive --region us-east-1']) expect(rx.test(ok), ok).toBe(true)
    for (const no of ['aws s3 rm s3://acme-reports-logs', 'aws s3 rm s3://acme-reports-logs --recursive --exclude "*"', 'aws s3 rm s3://acme-reports-logs/logs/2026-08-29-access.log.gz', 'aws s3 rm s3://other --recursive', 'aws s3 rb s3://acme-reports-logs --force']) expect(rx.test(no), no).toBe(false)
  })

  it('trap: state rm then destroy orphans the bucket and its data', async () => {
    const { sh, out } = await play('cd ~/reporting-infra', 'terraform state rm aws_s3_bucket.logs', D, 'terraform plan')
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('Destroy complete! Resources: 2 destroyed.')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'state-rm-bucket': true })
    // importing it back and taking route A is still possible; the trap stays on the score
    await sh.run('terraform import aws_s3_bucket.logs acme-reports-logs', atStage(scenario, 0), new Set())
    await sh.run(SED, atStage(scenario, 0), new Set())
    await sh.run(A, atStage(scenario, 0), new Set())
    await sh.run(D, atStage(scenario, 0), new Set())
    expect((await detectedAll(sh))['force-destroy-route']).toBe(true)
  })

  it('wrong hypotheses: honest output, nothing destroyed beyond the intended resources', async () => {
    const { sh, out } = await play('cd ~/reporting-infra', 'terraform destroy -lock=false -auto-approve', 'terraform force-unlock -force x', 'terraform state list')
    expect(out[1].output).toContain('BucketNotEmpty')
    expect(out[1].output).not.toContain('AccessDenied')
    expect(out[1].output).not.toContain('DependencyViolation')
    expect(out[1].output).not.toContain('state lock')
    expect(out[3].output.trim()).toBe('aws_s3_bucket.logs')
    expect(await detectedAll(sh)).toEqual(NONE)
  })
})

function RM_LS() {
  return 'aws s3 ls s3://acme-reports-logs --recursive'
}
