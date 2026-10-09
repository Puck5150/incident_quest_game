import { describe, expect, it } from 'vitest'
import { TerraformSchema, type TerraformBlock } from '../src/schema/scenario.ts'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import { loadModuleTree } from '../src/game/terraform/modules.ts'

const LAB = '/home/you/infra'
const ROOT = 'module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\n\nresource "aws_subnet" "a" {\n  vpc_id     = module.net.vpc_id\n  cidr_block = "10.0.1.0/24"\n}\n'
const NET = 'variable "cidr" {\n  type = string\n}\n\nmodule "inner" {\n  source = "./inner"\n  cidr   = var.cidr\n}\n\noutput "vpc_id" {\n  value = module.inner.vpc_id\n}\n'
const INNER = 'variable "cidr" {\n  type = string\n}\n\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}\n\noutput "vpc_id" {\n  value = aws_vpc.main.id\n}\n'
const FILES = { 'main.tf': ROOT, 'modules/net/main.tf': NET, 'modules/net/inner/main.tf': INNER }
const MANIFEST = [
  { key: 'net', source: './modules/net', dir: 'modules/net' },
  { key: 'net.inner', source: './inner', dir: 'modules/net/inner' },
]
const VPC = { id: 'vpc-1', cidr_block: '10.0.0.0/16', arn: 'arn:aws:ec2:us-east-1:123456789012:vpc/vpc-1', default_security_group_id: 'sg-1', enable_dns_hostnames: false, enable_dns_support: true }

function world(files: Record<string, string> = FILES, tf: Partial<TerraformBlock> = {}) {
  const block = { files: Object.entries(files).map(([path, content]) => ({ path, content })), modules: { installed: MANIFEST }, ...tf } as TerraformBlock
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
  return { ctx, lab, disk, set: (path: string, text: string) => void (disk[`${LAB}/${path}`] = text), run: (...args: string[]) => runTerraform(args, ctx) }
}
const stateAddrs = (w: ReturnType<typeof world>) => w.run('state', 'list').then((r) => r.stdout.split('\n'))
const heads = (stdout: string) => stdout.split('\n').filter((l) => l.startsWith('  # ') && !l.startsWith('  # ('))

const reader = (disk: Record<string, string>) => async (dir: string) =>
  Object.entries(disk).filter(([p]) => p.slice(0, p.lastIndexOf('/')) === dir).map(([p, text]) => ({ name: p.slice(p.lastIndexOf('/') + 1), text }))
const rootFiles = (text: string) => [{ name: 'main.tf', text }]
const call = (name: string, source: string) => `module "${name}" {\n  source = "${source}"\n}\n`
const res = 'resource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n'

