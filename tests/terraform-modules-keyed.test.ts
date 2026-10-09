import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { IncidentShell } from '../src/game/shell.ts'
import { TerraformSchema, type Scenario, type TerraformBlock } from '../src/schema/scenario.ts'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'

const LAB = '/home/you/infra'
const NET = 'variable "cidr" {\n  type = string\n}\n\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}\n\noutput "vpc_id" {\n  value = aws_vpc.main.id\n}\n'
const FE = (keys = '["a", "b"]') => `module "net" {\n  source   = "./modules/net"\n  for_each = toset(${keys})\n  cidr     = each.key == "a" ? "10.0.0.0/16" : "10.1.0.0/16"\n}\n`
const SUBNETS = 'resource "aws_subnet" "a" {\n  vpc_id     = module.net["a"].vpc_id\n  cidr_block = "10.0.1.0/24"\n}\n\nresource "aws_subnet" "b" {\n  vpc_id     = module.net["b"].vpc_id\n  cidr_block = "10.1.1.0/24"\n}\n'
const CNT = (n = 2) => `module "net" {\n  source = "./modules/net"\n  count  = ${n}\n  cidr   = "10.${'${count.index}'}.0.0/16"\n}\n`
const installed = { modules: { installed: [{ key: 'net', source: './modules/net', dir: 'modules/net' }] } }

function world(root: string, tf: Partial<TerraformBlock> = {}, extra: Record<string, string> = {}) {
  const block = { files: [{ path: 'main.tf', content: root }, { path: 'modules/net/main.tf', content: NET }, ...Object.entries(extra).map(([path, content]) => ({ path, content }))], ...installed, ...tf } as TerraformBlock
  const lab = labFromScenario(block, LAB, '/home/you')
  const disk: Record<string, string> = {}
  for (const f of lab.files) disk[f.path] = f.content
  if (lab.initialized) disk[`${LAB}/.terraform.lock.hcl`] = LOCK_FILE
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
  return { ctx, lab, disk, setRoot: (text: string) => void (disk[`${LAB}/main.tf`] = text), run: (...args: string[]) => runTerraform(args, ctx) }
}
const stateAddrs = (w: ReturnType<typeof world>) => w.run('state', 'list').then((r) => r.stdout.split('\n'))
const heads = (stdout: string) => stdout.split('\n').filter((l) => l.startsWith('  # ') && !l.startsWith('  # ('))
const index = (lines: string[], prefix: string) => lines.findIndex((l) => l.startsWith(prefix))

