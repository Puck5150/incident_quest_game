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
    const [r] = await run(scenario(), 'terraform import a.b x')
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
    expect(r.hits).toEqual(['terraform state list', 'evidence:listed'])
  })

  it('reads TF_VAR_ from exported variables only (just-bash gives commands a Map env)', async () => {
    const s = scenario({ files: [{ path: 'main.tf', content: 'variable "cidr" {\n  type = string\n}\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}\n' }] })
    const [, exported, prefixed, plain] = await run(s, 'export TF_VAR_cidr=10.9.0.0/16', 'terraform plan', 'TF_VAR_cidr=10.8.0.0/16 terraform plan', 'unset TF_VAR_cidr; TF_VAR_cidr=10.7.0.0/16; terraform plan')
    expect(exported.output).toContain('10.9.0.0/16')
    expect(prefixed.output).toContain('10.8.0.0/16')
    expect(plain.output).not.toContain('10.7.0.0/16')
  })

  it('ends every output line with a newline, so the shell sees real lines', async () => {
    const [v, status, wc] = await run(scenario(), 'terraform version', 'terraform plan; echo $?', 'terraform version | wc -l')
    expect(v.output.split('\n')).toHaveLength(3)
    expect(status.output.split('\n').at(-1)).toBe('0')
    expect(status.output.split('\n').at(-2)).not.toMatch(/0$/)
    expect(wc.output.trim()).toBe('3')
  })

  it('reports the subcommand it ran as a hit, only for ones it runs', async () => {
    const [plan, state, bare, unknown] = await run(scenario(), 'terraform plan', 'terraform state list', 'terraform', 'terraform frobnicate')
    expect(plan.hits).toEqual(['terraform plan'])
    expect(state.hits).toEqual(['terraform state list'])
    expect(bare.hits).toEqual([])
    expect(unknown.hits).toEqual([])
  })

  it('awards no verification or evidence for a run outside the lab directory, or for version', async () => {
    const s = scenario({ evidence: [{ evidence: 'planned', command: 'plan', contains: 'No changes' }] })
    const [, tmp, , ver] = await run(s, 'cd /tmp', 'printf \'resource "aws_vpc" "x" {\\n  cidr_block = "10.0.0.0/16"\\n}\\n\' > main.tf; terraform plan', 'cd ~/infra', 'terraform version')
    expect(tmp.hits).toEqual([])
    expect(ver.hits).toEqual([])
  })

  it('prints output -raw without a trailing newline', async () => {
    const [raw, shown] = await run(scenario({ outputs: { id: { value: 'vpc-1' } } }), 'terraform output -raw id | wc -c', 'terraform output id | wc -c')
    expect(raw.output.trim()).toBe('5')
    expect(shown.output.trim()).toBe('8')
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

describe('commandsHit', () => {
  it('lists terraform runs and drops evidence tokens', async () => {
    const { commandsHit } = await import('../src/game/engine.ts')
    const log: GameEvent[] = [{ type: 'SHELL_RAN', commands: ['terraform plan', 'evidence:x'], at: 0 }]
    expect([...commandsHit(scenario(), log)]).toEqual(['terraform plan'])
  })
})

describe('editor replay protocol', () => {
  it('a saved edit stands in for the editor; no saved edit means quit without saving', async () => {
    const s = scenario()
    const sh = new IncidentShell(s)
    const saved = [{ path: '/home/you/infra/main.tf', content: 'resource "aws_vpc" "main" {\n  cidr_block = "10.1.0.0/16"\n}\n' }]
    sh.onEdit = async (path) => saved.find((e) => e.path === path)?.content ?? null
    await sh.run('nano main.tf', s, new Set())
    expect((await sh.run('terraform plan', s, new Set())).output).toContain('forces replacement')
    sh.onEdit = async () => null
    const before = (await sh.run('cat main.tf', s, new Set())).output
    await sh.run('nano main.tf', s, new Set())
    expect((await sh.run('cat main.tf', s, new Set())).output).toBe(before)
  })
})
