import { describe, expect, it } from 'vitest'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import { lockFile } from '../src/game/terraform/layout.ts'
import { loadModuleTree } from '../src/game/terraform/modules.ts'
import { coreDiagnostics, modulesOf, mountedLock, parseLock, providerNeeds } from '../src/game/terraform/providers.ts'
import { TerraformSchema, type TerraformBlock } from '../src/schema/scenario.ts'

const LAB = '/home/you/infra'
const LOCK = `${LAB}/.terraform.lock.hcl`
const AWS = 'registry.terraform.io/hashicorp/aws'
const VPC = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const req = (version: string | null, extra = '') =>
  `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n${version === null ? '' : `      version = "${version}"\n`}    }\n  }\n${extra}}\n\n${VPC}`
const AVAIL = ['5.31.0', '5.50.0', '5.67.0']
const PROV = { providers: { aws: { lock: '5.31.0', available: AVAIL } } }

function world(files: string | Record<string, string>, tf: Partial<TerraformBlock> = {}, disk0: Record<string, string> = {}) {
  const list = typeof files === 'string' ? { 'main.tf': files } : files
  const block = { files: Object.entries(list).map(([path, content]) => ({ path, content })), ...tf } as TerraformBlock
  const lab = labFromScenario(block, LAB, '/home/you')
  const disk: Record<string, string> = {}
  for (const f of lab.files) disk[f.path] = f.content
  if (lab.initialized) disk[LOCK] = mountedLock(block, lab.files)
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
  return { ctx, lab, disk, set: (p: string, text: string) => void (disk[`${LAB}/${p}`] = text), run: (...args: string[]) => runTerraform(args, ctx) }
}
const flat = (s: string) => s.replace(/\n│ /g, ' ')
const HASH = (v: string) => (v === '5.67.0' ? 'h1:Zq0uB8Zc1nS5eYpR3m7KpTz2W0k6YV3d8J4bN1xQwLs=' : expect.stringMatching(/^h1:[A-Za-z0-9+/]{43}=$/))

describe('lock file text', () => {
  it('without constraints is unchanged', () => {
    expect(LOCK_FILE).toBe(`# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\nprovider "${AWS}" {\n  version = "5.67.0"\n  hashes = [\n    "h1:Zq0uB8Zc1nS5eYpR3m7KpTz2W0k6YV3d8J4bN1xQwLs=",\n  ]\n}\n`)
    expect(world(VPC).disk[LOCK]).toBe(LOCK_FILE)
  })
  it('with constraints has the aligned constraints line and deterministic hashes', () => {
    const text = world(req('~> 5.0'), PROV).disk[LOCK]
    const hash = /"(h1:[^"]+)"/.exec(text)![1]
    expect(text).toBe(`# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\nprovider "${AWS}" {\n  version     = "5.31.0"\n  constraints = "~> 5.0"\n  hashes = [\n    "${hash}",\n  ]\n}\n`)
    expect(hash).not.toBe('h1:Zq0uB8Zc1nS5eYpR3m7KpTz2W0k6YV3d8J4bN1xQwLs=')
    expect(world(req('~> 5.0'), PROV).disk[LOCK]).toBe(text)
    expect(lockFile([{ source: AWS, version: '5.50.0' }])).not.toContain(hash)
  })
  it('default version keeps the default hash even with a constraint', () => {
    expect(world(req('~> 5.0')).disk[LOCK]).toBe(`${LOCK_FILE.replace('version = "5.67.0"', 'version     = "5.67.0"\n  constraints = "~> 5.0"')}`)
  })
  it('mounts the newest authored version that meets the constraints when no lock is given', () => {
    expect(world(req('~> 5.40, < 5.60'), { providers: { aws: { available: AVAIL } } }).disk[LOCK]).toContain('version     = "5.50.0"')
  })
  it('parseLock reads versions, constraints and hashes', () => {
    const e = parseLock(world(req('~> 5.0'), PROV).disk[LOCK]).get(AWS)!
    expect(e).toMatchObject({ version: '5.31.0', constraints: '~> 5.0' })
    expect(e.hashes).toHaveLength(1)
  })
})