describe('keyed modules: for_each and count', () => {
  it('for_each: plan text, apply order, state, per-instance outputs', async () => {
    const w = world(`${FE()}${SUBNETS}output "ids" {\n  value = [module.net["a"].vpc_id, module.net["b"].vpc_id]\n}\n`)
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(heads(plan.stdout)).toEqual(['  # aws_subnet.a will be created', '  # aws_subnet.b will be created', '  # module.net["a"].aws_vpc.main will be created', '  # module.net["b"].aws_vpc.main will be created'])
    expect(plan.stdout).toContain('  # module.net["a"].aws_vpc.main will be created\n  + resource "aws_vpc" "main" {')
    expect(plan.stdout).toContain('      + cidr_block                = "10.0.0.0/16"')
    expect(plan.stdout).toContain('      + cidr_block                = "10.1.0.0/16"')
    expect(plan.stdout).toContain('Plan: 4 to add, 0 to change, 0 to destroy.')
    const apply = await w.run('apply', '-auto-approve')
    expect(apply.exitCode, apply.stderr).toBe(0)
    const lines = apply.stdout.split('\n')
    expect(lines).toContain('module.net["a"].aws_vpc.main: Creating...')
    expect(index(lines, 'module.net["a"].aws_vpc.main: Creation complete')).toBeLessThan(lines.indexOf('aws_subnet.a: Creating...'))
    expect(index(lines, 'module.net["b"].aws_vpc.main: Creation complete')).toBeLessThan(lines.indexOf('aws_subnet.b: Creating...'))
    expect(apply.stdout).toContain('Apply complete! Resources: 4 added, 0 changed, 0 destroyed.')
    expect(await stateAddrs(w)).toEqual(['aws_subnet.a', 'aws_subnet.b', 'module.net["a"].aws_vpc.main', 'module.net["b"].aws_vpc.main'])
    const pulled = JSON.parse((await w.run('state', 'pull')).stdout) as { resources: { module?: string; type: string }[] }
    expect(pulled.resources.filter((r) => r.type === 'aws_vpc').map((r) => r.module).sort()).toEqual(['module.net["a"]', 'module.net["b"]'])
    const subnetA = w.lab.state.resources.find((r) => r.name === 'a')!.instances[0].attributes
    const vpcA = w.lab.state.resources.find((r) => r.module === 'module.net["a"]')!.instances[0].attributes
    expect(subnetA.vpc_id).toBe(vpcA.id)
    expect(vpcA.id).not.toBe(w.lab.state.resources.find((r) => r.module === 'module.net["b"]')!.instances[0].attributes.id)
    expect((await w.run('state', 'show', 'module.net["b"].aws_vpc.main')).stdout.split('\n')[0]).toBe('# module.net["b"].aws_vpc.main:')
    expect((await w.run('state', 'list', 'module.net["a"]')).stdout).toBe('module.net["a"].aws_vpc.main')
    expect((await w.run('state', 'list', 'module.net')).stdout).toBe('module.net["a"].aws_vpc.main\nmodule.net["b"].aws_vpc.main')
    expect((await w.run('plan')).stdout).toContain('No changes.')
    expect((await w.run('output', '-json')).stdout).toContain(String(vpcA.id))
    expect(w.lab.history.filter((h) => h.startsWith('create module'))).toEqual(['create module.net["a"].aws_vpc.main', 'create module.net["b"].aws_vpc.main'])
  })

  it('count = 2: indexes, count.index in the call arguments and the whole-module reference', async () => {
    const root = `${CNT()}resource "aws_subnet" "s" {\n  count      = 2\n  vpc_id     = module.net[count.index].vpc_id\n  cidr_block = "10.\${count.index}.1.0/24"\n}\noutput "first" {\n  value = module.net[0].vpc_id\n}\n`
    const w = world(root)
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('  # module.net[0].aws_vpc.main will be created')
    expect(plan.stdout).toContain('  # module.net[1].aws_vpc.main will be created')
    expect(plan.stdout).toContain('      + cidr_block                = "10.1.0.0/16"')
    expect(plan.stdout).toContain('Plan: 4 to add, 0 to change, 0 to destroy.')
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(await stateAddrs(w)).toEqual(['aws_subnet.s[0]', 'aws_subnet.s[1]', 'module.net[0].aws_vpc.main', 'module.net[1].aws_vpc.main'])
    const vpc1 = w.lab.state.resources.find((x) => x.module === 'module.net[1]')!.instances[0].attributes
    expect(w.lab.state.resources.find((x) => x.name === 's')!.instances[1].attributes.vpc_id).toBe(vpc1.id)
    expect((await w.run('state', 'list', 'module.net[1]')).stdout).toBe('module.net[1].aws_vpc.main')
  })

  it('a bare module reference is an object of instances (for_each) or a tuple (count)', async () => {
    const w = world(`${FE()}output "ks" {\n  value = keys(module.net)\n}\noutput "n" {\n  value = length(module.net)\n}\noutput "b" {\n  value = module.net["b"]\n}\n`)
    const ap = await w.run('apply', '-auto-approve')
    expect(ap.stderr).toBe('')
    const out = JSON.parse((await w.run('output', '-json')).stdout) as { ks: { value: string[] }; n: { value: number }; b: { value: { vpc_id: string } } }
    expect(out.ks.value).toEqual(['a', 'b'])
    expect(out.n.value).toBe(2)
    expect(out.b.value.vpc_id).toBe(w.lab.state.resources.find((r) => r.module === 'module.net["b"]')!.instances[0].attributes.id)
    const c = world(`${CNT()}output "n" {\n  value = length(module.net)\n}\noutput "second" {\n  value = module.net[1]\n}\n`)
    const r = await c.run('plan')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toContain('+ n      = 2')
  })

  it('an attribute read on a repeated module without an instance key is an error', async () => {
    const w = world(`${FE()}output "x" {\n  value = module.net.vpc_id\n}\n`)
    const r = await w.run('plan')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Unsupported attribute')
    expect(r.stderr).toContain('This object does not have an attribute named "vpc_id".')
  })

  it('count = 0 plans nothing and a for_each of an empty set too', async () => {
    const w = world(`${CNT(0)}output "n" {\n  value = length(module.net)\n}\n`)
    const r = await w.run('plan')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toContain('+ n = 0')
    expect((await world(FE('[]')).run('plan')).stdout).toContain('No changes.')
  })

  it('an unknown for_each or count gives the resource errors, located on the module call', async () => {
    const root = `resource "aws_s3_bucket" "x" {\n  bucket = "x"\n}\nmodule "net" {\n  source   = "./modules/net"\n  for_each = toset([aws_s3_bucket.x.id])\n  cidr     = "10.0.0.0/16"\n}\n`
    const r = await world(root).run('plan')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Error: Invalid for_each argument')
    expect(r.stderr).toContain('│   on main.tf line 6, in module "net":')
    expect(r.stderr).toContain('The "for_each" map includes keys derived from resource attributes that')
    const c = await world(`resource "aws_s3_bucket" "x" {\n  bucket = "x"\n}\nmodule "net" {\n  source = "./modules/net"\n  count  = length(aws_s3_bucket.x.id)\n  cidr   = "x"\n}\n`).run('plan')
    expect(c.stderr).toContain('Error: Invalid count argument')
    expect(c.stderr).toContain('in module "net"')
    const both = await world(`module "net" {\n  source   = "./modules/net"\n  count    = 1\n  for_each = toset(["a"])\n  cidr     = "x"\n}\n`).run('plan')
    expect(both.stderr).toContain('Invalid combination of "count" and "for_each"')
  })

  it('a module output used in a root for_each: keys known after apply error like resources', async () => {
    const root = `module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\nresource "aws_subnet" "s" {\n  for_each   = toset([module.net.vpc_id])\n  vpc_id     = each.key\n  cidr_block = "10.0.1.0/24"\n}\n`
    const r = await world(root).run('plan')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Error: Invalid for_each argument')
    expect(r.stderr).toContain('in resource "aws_subnet" "s"')
    // a for_each over the module's keys is fine even though the values are unknown
    const ok = await world(`${FE()}resource "aws_subnet" "s" {\n  for_each   = module.net\n  vpc_id     = each.value.vpc_id\n  cidr_block = "10.0.1.0/24"\n}\n`).run('plan')
    expect(ok.exitCode, ok.stderr).toBe(0)
    expect(heads(ok.stdout)).toContain('  # aws_subnet.s["b"] will be created')
  })

  it('a keyed module and a plain module together, and two keyed calls to one directory', async () => {
    const root = `${FE()}module "solo" {\n  source = "./modules/net"\n  cidr   = "10.9.0.0/16"\n}\nmodule "other" {\n  source = "./modules/net"\n  count  = 2\n  cidr   = "10.\${count.index + 5}.0.0/16"\n}\n`
    const w = world(root, { modules: { installed: [{ key: 'net', source: './modules/net', dir: 'modules/net' }, { key: 'solo', source: './modules/net', dir: 'modules/net' }, { key: 'other', source: './modules/net', dir: 'modules/net' }] } })
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(await stateAddrs(w)).toEqual(['module.other[0].aws_vpc.main', 'module.other[1].aws_vpc.main', 'module.net["a"].aws_vpc.main', 'module.net["b"].aws_vpc.main', 'module.solo.aws_vpc.main'].sort(cmpAddr))
    const ids = w.lab.state.resources.map((x) => x.instances[0].attributes.id)
    expect(new Set(ids).size).toBe(5)
    expect((await w.run('plan')).stdout).toContain('No changes.')
  })
})

