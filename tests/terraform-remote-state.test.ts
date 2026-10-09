import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import { mountedLock } from '../src/game/terraform/providers.ts'
import { ScenarioSchema, TerraformSchema, type TerraformBlock } from '../src/schema/scenario.ts'

const LAB = '/home/you/infra'
const CFG = { bucket: 'acme-tf-state', key: 'network/terraform.tfstate', region: 'us-east-1' }
const REMOTE = { backend: 's3' as const, config: CFG, outputs: { vpc_id: 'vpc-0abc', subnet_ids: ['subnet-1', 'subnet-2'] } }
const DATA = 'data "terraform_remote_state" "net" {\n  backend = "s3"\n  config = {\n    bucket = "acme-tf-state"\n    key    = "network/terraform.tfstate"\n    region = "us-east-1"\n  }\n}\n'
const SUBNET = 'resource "aws_subnet" "a" {\n  vpc_id     = data.terraform_remote_state.net.outputs.vpc_id\n  cidr_block = "10.0.1.0/24"\n}\n'
const MAIN = DATA + SUBNET

function world(files: string | Record<string, string>, tf: Partial<TerraformBlock> = { remote_states: [REMOTE] }, lock?: string) {
  const list = typeof files === 'string' ? { 'main.tf': files } : files
  const block = { files: Object.entries(list).map(([path, content]) => ({ path, content })), ...tf } as TerraformBlock
  const lab = labFromScenario(block, LAB, '/home/you')
  const disk: Record<string, string> = {}
  for (const f of lab.files) disk[f.path] = f.content
  disk[`${LAB}/.terraform.lock.hcl`] = lock ?? mountedLock(block, lab.files)
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
  return { lab, set: (name: string, text: string) => void (disk[`${LAB}/${name}`] = text), run: (...args: string[]) => runTerraform(args, ctx) }
}
const flat = (s: string) => s.replace(/\n│ /g, ' ')

