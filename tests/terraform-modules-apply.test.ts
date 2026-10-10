import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { IncidentShell } from '../src/game/shell.ts'
import type { Scenario, TerraformBlock } from '../src/schema/scenario.ts'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'

const LAB = '/home/you/infra'
const ROOT = 'module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\n\nresource "aws_subnet" "a" {\n  vpc_id     = module.net.vpc_id\n  cidr_block = "10.0.1.0/24"\n}\n\noutput "vpc" {\n  value = module.net.vpc_id\n}\n'
const NET = 'variable "cidr" {\n  type = string\n}\n\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}\n\noutput "vpc_id" {\n  value = aws_vpc.main.id\n}\n'
const installed = { modules: { installed: [{ key: 'net', source: './modules/net', dir: 'modules/net' }] } }

function world(tf: Partial<TerraformBlock> = {}, o: { files?: Record<string, string> } = {}) {
  const block = { files: [{ path: 'main.tf', content: ROOT }, { path: 'modules/net/main.tf', content: NET }], ...installed, ...tf } as TerraformBlock
  const lab = labFromScenario(block, LAB, '/home/you')
  const disk: Record<string, string> = {}
  for (const f of lab.files) disk[f.path] = f.content
  if (lab.initialized) disk[`${LAB}/.terraform.lock.hcl`] = LOCK_FILE
  Object.assign(disk, o.files ?? {})
  const ctx: CliContext = {
    lab,
    cwd: LAB,
    mainHost: true,
    env: {},
    taken: new Set(),
    listFiles: async (dir) => Object.entries(disk).filter(([p]) => p.slice(0, p.lastIndexOf('/')) === dir).map(([p, text]) => ({ name: p.slice(p.lastIndexOf('/') + 1), text })),
    readFile: async (p) => disk[p],
    write: async (dir, name, text) => void (disk[`${dir}/${name}`] = text),
  }
  return { ctx, lab, disk, run: (...args: string[]) => runTerraform(args, ctx) }
}
const VPC_ATTRS = { id: 'vpc-1', cidr_block: '10.0.0.0/16', arn: 'arn:aws:ec2:us-east-1:123456789012:vpc/vpc-1', default_security_group_id: 'sg-1', enable_dns_hostnames: false, enable_dns_support: true }
const inModule = { type: 'aws_vpc', name: 'main', module: 'module.net', attrs: VPC_ATTRS }

describe('terraform modules: end to end', () => {
  it('init, validate, plan, apply, state list/show/pull', async () => {
    const w = world({ initialized: false })
    expect((await w.run('init')).exitCode).toBe(0)
    expect((await w.run('validate')).stdout).toContain('Success!')
    const plan = await w.run('plan')
    expect(plan.exitCode).toBe(0)
    const heads = plan.stdout.split('\n').filter((l) => l.startsWith('  # '))
    expect(heads).toEqual(['  # aws_subnet.a will be created', '  # module.net.aws_vpc.main will be created'])
    expect(plan.stdout).toContain('Plan: 2 to add, 0 to change, 0 to destroy.')
    const apply = await w.run('apply', '-auto-approve')
    expect(apply.exitCode).toBe(0)
    const lines = apply.stdout.split('\n')
    expect(lines).toContain('module.net.aws_vpc.main: Creating...')
    expect(lines.findIndex((l) => l.startsWith('module.net.aws_vpc.main: Creation complete'))).toBeLessThan(lines.indexOf('aws_subnet.a: Creating...'))
    expect(apply.stdout).toContain('Apply complete! Resources: 2 added, 0 changed, 0 destroyed.')
    expect((await w.run('state', 'list')).stdout).toBe('aws_subnet.a\nmodule.net.aws_vpc.main')
    expect((await w.run('state', 'list', 'module.net')).stdout).toBe('module.net.aws_vpc.main')
    const show = await w.run('state', 'show', 'module.net.aws_vpc.main')
    expect(show.stdout.split('\n')[0]).toBe('# module.net.aws_vpc.main:')
    const pulled = JSON.parse((await w.run('state', 'pull')).stdout) as { resources: { module?: string; type: string }[] }
    expect(pulled.resources.find((r) => r.type === 'aws_vpc')).toMatchObject({ module: 'module.net', mode: 'managed' })
    expect(Object.keys(pulled.resources.find((r) => r.type === 'aws_vpc')!)[0]).toBe('module')
    expect(w.lab.history).toEqual(['create module.net.aws_vpc.main', 'create aws_subnet.a'])
    expect((await w.run('plan')).stdout).toContain('No changes.')
    expect((await w.run('output')).stdout).toMatch(/^vpc = "vpc-/)
  })

  it('the same module called twice gets different ids', async () => {
    const two = ROOT.replace(/resource[\s\S]*$/, '') + 'module "net2" {\n  source = "./modules/net"\n  cidr   = "10.1.0.0/16"\n}\n'
    const w = world({ files: [{ path: 'main.tf', content: two }, { path: 'modules/net/main.tf', content: NET }], modules: { installed: [{ key: 'net', source: './modules/net', dir: 'modules/net' }, { key: 'net2', source: './modules/net', dir: 'modules/net' }] } })
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode, r.stderr).toBe(0)
    const ids = [...w.lab.state.resources.flatMap((x) => x.instances.map((i) => i.attributes.id))]
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(w.lab.state.resources.map((x) => x.module).sort()).toEqual(['module.net', 'module.net2'])
  })

  it('destroy runs in reverse order across the boundary and empties the state', async () => {
    const w = world()
    await w.run('apply', '-auto-approve')
    const r = await w.run('destroy', '-auto-approve')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Destroy complete! Resources: 2 destroyed.')
    const lines = r.stdout.split('\n')
    expect(lines.indexOf('aws_subnet.a: Destruction complete after 1s')).toBeLessThan(lines.findIndex((l) => l.startsWith('module.net.aws_vpc.main: Destroying...')))
    expect(w.lab.state.resources).toEqual([])
    expect(w.lab.history.slice(-2)).toEqual(['delete aws_subnet.a', 'delete module.net.aws_vpc.main'])
  })
})