// state list order: module path first by name then key, then the rest
const cmpAddr = (a: string, b: string) => {
  const ma = /^module\.(\w+)(?:\[(.+?)\])?\./.exec(a)
  const mb = /^module\.(\w+)(?:\[(.+?)\])?\./.exec(b)
  if (!ma || !mb) return ma ? 1 : mb ? -1 : a < b ? -1 : 1
  return ma[1] !== mb[1] ? (ma[1] < mb[1] ? -1 : 1) : (ma[2] ?? '') < (mb[2] ?? '') ? -1 : 1
}

describe('keyed modules: removed keys and dependencies', () => {
  const SUBS = 'resource "aws_subnet" "s" {\n  for_each   = module.net\n  vpc_id     = each.value.vpc_id\n  cidr_block = "10.0.1.0/24"\n}\n'

  it('removing a key destroys its dependents first, then its module resources, with the reason text', async () => {
    const w = world(`${FE()}${SUBS}`)
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    const before = w.lab.state.resources.flatMap((r) => r.instances.map((i) => i.dependencies))
    expect(before.filter(Boolean)).toEqual([['module.net.aws_vpc.main'], ['module.net.aws_vpc.main']])
    w.setRoot(`${FE('["a"]')}${SUBS}`)
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('  # aws_subnet.s["b"] will be destroyed\n  # (because key ["b"] is not in for_each map)')
    expect(plan.stdout).toContain('  # module.net["b"].aws_vpc.main will be destroyed\n  # (because module.net["b"] is not in configuration)')
    expect(plan.stdout).toContain('Plan: 0 to add, 0 to change, 2 to destroy.')
    const apply = await w.run('apply', '-auto-approve')
    expect(apply.exitCode, apply.stderr).toBe(0)
    expect(w.lab.history.slice(-2)).toEqual(['delete aws_subnet.s["b"]', 'delete module.net["b"].aws_vpc.main'])
    expect(await stateAddrs(w)).toEqual(['aws_subnet.s["a"]', 'module.net["a"].aws_vpc.main'])
    expect((await w.run('plan')).stdout).toContain('No changes.')
  })

  it('removing a key whose dependent stays is the usual invalid-index error', async () => {
    const w = world(`${FE()}${SUBNETS}`)
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    w.setRoot(`${FE('["a"]')}${SUBNETS}`)
    const plan = await w.run('plan')
    expect(plan.exitCode).toBe(1)
    expect(plan.stderr).toContain('Error: Invalid index')
    expect(plan.stderr).toContain('in resource "aws_subnet" "b"')
  })

  it('removing a key and its explicit dependent: dependent goes first even though it is a plain root resource', async () => {
    const w = world(`${FE()}${SUBNETS}`)
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    w.setRoot(`${FE('["a"]')}${SUBNETS.split('\n\n')[0]}\n`)
    const plan = await w.run('plan')
    expect(plan.stdout).toContain('  # aws_subnet.b will be destroyed\n  # (because aws_subnet.b is not in configuration)')
    expect(plan.stdout).toContain('  # module.net["b"].aws_vpc.main will be destroyed\n  # (because module.net["b"] is not in configuration)')
    const apply = await w.run('apply', '-auto-approve')
    expect(apply.exitCode, apply.stderr).toBe(0)
    expect(apply.stderr).not.toContain('DependencyViolation')
    expect(w.lab.history.slice(-2)).toEqual(['delete aws_subnet.b', 'delete module.net["b"].aws_vpc.main'])
  })

  it('terraform destroy removes dependents before the vpcs of every instance', async () => {
    const w = world(`${FE()}${SUBNETS}`)
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    const r = await w.run('destroy', '-auto-approve')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toContain('Destroy complete! Resources: 4 destroyed.')
    const del = w.lab.history.filter((h) => h.startsWith('delete'))
    expect(del.slice(0, 2).sort()).toEqual(['delete aws_subnet.a', 'delete aws_subnet.b'])
    expect(del.slice(2).sort()).toEqual(['delete module.net["a"].aws_vpc.main', 'delete module.net["b"].aws_vpc.main'])
    expect(w.lab.state.resources).toEqual([])
  })

  it('state written by an older plan: dependencies on the static name never collapse an unrelated instance', async () => {
    // subnet a depends on vpc a only in practice, but state names the static resource: both vpcs wait for both subnets
    const w = world(`${FE()}${SUBNETS}`)
    await w.run('apply', '-auto-approve')
    w.setRoot('# empty\n')
    const apply = await w.run('apply', '-auto-approve')
    expect(apply.exitCode, apply.stderr).toBe(0)
    const del = w.lab.history.filter((h) => h.startsWith('delete'))
    expect(del.indexOf('delete aws_subnet.a')).toBeLessThan(del.indexOf('delete module.net["a"].aws_vpc.main'))
    expect(del.indexOf('delete aws_subnet.b')).toBeLessThan(del.indexOf('delete module.net["b"].aws_vpc.main'))
  })

  it('count shrink destroys the highest index', async () => {
    const w = world(CNT())
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    w.setRoot(CNT(1))
    const plan = await w.run('plan')
    expect(plan.stdout).toContain('  # module.net[1].aws_vpc.main will be destroyed\n  # (because module.net[1] is not in configuration)')
    expect(plan.stdout).toContain('Plan: 0 to add, 0 to change, 1 to destroy.')
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    expect(await stateAddrs(w)).toEqual(['module.net[0].aws_vpc.main'])
  })

  it('count to for_each without moved blocks replaces every instance; moved blocks map it key by key', async () => {
    const w = world(CNT())
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    const ids = w.lab.state.resources.map((r) => r.instances[0].attributes.id)
    w.setRoot(FE())
    const plain = await w.run('plan')
    expect(plain.stdout).toContain('  # module.net[0].aws_vpc.main will be destroyed\n  # (because module.net[0] is not in configuration)')
    expect(plain.stdout).toContain('  # module.net["a"].aws_vpc.main will be created')
    expect(plain.stdout).toContain('Plan: 2 to add, 0 to change, 2 to destroy.')
    const moves = 'moved {\n  from = module.net[0]\n  to   = module.net["a"]\n}\n\nmoved {\n  from = module.net[1]\n  to   = module.net["b"]\n}\n\n'
    w.setRoot(`${moves}${FE().replace('"10.0.0.0/16"', '"10.0.0.0/16"').replace('"10.1.0.0/16"', '"10.1.0.0/16"')}`)
    const mv = await w.run('plan')
    expect(mv.exitCode, mv.stderr).toBe(0)
    expect(mv.stdout).toContain('  # module.net[0].aws_vpc.main has moved to module.net["a"].aws_vpc.main')
    expect(mv.stdout).toContain('  # module.net[1].aws_vpc.main has moved to module.net["b"].aws_vpc.main')
    expect(mv.stdout).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    expect(await stateAddrs(w)).toEqual(['module.net["a"].aws_vpc.main', 'module.net["b"].aws_vpc.main'])
    expect(w.lab.state.resources.map((r) => r.instances[0].attributes.id).sort()).toEqual([...ids].sort())
  })

  it('for_each to count likewise (key to index moves)', async () => {
    const w = world(FE())
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    w.setRoot(CNT())
    const plain = await w.run('plan')
    expect(plain.stdout).toContain('  # module.net["a"].aws_vpc.main will be destroyed\n  # (because module.net["a"] is not in configuration)')
    w.setRoot(`moved {\n  from = module.net["a"]\n  to   = module.net[0]\n}\n\nmoved {\n  from = module.net["b"]\n  to   = module.net[1]\n}\n\n${CNT()}`)
    const mv = await w.run('plan')
    expect(mv.stdout).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    expect(mv.stdout).toContain('# module.net["a"].aws_vpc.main has moved to module.net[0].aws_vpc.main')
  })
})