describe('nested modules: loader', () => {
  it('follows calls two and three levels deep, keys are dotted paths, sources are relative to the calling module', async () => {
    const disk = { 'modules/net/main.tf': call('inner', './inner'), 'modules/net/inner/main.tf': call('deep', './deep'), 'modules/net/inner/deep/main.tf': res }
    const r = await loadModuleTree(rootFiles(call('net', './modules/net')), reader(disk), undefined, true)
    expect(r.install).toEqual([])
    expect(r.entries).toEqual([
      { key: 'net', source: './modules/net', dir: 'modules/net' },
      { key: 'net.inner', source: './inner', dir: 'modules/net/inner' },
      { key: 'net.inner.deep', source: './deep', dir: 'modules/net/inner/deep' },
    ])
    expect([...r.tree.children.keys()].sort()).toEqual(['net', 'net.inner', 'net.inner.deep'])
    expect(r.tree.children.get('net.inner.deep')!.files.files[0].name).toBe('modules/net/inner/deep/main.tf')
  })

  it('a child may reach a sibling directory with ../', async () => {
    const disk = { 'modules/net/main.tf': call('shared', '../shared'), 'modules/shared/main.tf': res }
    const r = await loadModuleTree(rootFiles(call('net', './modules/net')), reader(disk), undefined, true)
    expect(r.install).toEqual([])
    expect(r.entries.map((e) => `${e.key}=${e.dir}`)).toEqual(['net=modules/net', 'net.shared=modules/shared'])
  })

  it('a missing nested directory is the unreadable-directory error pair', async () => {
    const disk = { 'modules/net/main.tf': call('inner', './nope') }
    const r = await loadModuleTree(rootFiles(call('net', './modules/net')), reader(disk), undefined, true)
    expect(r.install.map((d) => d.summary)).toEqual(['Unreadable module directory', 'Unreadable module directory'])
    expect(r.install[0].detail).toContain('lstat modules/net/nope')
    expect(r.install[1].detail).toBe('The directory  could not be read for module "inner" at modules/net/main.tf:1.')
  })

  it('a module that calls itself, directly or through another, is a lab error naming the loop', async () => {
    const direct = await loadModuleTree(rootFiles(call('net', './modules/net')), reader({ 'modules/net/main.tf': call('again', '../net') }), undefined, true)
    expect(direct.install).toMatchObject([{ summary: 'Module cycle', file: 'modules/net/main.tf', line: 1, context: 'module "again"' }])
    expect(direct.install[0].detail).toBe('Module "again" calls the module in "modules/net", which is already being loaded: . -> modules/net -> modules/net.')
    const indirect = await loadModuleTree(rootFiles(call('a', './a')), reader({ 'a/main.tf': call('b', './b'), 'a/b/main.tf': call('a', '../../a') }), undefined, true)
    expect(indirect.install.map((d) => d.summary)).toEqual(['Module cycle'])
    const toRoot = await loadModuleTree(rootFiles(call('a', './a')), reader({ 'a/main.tf': call('up', '../') }), undefined, true)
    expect(toRoot.install.map((d) => d.summary)).toEqual(['Module cycle'])
  })

  it('nesting deeper than 8 levels is an error', async () => {
    const disk: Record<string, string> = {}
    let dir = 'm'
    for (let i = 0; i < 10; i++) {
      disk[`${dir}/main.tf`] = i < 9 ? call('n', './n') : res
      dir += '/n'
    }
    const r = await loadModuleTree(rootFiles(call('m', './m')), reader(disk), undefined, true)
    expect(r.install).toMatchObject([{ summary: 'Module stack level too deep', detail: 'This configuration has nested modules more than 8 levels deep.' }])
    expect(r.entries).toHaveLength(8)
  })

  it('without install, the manifest decides: a nested call that is not recorded is not installed', async () => {
    const disk = { 'modules/net/main.tf': call('inner', './inner'), 'modules/net/inner/main.tf': res }
    const manifest = [{ key: 'net', source: './modules/net', dir: 'modules/net' }]
    const r = await loadModuleTree(rootFiles(call('net', './modules/net')), reader(disk), manifest, false)
    expect(r.install).toMatchObject([{ summary: 'Module not installed', file: 'modules/net/main.tf', line: 1, context: 'module "inner"' }])
    const changed = await loadModuleTree(rootFiles(call('net', './modules/net')), reader(disk), [...manifest, { key: 'net.inner', source: './other', dir: 'modules/net/inner' }], false)
    expect(changed.install.map((d) => d.summary)).toEqual(['Module source has changed'])
  })

  it('an unsupported source in a nested call is reported at the nested call', async () => {
    const r = await loadModuleTree(rootFiles(call('net', './modules/net')), reader({ 'modules/net/main.tf': call('reg', 'git::https://example.com/x.git') }), undefined, true)
    expect(r.install).toMatchObject([{ summary: 'Unsupported module source', file: 'modules/net/main.tf' }])
  })
})

describe('nested modules: load order', () => {
  it('entries are depth first with call names sorted per level: net, net.inner, net-x', async () => {
    const disk = { 'modules/net/main.tf': call('inner', './inner'), 'modules/net/inner/main.tf': res, 'modules/net-x/main.tf': res }
    const r = await loadModuleTree(rootFiles(`${call('net-x', './modules/net-x')}${call('net', './modules/net')}`), reader(disk), undefined, true)
    expect(r.entries.map((e) => e.key)).toEqual(['net', 'net.inner', 'net-x'])
  })
})