describe('terraform_remote_state', () => {
  it('feeds an output into a resource and lists the data source in state after apply', async () => {
    const w = world(MAIN)
    const plan = await w.run('plan')
    expect(plan.exitCode).toBe(0)
    expect(plan.stdout).toContain('data.terraform_remote_state.net: Reading...\ndata.terraform_remote_state.net: Read complete after 0s\n')
    expect(plan.stdout).toContain('+ vpc_id                  = "vpc-0abc"')
    expect(plan.stdout).toContain('Plan: 1 to add, 0 to change, 0 to destroy.')
    const apply = await w.run('apply', '-auto-approve')
    expect(apply.exitCode).toBe(0)
    expect((await w.run('state', 'list')).stdout).toBe('aws_subnet.a\ndata.terraform_remote_state.net')
    const show = (await w.run('state', 'show', 'data.terraform_remote_state.net')).stdout
    expect(show).toContain('# data.terraform_remote_state.net:\ndata "terraform_remote_state" "net" {')
    expect(show).toContain('backend = "s3"')
    expect(show).not.toContain(' id ')
    const rs = w.lab.state.resources.find((r) => r.mode === 'data')!
    expect(rs.provider).toBe('provider["terraform.io/builtin/terraform"]')
    expect(rs.instances[0].attributes).toEqual({ backend: 's3', config: CFG, defaults: null, outputs: REMOTE.outputs, workspace: null })
  })

  it('does not bump the serial on an unchanged re-apply', async () => {
    const w = world(MAIN)
    await w.run('apply', '-auto-approve')
    const serial = w.lab.state.serial
    const again = await w.run('apply', '-auto-approve')
    expect(again.stdout).toContain('data.terraform_remote_state.net: Read complete after 0s\n')
    expect(w.lab.state.serial).toBe(serial)
  })

  it('refresh lines come from state on later plans, also with -refresh=false', async () => {
    const w = world(MAIN)
    await w.run('apply', '-auto-approve')
    for (const flags of [[], ['-refresh=false']]) {
      const out = (await w.run('plan', ...flags)).stdout
      expect(out).toContain('data.terraform_remote_state.net: Reading...\ndata.terraform_remote_state.net: Read complete after 0s\n')
      expect(out).toContain('No changes.')
    }
  })

  it('a missing output is an Unsupported attribute error at the reference', async () => {
    const w = world(MAIN.replace('outputs.vpc_id', 'outputs.network_id'))
    const out = await w.run('plan')
    expect(out.exitCode).toBe(1)
    const e = flat(out.stderr)
    expect(e).toContain('Error: Unsupported attribute')
    expect(e).toContain('on main.tf line 10, in resource "aws_subnet" "a":')
    expect(e).toContain('This object does not have an attribute named "network_id".')
  })

  it('a first-level typo on the data source keeps the block-schema wording', async () => {
    const out = await world(MAIN.replace('outputs.vpc_id', 'output.vpc_id')).run('plan')
    expect(flat(out.stderr)).toContain('This object has no argument, nested block, or exported attribute named "output".')
  })

  it('no matching remote state fails at the data block', async () => {
    const out = await world(MAIN.replace('network/terraform.tfstate', 'network/other.tfstate')).run('plan')
    expect(out.exitCode).toBe(1)
    const e = flat(out.stderr)
    expect(e).toContain('Error: Unable to find remote state')
    expect(e).toContain('with data.terraform_remote_state.net,')
    expect(e).toContain('on main.tf line 1, in data "terraform_remote_state" "net":')
    expect(e).toContain('No stored state was found for the given workspace in the given backend.')
    expect(e).not.toContain('Unsupported attribute')
  })

  it('matches on workspace, backend and every authored config key', async () => {
    const other = { ...REMOTE, workspace: 'prod', outputs: { vpc_id: 'vpc-prod' } }
    const ws = DATA.replace('backend = "s3"', 'backend = "s3"\n  workspace = "prod"') + SUBNET
    const w = world(ws, { remote_states: [REMOTE, other] })
    expect((await w.run('plan')).stdout).toContain('"vpc-prod"')
    expect(flat((await world(MAIN.replace('"s3"', '"gcs"')).run('plan')).stderr)).toContain('Unable to find remote state')
    expect(flat((await world(ws, { remote_states: [REMOTE] }).run('plan')).stderr)).toContain('Unable to find remote state')
  })

  it('defaults fill outputs the upstream lacks', async () => {
    const src = DATA.replace('backend = "s3"', 'backend = "s3"\n  defaults = { extra = "x" }') + SUBNET.replace('outputs.vpc_id', 'outputs.extra')
    expect((await world(src).run('plan')).stdout).toContain('"x"')
  })

  it('unsupported backend type and bad argument types', async () => {
    expect(flat((await world(MAIN.replace('"s3"', '"bogus"')).run('plan')).stderr).replace(/\s+/g, ' ')).toContain('Error: Invalid backend configuration with data.terraform_remote_state.net, on main.tf line 2, in data "terraform_remote_state" "net": 2: backend = "bogus" There is no backend type named "bogus".')
    expect(flat((await world(MAIN.replace(/config = \{[^}]*\}/, 'config = "x"')).run('plan')).stderr)).toContain('The configuration must be an object value.')
    expect(flat((await world(MAIN.replace('backend = "s3"', 'backend = "s3"\n  defaults = "x"')).run('plan')).stderr)).toContain('Defaults must be given in an object value.')
    expect(flat((await world(MAIN.replace('  backend = "s3"\n', '')).run('plan')).stderr)).toContain('The argument "backend" is required, but no definition was found.')
  })

  it('unknown config values defer the read', async () => {
    const src = 'resource "aws_s3_bucket" "state" {\n  bucket = "tf-state"\n}\n' + DATA.replace('"acme-tf-state"', 'aws_s3_bucket.state.id') + SUBNET
    const w = world(src)
    const out = await w.run('plan')
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('+ vpc_id                  = (known after apply)')
    expect(out.stdout).toContain('Plan: 2 to add')
    // the bucket id is generated at apply, so the read (and the match) happens with a known value: no remote state matches
    const a = await w.run('apply', '-auto-approve')
    expect(flat(a.stderr)).toContain('Unable to find remote state')
  })

  it('drops the data source from state when its block is removed', async () => {
    const w = world(MAIN)
    await w.run('apply', '-auto-approve')
    expect((await w.run('state', 'list')).stdout).toContain('data.terraform_remote_state.net')
    w.set('main.tf', 'resource "aws_subnet" "a" {\n  vpc_id     = "vpc-1"\n  cidr_block = "10.0.1.0/24"\n}\n')
    const plan = await w.run('plan')
    expect(plan.stdout).not.toContain('Reading')
    expect(plan.stdout).not.toContain('terraform_remote_state')
    await w.run('apply', '-auto-approve')
    expect((await w.run('state', 'list')).stdout).toBe('aws_subnet.a')
    expect((await w.run('plan')).stdout).not.toContain('Reading')
  })

  it('keeps the entry while an argument is unknown (deferred read)', async () => {
    const src = 'resource "aws_s3_bucket" "state" {\n  bucket = "tf-state"\n}\n' + DATA.replace('"acme-tf-state"', 'aws_s3_bucket.state.id')
    const w = world(src)
    w.lab.state = { ...w.lab.state, resources: [{ mode: 'data', type: 'terraform_remote_state', name: 'net', provider: 'provider["terraform.io/builtin/terraform"]', instances: [{ attributes: { backend: 's3', config: CFG, defaults: null, outputs: {}, workspace: null } }] }] }
    const out = await w.run('plan')
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('data.terraform_remote_state.net: Reading...')
  })

  it('works inside a module with the module prefix', async () => {
    const files = {
      'main.tf': 'module "net" {\n  source = "./modules/net"\n}\n',
      'modules/net/main.tf': MAIN,
    }
    const w = world(files, { remote_states: [REMOTE] })
    await w.run('init')
    const plan = await w.run('plan')
    expect(plan.stdout).toContain('module.net.data.terraform_remote_state.net: Reading...')
    await w.run('apply', '-auto-approve')
    expect((await w.run('state', 'list')).stdout).toBe('module.net.aws_subnet.a\nmodule.net.data.terraform_remote_state.net')
    const missing = await world({ ...files, 'modules/net/main.tf': MAIN.replace('network/terraform.tfstate"\n', 'x"\n') }, { remote_states: [REMOTE] })
    await missing.run('init')
    expect(flat((await missing.run('plan')).stderr)).toContain('with module.net.data.terraform_remote_state.net,')
  })

  it('validate accepts the type', async () => {
    const out = await world(MAIN).run('validate')
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('Success!')
  })

  it('needs no lock entry for the built-in provider', async () => {
    const lock = 'provider "registry.terraform.io/hashicorp/aws" {\n  version = "5.67.0"\n}\n'
    const w = world(MAIN, { remote_states: [REMOTE] }, lock)
    const out = await w.run('plan')
    expect(out.stderr).not.toContain('dependency lock')
    expect(out.exitCode).toBe(0)
    const only = await world(DATA, { remote_states: [REMOTE] }, '').run('plan')
    expect(only.stderr).not.toContain('dependency lock')
  })

  it('output names such as __proto__ work', async () => {
    const outputs = JSON.parse('{"__proto__": "p", "vpc_id": "vpc-1"}')
    const w = world(MAIN, { remote_states: [{ ...REMOTE, outputs }] })
    await w.run('apply', '-auto-approve')
    const o = w.lab.state.resources.find((r) => r.mode === 'data')!.instances[0].attributes.outputs as Record<string, unknown>
    expect(Object.hasOwn(o, '__proto__')).toBe(true)
    expect(o.vpc_id).toBe('vpc-1')
    expect(flat((await world(MAIN.replace('outputs.vpc_id', 'outputs.zzz'), { remote_states: [{ ...REMOTE, outputs }] }).run('plan')).stderr)).toContain('named "zzz"')
  })

  it('without remote states nothing changes for other data sources', async () => {
    const out = await world('data "aws_region" "current" {}\n', {}).run('plan')
    expect(out.stdout).not.toContain('Reading...')
  })
})