describe('requirement collection', () => {
  it('combines root, local child and registry module constraints per provider', async () => {
    const files = {
      'main.tf': `${req('~> 5.0')}module "net" {\n  source = "./modules/net"\n}\nmodule "reg" {\n  source = "acme/network/aws"\n}\n`,
      'modules/net/main.tf': 'terraform {\n  required_providers {\n    aws = {\n      version = ">= 5.40"\n    }\n    random = {\n      source  = "hashicorp/random"\n      version = "~> 3.5"\n    }\n  }\n}\n',
    }
    const dirs: Record<string, { name: string; text: string }[]> = {
      '': Object.entries(files).filter(([p]) => !p.includes('/')).map(([name, text]) => ({ name, text })),
      'modules/net': [{ name: 'main.tf', text: files['modules/net/main.tf'] }],
    }
    const registry = [{ source: 'registry.terraform.io/acme/network/aws', versions: [{ version: '2.0.0', files: [{ path: 'main.tf', content: 'terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = ">= 5.40" }\n  }\n}\n' }] }] }]
    const m = await loadModuleTree(dirs[''], async (d) => dirs[d] ?? [], undefined, true, { registry })
    expect(m.install).toEqual([])
    const { needs, diagnostics } = providerNeeds(modulesOf(m.tree), [])
    expect(diagnostics).toEqual([])
    expect(needs).toEqual([
      { source: AWS, constraints: '~> 5.0, >= 5.40' },
      { source: 'registry.terraform.io/hashicorp/random', constraints: '~> 3.5' },
    ])
  })
  it('handles the legacy string form, a host address and __proto__ names', () => {
    const text = 'terraform {\n  required_providers {\n    aws = ">= 4.0"\n    __proto__ = { source = "example.com/acme/__proto__", version = "1.0.0" }\n    other = { source = "hashicorp/other" }\n  }\n}\n'
    const { needs } = providerNeeds([{ key: '', files: [{ name: 'main.tf', text }] }], [])
    expect(needs).toEqual([
      { source: 'example.com/acme/__proto__', constraints: '1.0.0' },
      { source: AWS, constraints: '>= 4.0' },
      { source: 'registry.terraform.io/hashicorp/other', constraints: '' },
    ])
  })
})