describe('nested modules: init, get and modules.json', () => {
  it('init lists every level and writes dotted keys', async () => {
    const w = world(FILES, { initialized: false, modules: undefined })
    const r = await w.run('init')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout.split('\n').slice(0, 3)).toEqual(['Initializing modules...', '- net in modules/net', '- net.inner in modules/net/inner'])
    expect(JSON.parse(w.disk[`${LAB}/.terraform/modules/modules.json`])).toEqual({
      Modules: [
        { Key: '', Source: '', Dir: '.' },
        { Key: 'net', Source: './modules/net', Dir: 'modules/net' },
        { Key: 'net.inner', Source: './inner', Dir: 'modules/net/inner' },
      ],
    })
    const g = await w.run('get')
    expect(g.stdout).toBe('- net in modules/net\n- net.inner in modules/net/inner')
    expect((await w.run('validate')).stdout).toContain('Success!')
  })

  it('a lab that starts initialised mounts the nested manifest; a missing record is Module not installed', async () => {
    const w = world(FILES, { modules: { installed: [MANIFEST[0]] } })
    const r = await w.run('plan')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Error: Module not installed')
    expect(r.stderr).toContain('│   on modules/net/main.tf line 5, in module "inner":')
    expect(r.stderr).toContain('│    5: module "inner" {')
    expect((await w.run('init')).exitCode).toBe(0)
    expect((await w.run('plan')).exitCode).toBe(0)
  })

  it('init reports a nested call whose directory is missing, and a cycle', async () => {
    const w = world({ 'main.tf': ROOT, 'modules/net/main.tf': NET }, { initialized: false, modules: undefined })
    const r = await w.run('init')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Unreadable module directory')
    const c = world({ 'main.tf': call('net', './modules/net'), 'modules/net/main.tf': call('me', './') }, { initialized: false, modules: undefined })
    expect((await c.run('init')).stderr).toContain('Error: Module cycle')
  })

  it('schema: dotted installed keys are accepted, bad keys are not', () => {
    const base = { files: Object.entries(FILES).map(([path, content]) => ({ path, content })) }
    expect(TerraformSchema.safeParse({ ...base, modules: { installed: MANIFEST } }).error?.issues).toBeUndefined()
    expect(TerraformSchema.safeParse({ ...base, modules: { installed: [{ ...MANIFEST[0], key: 'net..inner' }] } }).success).toBe(false)
    expect(TerraformSchema.safeParse({ ...base, state: [{ module: 'module.net.module.inner', type: 'aws_vpc', name: 'main', attrs: VPC }] }).error?.issues).toBeUndefined()
  })
})

// root -> net -> inner -> deep
const VAR = 'variable "cidr" {\n  type = string\n}\n\n'
const T3 = {
  'main.tf': 'module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\n\nresource "aws_subnet" "root" {\n  vpc_id     = module.net.vpc_id\n  cidr_block = "10.0.1.0/24"\n}\n\noutput "vpc" {\n  value = module.net.vpc_id\n}\n',
  'modules/net/main.tf': `${VAR}module "inner" {\n  source = "./inner"\n  cidr   = var.cidr\n}\n\noutput "vpc_id" {\n  value = module.inner.vpc_id\n}\n`,
  'modules/net/inner/main.tf': `${VAR}module "deep" {\n  source = "./deep"\n  cidr   = var.cidr\n}\n\nresource "aws_subnet" "mid" {\n  vpc_id     = module.deep.vpc_id\n  cidr_block = "10.0.2.0/24"\n}\n\noutput "vpc_id" {\n  value = module.deep.vpc_id\n}\n`,
  'modules/net/inner/deep/main.tf': INNER,
}
const M3 = [...MANIFEST, { key: 'net.inner.deep', source: './deep', dir: 'modules/net/inner/deep' }]
const world3 = (over: Record<string, string> = {}, tf: Partial<TerraformBlock> = {}) => world({ ...T3, ...over }, { modules: { installed: M3 }, ...tf })
const DEEP = 'module.net.module.inner.module.deep.aws_vpc.main'