describe('terraform modules: faults and errors', () => {
  it('a fault at the module resource address fails with a boxed module error and a partial state', async () => {
    const w = world({ faults: [{ at: 'module.net.aws_vpc.main', on: 'create', error: 'creating EC2 VPC: VpcLimitExceeded' }] })
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('│   with module.net.aws_vpc.main,')
    expect(r.stderr).toContain('│   on modules/net/main.tf line 5, in resource "aws_vpc" "main":')
    expect(r.stderr).toContain('│    5: resource "aws_vpc" "main" {')
    expect(w.lab.state.resources).toEqual([])
    expect(r.stdout).not.toContain('aws_subnet.a: Creating...')
  })

  it('a fault on a root resource that depends on the module leaves the module resource in state', async () => {
    const w = world({ faults: [{ at: 'aws_subnet.a', on: 'create', error: 'boom' }] })
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('│   with aws_subnet.a,')
    expect(w.lab.state.resources.map((x) => `${x.module}/${x.type}`)).toEqual(['module.net/aws_vpc'])
  })

  it('a fault keyed to the module instance address matches too, once (times)', async () => {
    const w = world({ faults: [{ at: 'module.net.aws_vpc.main', on: 'create', error: 'flaky', times: 1 }] })
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(1)
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    expect(w.lab.state.resources.map((x) => x.module ?? '')).toEqual(['module.net', ''].sort((a, b) => w.lab.state.resources.findIndex((x) => (x.module ?? '') === a) - w.lab.state.resources.findIndex((x) => (x.module ?? '') === b)))
  })
})

describe('terraform modules: moving a resource into a module without a moved block', () => {
  const ROOT_VPC = 'module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\n'
  const rootState = { type: 'aws_vpc', name: 'main', attrs: VPC_ATTRS }

  it('plans destroy + create and apply performs both', async () => {
    const w = world({ state: [rootState], files: [{ path: 'main.tf', content: ROOT_VPC }, { path: 'modules/net/main.tf', content: NET }] })
    const plan = await w.run('plan')
    expect(plan.stdout).toContain('# aws_vpc.main will be destroyed')
    expect(plan.stdout).toContain('(because aws_vpc.main is not in configuration)')
    expect(plan.stdout).toContain('# module.net.aws_vpc.main will be created')
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(w.lab.history).toEqual(['delete aws_vpc.main', 'create module.net.aws_vpc.main'])
    expect(w.lab.state.resources.map((x) => x.module)).toEqual(['module.net'])
  })

  it('prevent_destroy on the pre-existing module resource blocks its replacement', async () => {
    const guarded = NET.replace('cidr_block = var.cidr', 'cidr_block = var.cidr\n\n  lifecycle {\n    prevent_destroy = true\n  }')
    const w = world({ state: [{ ...inModule, attrs: { ...VPC_ATTRS, cidr_block: '10.9.0.0/16' } }], files: [{ path: 'main.tf', content: ROOT_VPC }, { path: 'modules/net/main.tf', content: guarded }] })
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Error: Instance cannot be destroyed')
    expect(r.stderr).toContain('on modules/net/main.tf line 5')
    expect(r.stderr).toContain('Resource module.net.aws_vpc.main has lifecycle.prevent_destroy set')
    expect(w.lab.history).toEqual([])
    expect(w.lab.state.resources[0].instances[0].attributes.id).toBe('vpc-1')
  })

  it('an orphaned module resource is destroyed when the call is removed', async () => {
    const w = world({ state: [inModule], files: [{ path: 'main.tf', content: '# nothing\nresource "aws_s3_bucket" "b" {\n  bucket = "b-1"\n}\n' }, { path: 'modules/net/main.tf', content: NET }] })
    const plan = await w.run('plan')
    expect(plan.stdout).toContain('# module.net.aws_vpc.main will be destroyed')
    expect(plan.stdout).toContain('(because module.net is not in configuration)')
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    expect(w.lab.history).toContain('delete module.net.aws_vpc.main')
    expect(w.lab.state.resources.map((x) => x.module ?? '')).toEqual([''])
  })
})