describe('Inconsistent dependency lock file', () => {
  it('names the updated constraints when the lock recorded different ones, then the lock-equal form after init records them', async () => {
    const w = world(req('~> 5.50'), PROV, { [LOCK]: world(req('~> 5.0'), PROV).disk[LOCK] })
    const r = await w.run('plan')
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr.startsWith('╷\n│ Error: Inconsistent dependency lock file\n│ \n')).toBe(true)
    expect(r.stderr).toContain(`│   - provider ${AWS}: locked version selection 5.31.0 doesn't match the updated version constraints "~> 5.50"\n│ \n`)
    expect(flat(r.stderr)).toContain('To update the locked dependency selections to match a changed configuration, run:   terraform init -upgrade')
    const same = world(req('~> 5.50'), PROV, { [LOCK]: world(req('~> 5.50'), PROV).disk[LOCK] })
    expect((await same.run('plan')).stderr).toContain(`provider ${AWS}: version constraints "~> 5.50" don't match the locked version selection 5.31.0`)
  })
  it('stops plan, apply, destroy, refresh and import with exit 1; validate and state commands do not check versions', async () => {
    const w = world(req('~> 5.50'), PROV, { [LOCK]: world(req('~> 5.0'), PROV).disk[LOCK] })
    for (const args of [['plan'], ['apply', '-auto-approve'], ['destroy', '-auto-approve'], ['refresh'], ['import', 'aws_vpc.main', 'vpc-1']]) {
      const r = await w.run(...args)
      expect([args[0], r.exitCode]).toEqual([args[0], 1])
      expect(r.stderr).toContain('Error: Inconsistent dependency lock file')
    }
    // Real `terraform validate` never calls VerifyDependencySelections (backend_local does, for operations).
    expect((await w.run('validate')).exitCode).toBe(0)
    expect((await w.run('state', 'list')).stderr).not.toContain('Inconsistent')
  })
  it('a satisfied lock plans normally', async () => {
    const w = world(req('~> 5.0'), PROV)
    const r = await w.run('plan')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('1 to add')
  })
  it('lists a missing entry and a mismatch together, sorted, with the -upgrade suggestion once the lock is not empty', async () => {
    const two = `terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 5.50" }\n  }\n}\n${VPC}resource "random_id" "x" {\n  byte_length = 4\n}\n`
    const r = await world(two, PROV, { [LOCK]: world(req('~> 5.0'), PROV).disk[LOCK] }).run('plan')
    expect(r.stderr).toContain(`  - provider ${AWS}: locked version selection 5.31.0 doesn't match the updated version constraints "~> 5.50"\n│   - provider registry.terraform.io/hashicorp/random: required by this configuration but no version is selected`)
    expect(r.stderr).toContain('terraform init -upgrade')
    const empty = await world(VPC, {}, { [LOCK]: '' }).run('plan')
    expect(flat(empty.stderr)).toContain('To make the initial dependency selections that will initialize the dependency lock file, run:   terraform init')
  })
  it('a constraint in a registry module makes the existing lock inconsistent; init -upgrade fixes it', async () => {
    const reg = (v: string, c: string) => ({ version: v, files: [{ path: 'main.tf', content: `terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "${c}" }\n  }\n}\n\nresource "aws_subnet" "a" {\n  vpc_id     = "vpc-1"\n  cidr_block = "10.0.1.0/24"\n}\n` }] })
    const modules = { registry: [{ source: 'acme/network/aws', versions: [reg('2.0.0', '~> 5.0'), reg('2.1.0', '~> 5.50')] }] }
    const root = 'module "network" {\n  source  = "acme/network/aws"\n  version = "~> 2.0"\n}\n'
    const w = world(root, { ...PROV, initialized: true, modules: { ...modules, installed: [{ key: 'network', source: 'acme/network/aws', version: '2.0.0' }] } })
    expect(w.disk[LOCK]).toContain('constraints = "~> 5.0"')
    expect((await w.run('plan')).exitCode).toBe(0)
    // A plain init keeps module 2.0.0 and its lock.
    const plain = await w.run('init')
    expect(plain.stdout).toContain('- Reusing previous version of hashicorp/aws from the dependency lock file')
    expect(plain.stdout).toContain('- Using previously-installed hashicorp/aws v5.31.0')
    const up = await w.run('init', '-upgrade')
    expect(up.exitCode).toBe(0)
    expect(up.stdout).toContain('Upgrading modules...')
    expect(up.stdout).toContain('Downloading registry.terraform.io/acme/network/aws 2.1.0 for network...')
    expect(up.stdout).toContain('- Finding hashicorp/aws versions matching "~> 5.50"...')
    expect(up.stdout).toContain('- Installing hashicorp/aws v5.67.0...')
    expect(parseLock(w.disk[LOCK]).get(AWS)).toMatchObject({ version: '5.67.0', constraints: '~> 5.50' })
    expect((await w.run('plan')).exitCode).toBe(0)
  })
  it('the module upgrade by itself (get -update) leaves the lock inconsistent for plan', async () => {
    const reg = (v: string, c: string) => ({ version: v, files: [{ path: 'main.tf', content: `terraform {\n  required_providers {\n    aws = { version = "${c}" }\n  }\n}\n\nresource "aws_subnet" "a" {\n  vpc_id     = "vpc-1"\n  cidr_block = "10.0.1.0/24"\n}\n` }] })
    const modules = { registry: [{ source: 'acme/network/aws', versions: [reg('2.0.0', '~> 5.0'), reg('2.1.0', '~> 5.50')] }] }
    const w = world('module "network" {\n  source  = "acme/network/aws"\n  version = "~> 2.0"\n}\n', { ...PROV, modules: { ...modules, installed: [{ key: 'network', source: 'acme/network/aws', version: '2.0.0' }] } })
    expect((await w.run('get', '-update')).exitCode).toBe(0)
    const r = await w.run('plan')
    expect(r.stderr).toContain(`provider ${AWS}: locked version selection 5.31.0 doesn't match the updated version constraints "~> 5.50"`)
  })
})