describe('keyed modules: moved blocks and state commands', () => {
  const applied = async (root: string) => {
    const w = world(root)
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode, r.stderr).toBe(0)
    return w
  }

  it('moved module.net to module.net["a"] when for_each is added', async () => {
    const single = 'module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\n'
    const w = await applied(single)
    const id = w.lab.state.resources[0].instances[0].attributes.id
    w.setRoot(`${FE('["a"]').replace('each.key == "a" ? "10.0.0.0/16" : "10.1.0.0/16"', '"10.0.0.0/16"')}`)
    const without = await w.run('plan')
    expect(without.stdout).toContain('  # module.net.aws_vpc.main will be destroyed\n  # (because module.net is not in configuration)')
    expect(without.stdout).toContain('  # module.net["a"].aws_vpc.main will be created')
    w.setRoot(`moved {\n  from = module.net\n  to   = module.net["a"]\n}\n\n${FE('["a"]').replace('each.key == "a" ? "10.0.0.0/16" : "10.1.0.0/16"', '"10.0.0.0/16"')}`)
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('module.net.aws_vpc.main has moved to module.net["a"].aws_vpc.main')
    expect(plan.stdout).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    expect(w.lab.state.resources[0]).toMatchObject({ module: 'module.net["a"]' })
    expect(w.lab.state.resources[0].instances[0].attributes.id).toBe(id)
  })

  it('module rename keeps every key, and rewrites state dependencies', async () => {
    const w = await applied(`${FE()}${SUBNETS}`)
    const ids = w.lab.state.resources.filter((r) => r.module).map((r) => r.instances[0].attributes.id).sort()
    const renamed = `${FE().replace('module "net"', 'module "network"')}${SUBNETS.replaceAll('module.net[', 'module.network[')}`
    w.disk[`${LAB}/main.tf`] = `moved {\n  from = module.net\n  to   = module.network\n}\n\n${renamed}`
    const p = await w.run('plan')
    // the new call is not installed: init first
    expect(p.stderr).toContain('Module not installed')
    expect((await w.run('init')).exitCode).toBe(0)
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('module.net["a"].aws_vpc.main has moved to module.network["a"].aws_vpc.main')
    expect(plan.stdout).toContain('module.net["b"].aws_vpc.main has moved to module.network["b"].aws_vpc.main')
    expect(plan.stdout).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    expect(await stateAddrs(w)).toEqual(['aws_subnet.a', 'aws_subnet.b', 'module.network["a"].aws_vpc.main', 'module.network["b"].aws_vpc.main'])
    expect(w.lab.state.resources.filter((r) => r.module).map((r) => r.instances[0].attributes.id).sort()).toEqual(ids)
    expect(w.lab.state.resources.flatMap((r) => r.instances.map((i) => i.dependencies)).filter(Boolean)).toEqual([['module.network.aws_vpc.main'], ['module.network.aws_vpc.main']])
    // the destroy order still holds after the rename
    const d = await w.run('destroy', '-auto-approve')
    expect(d.exitCode, d.stderr).toBe(0)
  })

  it('moving one key to another key: names do not change, the instance follows', async () => {
    const w = await applied(FE())
    w.setRoot(`moved {\n  from = module.net["b"]\n  to   = module.net["c"]\n}\n\n${FE('["a", "c"]')}`)
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('module.net["b"].aws_vpc.main has moved to module.net["c"].aws_vpc.main')
  })

  it('a moved block whose source module instance is still declared is an error', async () => {
    const w = await applied(FE())
    w.setRoot(`moved {\n  from = module.net["a"]\n  to   = module.net["c"]\n}\n\n${FE('["a", "c"]')}`)
    const r = await w.run('plan')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Moved object still exists')
  })

  it('state mv of one module instance, state rm of another', async () => {
    const w = await applied(FE())
    const mv = await w.run('state', 'mv', 'module.net["b"]', 'module.net["c"]')
    expect(mv.exitCode, mv.stderr).toBe(0)
    expect(await stateAddrs(w)).toEqual(['module.net["a"].aws_vpc.main', 'module.net["c"].aws_vpc.main'])
    const rm = await w.run('state', 'rm', 'module.net["a"]')
    expect(rm.stdout).toContain('Removed module.net["a"].aws_vpc.main')
    expect(await stateAddrs(w)).toEqual(['module.net["c"].aws_vpc.main'])
    const one = await w.run('state', 'mv', 'module.net["c"].aws_vpc.main', 'module.net["d"].aws_vpc.main')
    expect(one.exitCode, one.stderr).toBe(0)
    expect(await stateAddrs(w)).toEqual(['module.net["d"].aws_vpc.main'])
  })

  it('moving only some instances to a new module name keeps the dependencies of those that stayed', async () => {
    const w = await applied(`${FE()}${SUBNETS}`)
    const mv = await w.run('state', 'mv', 'module.net["b"]', 'module.other["b"]')
    expect(mv.exitCode, mv.stderr).toBe(0)
    const deps = w.lab.state.resources.flatMap((r) => r.instances.map((i) => i.dependencies)).filter(Boolean)
    expect(deps).toEqual([['module.net.aws_vpc.main', 'module.other.aws_vpc.main'], ['module.net.aws_vpc.main', 'module.other.aws_vpc.main']])
  })
})

