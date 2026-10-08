import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { IncidentShell } from '../src/game/shell.ts'
import type { Scenario } from '../src/schema/scenario.ts'

const base = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@') && !s.stages)!
const fixId = base.actions[0].id
const scenario = (tf: Record<string, unknown> = {}): Scenario => ({
  ...structuredClone(base),
  terminal: { ...structuredClone(base.terminal!), prompt: 'you@laptop:~/infra$', commands: [] },
  terraform: { dir: '~/infra', files: [{ path: 'main.tf', content: 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n' }], state: [], ...tf },
}) as Scenario
const run = async (sh: IncidentShell, s: Scenario, ...lines: string[]) => runWith(sh, s, new Set(), ...lines)
const runWith = async (sh: IncidentShell, s: Scenario, taken: Set<string>, ...lines: string[]) => {
  const out = []
  for (const l of lines) out.push(await sh.run(l, s, taken))
  return out
}
const error = 'creating EC2 VPC: api error Throttling'

describe('terraform apply through the shell', () => {
  it('-auto-approve applies', async () => {
    const s = scenario()
    const [a, list] = await run(new IncidentShell(s), s, 'terraform apply -auto-approve', 'terraform state list')
    expect(a.output).toContain('Apply complete! Resources: 1 added')
    expect(list.output).toBe('aws_vpc.main')
  })

  it('reads the answer from a pipe', async () => {
    const s = scenario()
    const [a, list] = await run(new IncidentShell(s), s, 'echo yes | terraform apply', 'terraform state list')
    expect(a.output).toContain('Apply complete!')
    expect(list.output).toBe('aws_vpc.main')
  })

  it('cancels with nobody to ask, applies when the hook says yes', async () => {
    const s = scenario()
    const sh = new IncidentShell(s)
    const [c] = await run(sh, s, 'terraform apply')
    expect(c.output).toContain('Apply cancelled.')
    sh.onConfirm = async () => 'yes'
    const [a] = await run(sh, s, 'terraform apply')
    expect(a.output).toContain('Apply complete!')
  })

  it('does not touch the lab away from the lab directory', async () => {
    const s = scenario()
    const sh = new IncidentShell(s)
    const [away, list] = await run(sh, s, 'cd /tmp && terraform apply -auto-approve', 'terraform state list')
    expect(away.exitCode).toBe(1)
    expect(list.output).not.toContain('aws_vpc.main')
  })

  it('replays deterministically: each shell has its own fault attempts', async () => {
    const s = scenario({ faults: [{ at: 'aws_vpc.main', on: 'create', error, times: 1 }] })
    const go = async () => {
      const sh = new IncidentShell(s)
      const [one, two, state] = await run(sh, s, 'terraform apply -auto-approve', 'terraform apply -auto-approve', 'terraform state pull')
      return [one.output, two.output, state.output, one.exitCode, two.exitCode]
    }
    const a = await go()
    const b = await go()
    expect(b).toEqual(a)
    expect(a[3]).toBe(1)
    expect(a[4]).toBe(0)
  })

  it('a fault with until_actions gates on the actions taken', async () => {
    const s = scenario({ faults: [{ at: 'aws_vpc.main', on: 'create', error, until_actions: [fixId] }] })
    const sh = new IncidentShell(s)
    const [bad] = await run(sh, s, 'terraform apply -auto-approve')
    expect(bad.exitCode).toBe(1)
    await sh.update(s, new Set([fixId]))
    const [good] = await runWith(sh, s, new Set([fixId]), 'terraform apply -auto-approve')
    expect(good.exitCode).toBe(0)
  })
})