describe('nested modules: plan, apply and destroy across three levels', () => {
  it('plan lines, apply order, state shape, outputs bubbling up, destroy order', async () => {
    const w = world3()
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(heads(plan.stdout)).toEqual(['  # aws_subnet.root will be created', '  # module.net.module.inner.aws_subnet.mid will be created', `  # ${DEEP} will be created`])
    expect(plan.stdout).toContain('Plan: 3 to add, 0 to change, 0 to destroy.')
    expect(plan.stdout).toContain('+ vpc = (known after apply)')
    const apply = await w.run('apply', '-auto-approve')
    expect(apply.exitCode, apply.stderr).toBe(0)
    expect(w.lab.history.slice(0, 1)).toEqual([`create ${DEEP}`])
    expect(w.lab.history.slice(1).sort()).toEqual(['create aws_subnet.root', 'create module.net.module.inner.aws_subnet.mid'])
    expect(await stateAddrs(w)).toEqual(['aws_subnet.root', 'module.net.module.inner.aws_subnet.mid', DEEP])
    const deep = w.lab.state.resources.find((r) => r.type === 'aws_vpc')!
    expect(deep.module).toBe('module.net.module.inner.module.deep')
    const vpcId = deep.instances[0].attributes.id
    expect(w.lab.state.resources.find((r) => r.name === 'mid')!.instances[0].attributes.vpc_id).toBe(vpcId)
    expect(w.lab.state.resources.find((r) => r.name === 'root')!.instances[0].attributes.vpc_id).toBe(vpcId)
    expect(w.lab.state.resources.find((r) => r.name === 'root')!.instances[0].dependencies).toEqual([DEEP])
    expect(w.lab.state.outputs.vpc.value).toBe(vpcId)
    expect((await w.run('plan')).stdout).toContain('No changes.')
    expect((await w.run('state', 'show', DEEP)).stdout.split('\n')[0]).toBe(`# ${DEEP}:`)
    expect((await w.run('state', 'list', 'module.net.module.inner')).stdout).toBe(`module.net.module.inner.aws_subnet.mid\n${DEEP}`)
    const d = await w.run('destroy', '-auto-approve')
    expect(d.exitCode, d.stderr).toBe(0)
    const del = w.lab.history.filter((h) => h.startsWith('delete'))
    expect(del[2]).toBe(`delete ${DEEP}`)
    expect(del.slice(0, 2).sort()).toEqual(['delete aws_subnet.root', 'delete module.net.module.inner.aws_subnet.mid'])
  })

  it('path.module and terraform.workspace in a grandchild', async () => {
    const w = world3({ 'modules/net/inner/deep/main.tf': `${INNER}output "dir" {\n  value = path.module\n}\n` , 'modules/net/inner/main.tf': `${T3['modules/net/inner/main.tf']}output "dir" {\n  value = module.deep.dir\n}\n` , 'modules/net/main.tf': `${T3['modules/net/main.tf']}output "dir" {\n  value = module.inner.dir\n}\n`, 'main.tf': `${T3['main.tf']}output "dir" {\n  value = module.net.dir\n}\n` })
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('+ dir = "modules/net/inner/deep"')
  })

  it('a variable chain: parent argument to child variable to grandchild variable', async () => {
    const w = world3()
    const plan = await w.run('plan')
    expect(plan.stdout).toContain('      + cidr_block                = "10.0.0.0/16"')
  })
})

describe('nested modules: diagnostics', () => {
  it('an undeclared reference in the grandchild names the module path and the grandchild file', async () => {
    const w = world3({ 'modules/net/inner/deep/main.tf': `${INNER}resource "aws_s3_bucket" "x" {\n  bucket = aws_s3_bucket.nope.id\n}\n` })
    const r = await w.run('plan')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Error: Reference to undeclared resource')
    expect(r.stderr).toContain('│   on modules/net/inner/deep/main.tf line 13:')
    expect(r.stderr.replace(/\n│ /g, ' ')).toContain('has not been declared in module.net.module.inner.module.deep.')
  })

  it('a missing argument in a nested call is reported at the nested call, an unknown one too', async () => {
    const w = world3({ 'modules/net/inner/main.tf': T3['modules/net/inner/main.tf'].replace('  cidr   = var.cidr\n', '  bogus  = 1\n') })
    const r = await w.run('validate')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Error: Missing required argument')
    expect(r.stderr).toContain('The argument "cidr" is required, but no definition was found.')
    expect(r.stderr).toContain('Error: Unsupported argument')
    expect(r.stderr).toContain('│   on modules/net/inner/main.tf line 5, in module "deep":')
    expect(r.stderr).toContain('│   on modules/net/inner/main.tf line 7, in module "deep":')
  })

  it('a runtime error in the grandchild file carries its location and module context', async () => {
    const w = world3({ 'modules/net/inner/deep/main.tf': INNER.replace('var.cidr', 'each.key') })
    const r = await w.run('plan')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('│   on modules/net/inner/deep/main.tf line 6, in resource "aws_vpc" "main":')
  })

  it('a reference cycle through the chain is found', async () => {
    const w = world3({
      'modules/net/main.tf': `${VAR}module "inner" {\n  source = "./inner"\n  cidr   = module.inner.vpc_id\n}\n\noutput "vpc_id" {\n  value = module.inner.vpc_id\n}\n`,
    })
    const r = await w.run('plan')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Cycle: ')
    expect(r.stderr).toContain('module.net.module.inner')
  })
})