describe('terraform.remote_states schema', () => {
  const base = { files: [{ path: 'main.tf', content: MAIN }] }
  const ok = (rs: unknown) => TerraformSchema.safeParse({ ...base, remote_states: rs })
  it('accepts a valid entry', () => {
    expect(ok([REMOTE, { ...REMOTE, workspace: 'prod' }]).success).toBe(true)
  })
  it('rejects bad entries', () => {
    expect(ok([{ ...REMOTE, backend: 'bogus' }]).success).toBe(false)
    expect(ok([{ backend: 's3', config: CFG }]).success).toBe(false)
    expect(ok([{ ...REMOTE, extra: 1 }]).success).toBe(false)
    expect(ok([{ ...REMOTE, workspace: 'bad name' }]).success).toBe(false)
  })
  it('rejects a duplicate entry in a scenario', () => {
    const scenario = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@'))!
    const parse = (rs: unknown) => ScenarioSchema.safeParse({ ...structuredClone(scenario), terraform: { ...base, remote_states: rs } })
    expect(parse([REMOTE, { ...REMOTE, workspace: 'prod' }]).success).toBe(true)
    const r = parse([REMOTE, { ...REMOTE, config: { region: 'us-east-1', key: CFG.key, bucket: CFG.bucket } }])
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('duplicate remote state')
  })
})
