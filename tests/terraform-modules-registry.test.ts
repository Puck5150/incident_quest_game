import { describe, expect, it } from 'vitest'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import { loadModuleTree } from '../src/game/terraform/modules.ts'
import path from 'node:path'
import { loadContent } from '../vite-plugin-content.ts'
import { ScenarioSchema, TerraformSchema, type TerraformBlock } from '../src/schema/scenario.ts'

const LAB = '/home/you/infra'
const MODS = `${LAB}/.terraform/modules`
const root = (version: string | null = '~> 2.0', extra = '') =>
  `module "network" {\n  source  = "acme/network/aws"\n${version === null ? '' : `  version = "${version}"\n`}  cidr    = "10.0.0.0/16"\n}\n${extra}`
const net = (zone: string, extra = '') =>
  `variable "cidr" {\n  type = string\n}\n\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}\n\nresource "aws_subnet" "a" {\n  vpc_id            = aws_vpc.main.id\n  cidr_block        = "10.0.1.0/24"\n  availability_zone = "${zone}"\n}\n\noutput "vpc_id" {\n  value = aws_vpc.main.id\n}\n${extra}`
const ver = (version: string, zone: string, extra = '') => ({ version, files: [{ path: 'main.tf', content: net(zone, extra) }] })
const REGISTRY = [{ source: 'acme/network/aws', versions: [ver('2.0.1', 'us-east-1a'), ver('3.0.0', 'us-east-1c'), ver('2.1.0', 'us-east-1b'), ver('3.1.0-beta.1', 'us-east-1d'), ver('1.9.0', 'us-east-1a')] }]
const REG = 'registry.terraform.io/acme/network/aws'

function world(rootText: string, tf: Partial<TerraformBlock> = {}, disk0: Record<string, string> = {}) {
  const block = { files: [{ path: 'main.tf', content: rootText }], initialized: false, modules: { registry: REGISTRY }, ...tf } as TerraformBlock
  const lab = labFromScenario(block, LAB, '/home/you')
  const disk: Record<string, string> = {}
  for (const f of lab.files) disk[f.path] = f.content
  if (lab.initialized) disk[`${LAB}/.terraform.lock.hcl`] = LOCK_FILE
  Object.assign(disk, disk0)
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
  return { ctx, lab, disk, set: (path: string, text: string) => void (disk[`${LAB}/${path}`] = text), run: (...args: string[]) => runTerraform(args, ctx) }
}
const flat = (s: string) => s.replace(/\n│ /g, ' ')
const manifest = (w: { disk: Record<string, string> }) => JSON.parse(w.disk[`${MODS}/modules.json`]).Modules as { Key: string; Source: string; Version?: string; Dir: string }[]
const installedAt = (version: string) => ({ initialized: true, modules: { registry: REGISTRY, installed: [{ key: 'network', source: 'acme/network/aws', version }] } })