describe('keyed modules: import, replace, taint', () => {
  const BUCKET = 'resource "aws_s3_bucket" "b" {\n  bucket = var.name\n}\nvariable "name" {}\n'
  const KB = (keys = '["a", "b"]') => `module "bk" {\n  source   = "./modules/bk"\n  for_each = toset(${keys})\n  name     = "bucket-\${each.key}"\n}\n`
  const bk = { 'modules/bk/main.tf': BUCKET }
  const withBk = (root: string, tf: Partial<TerraformBlock> = {}) =>
    world(root, { modules: { installed: [{ key: 'bk', source: './modules/bk', dir: 'modules/bk' }] }, cloud: { add: [{ type: 'aws_s3_bucket', attrs: { bucket: 'bucket-a', id: 'bucket-a', arn: 'arn:aws:s3:::bucket-a' } }] }, ...tf }, bk)

  it('terraform import into a keyed module instance', async () => {
    const w = withBk(KB())
    const r = await w.run('import', 'module.bk["a"].aws_s3_bucket.b', 'bucket-a')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toContain('module.bk["a"].aws_s3_bucket.b: Importing from ID "bucket-a"...')
    expect(w.lab.state.resources[0]).toMatchObject({ module: 'module.bk["a"]', type: 'aws_s3_bucket' })
    const again = await w.run('import', 'module.bk["a"].aws_s3_bucket.b', 'bucket-a')
    expect(again.stderr).toContain('Resource already managed by Terraform')
    const plan = await w.run('plan')
    expect(plan.stdout).toContain('module.bk["b"].aws_s3_bucket.b will be created')
    expect(plan.stdout).not.toContain('module.bk["a"].aws_s3_bucket.b will be')
  })

  it('import into a key the module call does not produce, or without a key on a repeated call', async () => {
    const w = withBk(KB())
    const missing = await w.run('import', 'module.bk["zzz"].aws_s3_bucket.b', 'bucket-a')
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('Configuration for import target does not exist')
    expect(missing.stderr).toContain('module.bk["zzz"].aws_s3_bucket.b')
    const bare = await w.run('import', 'module.bk.aws_s3_bucket.b', 'bucket-a')
    expect(bare.stderr).toContain('Configuration for import target does not exist')
    const nores = await w.run('import', 'module.bk["a"].aws_s3_bucket.nope', 'bucket-a')
    expect(nores.stderr).toContain('does not exist in the configuration')
    expect(w.lab.state.resources).toEqual([])
  })

  it('import when the expansion is unknown is accepted', async () => {
    const root = `resource "aws_s3_bucket" "x" {\n  bucket = "x"\n}\nmodule "bk" {\n  source   = "./modules/bk"\n  for_each = toset([aws_s3_bucket.x.id])\n  name     = "n"\n}\n`
    const w = withBk(root)
    const r = await w.run('import', 'module.bk["whatever"].aws_s3_bucket.b', 'bucket-a')
    expect(r.exitCode, r.stderr).toBe(0)
  })

  it('an import block in the root can target a keyed module instance', async () => {
    const w = withBk(`${KB()}import {\n  to = module.bk["a"].aws_s3_bucket.b\n  id = "bucket-a"\n}\n`)
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('# module.bk["a"].aws_s3_bucket.b will be imported')
    expect(plan.stdout).toContain('Plan: 1 to import, 1 to add, 0 to change, 0 to destroy.')
    const bad = withBk(`${KB('["b"]')}import {\n  to = module.bk["a"].aws_s3_bucket.b\n  id = "bucket-a"\n}\n`)
    expect((await bad.run('plan')).stderr).toContain('Configuration for import target does not exist')
  })

  it('-replace and taint touch one instance only', async () => {
    const w = world(`${FE()}${SUBNETS}`)
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    const plan = await w.run('plan', '-replace=module.net["a"].aws_vpc.main')
    expect(plan.stdout).toContain('  # module.net["a"].aws_vpc.main will be replaced, as requested')
    expect(plan.stdout).not.toContain('module.net["b"].aws_vpc.main will')
    expect(plan.stdout).not.toContain('aws_subnet.b will')
    const t = await w.run('taint', 'module.net["b"].aws_vpc.main')
    expect(t.stdout).toBe('Resource instance module.net["b"].aws_vpc.main has been marked as tainted.')
    expect((await w.run('state', 'show', 'module.net["b"].aws_vpc.main')).stdout.split('\n')[0]).toBe('# module.net["b"].aws_vpc.main: (tainted)')
    const p2 = await w.run('plan')
    expect(p2.stdout).toContain('  # module.net["b"].aws_vpc.main is tainted, so must be replaced')
    expect(p2.stdout).not.toContain('module.net["a"].aws_vpc.main is tainted')
    const before = w.lab.history.length
    const apply = await w.run('apply', '-auto-approve')
    expect(apply.exitCode, apply.stderr).toBe(0)
    expect(w.lab.history.slice(before)).toEqual(['delete aws_subnet.b', 'delete module.net["b"].aws_vpc.main', 'create module.net["b"].aws_vpc.main', 'create aws_subnet.b'])
    expect((await w.run('untaint', 'module.net["a"].aws_vpc.main')).stderr).toContain('is not currently tainted')
  })

  it('-replace without the key warns like a count resource and lists the instances', async () => {
    const w = world(FE())
    await w.run('apply', '-auto-approve')
    const plan = await w.run('plan', '-replace=module.net.aws_vpc.main')
    expect(plan.stdout).toContain('Warning: Incompletely-matched force-replace resource instance')
    expect(plan.stdout).toContain('-replace="module.net["a"].aws_vpc.main"')
  })
})

