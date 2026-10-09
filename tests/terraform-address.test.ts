import { describe, expect, it } from 'vitest'
import { addressCovers, compareAddresses, formatModule, formatResAddr, parseModuleAddr, parseResAddr, resourceKey, staticKey } from '../src/game/terraform/address.ts'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import { realityKey } from '../src/game/terraform/refresh.ts'
import { importObject, parseAddress, stateMove, stateRemove, taintInstance } from '../src/game/terraform/state-ops.ts'
import { findInstance, instanceAddress, listAddresses, stateJson } from '../src/game/terraform/state.ts'
import { ScenarioSchema, TerraformSchema, type TerraformBlock } from '../src/schema/scenario.ts'

describe('address parsing', () => {
  it.each([
    'aws_x.y',
    'aws_x.y[0]',
    'aws_x.y["a.b"]',
    'data.aws_x.y',
    'module.net.aws_x.y',
    'module.net["a"].aws_x.y["k"]',
    'module.a.module.b.aws_x.y',
    'module.a[2].module.b["z"].data.aws_x.y[1]',
    'module.__proto__.aws_x.__proto__',
  ])('round-trips %s', (t) => {
    const a = parseResAddr(t)
    expect(a).toBeDefined()
    expect(formatResAddr(a!)).toBe(t)
  })
  it('splits module steps, mode and key', () => {
    expect(parseResAddr('module.net["a"].data.aws_x.y[0]')).toEqual({ module: [{ name: 'net', key: 'a' }], mode: 'data', type: 'aws_x', name: 'y', key: 0 })
  })
  it('parses module-only addresses', () => {
    expect(parseModuleAddr('module.net')).toEqual([{ name: 'net' }])
    expect(formatModule(parseModuleAddr('module.net["a"].module.sub')!)).toBe('module.net["a"].module.sub')
    expect(parseModuleAddr('module.net.aws_x.y')).toBeUndefined()
    expect(parseModuleAddr('aws_x.y')).toBeUndefined()
  })
  it.each(['module.net', 'module.net.', 'aws_x', 'aws_x.y.', 'aws_x.y[', 'aws_x.y["k]', ' aws_x.y', 'aws_x.y ', 'module.net[.aws_x.y', 'var.x.y', 'module.net.var.x', '', 'module.', 'module..aws_x.y'])('rejects %j as a resource', (t) => {
    expect(parseResAddr(t)).toBeUndefined()
  })
  it('builds identity keys', () => {
    const a = parseResAddr('module.net["a"].aws_x.y[0]')!
    expect(resourceKey(a)).toBe('module.net["a"].aws_x.y')
    expect(staticKey(a)).toBe('module.net.aws_x.y')
  })
  it('sorts root first, then module path step by step (a prefix first), then name and key', () => {
    const list = ['module.b.aws_a.x', 'module.net["a"].aws_a.x', 'module.net.aws_a.x', 'module.a.module.z.aws_a.x', 'data.aws_a.y', 'aws_z.x', 'aws_a.x[1]', 'aws_a.x', 'module.net[0].aws_a.x']
    expect([...list].sort(compareAddresses)).toEqual(['aws_a.x', 'aws_a.x[1]', 'aws_z.x', 'data.aws_a.y', 'module.a.module.z.aws_a.x', 'module.b.aws_a.x', 'module.net.aws_a.x', 'module.net[0].aws_a.x', 'module.net["a"].aws_a.x'])
  })
  it('covers by segment', () => {
    expect(addressCovers('aws_x.y', 'aws_x.y[0]')).toBe(true)
    expect(addressCovers('aws_x.y[0]', 'aws_x.y[1]')).toBe(false)
    expect(addressCovers('aws_x.y', 'aws_x.yy')).toBe(false)
    expect(addressCovers('module.net.aws_x.y', 'module.net["a"].aws_x.y[1]')).toBe(true)
    expect(addressCovers('module.net["b"].aws_x.y', 'module.net["a"].aws_x.y')).toBe(false)
    expect(addressCovers('module.net', 'module.net["a"].aws_x.y')).toBe(true)
    expect(addressCovers('module.net', 'module.network.aws_x.y')).toBe(false)
    expect(addressCovers('module.net', 'aws_x.y')).toBe(false)
    expect(addressCovers('aws_x.y', 'module.net.aws_x.y')).toBe(false)
  })
})