describe('registry modules: schema', () => {
  const base = { files: [{ path: 'main.tf', content: root() }], initialized: true }
  const scenario = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@'))!
  const parse = (modules: unknown) => TerraformSchema.safeParse({ ...base, modules })
  const msgs = (modules: unknown) => {
    const r = ScenarioSchema.safeParse({ ...structuredClone(scenario), terraform: { ...base, modules } })
    return r.success ? [] : r.error.issues.map((i) => i.message)
  }
  it('accepts a registry with an installed version', () => {
    expect(parse({ registry: REGISTRY, installed: [{ key: 'network', source: 'acme/network/aws', version: '2.0.1' }] }).success).toBe(true)
    expect(parse({ registry: [{ source: 'example.com/acme/network/aws', versions: [ver('1.0.0', 'a')] }] }).success).toBe(true)
  })
  it('rejects malformed sources, versions and files', () => {
    expect(parse({ registry: [{ source: 'acme/network', versions: [ver('1.0.0', 'a')] }] }).success).toBe(false)
    expect(parse({ registry: [{ source: './acme/network/aws', versions: [ver('1.0.0', 'a')] }] }).success).toBe(false)
    expect(parse({ registry: [{ source: 'acme/network/aws', versions: [ver('1.0', 'a')] }] }).success).toBe(false)
    expect(parse({ registry: [{ source: 'acme/network/aws', versions: [] }] }).success).toBe(false)
    expect(parse({ registry: [{ source: 'acme/network/aws', versions: [{ version: '1.0.0', files: [{ path: 'main.txt', content: '' }] }] }] }).success).toBe(false)
    expect(parse({ registry: [{ source: 'acme/network/aws', versions: [{ version: '1.0.0', files: [{ path: '../main.tf', content: '' }] }] }] }).success).toBe(false)
  })
  it('rejects duplicates and a missing top-level .tf', () => {
    expect(msgs({ registry: [{ source: 'acme/network/aws', versions: [ver('1.0.0', 'a')] }, { source: 'registry.terraform.io/acme/network/aws', versions: [ver('1.0.0', 'a')] }] })).toContain('duplicate registry module "registry.terraform.io/acme/network/aws"')
    expect(msgs({ registry: [{ source: 'acme/network/aws', versions: [ver('1.0.0', 'a'), ver('1.0.0', 'b')] }] })).toContain('duplicate version "1.0.0" of acme/network/aws')
    const dup = { version: '1.0.0', files: [{ path: 'a.tf', content: '' }, { path: 'a.tf', content: '' }] }
    expect(msgs({ registry: [{ source: 'acme/network/aws', versions: [dup] }] })).toContain('duplicate file "a.tf" in acme/network/aws 1.0.0')
    expect(msgs({ registry: [{ source: 'acme/network/aws', versions: [{ version: '1.0.0', files: [{ path: 'sub/a.tf', content: '' }] }] }] })).toContain('acme/network/aws 1.0.0 needs a .tf file at the top of the module')
  })
  it('cross-checks installed entries against the registry', () => {
    const inst = (o: object) => ({ registry: REGISTRY, installed: [{ key: 'network', source: 'acme/network/aws', ...o }] })
    expect(msgs(inst({ version: '9.9.9' }))).toContain('acme/network/aws has no version 9.9.9 in modules.registry')
    expect(msgs(inst({}))).toContain('a registry module needs the installed version')
    expect(msgs({ installed: [{ key: 'network', source: 'acme/network/aws', version: '2.0.1' }] })).toContain('acme/network/aws is not in modules.registry')
    expect(msgs(inst({ version: '2.0.1', dir: 'elsewhere' }))).toContain('a registry module is installed in .terraform/modules/network: leave dir out')
    expect(msgs({ installed: [{ key: 'net', source: './modules/net', dir: 'modules/net', version: '1.0.0' }] })).toContain('only a registry module has a version')
    expect(parse(inst({ version: '2.0.1', dir: '.terraform/modules/network' })).success).toBe(true)
  })
  it('__proto__ is a safe source, key and version name', () => {
    expect(parse({ registry: [{ source: '__proto__/__proto__/__proto__', versions: [ver('1.0.0', 'a')] }], installed: [{ key: '__proto__', source: '__proto__/__proto__/__proto__', version: '1.0.0' }] }).success).toBe(true)
  })
})