describe('keyed modules: faults, errors, history and predicates', () => {
  it('a fault at an instance address fires only for that instance; the boxed error names it', async () => {
    const w = world(`${FE()}${SUBNETS}`, { faults: [{ at: 'module.net["a"].aws_vpc.main', on: 'create', error: 'creating EC2 VPC: VpcLimitExceeded' }] })
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('│   with module.net["a"].aws_vpc.main,')
    expect(r.stderr).toContain('│   on modules/net/main.tf line 5, in resource "aws_vpc" "main":')
    expect(r.stderr).not.toContain('module.net["b"].aws_vpc.main,')
    expect(r.stdout).toContain('module.net["b"].aws_vpc.main: Creation complete')
    // dependencies are on the resource, not the instance: neither subnet is attempted while module.net.aws_vpc.main has a failed instance
    expect(r.stdout).not.toContain('aws_subnet.a: Creating...')
    expect(r.stdout).not.toContain('aws_subnet.b: Creating...')
    expect(w.lab.state.resources.map((x) => `${x.module ?? ''}/${x.type}`)).toEqual(['module.net["b"]/aws_vpc'])
  })

  it('a fault at the module resource address fires for every instance', async () => {
    const w = world(FE(), { faults: [{ at: 'module.net.aws_vpc.main', on: 'create', error: 'boom' }] })
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('with module.net["a"].aws_vpc.main,')
    expect(r.stderr).toContain('with module.net["b"].aws_vpc.main,')
    expect(w.lab.state.resources).toEqual([])
  })

  it('a fault at an instance-qualified resource fires for each key of a counted resource inside the instance', async () => {
    const net = `${NET}resource "aws_s3_bucket" "c" {\n  count  = 2\n  bucket = "c-\${count.index}"\n}\n`
    const w = world(FE('["a"]'), { faults: [{ at: 'module.net["a"].aws_s3_bucket.c', on: 'create', error: 'boom' }, { at: 'module.net["a"].aws_vpc.main', on: 'update', error: 'no' }] }, { 'modules/net/main.tf': net })
    const r = await w.run('apply', '-auto-approve')
    expect(r.stderr.match(/with module\.net\["a"\]\.aws_s3_bucket\.c\[\d\],/g)).toHaveLength(2)
    expect(w.lab.state.resources.map((x) => x.type)).toEqual(['aws_vpc'])
  })

  it('a failed instance blocks the dependents of the module resource, not independent work', async () => {
    const w = world(`${FE()}${SUBNETS}resource "aws_s3_bucket" "free" {\n  bucket = "free-1"\n}\n`, { faults: [{ at: 'module.net["b"].aws_vpc.main', on: 'create', error: 'boom' }] })
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('aws_s3_bucket.free: Creation complete')
    expect(r.stdout).not.toContain('aws_subnet.b: Creating...')
    expect(r.stdout).toContain('module.net["a"].aws_vpc.main: Creation complete')
  })

  it('a fault on delete of one instance leaves its dependents destroyed and the instance in state', async () => {
    const w = world(`${FE()}${SUBNETS}`, { faults: [{ at: 'module.net["b"].aws_vpc.main', on: 'delete', error: 'DependencyViolation: stuck' }] })
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    const r = await w.run('destroy', '-auto-approve')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('with module.net["b"].aws_vpc.main,')
    expect(await stateAddrs(w)).toEqual(['module.net["b"].aws_vpc.main'])
  })

  const base = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@') && !s.stages && !s.terraform)!
  const scenario = (): Scenario =>
    ({
      ...structuredClone(base),
      terminal: { ...structuredClone(base.terminal!), prompt: 'you@laptop:~/infra$', commands: [] },
      terraform: { dir: '~/infra', files: [{ path: 'main.tf', content: `${FE()}${SUBNETS}` }, { path: 'modules/net/main.tf', content: NET }], state: [], ...installed },
    }) as Scenario

  it('state_has, state_lacks, applied and plan_has no_destroy with keyed module addresses', async () => {
    const s = scenario()
    const sh = new IncidentShell(s)
    await sh.run('ls', s, new Set())
    expect(await sh.doneWhen({ state_has: 'module.net["a"].aws_vpc.main' })).toBe(false)
    await sh.run('terraform apply -auto-approve', s, new Set())
    expect(await sh.doneWhen({ state_has: 'module.net["a"].aws_vpc.main' })).toBe(true)
    expect(await sh.doneWhen({ state_has: 'module.net["c"].aws_vpc.main' })).toBe(false)
    expect(await sh.doneWhen({ state_has: 'module.net.aws_vpc.main' })).toBe(true) // an unkeyed module step covers every instance
    expect(await sh.doneWhen({ state_has: 'module.net' })).toBe(true)
    expect(await sh.doneWhen({ state_has: 'module.net["b"]' })).toBe(true)
    expect(await sh.doneWhen({ applied: { op: 'create', address: 'module.net["b"].aws_vpc.main' } })).toBe(true)
    expect(await sh.doneWhen({ applied: { op: 'create', address: 'module.net["z"].aws_vpc.main' } })).toBe(false)
    expect(await sh.doneWhen({ applied: { op: 'create', address: 'module.net' } })).toBe(true)
    expect(await sh.doneWhen({ plan_clean: true })).toBe(true)
    await sh.run("sed -i 's#\"10.0.0.0/16\"#\"10.9.0.0/16\"#' main.tf", s, new Set())
    expect(await sh.doneWhen({ plan_has: { no_destroy: ['module.net["a"].aws_vpc.main'] } })).toBe(false)
    expect(await sh.doneWhen({ plan_has: { no_destroy: ['module.net["b"].aws_vpc.main'] } })).toBe(true)
    expect(await sh.doneWhen({ plan_has: { no_destroy: ['module.net'] } })).toBe(false)
    await sh.run('terraform destroy -auto-approve', s, new Set())
    expect(await sh.doneWhen({ state_lacks: 'module.net["a"].aws_vpc.main' })).toBe(true)
    expect(await sh.doneWhen({ applied: { op: 'delete', address: 'module.net["a"]' } })).toBe(true)
  })
})

