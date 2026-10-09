import { describe, expect, it } from 'vitest'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import { TerraformSchema, type TerraformBlock } from '../src/schema/scenario.ts'

const ROOT_TF = 'module "net" {\n  source = "./modules/net"\n}\n'
const NET_TF = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const LAB = '/home/you/infra'
const MANIFEST = '{"Modules":[{"Key":"","Source":"","Dir":"."},{"Key":"net","Source":"./modules/net","Dir":"modules/net"}]}'

function world(tf: Partial<TerraformBlock> = {}, o: { cwd?: string; files?: Record<string, string> } = {}) {
  const block = { files: [{ path: 'main.tf', content: ROOT_TF }, { path: 'modules/net/main.tf', content: NET_TF }], ...tf } as TerraformBlock
  const lab = labFromScenario(block, LAB, '/home/you')
  const disk: Record<string, string> = {}
  for (const f of lab.files) disk[f.path] = f.content
  if (lab.initialized) disk[`${LAB}/.terraform.lock.hcl`] = LOCK_FILE
  Object.assign(disk, o.files ?? {})
  const ctx: CliContext = {
    lab,
    cwd: o.cwd ?? LAB,
    mainHost: true,
    env: {},
    taken: new Set(),
    listFiles: async (dir) => Object.entries(disk).filter(([p]) => p.slice(0, p.lastIndexOf('/')) === dir).map(([p, text]) => ({ name: p.slice(p.lastIndexOf('/') + 1), text })),
    readFile: async (p) => disk[p],
    write: async (dir, name, text) => void (disk[`${dir}/${name}`] = text),
  }
  return { ctx, disk, run: (...args: string[]) => runTerraform(args, ctx) }
}
const fresh = (tf: Partial<TerraformBlock> = {}) => world({ initialized: false, ...tf })
const flat = (s: string) => s.replace(/\n│ /g, ' ')
const installed = { modules: { installed: [{ key: 'net', source: './modules/net', dir: 'modules/net' }] } }

const NOT_INSTALLED = [
  '╷',
  '│ Error: Module not installed',
  '│ ',
  '│   on main.tf line 1, in module "net":',
  '│    1: module "net" {',
  '│ ',
  '│ This module is not yet installed. Run "terraform init" to install all',
  '│ modules required by this configuration.',
  '╵',
].join('\n')

describe('terraform modules: init, get and install checks', () => {
  it('init lists the module first and writes the manifest', async () => {
    const w = fresh()
    const r = await w.run('init')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.split('\n').slice(0, 6)).toEqual(['Initializing modules...', '- net in modules/net', '', 'Initializing the backend...', '', 'Initializing provider plugins...'])
    expect(w.disk[`${LAB}/.terraform/modules/modules.json`]).toBe(MANIFEST)
  })

  it('init without module calls is unchanged and writes no manifest', async () => {
    const w = fresh({ files: [{ path: 'main.tf', content: NET_TF }] })
    const r = await w.run('init')
    expect(r.stdout.startsWith('\nInitializing the backend...\n')).toBe(true)
    expect(Object.keys(w.disk).some((p) => p.includes('modules.json'))).toBe(false)
  })

  it('an un-initialised configuration fails validate and plan with Module not installed, state untouched', async () => {
    const w = fresh()
    const serial = w.ctx.lab.state.serial
    for (const cmd of ['validate', 'plan', 'apply']) {
      const r = await w.run(cmd)
      expect(r.exitCode, cmd).toBe(1)
      expect(r.stderr, cmd).toBe(NOT_INSTALLED)
    }
    expect(w.ctx.lab.state.serial).toBe(serial)
  })

  it('init then plan: the manifest is read back and the install checks pass', async () => {
    const w = fresh()
    await w.run('init')
    expect((await w.run('validate')).stderr).not.toContain('Module not installed')
    const plan = await w.run('plan')
    expect(plan.stderr).not.toContain('Module not installed')
    expect(plan.stderr).toContain('Unsupported module') // replaced when the planner learns modules (TF6a task 4)
  })

  it('a scenario with modules.installed starts initialised', async () => {
    const w = world(installed)
    expect(w.disk[`${LAB}/.terraform/modules/modules.json`]).toBe(MANIFEST)
    expect((await w.run('plan')).stderr).not.toContain('Module not installed')
  })

  it('a changed source reports Module source has changed until init', async () => {
    const w = world(installed, { files: { [`${LAB}/main.tf`]: ROOT_TF.replace('./modules/net', './modules/net2'), [`${LAB}/modules/net2/main.tf`]: NET_TF } })
    const r = await w.run('validate')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Error: Module source has changed')
    expect(flat(r.stderr)).toContain('The source address was changed since this module was installed. Run "terraform init" to install all modules required by this configuration.')
    await w.run('init')
    expect((await w.run('validate')).stderr).not.toContain('Module source has changed')
  })

  it('terraform get installs local modules', async () => {
    const w = fresh()
    const r = await w.run('get')
    expect([r.exitCode, r.stdout]).toEqual([0, '- net in modules/net'])
    expect(w.disk[`${LAB}/.terraform/modules/modules.json`]).toBe(MANIFEST)
    expect((await w.run('validate')).stderr).not.toContain('Module not installed')
  })

  it('init reports a missing module directory with the real Unreadable module directory texts', async () => {
    const w = fresh({ files: [{ path: 'main.tf', content: ROOT_TF }] })
    const r = await w.run('init')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Error: Unreadable module directory')
    expect(flat(r.stderr)).toContain('Unable to evaluate directory symlink: lstat modules/net: no such file or directory')
    expect(flat(r.stderr)).toContain('The directory could not be read for module "net" at main.tf:1.') // the double space is wrapped away
    expect(Object.keys(w.disk).some((p) => p.includes('modules.json'))).toBe(false)
  })

  it('validate loads child files: a syntax error is reported at its lab-relative path and line', async () => {
    const w = world(installed, { files: { [`${LAB}/modules/net/main.tf`]: 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  oops = = 1\n}\n' } })
    const r = await w.run('validate')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('on modules/net/main.tf line 3')
  })

  it('a registry source gives the lab error', async () => {
    const w = fresh({ files: [{ path: 'main.tf', content: 'module "net" {\n  source = "acme/network/aws"\n  version = "2.0.1"\n}\n' }] })
    for (const cmd of ['init', 'get']) {
      const r = await w.run(cmd)
      expect(r.exitCode, cmd).toBe(1)
      expect(r.stderr, cmd).toContain('Error: Unsupported module source')
      expect(flat(r.stderr), cmd).toContain('this lab only installs local modules')
    }
  })

  it('other directories are unaffected', async () => {
    const w = world({}, { cwd: '/home/you', files: { '/home/you/other/main.tf': NET_TF, '/home/you/other/.terraform.lock.hcl': LOCK_FILE } })
    const r = await w.run('-chdir=other', 'validate')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Success!')
    expect((await w.run('-chdir=other', 'init')).stdout.startsWith('\nInitializing the backend...')).toBe(true)
  })

  it('schema: installed dir must hold .tf files from terraform.files', () => {
    const base = { files: [{ path: 'main.tf', content: ROOT_TF }, { path: 'modules/net/main.tf', content: NET_TF }] }
    expect(TerraformSchema.safeParse({ ...base, ...installed }).success).toBe(true)
    expect(TerraformSchema.safeParse({ ...base, modules: { installed: [{ key: 'net', source: './modules/net', dir: '../x' }] } }).success).toBe(false)
  })
})