describe('registry modules: init', () => {
  it('first install picks the newest satisfying version, with the real hook lines, files and manifest', async () => {
    const w = world(root())
    const r = await w.run('init')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout.split('\n').slice(0, 6)).toEqual(['Initializing modules...', `Downloading ${REG} 2.1.0 for network...`, '- network in .terraform/modules/network', '', 'Initializing the backend...', ''])
    expect(w.disk[`${MODS}/network/main.tf`]).toBe(net('us-east-1b'))
    expect(manifest(w)).toEqual([
      { Key: '', Source: '', Dir: '.' },
      { Key: 'network', Source: REG, Version: '2.1.0', Dir: '.terraform/modules/network' },
    ])
    expect(w.disk[`${MODS}/modules.json`]).toBe(`{"Modules":[{"Key":"","Source":"","Dir":"."},{"Key":"network","Source":"${REG}","Version":"2.1.0","Dir":".terraform/modules/network"}]}`)
  })

  it('no version constraint installs the newest release, never a prerelease', async () => {
    const w = world(root(null))
    await w.run('init')
    expect(manifest(w)[1].Version).toBe('3.0.0')
    const pre = world(root('3.1.0-beta.1'))
    const r = await pre.run('init')
    expect(r.stdout).toContain(`Downloading ${REG} 3.1.0-beta.1 for network...`)
  })

  it('a plain init keeps an installed version that still satisfies: no download and no hook line', async () => {
    const w = world(root('~> 2.0'), installedAt('2.0.1'))
    const r = await w.run('init')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout.split('\n').slice(0, 3)).toEqual(['Initializing modules...', '', 'Initializing the backend...'])
    expect(manifest(w)[1].Version).toBe('2.0.1')
    expect(w.disk[`${MODS}/network/main.tf`]).toContain('us-east-1a')
  })

  it('init -upgrade re-resolves to the newest satisfying version', async () => {
    const w = world(root('~> 2.0'), installedAt('2.0.1'))
    const r = await w.run('init', '-upgrade')
    expect(r.stdout.split('\n').slice(0, 4)).toEqual(['Upgrading modules...', `Downloading ${REG} 2.1.0 for network...`, '- network in .terraform/modules/network', ''])
    expect(manifest(w)[1].Version).toBe('2.1.0')
    expect(w.disk[`${MODS}/network/main.tf`]).toContain('us-east-1b')
    // already newest: re-resolved, but the download still happens (-upgrade replaces every module)
    expect((await w.run('init', '-upgrade')).stdout).toContain(`Downloading ${REG} 2.1.0 for network...`)
  })

  it('terraform get installs, and get -update upgrades; both print only the hook lines', async () => {
    const w = world(root('~> 2.0'), installedAt('2.0.1'))
    expect(await w.run('get')).toMatchObject({ exitCode: 0, stdout: '' })
    const r = await w.run('get', '-update')
    expect([r.exitCode, r.stdout]).toEqual([0, `Downloading ${REG} 2.1.0 for network...\n- network in .terraform/modules/network`])
    const fresh = world(root('~> 2.0'))
    expect((await fresh.run('get')).stdout).toBe(`Downloading ${REG} 2.1.0 for network...\n- network in .terraform/modules/network`)
  })

  it('an installed version that stops satisfying is replaced by a plain init', async () => {
    const w = world(root('~> 2.1'), installedAt('2.0.1'))
    const r = await w.run('init')
    expect(r.stdout).toContain(`Downloading ${REG} 2.1.0 for network...`)
    expect(manifest(w)[1].Version).toBe('2.1.0')
  })

  it('a file only the old version had is emptied on upgrade', async () => {
    const old = { version: '1.0.0', files: [{ path: 'main.tf', content: net('a') }, { path: 'extra.tf', content: 'output "x" {\n  value = 1\n}\n' }] }
    const w = world(root('~> 1.0'), { initialized: true, modules: { registry: [{ source: 'acme/network/aws', versions: [old, ver('1.1.0', 'b')] }], installed: [{ key: 'network', source: 'acme/network/aws', version: '1.0.0' }] } })
    expect(w.disk[`${MODS}/network/extra.tf`]).toContain('output "x"')
    await w.run('init', '-upgrade')
    expect(w.disk[`${MODS}/network/extra.tf`]).toBe('')
    expect(manifest(w)[1].Version).toBe('1.1.0')
  })
})