describe('keyed modules: scenario data', () => {
  const VPC = { id: 'vpc-1', cidr_block: '10.0.0.0/16', arn: 'arn:aws:ec2:us-east-1:123456789012:vpc/vpc-1', default_security_group_id: 'sg-1', enable_dns_hostnames: false, enable_dns_support: true }

  it('state entries and faults accept keyed module addresses; done_when predicates parse them', () => {
    const files = [{ path: 'main.tf', content: FE('["a"]') }, { path: 'modules/net/main.tf', content: NET }]
    const ok = TerraformSchema.safeParse({ files, ...installed, state: [{ module: 'module.net["a"]', type: 'aws_vpc', name: 'main', attrs: VPC }], faults: [{ at: 'module.net["a"].aws_vpc.main', on: 'delete', error: 'x' }] })
    expect(ok.error?.issues).toBeUndefined()
    expect(TerraformSchema.safeParse({ files, ...installed, faults: [{ at: 'module.net[a].aws_vpc.main', on: 'delete', error: 'x' }] }).success).toBe(false)
  })

  it('hand-built keyed state is read as the current instance by plan', async () => {
    const w = world(FE('["a"]'), { state: [{ module: 'module.net["a"]', type: 'aws_vpc', name: 'main', attrs: VPC }] })
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('No changes.')
    w.setRoot(FE('["a", "b"]'))
    expect(heads((await w.run('plan')).stdout)).toEqual(['  # module.net["b"].aws_vpc.main will be created'])
    w.setRoot(FE('[]'))
    expect((await w.run('plan')).stdout).toContain('(because module.net["a"] is not in configuration)')
  })

  it('a keyed state instance whose call became single-instance is orphaned with the module reason', async () => {
    const w = world('module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\n', { state: [{ module: 'module.net["a"]', type: 'aws_vpc', name: 'main', attrs: VPC }] })
    const plan = await w.run('plan')
    expect(plan.stdout).toContain('  # module.net["a"].aws_vpc.main will be destroyed\n  # (because module.net["a"] is not in configuration)')
    expect(plan.stdout).toContain('  # module.net.aws_vpc.main will be created')
  })

  it('a resource missing from a still-present module instance says so by resource', async () => {
    const w = world(FE('["a"]'), { state: [{ module: 'module.net["a"]', type: 'aws_vpc', name: 'old', attrs: VPC }] })
    expect((await w.run('plan')).stdout).toContain('  # module.net["a"].aws_vpc.old will be destroyed\n  # (because aws_vpc.old is not in configuration)')
  })

  it('proto-named module keys and calls stay safe', async () => {
    const root = 'module "__proto__" {\n  source   = "./modules/net"\n  for_each = toset(["__proto__", "constructor"])\n  cidr     = "10.0.0.0/16"\n}\noutput "o" {\n  value = module.__proto__["constructor"].vpc_id\n}\n'
    const w = world(root, { modules: { installed: [{ key: '__proto__', source: './modules/net', dir: 'modules/net' }] } })
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(await stateAddrs(w)).toEqual(['module.__proto__["__proto__"].aws_vpc.main', 'module.__proto__["constructor"].aws_vpc.main'])
    expect((await w.run('plan')).stdout).toContain('No changes.')
  })
})
