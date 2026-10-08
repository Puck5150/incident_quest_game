import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { IncidentShell } from '../src/game/shell.ts'
import type { Scenario } from '../src/schema/scenario.ts'
import type { Lab } from '../src/game/terraform/lab.ts'

const base = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@') && !s.stages && !s.terraform)!
const VPC = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const scenario = (tf: Record<string, unknown> = {}): Scenario =>
  ({
    ...structuredClone(base),
    terminal: { ...structuredClone(base.terminal!), prompt: 'you@laptop:~/infra$', commands: [{ match: 'ssh db-01 uptime', output: 'up 3 days' }] },
    terraform: { dir: '~/infra', files: [{ path: 'main.tf', content: VPC }], state: [], ...tf },
  }) as Scenario
const VPC_STATE = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', cidr_block: '10.0.0.0/16' } }
const run = async (sh: IncidentShell, s: Scenario, ...lines: string[]) => {
  for (const l of lines) await sh.run(l, s, new Set())
}

describe('IncidentShell.doneWhen', () => {
  it('state_lacks before and after state rm', async () => {
    const s = scenario({ state: [VPC_STATE, { type: 'aws_s3_bucket', name: 'b', attrs: { id: 'b', bucket: 'b' } }] })
    const sh = new IncidentShell(s)
    expect(await sh.doneWhen({ state_lacks: 'aws_s3_bucket.b' })).toBe(false)
    await run(sh, s, 'terraform state rm aws_s3_bucket.b')
    expect(await sh.doneWhen({ state_lacks: 'aws_s3_bucket.b' })).toBe(true)
  })

  it('plan_clean is false with a pending create, true after apply', async () => {
    const s = scenario()
    const sh = new IncidentShell(s)
    expect(await sh.doneWhen({ plan_clean: true })).toBe(false)
    await run(sh, s, 'terraform apply -auto-approve')
    expect(await sh.doneWhen({ plan_clean: true })).toBe(true)
  })

  it('plan_clean sees only exported variables, like terraform plan', async () => {
    const s = scenario({ state: [VPC_STATE], files: [{ path: 'main.tf', content: VPC + 'variable "c" {\n  type = string\n}\n' }] })
    const sh = new IncidentShell(s)
    await run(sh, s, 'cd ~/infra', 'TF_VAR_c=x')
    expect((await sh.run('terraform plan', s, new Set())).output).toContain('No value for required variable')
    expect(await sh.doneWhen({ plan_clean: true })).toBe(false)
    await run(sh, s, 'export TF_VAR_c')
    expect((await sh.run('terraform plan', s, new Set())).output).toContain('No changes.')
    expect(await sh.doneWhen({ plan_clean: true })).toBe(true)
  })

  it('applied sees the delete half of a replace', async () => {
    const s = scenario({ state: [VPC_STATE] })
    const sh = new IncidentShell(s)
    expect(await sh.doneWhen({ applied: { op: 'delete', address: 'aws_vpc.main' } })).toBe(false)
    await run(sh, s, 'terraform apply -replace=aws_vpc.main -auto-approve')
    expect(await sh.doneWhen({ applied: { op: 'delete', address: 'aws_vpc.main' } })).toBe(true)
    expect(await sh.doneWhen({ applied: { op: 'create', address: 'aws_vpc.main' } })).toBe(true)
  })

  it('lock_free before and after force-unlock', async () => {
    const s = scenario({ state: [VPC_STATE], lock: { id: 'abc', who: 'x@y', created: '2026-01-01T00:00:00Z' } })
    const sh = new IncidentShell(s)
    expect(await sh.doneWhen({ lock_free: true })).toBe(false)
    await run(sh, s, 'terraform force-unlock -force abc')
    expect(await sh.doneWhen({ lock_free: true })).toBe(true)
  })

  it('file_contains after sed -i', async () => {
    const s = scenario()
    const sh = new IncidentShell(s)
    const p = { file_contains: { path: '/home/you/infra/main.tf', matches: '10\\.1\\.0\\.0/16' } }
    expect(await sh.doneWhen(p)).toBe(false)
    await run(sh, s, "sed -i 's#10.0.0.0/16#10.1.0.0/16#' main.tf")
    expect(await sh.doneWhen(p)).toBe(true)
  })

  it('judges the main host while the player is ssh-ed elsewhere', async () => {
    const s = scenario({ state: [VPC_STATE] })
    const sh = new IncidentShell(s)
    await run(sh, s, 'ssh db-01')
    expect(sh.currentHost).toBe('db-01')
    expect(await sh.doneWhen({ all: [{ plan_clean: true }, { file_contains: { path: '/home/you/infra/main.tf', matches: 'aws_vpc' } }] })).toBe(true)
  })

  it('is false without a terraform block', async () => {
    const s = { ...structuredClone(base) } as Scenario
    expect(await new IncidentShell(s).doneWhen({ lock_free: true })).toBe(false)
  })

  it('an unparsable config fails plan predicates only', async () => {
    const s = scenario({ files: [{ path: 'main.tf', content: 'resource "aws_vpc" "main" {\n' }], state: [VPC_STATE] })
    const sh = new IncidentShell(s)
    expect(await sh.doneWhen({ plan_clean: true })).toBe(false)
    expect(await sh.doneWhen({ plan_has: { no_destroy: [] } })).toBe(false)
    expect(await sh.doneWhen({ state_has: 'aws_vpc.main' })).toBe(true)
    expect(await sh.doneWhen({ lock_free: true })).toBe(true)
  })

  it('never changes the lab', async () => {
    // Drift in the cloud: a refresh-on plan sees it, but doneWhen must not write it back.
    const s = scenario({ state: [VPC_STATE], cloud: { patch: [{ type: 'aws_vpc', id: 'vpc-1', set: { cidr_block: '10.9.0.0/16' } }] } })
    const sh = new IncidentShell(s)
    await run(sh, s, 'terraform state rm aws_vpc.main', 'terraform import aws_vpc.main vpc-1')
    const lab = (sh as unknown as { lab: Lab }).lab
    const before = structuredClone({ state: lab.state, reality: lab.reality, history: lab.history, lock: lab.lock })
    expect(await sh.doneWhen({ plan_clean: true })).toBe(false)
    expect(await sh.doneWhen({ all: [{ plan_has: { no_destroy: ['aws_vpc.main'] } }, { state_has: 'aws_vpc.main' }, { not: { lock_free: true } }] })).toBe(false)
    expect({ state: lab.state, reality: lab.reality, history: lab.history, lock: lab.lock }).toEqual(before)
    expect(lab.state.serial).toBe(before.state.serial)
  })
})
