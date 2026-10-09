import { describe, expect, it } from 'vitest'
import { runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import { cachedPackage, providerHash } from '../src/game/terraform/layout.ts'
import { mountedLock } from '../src/game/terraform/providers.ts'
import { filesOnDisk } from '../src/game/paths.ts'
import type { TerraformBlock } from '../src/schema/scenario.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const LAB = '/home/you/infra'
const LOCK = `${LAB}/.terraform.lock.hcl`
const AWS = 'registry.terraform.io/hashicorp/aws'
const CACHE = '.terraform/providers'
const pkg = (v: string) => `${LAB}/${CACHE}/${AWS}/${v}/linux_amd64/terraform-provider-aws_v${v}_x5`
const VPC = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const req = (version: string | null, rest = VPC) => `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n${version === null ? '' : `      version = "${version}"\n`}    }\n  }\n}\n\n${rest}`
const PROV = { providers: { aws: { lock: '5.31.0', available: ['5.31.0', '5.50.0', '5.67.0'] } } }
const VPC_STATE = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', cidr_block: '10.0.0.0/16', arn: 'arn:aws:ec2:us-east-1:123456789012:vpc/vpc-1', default_security_group_id: 'sg-1', enable_dns_hostnames: false, enable_dns_support: true } }

function world(files: string | Record<string, string>, tf: Partial<TerraformBlock> = {}) {
  const list = typeof files === 'string' ? { 'main.tf': files } : files
  const block = { files: Object.entries(list).map(([path, content]) => ({ path, content })), ...tf } as TerraformBlock
  const lab = labFromScenario(block, LAB, '/home/you')
  const disk: Record<string, string> = {}
  for (const f of lab.files) disk[f.path] = f.content
  if (lab.initialized) {
    disk[LOCK] = mountedLock(block, lab.files)
    for (const [source, versions] of lab.providerCache!)
      for (const [v, h] of versions) {
        const p = cachedPackage(source, v, h)!
        disk[`${LAB}/${p.dir}/${p.name}`] = p.content
      }
  }
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
  const lockOf = () => disk[LOCK]
  return { ctx, lab, disk, lockOf, edit: (from: string | RegExp, to: string | ((m: string) => string)) => void (disk[LOCK] = disk[LOCK].replace(from, to as string)), run: (...args: string[]) => runTerraform(args, ctx) }
}
const HASHLINE = /"h1:[^"]+"/
const flat = (s: string) => s.replace(/[╷╵│]/g, ' ').replace(/\s+/g, ' ')

describe('the provider cache', () => {
  it('init installs the package on disk and in the lab', async () => {
    const w = world(req('~> 5.0'), { ...PROV, initialized: false })
    expect(w.lab.providerCache!.size).toBe(0)
    const r = await w.run('init')
    expect(r.exitCode).toBe(0)
    const hash = providerHash(AWS, '5.67.0')
    expect(w.lab.providerCache!.get(AWS)!.get('5.67.0')).toBe(hash)
    expect(w.disk[pkg('5.67.0')]).toBe(`#!/bin/sh\n# Simulated package of provider ${AWS} 5.67.0 (linux_amd64)\n# hash: ${hash}\n`)
    expect(w.disk[pkg('5.67.0')]).toBe(cachedPackage(AWS, '5.67.0', hash)!.content)
    expect(w.lockOf()).toContain(`"${hash}"`)
    expect((await w.run('plan')).exitCode).toBe(0)
  })

  it('an uninitialised lab with a committed lock file has no cache: operations ask for init', async () => {
    const w = world(req('~> 5.0'), { ...PROV, initialized: false })
    w.disk[LOCK] = mountedLock({ files: [{ path: 'main.tf', content: req('~> 5.0') }], ...PROV } as TerraformBlock, [{ path: 'main.tf', content: req('~> 5.0') }])
    const r = await w.run('plan')
    expect(r.exitCode).toBe(1)
    expect(flat(r.stderr)).toContain(`- ${AWS}: there is no package for ${AWS} 5.31.0 cached in ${CACHE}`)
    expect((await w.run('init')).exitCode).toBe(0)
    expect(w.disk[pkg('5.31.0')]).toContain('5.31.0')
    expect((await w.run('plan')).exitCode).toBe(0)
  })

  it('an initialised lab starts with the cache for its lock, on the shell disk too', () => {
    const w = world(req('~> 5.0'), PROV)
    expect([...w.lab.providerCache!.get(AWS)!.keys()]).toEqual(['5.31.0'])
    const disk = filesOnDisk({ id: 'x', terminal: { prompt: 'you@laptop:~/infra$' }, terraform: { files: [{ path: 'main.tf', content: req('~> 5.0') }], ...PROV } } as never)
    expect(disk.get(pkg('5.31.0'))).toBe(cachedPackage(AWS, '5.31.0', providerHash(AWS, '5.31.0'))!.content)
    // the default lab: the default version and hash
    const d = filesOnDisk({ id: 'x', terminal: { prompt: 'you@laptop:~/infra$' }, terraform: { files: [{ path: 'main.tf', content: VPC }] } } as never)
    expect(d.get(pkg('5.67.0'))).toContain('# hash: h1:Zq0uB8Zc1nS5eYpR3m7KpTz2W0k6YV3d8J4bN1xQwLs=')
    expect(filesOnDisk({ id: 'x', terminal: { prompt: 'you@laptop:~/infra$' }, terraform: { initialized: false, files: [{ path: 'main.tf', content: VPC }] } } as never).has(pkg('5.67.0'))).toBe(false)
  })

  it('default labs are unaffected: the whole lock and init flow works as before', async () => {
    const w = world(VPC, { state: [VPC_STATE] })
    for (const c of [['plan'], ['validate'], ['state', 'list'], ['output'], ['init'], ['plan'], ['apply', '-auto-approve']]) expect((await w.run(...c)).exitCode).toBe(0)
    expect((await w.run('init')).stdout).toContain('- Using previously-installed hashicorp/aws v5.67.0')
  })
})