describe('terraform modules: replace and taint', () => {
  const state = [inModule, { type: 'aws_subnet', name: 'a', attrs: { id: 'subnet-1', vpc_id: 'vpc-1', cidr_block: '10.0.1.0/24', arn: 'arn:aws:ec2:us-east-1:123456789012:subnet/subnet-1', availability_zone: 'us-east-1a', map_public_ip_on_launch: false } }]

  it('-replace=module.net.aws_vpc.main replaces the module resource and its dependents update', async () => {
    const w = world({ state })
    const plan = await w.run('plan', '-replace=module.net.aws_vpc.main')
    expect(plan.stdout).toContain('# module.net.aws_vpc.main will be replaced, as requested')
    const r = await w.run('apply', '-replace=module.net.aws_vpc.main', '-auto-approve')
    expect(r.exitCode, r.stderr).toBe(0)
    // the new vpc id forces the dependent subnet to be replaced too; it goes first and comes back last
    expect(w.lab.history).toEqual(['delete aws_subnet.a', 'delete module.net.aws_vpc.main', 'create module.net.aws_vpc.main', 'create aws_subnet.a'])
  })

  it('an unknown module address in -replace is rejected as invalid, a bad one is not a resource', async () => {
    const w = world({ state })
    expect((await w.run('plan', '-replace=module.net')).stderr).toContain('Invalid force-replace address')
  })

  it('taint module.net.aws_vpc.main then apply replaces only that instance', async () => {
    const w = world({ state })
    const t = await w.run('taint', 'module.net.aws_vpc.main')
    expect(t.stdout).toBe('Resource instance module.net.aws_vpc.main has been marked as tainted.')
    expect((await w.run('state', 'show', 'module.net.aws_vpc.main')).stdout.split('\n')[0]).toBe('# module.net.aws_vpc.main: (tainted)')
    const plan = await w.run('plan')
    expect(plan.stdout).toContain('# module.net.aws_vpc.main is tainted, so must be replaced')
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    expect(w.lab.history).toEqual(['taint module.net.aws_vpc.main', 'delete aws_subnet.a', 'delete module.net.aws_vpc.main', 'create module.net.aws_vpc.main', 'create aws_subnet.a'])
    expect(w.lab.state.resources.find((x) => x.type === 'aws_vpc')!.instances[0].status).toBeUndefined()
  })
})

describe('terraform modules: saved plans', () => {
  it('apply of a saved plan uses the saved tree even if module files change', async () => {
    const w = world()
    const p = await w.run('plan', '-out=p')
    expect(p.exitCode).toBe(0)
    w.disk[`${LAB}/modules/net/main.tf`] = NET.replace('var.cidr', '"10.5.0.0/16"')
    const r = await w.run('apply', 'p')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(w.lab.state.resources.find((x) => x.type === 'aws_vpc')!.instances[0].attributes.cidr_block).toBe('10.0.0.0/16')
  })

  it('a saved plan is stale after another apply', async () => {
    const w = world()
    await w.run('plan', '-out=p')
    await w.run('apply', '-auto-approve')
    const r = await w.run('apply', 'p')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Saved plan is stale')
  })
})