const attrs = (id: string, extra: object = {}) => ({ id, arn: `arn:${id}`, ...extra })
const entries = [
  { type: 'aws_vpc', name: 'main', attrs: attrs('vpc-root', { cidr_block: '10.0.0.0/16' }) },
  { module: 'module.net', type: 'aws_vpc', name: 'main', attrs: attrs('vpc-net', { cidr_block: '10.1.0.0/16' }) },
  { module: 'module.net', type: 'aws_subnet', name: 's', key: 0, attrs: attrs('subnet-0', { vpc_id: 'vpc-net' }) },
  { module: 'module.net', type: 'aws_subnet', name: 's', key: 1, attrs: attrs('subnet-1', { vpc_id: 'vpc-net' }) },
  { module: 'module.sets["a"]', type: 'aws_vpc', name: 'main', attrs: attrs('vpc-a') },
]
const DIR = '/home/you/infra'
const tf = { files: [{ path: 'main.tf', content: '' }], state: entries } as unknown as TerraformBlock
const lab = () => labFromScenario(tf, DIR, '/home/you')

describe('module resources in state', () => {
  it('buildState keeps the module and derives dependencies with resourceKey', () => {
    const s = lab().state
    expect(s.resources.map((r) => r.module)).toEqual([undefined, 'module.net', 'module.net', 'module.sets["a"]'])
    expect(s.resources[2].instances[0].dependencies).toEqual(['module.net.aws_vpc.main'])
  })
  it('lists in module order and finds instances', () => {
    const s = lab().state
    expect(listAddresses(s)).toEqual(['aws_vpc.main', 'module.net.aws_subnet.s[0]', 'module.net.aws_subnet.s[1]', 'module.net.aws_vpc.main', 'module.sets["a"].aws_vpc.main'])
    expect(findInstance(s, 'module.net.aws_subnet.s[1]')?.instance.attributes.id).toBe('subnet-1')
    expect(findInstance(s, 'aws_subnet.s[1]')).toBeUndefined()
    expect(instanceAddress({ module: 'module.sets["a"]', mode: 'data', type: 't', name: 'n' }, 'k')).toBe('module.sets["a"].data.t.n["k"]')
  })
  it('writes module first in a tfstate resource entry', () => {
    const doc = JSON.parse(stateJson(lab().state)) as { resources: Record<string, unknown>[] }
    expect(Object.keys(doc.resources[0])).toEqual(['mode', 'type', 'name', 'provider', 'instances'])
    expect(Object.keys(doc.resources[1])).toEqual(['module', 'mode', 'type', 'name', 'provider', 'instances'])
    expect(doc.resources[1].module).toBe('module.net')
  })
})