describe('a hand-edited lock file', () => {
  const versionEdit = async () => {
    const w = world(req('~> 5.0'), { ...PROV, state: [VPC_STATE] })
    w.edit('version     = "5.31.0"', 'version     = "5.50.0"')
    return w
  }
  const NO_PKG_BOX = `╷\n│ Error: Required plugins are not installed\n│ \n│ The installed provider plugins are not consistent with the packages selected\n│ in the dependency lock file:\n│   - ${AWS}: there is no package for ${AWS} 5.50.0 cached in ${CACHE}\n│ \n│ Terraform uses external plugins to integrate with a variety of different\n│ infrastructure services. To download the plugins required for this\n│ configuration, run:\n│   terraform init\n╵`

  it('a different version has no cached package: the operations fail with the real error', async () => {
    const w = await versionEdit()
    for (const c of [['plan'], ['apply', '-auto-approve'], ['destroy', '-auto-approve'], ['refresh'], ['import', 'aws_vpc.main', 'vpc-1']]) {
      const r = await w.run(...c)
      expect(r.exitCode, c.join(' ')).toBe(1)
      expect(r.stdout).toBe('')
      expect(r.stderr).toBe(NO_PKG_BOX)
    }
  })

  it('an edited hash does not match the cached package', async () => {
    const w = world(req('~> 5.0'), { ...PROV, state: [VPC_STATE] })
    w.edit(HASHLINE, '"h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="')
    for (const c of [['plan'], ['apply', '-auto-approve'], ['destroy', '-auto-approve'], ['refresh'], ['import', 'aws_vpc.main', 'vpc-1']]) {
      const r = await w.run(...c)
      expect(r.exitCode, c.join(' ')).toBe(1)
      expect(flat(r.stderr)).toContain(`- ${AWS}: the cached package for ${AWS} 5.31.0 (in ${CACHE}) does not match any of the checksums recorded in the dependency lock file`)
    }
  })

  it('a hash list that still includes the cached package is accepted', async () => {
    const w = world(req('~> 5.0'), PROV)
    w.edit(HASHLINE, (m) => `"h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",\n    ${m}`)
    expect((await w.run('plan')).exitCode).toBe(0)
  })

  it('the commands that open the backend fail too (state, output, show, workspace, taint), validate with a plain error', async () => {
    const w = await versionEdit()
    for (const c of [['state', 'list'], ['state', 'show', 'aws_vpc.main'], ['output'], ['show'], ['workspace', 'list'], ['taint', 'aws_vpc.main']]) {
      const r = await w.run(...c)
      expect(r.exitCode, c.join(' ')).toBe(1)
      expect(r.stderr, c.join(' ')).toContain('Error: Required plugins are not installed')
    }
    const v = await w.run('validate')
    expect(v.exitCode).toBe(1)
    expect(v.stderr).toBe(`╷\n│ Error: ${AWS}: there is no package for ${AWS} 5.50.0 cached in ${CACHE}\n│ \n╵`)
    // these do not open the backend
    expect((await w.run('workspace', 'show')).exitCode).toBe(0)
    expect((await w.run('version')).exitCode).toBe(0)
    expect((await w.run('get')).exitCode).toBe(0)
  })

  it('reports the cache problem before the constraint problem when both apply', async () => {
    const w = world(req('>= 5.40'), PROV) // the lock (5.31.0) already breaks the constraint
    const only = await w.run('plan')
    expect(flat(only.stderr)).toContain('Error: Inconsistent dependency lock file')
    w.edit('version     = "5.31.0"', 'version     = "5.20.0"')
    const both = await w.run('plan')
    expect(both.stderr).toContain('Error: Required plugins are not installed')
    expect(both.stderr).not.toContain('Inconsistent dependency lock file')
  })

  it('init cannot install a version whose recorded hash is another version: the package does not match', async () => {
    const w = await versionEdit()
    const before = w.lockOf()
    const r = await w.run('init')
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain(`- Reusing previous version of hashicorp/aws from the dependency lock file\n- Installing hashicorp/aws v5.50.0...`)
    expect(flat(r.stderr)).toContain(`Error: Failed to install provider Error while installing hashicorp/aws v5.50.0: the current package for ${AWS} 5.50.0 doesn't match any of the checksums previously recorded in the dependency lock file; for more information: https://www.terraform.io/language/provider-checksum-verification`)
    expect(w.lockOf()).toBe(before)
    expect(w.lab.providerCache!.get(AWS)!.has('5.50.0')).toBe(false)
    expect((await w.run('plan')).stderr).toContain('Required plugins are not installed')
  })

  it('init repairs a lock edited without a matching hash: it installs the locked version and keeps the lock', async () => {
    const w = await versionEdit()
    w.edit(HASHLINE, '"zh:0000000000000000000000000000000000000000000000000000000000000000"')
    const r = await w.run('init')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(`- Reusing previous version of hashicorp/aws from the dependency lock file\n- Installing hashicorp/aws v5.50.0...\n- Installed hashicorp/aws v5.50.0 (signed by HashiCorp)`)
    const h = providerHash(AWS, '5.50.0')
    expect(w.lockOf()).toBe(`# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\nprovider "${AWS}" {\n  version     = "5.50.0"\n  constraints = "~> 5.0"\n  hashes = [\n    "${h}",\n    "zh:0000000000000000000000000000000000000000000000000000000000000000",\n  ]\n}\n`)
    expect(w.disk[pkg('5.50.0')]).toBe(cachedPackage(AWS, '5.50.0', h)!.content)
    expect([...w.lab.providerCache!.get(AWS)!.keys()].sort()).toEqual(['5.31.0', '5.50.0'])
    expect((await w.run('plan')).exitCode).toBe(0)
  })

  it('init -upgrade re-selects by the constraints and rewrites both the lock and the cache', async () => {
    const w = await versionEdit()
    const r = await w.run('init', '-upgrade')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(`- Finding hashicorp/aws versions matching "~> 5.0"...\n- Installing hashicorp/aws v5.67.0...\n- Installed hashicorp/aws v5.67.0 (signed by HashiCorp)`)
    expect(w.lockOf()).toBe(`# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\nprovider "${AWS}" {\n  version     = "5.67.0"\n  constraints = "~> 5.0"\n  hashes = [\n    "h1:Zq0uB8Zc1nS5eYpR3m7KpTz2W0k6YV3d8J4bN1xQwLs=",\n  ]\n}\n`)
    expect(w.disk[pkg('5.67.0')]).toContain('# hash: h1:Zq0uB8Zc1nS5eYpR3m7KpTz2W0k6YV3d8J4bN1xQwLs=')
    expect((await w.run('plan')).exitCode).toBe(0)
  })

  it('a version that the registry does not offer cannot be installed', async () => {
    const w = world(req('~> 5.0'), PROV)
    w.edit('version     = "5.31.0"', 'version     = "5.40.0"')
    const r = await w.run('init')
    expect(r.exitCode).toBe(1)
    expect(flat(r.stderr)).toContain('Error: Failed to query available provider packages Could not retrieve the list of available versions for provider hashicorp/aws: the previously-selected version 5.40.0 is no longer available')
  })

  it('a hand-edited hash is not repaired by init or init -upgrade at the same version; removing the lock file is', async () => {
    const w = world(VPC, { state: [VPC_STATE] })
    w.edit(HASHLINE, '"h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="')
    expect((await w.run('plan')).stderr).toContain('does not match any of the checksums recorded')
    for (const a of [[], ['-upgrade']]) {
      const r = await w.run('init', ...a)
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain('Failed to install provider')
    }
    delete w.disk[LOCK]
    expect((await w.run('init')).exitCode).toBe(0)
    expect(w.lockOf()).toContain('"h1:Zq0uB8Zc1nS5eYpR3m7KpTz2W0k6YV3d8J4bN1xQwLs="')
    expect((await w.run('plan')).exitCode).toBe(0)
  })

  it('an lock that omits a provider the configuration needs still gets the old error, not a cache error', async () => {
    const w = world(VPC)
    delete w.disk[LOCK]
    expect((await w.run('plan')).stderr).toContain('required by this configuration but no version is selected')
  })

  it('__proto__ provider names do not touch the prototype', async () => {
    const files = `terraform {\n  required_providers {\n    __proto__ = {\n      source = "acme/__proto__"\n    }\n  }\n}\n\n${VPC}`
    const w = world(files, { initialized: false })
    expect((await w.run('init')).exitCode).toBe(0)
    expect(w.lockOf()).toContain('registry.terraform.io/acme/__proto__')
    expect(w.lab.providerCache!.get('registry.terraform.io/acme/__proto__')!.size).toBe(1)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((await w.run('plan')).exitCode).toBe(0)
    expect((await w.run('providers')).stdout).toContain('provider[registry.terraform.io/acme/__proto__]')
  })
})