describe('registry modules: errors', () => {
  it('no authored version satisfies: Unresolvable module version constraint, nothing written', async () => {
    const w = world(root('~> 4.0'))
    const r = await w.run('init')
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toBe('Initializing modules...')
    expect(r.stderr).toContain('Error: Unresolvable module version constraint')
    expect(r.stderr).toContain('on main.tf line 1, in module "network":')
    expect(flat(r.stderr)).toContain(`There is no available version of module "${REG}" (main.tf:1) which matches the given version constraint. The newest available version is 3.0.0.`)
    expect(w.disk[`${MODS}/modules.json`]).toBeUndefined()
  })

  it('an unknown registry source is Module not found, naming the host', async () => {
    const w = world('module "x" {\n  source = "other/thing/aws"\n}\n')
    const r = await w.run('init')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Error: Module not found')
    expect(flat(r.stderr)).toContain('Module "x" (from main.tf:1) cannot be found in the module registry at registry.terraform.io.')
    const host = world('module "x" {\n  source = "example.com/other/thing/aws"\n}\n')
    expect(flat((await host.run('init')).stderr)).toContain('cannot be found in the module registry at example.com.')
  })

  it('a version constraint on a local source is Invalid version constraint at init', async () => {
    const w = world('module "net" {\n  source  = "./modules/net"\n  version = "1.0.0"\n}\n', { files: [{ path: 'main.tf', content: 'module "net" {\n  source  = "./modules/net"\n  version = "1.0.0"\n}\n' }, { path: 'modules/net/main.tf', content: 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n' }] })
    for (const cmd of ['init', 'get']) {
      const r = await w.run(cmd)
      expect(r.exitCode, cmd).toBe(1)
      expect(r.stderr, cmd).toContain('Error: Invalid version constraint')
      expect(flat(r.stderr), cmd).toContain('Cannot apply a version constraint to module "net" (at main.tf:1) because it has a relative local path.')
    }
  })

  it('a malformed version string is Invalid version constraint at the version line, for every command', async () => {
    const w = world(root('latest'))
    for (const cmd of ['init', 'validate', 'plan']) {
      const r = await w.run(cmd)
      expect(r.exitCode, cmd).toBe(1)
      expect(r.stderr, cmd).toContain('Error: Invalid version constraint')
      expect(r.stderr, cmd).toContain('on main.tf line 3, in module "network":')
      expect(flat(r.stderr), cmd).toContain('This string does not use correct version constraint syntax.')
    }
  })

  it('validate and plan before init: Module not installed; after a bumped constraint: version requirements have changed', async () => {
    const w = world(root('~> 2.0'))
    expect((await w.run('validate')).stderr).toContain('Error: Module not installed')
    await w.run('init')
    expect((await w.run('validate')).exitCode).toBe(0)
    w.set('main.tf', root('~> 3.0'))
    for (const cmd of ['validate', 'plan', 'apply']) {
      const r = await w.run(cmd)
      expect(r.exitCode, cmd).toBe(1)
      expect(r.stderr, cmd).toContain('Error: Module version requirements have changed')
      expect(r.stderr, cmd).toContain('on main.tf line 2, in module "network":')
      expect(flat(r.stderr), cmd).toContain('The version requirements have changed since this module was installed and the installed version (2.1.0) is no longer acceptable. Run "terraform init" to install all modules required by this configuration.')
    }
    await w.run('init')
    expect((await w.run('validate')).exitCode).toBe(0)
    expect(manifest(w)[1].Version).toBe('3.0.0')
  })

  it('a recorded module without a version, once a constraint appears, uses the variant without the version', async () => {
    const w = world(root('~> 2.0'), { initialized: true }, { [`${MODS}/modules.json`]: `{"Modules":[{"Key":"","Source":"","Dir":"."},{"Key":"network","Source":"${REG}","Dir":".terraform/modules/network"}]}`, [`${MODS}/network/main.tf`]: net('a') })
    expect(flat((await w.run('validate')).stderr)).toContain('the installed version is no longer acceptable.')
  })

  it('a changed source reports Module source has changed', async () => {
    const w = world(root('~> 2.0'), installedAt('2.0.1'))
    w.set('main.tf', root('~> 2.0').replace('acme/network/aws', 'acme/other/aws'))
    const err = (await w.run('validate')).stderr
    expect(err).toContain('Error: Module source has changed')
    expect(err).toContain('on main.tf line 2, in module "network":')
  })
})

describe('registry modules: plan and apply', () => {
  it('create, then state lists module addresses', async () => {
    const w = world(root('~> 2.0', 'output "v" {\n  value = module.network.vpc_id\n}\n'))
    await w.run('init')
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('# module.network.aws_vpc.main will be created')
    expect(plan.stdout).toMatch(/\+ availability_zone\s+= "us-east-1b"/)
    expect(plan.stdout).toContain('Plan: 2 to add, 0 to change, 0 to destroy.')
    const apply = await w.run('apply', '-auto-approve')
    expect(apply.exitCode, apply.stderr).toBe(0)
    expect((await w.run('state', 'list')).stdout.split('\n')).toEqual(['module.network.aws_subnet.a', 'module.network.aws_vpc.main'])
    expect(w.ctx.lab.state.resources.map((r) => r.module)).toEqual(['module.network', 'module.network'])
  })

  it('module upgrade changes the plan: bump the constraint, init, replacement', async () => {
    const w = world(root('~> 2.0'), installedAt('2.0.1'))
    await w.run('init') // keeps 2.0.1
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    expect((await w.run('plan')).stdout).toContain('No changes.')
    w.set('main.tf', root('~> 2.1'))
    const err = await w.run('plan')
    expect(err.exitCode).toBe(1)
    expect(err.stderr).toContain('Error: Module version requirements have changed')
    expect(flat(err.stderr)).toContain('installed version (2.0.1) is no longer acceptable')
    const init = await w.run('init') // no -upgrade: 2.0.1 no longer satisfies
    expect(init.stdout).toContain(`Downloading ${REG} 2.1.0 for network...`)
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('# module.network.aws_subnet.a must be replaced')
    expect(plan.stdout).toMatch(/~ availability_zone\s+= "us-east-1a" -> "us-east-1b" # forces replacement/)
    expect(plan.stdout).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
  })

  it('when the constraint allows both versions, plain init keeps the old one and only -upgrade moves', async () => {
    const w = world(root('~> 2.0'), installedAt('2.0.1'))
    await w.run('apply', '-auto-approve')
    await w.run('init')
    expect((await w.run('plan')).stdout).toContain('No changes.')
    await w.run('init', '-upgrade')
    const plan = await w.run('plan')
    expect(plan.stdout).toContain('# forces replacement')
    expect(plan.stdout).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
  })

  it('a scenario starting with a registry module installed mounts its files and manifest', () => {
    const w = world(root('~> 2.0'), installedAt('2.0.1'))
    expect(w.disk[`${MODS}/network/main.tf`]).toBe(net('us-east-1a'))
    expect(manifest(w)).toEqual([{ Key: '', Source: '', Dir: '.' }, { Key: 'network', Source: REG, Version: '2.0.1', Dir: '.terraform/modules/network' }])
  })

  it('keyed instances of a registry module', async () => {
    const text = `module "network" {\n  source   = "acme/network/aws"\n  version  = "~> 2.0"\n  for_each = toset(["a", "b"])\n  cidr     = "10.0.0.0/16"\n}\n`
    const w = world(text)
    await w.run('init')
    const plan = await w.run('plan')
    expect(plan.stdout).toContain('# module.network["a"].aws_vpc.main will be created')
    expect(plan.stdout).toContain('# module.network["b"].aws_subnet.a will be created')
    expect(plan.stdout).toContain('Plan: 4 to add')
  })
})

describe('registry modules: nesting', () => {
  const reg2 = [
    { source: 'acme/outer/aws', versions: [{ version: '1.0.0', files: [{ path: 'main.tf', content: 'module "inner" {\n  source  = "acme/network/aws"\n  version = "~> 2.0"\n  cidr    = "10.1.0.0/16"\n}\n\nmodule "local" {\n  source = "./sub"\n}\n' }, { path: 'sub/main.tf', content: 'resource "aws_s3_bucket" "b" {\n  bucket = "sub-bucket"\n}\n' }] }] },
    ...REGISTRY,
  ]
  const text = 'module "outer" {\n  source  = "acme/outer/aws"\n  version = "1.0.0"\n}\n'

  it('registry to registry and a local call inside a registry module resolve under their install dirs', async () => {
    const w = world(text, { modules: { registry: reg2 } })
    const r = await w.run('init')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout.split('\n').slice(0, 8)).toEqual([
      'Initializing modules...',
      `Downloading registry.terraform.io/acme/outer/aws 1.0.0 for outer...`,
      '- outer in .terraform/modules/outer',
      `Downloading ${REG} 2.1.0 for outer.inner...`,
      '- outer.inner in .terraform/modules/outer.inner',
      '- outer.local in .terraform/modules/outer/sub',
      '',
      'Initializing the backend...',
    ])
    expect(manifest(w).map((m) => [m.Key, m.Version ?? null, m.Dir])).toEqual([
      ['', null, '.'],
      ['outer', '1.0.0', '.terraform/modules/outer'],
      ['outer.inner', '2.1.0', '.terraform/modules/outer.inner'],
      ['outer.local', null, '.terraform/modules/outer/sub'],
    ])
    expect(w.disk[`${MODS}/outer/sub/main.tf`]).toContain('sub-bucket')
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('# module.outer.module.inner.aws_vpc.main will be created')
    expect(plan.stdout).toContain('# module.outer.module.local.aws_s3_bucket.b will be created')
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    expect((await w.run('state', 'list')).stdout).toContain('module.outer.module.inner.aws_subnet.a')
  })

  it('an inner module bumped in the outer version is re-resolved with its own constraint', async () => {
    const w = world(text, { modules: { registry: reg2 } })
    await w.run('init')
    const bumped = reg2.map((r) => (r.source === 'acme/outer/aws' ? { ...r, versions: [...r.versions, { version: '1.1.0', files: [{ path: 'main.tf', content: r.versions[0].files[0].content.replace('~> 2.0', '~> 3.0') }, r.versions[0].files[1]] }] } : r))
    const w2 = world(text.replace('1.0.0', '1.1.0'), { modules: { registry: bumped } }, { ...w.disk, [`${LAB}/main.tf`]: text.replace('1.0.0', '1.1.0') })
    expect((await w2.run('validate')).stderr).toContain('Module version requirements have changed')
    const r = await w2.run('init')
    expect(r.stdout).toContain('Downloading registry.terraform.io/acme/outer/aws 1.1.0 for outer...')
    expect(r.stdout).toContain(`Downloading ${REG} 3.0.0 for outer.inner...`)
  })

  it('loader: __proto__ call names and module sources are safe', async () => {
    const reader = async (dir: string) => (dir === '.terraform/modules/__proto__' ? [] : [])
    const m = await loadModuleTree([{ name: 'main.tf', text: 'module "__proto__" {\n  source = "__proto__/__proto__/__proto__"\n  version = ">= 1.0"\n}\n' }], reader, undefined, true, {
      registry: [{ source: 'registry.terraform.io/__proto__/__proto__/__proto__', versions: [{ version: '1.0.0', files: [{ path: 'main.tf', content: 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n' }] }] }],
    })
    expect(m.install).toEqual([])
    expect(m.entries).toEqual([{ key: '__proto__', source: 'registry.terraform.io/__proto__/__proto__/__proto__', dir: '.terraform/modules/__proto__', version: '1.0.0' }])
    expect(m.downloads.map((d) => d.dir)).toEqual(['.terraform/modules/__proto__'])
  })
})