describe('state-ops with module addresses', () => {
  const s = () => lab().state
  it('parseAddress carries the module', () => {
    expect(parseAddress('module.net["a"].aws_x.y[0]')).toEqual({ ok: true, mode: 'managed', type: 'aws_x', name: 'y', key: 0, module: 'module.net["a"]' })
  })
  it('moves a root resource into a module and back', () => {
    const r = stateMove(s(), 'aws_vpc.main', 'module.other.aws_vpc.main')
    expect(r.ok && r.moved).toEqual([{ from: 'aws_vpc.main', to: 'module.other.aws_vpc.main' }])
    if (!r.ok) return
    expect(r.state.resources.find((x) => x.module === 'module.other')?.provider).toBe('provider["registry.terraform.io/hashicorp/aws"]')
    const back = stateMove(r.state, 'module.other.aws_vpc.main', 'aws_vpc.main')
    expect(back.ok && back.state.resources.find((x) => x.name === 'main' && !x.module)).toBeTruthy()
    expect(back.ok && 'module' in back.state.resources.find((x) => x.name === 'main' && x.instances[0].attributes.id === 'vpc-root')!).toBe(false)
  })
  it('refuses to move onto an existing module resource', () => {
    expect(stateMove(s(), 'aws_vpc.main', 'module.net.aws_vpc.main')).toMatchObject({ ok: false, detail: 'Cannot move to module.net.aws_vpc.main: there is already a resource instance at that address in the current state.' })
  })
  it('moves one module instance key and rewrites dependencies', () => {
    const r = stateMove(s(), 'module.net.aws_subnet.s[1]', 'module.net.aws_subnet.s[5]')
    expect(r.ok && r.moved).toEqual([{ from: 'module.net.aws_subnet.s[1]', to: 'module.net.aws_subnet.s[5]' }])
  })
  it('renames a module, keeping keys and rewriting dependencies', () => {
    const r = stateMove(s(), 'module.net', 'module.core')
    expect(r.ok && r.moved.map((m) => m.to)).toEqual(['module.core.aws_subnet.s[0]', 'module.core.aws_subnet.s[1]', 'module.core.aws_vpc.main'])
    if (!r.ok) return
    expect(listAddresses(r.state)).toEqual(['aws_vpc.main', 'module.core.aws_subnet.s[0]', 'module.core.aws_subnet.s[1]', 'module.core.aws_vpc.main', 'module.sets["a"].aws_vpc.main'])
    expect(r.state.resources.find((x) => x.type === 'aws_subnet')?.instances[0].dependencies).toEqual(['module.core.aws_vpc.main'])
  })
  it('moves a keyed module instance and rejects mixing modules and resources', () => {
    const r = stateMove(s(), 'module.sets["a"]', 'module.sets["b"]')
    expect(r.ok && r.moved).toEqual([{ from: 'module.sets["a"].aws_vpc.main', to: 'module.sets["b"].aws_vpc.main' }])
    expect(stateMove(s(), 'module.net', 'aws_vpc.x')).toMatchObject({ ok: false })
    expect(stateMove(s(), 'module.nope', 'module.x')).toMatchObject({ ok: false, detail: 'Cannot move module.nope: does not match anything in the current state.' })
    expect(stateMove(s(), 'module.net', 'module.sets["a"]')).toMatchObject({ ok: false })
  })
  it('removes a whole module or one resource', () => {
    const all = stateRemove(s(), ['module.net'])
    expect(all.ok && all.removed).toEqual(['module.net.aws_vpc.main', 'module.net.aws_subnet.s[0]', 'module.net.aws_subnet.s[1]'])
    const one = stateRemove(s(), ['module.net.aws_subnet.s'])
    expect(one.ok && one.removed).toEqual(['module.net.aws_subnet.s[0]', 'module.net.aws_subnet.s[1]'])
    const root = stateRemove(s(), ['aws_vpc.main'])
    expect(root.ok && root.removed).toEqual(['aws_vpc.main'])
    expect(stateRemove(s(), ['module.net["x"]'])).toMatchObject({ ok: false })
  })
  it('taints a module instance', () => {
    const r = taintInstance(s(), 'module.net.aws_subnet.s[0]')
    expect(r.ok && findInstance(r.state, 'module.net.aws_subnet.s[0]')?.instance.status).toBe('tainted')
    expect(taintInstance(s(), 'aws_subnet.s[0]')).toMatchObject({ ok: false })
  })
  it('imports into a module when declared, and names the module otherwise', () => {
    const reality = { [realityKey('aws_vpc', 'vpc-new')]: { id: 'vpc-new' } }
    const r = importObject(s(), reality, 'module.net.aws_vpc.extra', 'vpc-new', true)
    expect(r.ok && findInstance(r.state, 'module.net.aws_vpc.extra')?.resource.module).toBe('module.net')
    expect(importObject(s(), reality, 'module.net.aws_vpc.extra', 'vpc-new', false)).toMatchObject({
      ok: false,
      summary: 'Resource address "module.net.aws_vpc.extra" does not exist in the configuration.',
    })
  })
})

