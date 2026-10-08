import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { IncidentShell } from '../src/game/shell.ts'
import type { Scenario } from '../src/schema/scenario.ts'

// The fixture builder from terraform-shell-apply.test.ts, with a held lock, a second
// workspace and a bucket that exists in the cloud but not in state.
const base = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@') && !s.stages)!
const VPC_TF = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const BUCKET_TF = 'resource "aws_s3_bucket" "b" {\n  bucket = "legacy"\n}\n'
const VPC = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1', tags_all: {} } }
const BUCKET = { id: 'legacy', arn: 'arn:legacy', bucket: 'legacy', force_destroy: false, bucket_domain_name: 'legacy.s3', tags_all: {} }
const LOCK_ID = '9db590f1-b6fe-c5f2-2678-8804f089deba'
const scenario = (): Scenario =>
  ({
    ...structuredClone(base),
    terminal: { ...structuredClone(base.terminal!), prompt: 'you@laptop:~/infra$', commands: [] },
    terraform: {
      dir: '~/infra',
      files: [{ path: 'main.tf', content: VPC_TF + BUCKET_TF }],
      state: [VPC],
      lock: { id: LOCK_ID, who: 'ci@runner-7', created: '2026-10-08 09:14:02.123456789 +0000 UTC' },
      workspaces: { staging: { state: [{ ...VPC, attrs: { ...VPC.attrs, id: 'vpc-9', arn: 'arn:vpc-9' } }] } },
      cloud: { add: [{ type: 'aws_s3_bucket', attrs: BUCKET }] },
    },
  }) as Scenario
const run = async (sh: IncidentShell, s: Scenario, ...lines: string[]) => {
  const out = []
  for (const l of lines) out.push(await sh.run(l, s, new Set()))
  return out
}
const CLEAN = 'No changes. Your infrastructure matches the configuration.'

describe('terraform state commands, locks and workspaces through the shell', () => {
  it('a held lock blocks plan until force-unlock -force clears it', async () => {
    const s = scenario()
    const [locked, unlock, plan] = await run(new IncidentShell(s), s, 'terraform plan', `terraform force-unlock -force ${LOCK_ID}`, 'terraform plan')
    expect(locked.exitCode).toBe(1)
    expect(locked.output).toContain('Error acquiring the state lock')
    expect(locked.output).toContain(LOCK_ID)
    expect(unlock.exitCode).toBe(0)
    expect(unlock.output).toContain('Terraform state has been successfully unlocked!')
    expect(plan.exitCode).toBe(0)
    expect(plan.output).toContain('Plan: 1 to add, 0 to change, 0 to destroy.')
  })

  it('force-unlock takes a piped yes, and cancels with nobody to ask', async () => {
    const s = scenario()
    const [piped, plan] = await run(new IncidentShell(s), s, `echo yes | terraform force-unlock ${LOCK_ID}`, 'terraform plan')
    expect(piped.output).toContain('Terraform state has been successfully unlocked!')
    expect(plan.exitCode).toBe(0)

    const [cancelled, still] = await run(new IncidentShell(s), s, `terraform force-unlock ${LOCK_ID}`, 'terraform plan')
    expect(cancelled.exitCode).toBe(1)
    expect(cancelled.output).toContain('force-unlock cancelled.')
    expect(still.output).toContain('Error acquiring the state lock')
  })

  // One walk through every state-changing command; the replay test reruns it.
  const WALK = [
    `terraform force-unlock -force ${LOCK_ID}`,
    'terraform import aws_s3_bucket.b legacy',
    'terraform plan',
    'terraform state mv aws_s3_bucket.b aws_s3_bucket.old',
    'terraform plan',
    'terraform state mv aws_s3_bucket.old aws_s3_bucket.b',
    'terraform plan',
    'terraform state rm aws_s3_bucket.b',
    'terraform plan',
    'terraform import aws_s3_bucket.b legacy',
    'terraform workspace new qa',
    'terraform plan',
    'terraform workspace list',
    'terraform workspace select default',
    'terraform plan',
    'terraform state pull',
  ]

  it('import, state mv, state rm and workspaces change what plan sees', async () => {
    const s = scenario()
    const [, imp, clean1, mv, moved, back, clean2, rm, creates, , qa, qaPlan, list, select, clean3] = await run(new IncidentShell(s), s, ...WALK)
    expect(imp.output).toContain('Import successful!')
    expect(clean1.output).toContain(CLEAN)
    expect(mv.output).toContain('Successfully moved 1 object(s).')
    expect(moved.output).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
    expect(back.exitCode).toBe(0)
    expect(clean2.output).toContain(CLEAN)
    expect(rm.output).toContain('Removed aws_s3_bucket.b')
    expect(creates.output).toContain('Plan: 1 to add, 0 to change, 0 to destroy.')
    expect(qa.output).toContain('Created and switched to workspace "qa"!')
    expect(qaPlan.output).toContain('Plan: 2 to add, 0 to change, 0 to destroy.')
    expect(list.output).toBe('  default\n* qa\n  staging')
    expect(select.output).toBe('Switched to workspace "default".')
    expect(clean3.output).toContain(CLEAN)
  })

  it('replays deterministically in a fresh shell', async () => {
    const s = scenario()
    const go = async () => (await run(new IncidentShell(s), s, ...WALK)).map((r) => [r.output, r.exitCode])
    const a = await go()
    expect(await go()).toEqual(a)
    expect(a.at(-1)![0]).toContain('"lineage": "00000000-0000-4000-8000-000000000001"')
  })
})