describe('terraform modules: diagnostics and refresh', () => {
  it('a module syntax error is shown once by validate, plan and apply', async () => {
    const bad = NET + 'resource "aws_vpc" "x" {\n  oops = = 1\n}\n'
    const w = world({}, { files: { [`${LAB}/modules/net/main.tf`]: bad } })
    for (const cmd of [['validate'], ['plan'], ['apply', '-auto-approve']]) {
      const r = await w.run(...cmd)
      expect(r.exitCode, cmd.join(' ')).toBe(1)
      expect(r.stderr.split('on modules/net/main.tf line 13').length - 1, cmd.join(' ')).toBe(1)
      expect(r.stderr.match(/Error:/g)).toHaveLength(1)
    }
  })

  it('refresh and plan show module resources and drift in a module resource', async () => {
    const net = `${NET.replace('var.cidr', 'var.cidr\n  enable_dns_support = true')}output "dns" {\n  value = aws_vpc.main.enable_dns_support\n}\n`
    const root = `${ROOT}output "dns" {\n  value = module.net.dns\n}\n`
    const w = world({ state: [inModule], files: [{ path: 'main.tf', content: root }, { path: 'modules/net/main.tf', content: net }], cloud: { patch: [{ type: 'aws_vpc', id: 'vpc-1', set: { enable_dns_support: false } }] } })
    const plan = await w.run('plan')
    expect(plan.stdout.split('\n')[0]).toBe('module.net.aws_vpc.main: Refreshing state... [id=vpc-1]')
    expect(plan.stdout).toContain('# module.net.aws_vpc.main has changed')
    const ref = await w.run('refresh')
    expect(ref.exitCode).toBe(0)
    expect(ref.stdout).toContain('module.net.aws_vpc.main: Refreshing state... [id=vpc-1]')
    expect(w.lab.state.resources[0].instances[0].attributes.enable_dns_support).toBe(false)
  })

  it('the lock-file check covers providers used only inside a module', async () => {
    const w = world({}, { files: { [`${LAB}/.terraform.lock.hcl`]: '' } })
    const r = await w.run('validate')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('provider registry.terraform.io/hashicorp/aws: required by this configuration but no version is selected')
  })
})

describe('terraform modules: predicates through the shell', () => {
  const base = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@') && !s.stages && !s.terraform)!
  const scenario = (): Scenario =>
    ({
      ...structuredClone(base),
      terminal: { ...structuredClone(base.terminal!), prompt: 'you@laptop:~/infra$', commands: [] },
      terraform: { dir: '~/infra', files: [{ path: 'main.tf', content: ROOT }, { path: 'modules/net/main.tf', content: NET }], state: [], ...installed },
    }) as Scenario

  it('state_has, applied, plan_clean and plan_has no_destroy with module addresses', async () => {
    const s = scenario()
    const sh = new IncidentShell(s)
    await sh.run('ls', s, new Set()) // files are mounted by the first command
    expect(await sh.doneWhen({ state_has: 'module.net.aws_vpc.main' })).toBe(false)
    expect(await sh.doneWhen({ plan_clean: true })).toBe(false)
    expect(await sh.doneWhen({ plan_has: { no_destroy: ['module.net'] } })).toBe(true)
    const out = await sh.run('terraform apply -auto-approve', s, new Set())
    expect(out.output).toContain('Apply complete! Resources: 2 added')
    expect(await sh.doneWhen({ state_has: 'module.net.aws_vpc.main' })).toBe(true)
    expect(await sh.doneWhen({ state_has: 'module.net' })).toBe(true)
    expect(await sh.doneWhen({ state_has: 'module.other' })).toBe(false)
    expect(await sh.doneWhen({ applied: { op: 'create', address: 'module.net.aws_vpc.main' } })).toBe(true)
    expect(await sh.doneWhen({ plan_clean: true })).toBe(true)
    await sh.run('terraform destroy -auto-approve', s, new Set())
    expect(await sh.doneWhen({ state_lacks: 'module.net.aws_vpc.main' })).toBe(true)
    expect(await sh.doneWhen({ applied: { op: 'delete', address: 'module.net' } })).toBe(true)
  })

  it('plan_has no_destroy is false when the plan would destroy a module resource', async () => {
    const s = scenario()
    const sh = new IncidentShell(s)
    await sh.run('terraform apply -auto-approve', s, new Set())
    await sh.run("sed -i 's#\"10.0.0.0/16\"#\"10.9.0.0/16\"#' main.tf", s, new Set())
    expect(await sh.doneWhen({ plan_has: { no_destroy: ['module.net.aws_vpc.main'] } })).toBe(false)
    expect(await sh.doneWhen({ plan_has: { no_destroy: ['module.other'] } })).toBe(true)
  })
})