describe('state commands in the CLI', () => {
  function world() {
    const l = lab()
    const disk: Record<string, string> = { [`${DIR}/.terraform.lock.hcl`]: LOCK_FILE, [`${DIR}/main.tf`]: '' }
    const ctx: CliContext = {
      lab: l,
      cwd: DIR,
      mainHost: true,
      env: {},
      taken: new Set(),
      listFiles: async (dir) => Object.entries(disk).filter(([p]) => p.slice(0, p.lastIndexOf('/')) === dir).map(([p, text]) => ({ name: p.slice(p.lastIndexOf('/') + 1), text })),
      readFile: async (p) => disk[p],
      write: async (dir, name, text) => void (disk[`${dir}/${name}`] = text),
    }
    return { l, run: (...args: string[]) => runTerraform(args, ctx) }
  }
  it('state list, filtered by module', async () => {
    const w = world()
    expect((await w.run('state', 'list')).stdout.split('\n')).toHaveLength(5)
    expect((await w.run('state', 'list', 'module.net')).stdout).toBe('module.net.aws_subnet.s[0]\nmodule.net.aws_subnet.s[1]\nmodule.net.aws_vpc.main')
    expect((await w.run('state', 'list', 'module.net.aws_subnet.s[1]')).stdout).toBe('module.net.aws_subnet.s[1]')
  })
  it('state show prints the qualified header', async () => {
    const r = await world().run('state', 'show', 'module.net.aws_vpc.main')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.split('\n').slice(0, 2)).toEqual(['# module.net.aws_vpc.main:', 'resource "aws_vpc" "main" {'])
  })
  it('state mv and rm with modules', async () => {
    const w = world()
    const mv = await w.run('state', 'mv', 'aws_vpc.main', 'module.other.aws_vpc.main')
    expect(mv.stdout).toBe('Move "aws_vpc.main" to "module.other.aws_vpc.main"\nSuccessfully moved 1 object(s).')
    const rm = await w.run('state', 'rm', 'module.net')
    expect(rm.stdout).toBe('Removed module.net.aws_vpc.main\nRemoved module.net.aws_subnet.s[0]\nRemoved module.net.aws_subnet.s[1]\nSuccessfully removed 3 resource instance(s).')
    expect(listAddresses(w.l.state)).toEqual(['module.other.aws_vpc.main', 'module.sets["a"].aws_vpc.main'])
  })
  it('taint, untaint and -replace accept module addresses', async () => {
    const w = world()
    expect((await w.run('taint', 'module.net.aws_vpc.main')).stdout).toBe('Resource instance module.net.aws_vpc.main has been marked as tainted.')
    expect((await w.run('untaint', 'module.net.aws_vpc.main')).exitCode).toBe(0)
    const r = await w.run('plan', '-replace=module.net.aws_vpc.main')
    expect(r.stdout).not.toContain('Invalid force-replace address')
    const bad = await w.run('plan', '-replace=data.aws_x.y')
    expect(bad.stderr + bad.stdout).toContain('Invalid force-replace address')
  })
  it('import into a module that is not in the configuration names the address', async () => {
    const r = await world().run('import', 'module.net.aws_vpc.extra', 'vpc-x')
    expect(r.exitCode).toBe(1)
    expect(r.stderr + r.stdout).toContain('Resource address "module.net.aws_vpc.extra" does not exist in the configuration.')
  })
})

describe('scenario schema', () => {
  const base = { files: [{ path: 'main.tf', content: 'x' }] }
  it('accepts module on state entries and module prefixes in faults.at', () => {
    expect(TerraformSchema.safeParse({ ...base, state: [{ module: 'module.net["a"].module.sub', type: 'aws_vpc', name: 'm', attrs: { id: 'v' } }] }).success).toBe(true)
    expect(TerraformSchema.safeParse({ ...base, faults: [{ at: 'module.net["a"].aws_s3_bucket.b', on: 'create', error: 'x' }] }).success).toBe(true)
  })
  it('rejects malformed module paths', () => {
    for (const m of ['net', 'module.', 'module.net.aws_vpc.m', 'module.net[']) {
      expect(TerraformSchema.safeParse({ ...base, state: [{ module: m, type: 'aws_vpc', name: 'm', attrs: { id: 'v' } }] }).success, m).toBe(false)
    }
  })
  it('is exported with the scenario schema', () => {
    expect(ScenarioSchema).toBeDefined()
  })
})