describe('nested modules: keys at any level', () => {
  const OUTER_FE = (keys = '["a", "b"]') => `module "net" {\n  source   = "./modules/net"\n  for_each = toset(${keys})\n  cidr     = each.key == "a" ? "10.0.0.0/16" : "10.1.0.0/16"\n}\n`
  const INNER_CNT = (n = 2) => `${VAR}module "inner" {\n  source = "./inner"\n  count  = ${n}\n  cidr   = "10.\${count.index}.0.0/16"\n}\n`
  const NET_SINGLE_INNER = T3['modules/net/main.tf'] // inner without keys
  const two = { 'modules/net/inner/main.tf': INNER, 'modules/net/main.tf': NET_SINGLE_INNER }

  it('a keyed module containing a nested non-keyed module', async () => {
    const w = world({ ...FILES, 'main.tf': OUTER_FE(), ...two }, {})
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(heads(plan.stdout)).toEqual(['  # module.net["a"].module.inner.aws_vpc.main will be created', '  # module.net["b"].module.inner.aws_vpc.main will be created'])
    expect(plan.stdout).toContain('      + cidr_block                = "10.1.0.0/16"')
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    expect(await stateAddrs(w)).toEqual(['module.net["a"].module.inner.aws_vpc.main', 'module.net["b"].module.inner.aws_vpc.main'])
    expect(w.lab.state.resources.map((r) => r.module)).toEqual(['module.net["a"].module.inner', 'module.net["b"].module.inner'])
    expect((await w.run('state', 'list', 'module.net["a"]')).stdout).toBe('module.net["a"].module.inner.aws_vpc.main')
    expect((await w.run('plan')).stdout).toContain('No changes.')
    // removing a key: the nested instance goes with the full instance path as the reason
    w.set('main.tf', OUTER_FE('["a"]'))
    const gone = await w.run('plan')
    expect(gone.stdout).toContain('  # module.net["b"].module.inner.aws_vpc.main will be destroyed\n  # (because module.net["b"].module.inner is not in configuration)')
  })

  it('a non-keyed module containing a keyed nested module', async () => {
    const w = world({ ...FILES, 'modules/net/main.tf': `${INNER_CNT()}output "vpc_id" {\n  value = module.inner[0].vpc_id\n}\n` })
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(heads(plan.stdout)).toEqual(['  # aws_subnet.a will be created', '  # module.net.module.inner[0].aws_vpc.main will be created', '  # module.net.module.inner[1].aws_vpc.main will be created'])
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    expect(w.lab.state.resources.map((r) => r.module).filter(Boolean)).toEqual(['module.net.module.inner[0]', 'module.net.module.inner[1]'])
    const shrunk = world({ ...FILES, 'modules/net/main.tf': `${INNER_CNT(1)}output "vpc_id" {\n  value = module.inner[0].vpc_id\n}\n` }, { state: w.lab.state.resources.filter((r) => r.module).map((r) => ({ module: r.module, type: r.type, name: r.name, key: r.instances[0].index_key, attrs: r.instances[0].attributes })) as never })
    const p = await shrunk.run('plan')
    expect(p.stdout).toContain('  # module.net.module.inner[1].aws_vpc.main will be destroyed\n  # (because module.net.module.inner[1] is not in configuration)')
  })

  it('both levels keyed: full addresses, state, -replace, taint, import and faults', async () => {
    const w = world(
      { ...FILES, 'main.tf': OUTER_FE(), 'modules/net/main.tf': `${INNER_CNT()}output "vpc_id" {\n  value = module.inner[0].vpc_id\n}\n` },
      { faults: [{ at: 'module.net["b"].module.inner[1].aws_vpc.main', on: 'create', error: 'VpcLimitExceeded' }] },
    )
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('│   with module.net["b"].module.inner[1].aws_vpc.main,')
    expect(r.stderr).toContain('│   on modules/net/inner/main.tf line 5, in resource "aws_vpc" "main":')
    expect(await stateAddrs(w)).toEqual(['module.net["a"].module.inner[0].aws_vpc.main', 'module.net["a"].module.inner[1].aws_vpc.main', 'module.net["b"].module.inner[0].aws_vpc.main'])
    w.lab.faults.length = 0
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    const plan = await w.run('plan', '-replace=module.net["a"].module.inner[1].aws_vpc.main')
    expect(heads(plan.stdout)).toEqual(['  # module.net["a"].module.inner[1].aws_vpc.main will be replaced, as requested'])
    expect((await w.run('taint', 'module.net["b"].module.inner[0].aws_vpc.main')).exitCode).toBe(0)
    expect(heads((await w.run('plan')).stdout)).toEqual(['  # module.net["b"].module.inner[0].aws_vpc.main is tainted, so must be replaced'])
  })

  it('import into a nested keyed instance checks every level', async () => {
    const bk = { 'main.tf': OUTER_FE('["a"]'), 'modules/net/main.tf': INNER_CNT(1), 'modules/net/inner/main.tf': `${VAR}resource "aws_s3_bucket" "b" {\n  bucket = "bk-\${var.cidr}"\n}\n` }
    const w = world({ ...bk }, { cloud: { add: [{ type: 'aws_s3_bucket', attrs: { id: 'bk-1', bucket: 'bk-1', arn: 'arn:aws:s3:::bk-1' } }] } })
    const ok = await w.run('import', 'module.net["a"].module.inner[0].aws_s3_bucket.b', 'bk-1')
    expect(ok.exitCode, ok.stderr).toBe(0)
    expect(w.lab.state.resources[0].module).toBe('module.net["a"].module.inner[0]')
    for (const bad of ['module.net["z"].module.inner[0].aws_s3_bucket.b', 'module.net["a"].module.inner[1].aws_s3_bucket.b', 'module.net["a"].module.inner.aws_s3_bucket.b']) {
      const r = await w.run('import', bad, 'bk-1')
      expect(r.stderr, bad).toContain('Configuration for import target does not exist')
    }
    expect((await w.run('import', 'module.net["a"].module.nope[0].aws_s3_bucket.b', 'bk-1')).stderr).toContain('does not exist in the configuration')
  })
})