describe('terraform init and the lock', () => {
  it('first init picks the newest available version that meets the constraints', async () => {
    const w = world(req('~> 5.40, < 5.60'), { initialized: false, providers: { aws: { available: AVAIL } } })
    const r = await w.run('init')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('- Finding hashicorp/aws versions matching "~> 5.40, < 5.60"...\n- Installing hashicorp/aws v5.50.0...\n- Installed hashicorp/aws v5.50.0 (signed by HashiCorp)')
    expect(r.stdout).toContain('Terraform has created a lock file .terraform.lock.hcl')
    expect(w.disk[LOCK]).toContain('version     = "5.50.0"\n  constraints = "~> 5.40, < 5.60"')
    expect((await w.run('version')).stdout).toBe(`Terraform v1.9.8\non linux_amd64\n+ provider ${AWS} v5.50.0`)
  })
  it('default scenarios init exactly as before', async () => {
    const w = world(VPC, { initialized: false })
    const r = await w.run('init')
    expect(r.stdout).toContain('- Finding latest version of hashicorp/aws...\n- Installing hashicorp/aws v5.67.0...\n- Installed hashicorp/aws v5.67.0 (signed by HashiCorp)')
    expect(w.disk[LOCK]).toBe(LOCK_FILE)
    const again = await w.run('init')
    expect(again.stdout).toContain('- Reusing previous version of hashicorp/aws from the dependency lock file\n- Using previously-installed hashicorp/aws v5.67.0')
    expect(again.stdout).not.toContain('made some changes')
  })
  it('reuses a satisfied lock without rewriting it, and records changed constraints silently', async () => {
    const w = world(req('~> 5.0'), PROV)
    const before = w.disk[LOCK]
    const r = await w.run('init')
    expect(r.stdout).toContain('- Reusing previous version of hashicorp/aws from the dependency lock file\n- Using previously-installed hashicorp/aws v5.31.0')
    expect(w.disk[LOCK]).toBe(before)
    w.set('main.tf', req('>= 5.20'))
    const r2 = await w.run('init')
    expect(r2.stdout).not.toContain('made some changes')
    expect(parseLock(w.disk[LOCK]).get(AWS)).toMatchObject({ version: '5.31.0', constraints: '>= 5.20' })
    expect(parseLock(w.disk[LOCK]).get(AWS)!.hashes).toEqual(parseLock(before).get(AWS)!.hashes)
  })
  it('a lock that pins a version the constraints no longer allow fails with the installer error', async () => {
    const w = world(req('~> 5.50'), PROV)
    const r = await w.run('init')
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('Initializing provider plugins...')
    expect(r.stdout).not.toContain('successfully initialized')
    expect(r.stderr.split('\n')[1]).toBe('│ Error: Failed to query available provider packages')
    expect(flat(r.stderr)).toContain(`Could not retrieve the list of available versions for provider hashicorp/aws: locked provider ${AWS} 5.31.0 does not match configured version constraint ~> 5.50; must use terraform init -upgrade to allow selection of new versions`)
    expect(parseLock(w.disk[LOCK]).get(AWS)!.version).toBe('5.31.0')
  })
  it('init -upgrade selects the newest satisfying version and rewrites the lock', async () => {
    const w = world(req('~> 5.50'), PROV)
    const r = await w.run('init', '-upgrade')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('- Finding hashicorp/aws versions matching "~> 5.50"...\n- Installing hashicorp/aws v5.67.0...\n- Installed hashicorp/aws v5.67.0 (signed by HashiCorp)')
    expect(r.stdout).toContain('Terraform has made some changes to the provider dependency selections recorded\nin the .terraform.lock.hcl file.')
    expect(w.disk[LOCK]).toContain(`version     = "5.67.0"\n  constraints = "~> 5.50"\n  hashes = [\n    "${HASH('5.67.0')}",`)
    expect((await w.run('plan')).exitCode).toBe(0)
    expect((await w.run('version')).stdout).toContain(`+ provider ${AWS} v5.67.0`)
  })
  it('init -upgrade with the same version available says nothing about changes', async () => {
    const w = world(req('~> 5.0'), { providers: { aws: { lock: '5.67.0', available: AVAIL } } })
    const r = await w.run('init', '-upgrade')
    expect(r.stdout).toContain('- Finding hashicorp/aws versions matching "~> 5.0"...\n- Using previously-installed hashicorp/aws v5.67.0')
    expect(r.stdout).not.toContain('made some changes')
  })
  it('no available release matching is an installer error', async () => {
    const w = world(req('~> 9.0'), PROV)
    for (const args of [['init', '-upgrade'], ['init']]) {
      const r = await w.run(...args)
      expect(r.exitCode).toBe(1)
      expect(flat(r.stderr)).toContain(args.length > 1 ? 'Failed to query available provider packages' : 'locked provider')
    }
    const r = await w.run('init', '-upgrade')
    expect(flat(r.stderr)).toContain('Could not retrieve the list of available versions for provider hashicorp/aws: no available releases match the given constraints ~> 9.0')
    expect(parseLock(w.disk[LOCK]).get(AWS)!.version).toBe('5.31.0')
    const fresh = world(req('~> 9.0'), { initialized: false })
    const f = await fresh.run('init')
    expect(f.exitCode).toBe(1)
    expect(flat(f.stderr)).toContain('no available releases match the given constraints ~> 9.0')
    expect(fresh.disk[LOCK]).toBeUndefined()
  })
  it('-lockfile=readonly: fine when the lock covers the providers, an error when it needs a change', async () => {
    const ok = world(req('~> 5.0'), PROV)
    const r = await ok.run('init', '-lockfile=readonly')
    expect(r.exitCode).toBe(0)
    const none = world(VPC, { initialized: false })
    const bad = await none.run('init', '-lockfile=readonly')
    expect(bad.exitCode).toBe(1)
    expect(bad.stdout).toContain('- Installing hashicorp/aws v5.67.0...')
    expect(bad.stdout).not.toContain('successfully initialized')
    expect(bad.stderr.split('\n')[1]).toBe('│ Error: Provider dependency changes detected')
    expect(flat(bad.stderr)).toContain('Changes to the required provider dependencies were detected, but the lock file is read-only. To use and record these requirements, run "terraform init" without the "-lockfile=readonly" flag.')
    expect(none.disk[LOCK]).toBeUndefined()
    const missing = world(`${VPC}resource "random_id" "x" {\n  byte_length = 4\n}\n`)
    expect((await missing.run('init', '-lockfile=readonly')).stderr).toContain('Provider dependency changes detected')
    expect(missing.disk[LOCK]).toBe(LOCK_FILE)
  })
  it('-upgrade conflicts with -lockfile=readonly', async () => {
    const r = await world(VPC).run('init', '-upgrade', '-lockfile=readonly')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toBe('╷\n│ Error: The -upgrade flag conflicts with -lockfile=readonly.\n╵')
  })
  it('a constraint that is not valid is reported by init and plan', async () => {
    const w = world(req('~> five'))
    for (const sub of ['init', 'plan', 'validate']) {
      const r = await w.run(sub)
      expect([sub, r.exitCode]).toEqual([sub, 1])
      expect(r.stderr).toContain('Error: Invalid version constraint')
      expect(r.stderr).toContain('This string does not use correct version constraint syntax.')
    }
  })
  it('__proto__ provider names do not break init or plan', async () => {
    const text = `terraform {\n  required_providers {\n    __proto__ = { source = "example.com/acme/__proto__", version = "1.0.0" }\n  }\n}\n${VPC}`
    const w = world(text, { initialized: false, providers: {} })
    const r = await w.run('init')
    expect(r.exitCode).toBe(1)
    expect(flat(r.stderr)).toContain('provider example.com/acme/__proto__: no available releases match the given constraints 1.0.0')
    expect((await world(text).run('plan')).stderr).toContain('provider example.com/acme/__proto__: required by this configuration but no version is selected')
  })
})

