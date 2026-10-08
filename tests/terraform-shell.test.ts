import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { evidenceSeen, runCommand, type GameEvent } from '../src/game/engine.ts'
import { filesOnDisk } from '../src/game/paths.ts'
import { IncidentShell } from '../src/game/shell.ts'
import type { Scenario } from '../src/schema/scenario.ts'

const base = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@') && !s.stages)!
const VPC = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1' } }
const scenario = (tf: Record<string, unknown> = {}): Scenario => ({
  ...structuredClone(base),
  terminal: { ...structuredClone(base.terminal!), prompt: 'you@laptop:~/infra$', commands: [{ match: 'echo scripted', output: 'x' }] },
  terraform: { dir: '~/infra', files: [{ path: 'main.tf', content: 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n' }], state: [VPC], ...tf },
}) as Scenario
const run = async (s: Scenario, ...lines: string[]) => {
  const sh = new IncidentShell(s)
  const out = []
  for (const l of lines) out.push(await sh.run(l, s, new Set()))
  return out
}

describe('files on disk', () => {
  it('mounts the terraform files and the lock file', () => {
    const files = filesOnDisk(scenario())
    expect([...files.keys()].filter((p) => p.includes('infra'))).toEqual(expect.arrayContaining(['/home/you/infra/main.tf', '/home/you/infra/.terraform.lock.hcl']))
    expect(filesOnDisk(scenario({ initialized: false })).has('/home/you/infra/.terraform.lock.hcl')).toBe(false)
  })
})

describe('the terraform command in the shell', () => {
  it('runs plan against the files on disk, and sees the player\'s edits', async () => {
    const [before, , after] = await run(scenario(), 'terraform plan', "sed -i 's/10.0.0.0/10.1.0.0/' main.tf", 'terraform plan')
    expect(before.output).toContain('No changes.')
    expect(after.output).toContain('# aws_vpc.main must be replaced')
    expect(after.output).toContain('forces replacement')
  })

  it('works with pipes and redirection like any command', async () => {
    const [grep, count] = await run(scenario(), 'terraform state list | grep -c vpc', 'terraform version > v.txt && cat v.txt | head -1')
    expect(grep.output).toBe('1')
    expect(count.output).toBe('Terraform v1.9.8')
  })

  it('keeps stderr and exit codes for errors', async () => {
    const [r] = await run(scenario(), 'terraform apply')
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain('Not available in this lab yet')
  })

  it('init writes the lock file when it was missing', async () => {
    const [plan, init, lock, again] = await run(scenario({ initialized: false }), 'terraform plan', 'terraform init', 'ls -a', 'terraform plan')
    expect(plan.output).toContain('Inconsistent dependency lock file')
    expect(init.output).toContain('Terraform has been successfully initialized!')
    expect(lock.output).toContain('.terraform.lock.hcl')
    expect(again.output).toContain('No changes.')
  })

  it('plans nothing outside the lab directory or on another host', async () => {
    const [away, , chdir, back] = await run(scenario(), 'cd /tmp && terraform plan', 'cd ~/infra', 'terraform -chdir=../../etc plan', 'terraform state list')
    expect(away.exitCode).toBe(1)
    expect(away.output).toContain('No configuration files')
    expect(away.output).not.toContain('Plan:')
    expect(chdir.output).toContain('No configuration files')
    expect(back.output).toContain('aws_vpc.main')
  })

  it('reports simulator evidence as hits', async () => {
    const s = scenario({ evidence: [{ evidence: 'listed', command: 'state list', contains: 'aws_vpc.main' }] })
    const [r] = await run(s, 'terraform state list')
    expect(r.hits).toEqual(['evidence:listed'])
  })

  it('leaves incidents without a terraform block on the scripted tool', async () => {
    const plain = { ...structuredClone(base), terraform: undefined } as Scenario
    const sh = new IncidentShell(plain)
    const r = await sh.run('terraform plan', plain, new Set())
    expect(r.output).not.toContain('Refreshing state')
  })
})

describe('engine support', () => {
  it('counts evidence tokens as evidence', () => {
    const s = scenario()
    const log: GameEvent[] = [{ type: 'SHELL_RAN', commands: ['evidence:listed'], at: 0 }]
    expect(evidenceSeen(s, log).has('listed')).toBe(true)
  })

  it('lists the terraform commands in help for such incidents only', () => {
    const help = runCommand(scenario(), 'help', new Set()).output
    for (const c of ['terraform init', 'terraform validate', 'terraform plan', 'terraform show', 'terraform state list', 'terraform state show ADDRESS', 'terraform output', 'terraform version']) expect(help).toContain(`  ${c}`)
    expect(runCommand({ ...scenario(), terraform: undefined } as Scenario, 'help', new Set()).output).not.toContain('terraform plan')
  })
})