describe('nested modules: orphans, moves and state commands', () => {
  const applied = async (over: Record<string, string> = {}) => {
    const w = world3(over)
    const r = await w.run('apply', '-auto-approve')
    expect(r.exitCode, r.stderr).toBe(0)
    return w
  }

  it('orphan reasons: the nested call removed, the whole outer call removed', async () => {
    const w = await applied()
    w.set('modules/net/main.tf', `${VAR}output "vpc_id" {\n  value = "x"\n}\n`)
    const a = await w.run('plan')
    expect(a.stdout).toContain(`  # ${DEEP} will be destroyed\n  # (because module.net.module.inner.module.deep is not in configuration)`)
    expect(a.stdout).toContain('  # module.net.module.inner.aws_subnet.mid will be destroyed\n  # (because module.net.module.inner is not in configuration)')
    const b = await applied()
    b.set('main.tf', 'resource "aws_s3_bucket" "x" {\n  bucket = "x"\n}\n')
    const p = await b.run('plan')
    expect(p.stdout).toContain(`  # ${DEEP} will be destroyed\n  # (because module.net.module.inner.module.deep is not in configuration)`)
  })

  it('a resource gone from a nested module is reported by resource', async () => {
    const w = await applied()
    w.set('modules/net/inner/main.tf', T3['modules/net/inner/main.tf'].replace(/resource "aws_subnet" "mid" \{[^}]*\}\n\n/, '').replace('module.deep.vpc_id\n}\n', 'module.deep.vpc_id\n}\n'))
    const p = await w.run('plan')
    expect(p.stdout).toContain('  # module.net.module.inner.aws_subnet.mid will be destroyed\n  # (because aws_subnet.mid is not in configuration)')
  })

  it('root moved block renames a nested module by its full path; dependencies follow; destroy-all still orders', async () => {
    const w = await applied()
    const before = w.lab.state.resources.find((r) => r.name === 'root')!.instances[0].dependencies
    expect(before).toEqual([DEEP])
    w.set('modules/net/main.tf', T3['modules/net/main.tf'].replaceAll('"inner"', '"core"').replace('./inner', './core').replaceAll('module.inner', 'module.core'))
    w.disk[`${LAB}/modules/net/core`] = '' // directory marker is not needed; copy the files
    w.set('modules/net/core/main.tf', T3['modules/net/inner/main.tf'])
    w.set('modules/net/core/deep/main.tf', INNER)
    const stale = await w.run('plan')
    expect(stale.stderr).toContain('Module not installed')
    w.set('main.tf', `moved {\n  from = module.net.module.inner\n  to   = module.net.module.core\n}\n\n${T3['main.tf']}`)
    expect((await w.run('init')).stdout).toContain('- net.core in modules/net/core')
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('module.net.module.inner.module.deep.aws_vpc.main has moved to module.net.module.core.module.deep.aws_vpc.main')
    expect(plan.stdout).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    const ndeep = 'module.net.module.core.module.deep.aws_vpc.main'
    expect(await stateAddrs(w)).toEqual(['aws_subnet.root', 'module.net.module.core.aws_subnet.mid', ndeep])
    expect(w.lab.state.resources.find((r) => r.name === 'root')!.instances[0].dependencies).toEqual([ndeep])
    expect(w.lab.state.resources.find((r) => r.name === 'mid')!.instances[0].dependencies).toEqual([ndeep])
    const d = await w.run('destroy', '-auto-approve')
    expect(d.exitCode, d.stderr).toBe(0)
    expect(d.stderr).not.toContain('DependencyViolation')
    expect(w.lab.state.resources).toEqual([])
  })

  it('a resource moves between nested modules; a moved block inside a child is ignored', async () => {
    const w = await applied()
    w.set('modules/net/inner/main.tf', `${T3['modules/net/inner/main.tf'].replace(/resource "aws_subnet" "mid" \{[^}]*\}\n\n/, '')}moved {\n  from = aws_subnet.mid\n  to   = aws_subnet.mid2\n}\n`)
    w.set('modules/net/inner/deep/main.tf', `${INNER}resource "aws_subnet" "mid" {\n  vpc_id     = aws_vpc.main.id\n  cidr_block = "10.0.2.0/24"\n}\n`)
    w.set('main.tf', `moved {\n  from = module.net.module.inner.aws_subnet.mid\n  to   = module.net.module.inner.module.deep.aws_subnet.mid\n}\n\n${T3['main.tf']}`)
    const plan = await w.run('plan')
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(plan.stdout).toContain('module.net.module.inner.aws_subnet.mid has moved to module.net.module.inner.module.deep.aws_subnet.mid')
    expect(plan.stdout).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
  })

  it('state mv between nested modules, and state rm of a nested module', async () => {
    const w = await applied()
    const mv = await w.run('state', 'mv', 'module.net.module.inner.aws_subnet.mid', 'module.net.aws_subnet.mid')
    expect(mv.exitCode, mv.stderr).toBe(0)
    expect(await stateAddrs(w)).toEqual(['aws_subnet.root', 'module.net.aws_subnet.mid', DEEP])
    const whole = await w.run('state', 'mv', 'module.net.module.inner', 'module.net.module.core')
    expect(whole.exitCode, whole.stderr).toBe(0)
    expect(await stateAddrs(w)).toEqual(['aws_subnet.root', 'module.net.aws_subnet.mid', 'module.net.module.core.module.deep.aws_vpc.main'])
    expect(w.lab.state.resources.find((r) => r.name === 'root')!.instances[0].dependencies).toEqual(['module.net.module.core.module.deep.aws_vpc.main'])
    const rm = await w.run('state', 'rm', 'module.net.module.core')
    expect(rm.stdout).toContain('Removed module.net.module.core.module.deep.aws_vpc.main')
  })

  it('a nested resource fault, history and predicates see the full address', async () => {
    const w = world3({}, { faults: [{ at: DEEP, on: 'create', error: 'boom', times: 1 }] })
    const r = await w.run('apply', '-auto-approve')
    expect(r.stderr).toContain(`│   with ${DEEP},`)
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    expect(w.lab.history[0]).toBe(`create ${DEEP}`)
  })

  it('prevent_destroy in a nested module blocks the plan with the full address', async () => {
    const w = await applied({ 'modules/net/inner/deep/main.tf': INNER.replace('cidr_block = var.cidr', 'cidr_block = var.cidr\n  lifecycle {\n    prevent_destroy = true\n  }') })
    const d = await w.run('destroy', '-auto-approve')
    expect(d.exitCode).toBe(1)
    expect(d.stderr.replace(/\n│ /g, ' ')).toContain(`Resource ${DEEP} has lifecycle.prevent_destroy set`)
  })
})