describe('required_version', () => {
  const rv = (c: string) => `terraform {\n  required_version = "${c}"\n}\n\n${VPC}`
  const DETAIL = 'does not support Terraform version 1.9.8. To proceed, either choose another supported Terraform version or update this version constraint. Version constraints are normally set for good reason, so updating the constraint may lead to other errors or unexpected behavior.'
  it('a root constraint the lab version fails stops init, validate, plan, apply, destroy, refresh and import', async () => {
    const w = world(rv('>= 1.10'))
    for (const args of [['init'], ['validate'], ['plan'], ['apply', '-auto-approve'], ['destroy', '-auto-approve'], ['refresh'], ['import', 'aws_vpc.main', 'vpc-1']]) {
      const r = await w.run(...args)
      expect([args[0], r.exitCode]).toEqual([args[0], 1])
      expect(r.stderr.split('\n').slice(0, 5)).toEqual(['╷', '│ Error: Unsupported Terraform Core version', '│ ', '│   on main.tf line 2, in terraform:', '│    2:   required_version = ">= 1.10"'])
      expect(flat(r.stderr)).toContain(`This configuration ${DETAIL}`)
    }
  })
  it('passes when the lab version satisfies it, and follows Lab.version', async () => {
    expect((await world(rv('>= 1.5, < 2.0')).run('validate')).exitCode).toBe(0)
    expect((await world(rv('>= 1.10'), { version: '1.10.2' }).run('validate')).exitCode).toBe(0)
    expect(flat((await world(rv('~> 1.9.0'), { version: '1.10.2' }).run('validate')).stderr)).toContain('does not support Terraform version 1.10.2.')
  })
  it('a child and a registry module name the module and its source', async () => {
    const child = (c: string) => `terraform {\n  required_version = "${c}"\n}\n${VPC}`
    const w = world({ 'main.tf': 'module "net" {\n  source = "./modules/net"\n}\n', 'modules/net/main.tf': child('>= 2.0') }, { initialized: false })
    const init = await w.run('init')
    expect(init.exitCode).toBe(1)
    expect(init.stderr).toContain('on modules/net/main.tf line 2, in terraform:')
    expect(flat(init.stderr)).toContain(`Module module.net (from ./modules/net) ${DETAIL}`)

    const modules = { registry: [{ source: 'acme/network/aws', versions: [{ version: '1.0.0', files: [{ path: 'main.tf', content: child('>= 2.0') }] }] }] }
    const reg = world('module "network" {\n  source = "acme/network/aws"\n}\n', { initialized: false, modules })
    const r = await reg.run('init')
    expect(r.exitCode).toBe(1)
    expect(flat(r.stderr)).toContain(`Module module.network (from registry.terraform.io/acme/network/aws) ${DETAIL}`)
    expect(r.stderr).toContain('on .terraform/modules/network/main.tf line 2, in terraform:')
  })
  it('nested modules print the full module path', async () => {
    const w = world(
      { 'main.tf': 'module "a" {\n  source = "./a"\n}\n', 'a/main.tf': 'module "b" {\n  source = "./b"\n}\n', 'a/b/main.tf': 'terraform {\n  required_version = "< 1.0"\n}\n' },
      { initialized: false },
    )
    const bFiles = [{ name: 'b/main.tf', text: 'terraform {\n  required_version = "< 1.0"\n}\n' }]
    expect(coreDiagnostics([{ key: 'a.b', source: './b', files: bFiles }], '1.9.8')[0].detail).toContain('Module module.a.module.b (from ./b) does not support')
    const r = await w.run('init')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('on a/b/main.tf line 2, in terraform:')
    expect(flat(r.stderr)).toContain('Module module.a.module.b (from ./b) does not support')
  })
})

describe('schema', () => {
  const base = { files: [{ path: 'main.tf', content: VPC }] }
  it('accepts versions and rejects malformed ones', () => {
    expect(TerraformSchema.safeParse({ ...base, providers: { aws: { lock: '5.31.0', available: AVAIL } } }).success).toBe(true)
    expect(TerraformSchema.safeParse({ ...base, providers: { aws: {} } }).success).toBe(true)
    expect(TerraformSchema.safeParse({ ...base, providers: { aws: { lock: '5.31' } } }).success).toBe(false)
    expect(TerraformSchema.safeParse({ ...base, providers: { aws: { available: [] } } }).success).toBe(false)
    expect(TerraformSchema.safeParse({ ...base, providers: { AWS: {} } }).success).toBe(false)
    expect(TerraformSchema.safeParse({ ...base, providers: { aws: { extra: 1 } } }).success).toBe(false)
  })
})