describe('terraform providers', () => {
  const RP = (v: string) => `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "${v}"\n    }\n  }\n}\n`
  const CALL = (name: string, source: string, extra = '') => `module "${name}" {\n  source = "${source}"\n${extra}}\n`
  const A = 'provider[registry.terraform.io/hashicorp/aws]'
  const manifest = (installed: NonNullable<TerraformBlock['modules']>['installed']) => ({ modules: { installed } }) as Partial<TerraformBlock>

  it('root only', async () => {
    const r = await world(req('~> 5.0')).run('providers')
    expect(r).toMatchObject({ exitCode: 0, stderr: '' })
    expect(r.stdout).toBe(`\nProviders required by configuration:\n.\n└── ${A} ~> 5.0\n\n`)
  })

  it('a resource alone needs the provider without a constraint, and an empty configuration lists nothing', async () => {
    expect((await world(VPC).run('providers')).stdout).toBe(`\nProviders required by configuration:\n.\n└── ${A}\n\n`)
    expect((await world('# nothing\n').run('providers')).stdout).toBe('\nProviders required by configuration:\n.\n\n')
  })

  it('providers required by state follow the tree, after a blank line', async () => {
    const r = await world(req('~> 5.0'), { state: [VPC_STATE] }).run('providers')
    expect(r.stdout).toBe(`\nProviders required by configuration:\n.\n└── ${A} ~> 5.0\n\nProviders required by state:\n\n    ${A}\n\n`)
  })

  it('root and a local module', async () => {
    const w = world({ 'main.tf': `${req('~> 5.0')}\n${CALL('network', './modules/network')}`, 'modules/network/main.tf': `${RP('>= 5.40')}\nresource "aws_subnet" "a" {\n  vpc_id     = "vpc-1"\n  cidr_block = "10.0.1.0/24"\n}\n` }, manifest([{ key: 'network', source: './modules/network', dir: 'modules/network' }]))
    expect((await w.run('providers')).stdout).toBe(`\nProviders required by configuration:\n.\n├── ${A} ~> 5.0\n└── module.network\n    └── ${A} >= 5.40\n\n`)
  })

  it('a registry module with a constraint, and a module that needs a provider only through a resource', async () => {
    const w = world(
      { 'main.tf': `${req('~> 5.0')}\n${CALL('net', 'acme/network/aws', '  version = "1.2.0"\n')}` },
      { modules: { installed: [{ key: 'net', source: 'acme/network/aws', version: '1.2.0' }], registry: [{ source: 'acme/network/aws', versions: [{ version: '1.2.0', files: [{ path: 'main.tf', content: `${RP('>= 5.40, < 6.0')}\nresource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\n` }] }] }] } },
    )
    expect((await w.run('providers')).stdout).toBe(`\nProviders required by configuration:\n.\n├── ${A} ~> 5.0\n└── module.net\n    └── ${A} >= 5.40, < 6.0\n\n`)
  })

  it('nested modules are children of their caller, siblings sorted, providers before modules', async () => {
    const w = world(
      { 'main.tf': `${CALL('zeta', './modules/z')}\n${CALL('net', './modules/net')}`, 'modules/net/main.tf': `${RP('>= 5.0')}\n${CALL('inner', './inner')}`, 'modules/net/inner/main.tf': VPC, 'modules/z/main.tf': VPC },
      manifest([{ key: 'net', source: './modules/net', dir: 'modules/net' }, { key: 'net.inner', source: './inner', dir: 'modules/net/inner' }, { key: 'zeta', source: './modules/z', dir: 'modules/z' }]),
    )
    expect((await w.run('providers')).stdout).toBe(`\nProviders required by configuration:\n.\n├── module.net\n│   ├── ${A} >= 5.0\n│   └── module.inner\n│       └── ${A}\n└── module.zeta\n    └── ${A}\n\n`)
  })

  it('a keyed module appears once, by its call name', async () => {
    const w = world(
      { 'main.tf': CALL('network', './modules/network', '  for_each = toset(["a", "b"])\n'), 'modules/network/main.tf': `${RP('>= 5.40')}\n${VPC}` },
      manifest([{ key: 'network', source: './modules/network', dir: 'modules/network' }]),
    )
    expect((await w.run('providers')).stdout).toBe(`\nProviders required by configuration:\n.\n└── module.network\n    └── ${A} >= 5.40\n\n`)
  })

  it('terraform_remote_state is the built-in provider, in the configuration and in the state', async () => {
    const files = `${VPC}\ndata "terraform_remote_state" "net" {\n  backend = "s3"\n  config = {\n    bucket = "b"\n    key    = "k"\n    region = "us-east-1"\n  }\n}\n`
    const w = world(files, { state: [VPC_STATE], remote_states: [{ backend: 's3', config: { bucket: 'b', key: 'k', region: 'us-east-1' }, outputs: {} }] })
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    const r = await w.run('providers')
    expect(r.stdout).toBe(`\nProviders required by configuration:\n.\n├── ${A}\n└── provider[terraform.io/builtin/terraform]\n\nProviders required by state:\n\n    ${A}\n\n    provider[terraform.io/builtin/terraform]\n\n`)
  })

  it('an invalid constraint, a syntax error and a missing configuration are errors; providers lock is not available', async () => {
    expect((await world(req('~> x')).run('providers')).stderr).toContain('Error: Invalid version constraint')
    expect((await world('resource "aws_vpc" "main" {\n  cidr_block\n}\n').run('providers')).stderr).toContain('Error: Argument or block definition required')
    expect((await world({}).run('providers')).stderr).toContain('Error: No configuration files')
    const lock = await world(VPC).run('providers', 'lock')
    expect(lock.exitCode).toBe(1)
    expect(lock.stderr).toContain('Not available in this lab yet')
    expect(flat(lock.stderr)).toContain('"terraform providers lock" is not simulated yet in this lab. You can still use: init, validate, plan, apply, destroy, show, state list, state show, state pull, state mv, state rm, import, taint, untaint, refresh, force-unlock, get, output, providers, workspace, version.')
  })

  it('fails like the operations when the cache does not match the lock file', async () => {
    const w = world(req('~> 5.0'), PROV)
    w.edit('version     = "5.31.0"', 'version     = "5.50.0"')
    expect((await w.run('providers')).stderr).toContain('Error: Required plugins are not installed')
  })

  it('is evidence when the scenario tags it', async () => {
    const w = world(req('~> 5.0'), { evidence: [{ evidence: 'tree', command: 'providers', contains: 'module.network' }, { evidence: 'other', command: 'providers', contains: 'nope' }] })
    expect((await w.run('providers')).evidence).toEqual([])
    const m = world({ 'main.tf': CALL('network', './modules/network'), 'modules/network/main.tf': VPC }, { ...manifest([{ key: 'network', source: './modules/network', dir: 'modules/network' }]), evidence: [{ evidence: 'tree', command: 'providers', contains: 'module.network' }] })
    expect((await m.run('providers')).evidence).toEqual(['evidence:tree'])
  })
})

describe('shipped incidents', () => {
  it('run their lock and init flow unchanged', async () => {
    const { play } = playbook(loadIncident('terraform-count-to-for-each'))
    const { out } = await play('ls -a', 'terraform init', 'terraform plan', 'terraform providers', 'find .terraform -type f', 'terraform validate')
    expect(out[1].output).toContain('- Using previously-installed hashicorp/aws v5.67.0')
    expect(out[1].output).toContain('Terraform has been successfully initialized!')
    expect(out[2].output).not.toContain('Required plugins')
    expect(out[3].output).toContain('Providers required by configuration:')
    expect(out[4].output).toContain('.terraform/providers/registry.terraform.io/hashicorp/aws/5.67.0/linux_amd64/terraform-provider-aws_v5.67.0_x5')
    expect(out[5].output).not.toContain('Error')
  })
})
