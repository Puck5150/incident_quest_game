import { describe, expect, it } from 'vitest'
import { UNKNOWN, type Value } from '../src/game/terraform/eval.ts'
import { buildGraph } from '../src/game/terraform/graph.ts'
import type { ModuleTree } from '../src/game/terraform/modules.ts'
import { planConfig, type PlanResult } from '../src/game/terraform/plan.ts'
import { realityKey, type Reality } from '../src/game/terraform/refresh.ts'
import { renderPlan, renderPlanErrors } from '../src/game/terraform/render.ts'
import { emptyState, type State } from '../src/game/terraform/state.ts'

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]'
type F = { name: string; text: string }
// root text plus child modules by call name (dir modules/<name>); `dirs` overrides the directory a call reads.
const tree = (root: string, children: Record<string, string> = {}, dirs: Record<string, string> = {}): ModuleTree => ({
  root: { dir: '', files: [{ name: 'main.tf', text: root }] },
  children: new Map(
    Object.entries(children).map(([name, text]) => {
      const dir = `modules/${dirs[name] ?? name}`
      return [name, { call: { name, source: `./${dir}`, pos: { line: 1, col: 1 }, file: 'main.tf', moduleDir: '' }, files: { dir, files: [{ name: `${dir}/main.tf`, text }] as F[] } }] as const
    }),
  ),
})
type Seed = { module?: string; type: string; name: string; attrs: Record<string, Value>; status?: 'tainted' }
const stateOf = (...seeds: Seed[]): State => {
  const s = emptyState()
  for (const x of seeds) {
    s.resources.push({ ...(x.module ? { module: x.module } : {}), mode: 'managed', type: x.type, name: x.name, provider: AWS, instances: [{ ...(x.status ? { status: x.status } : {}), attributes: x.attrs }] })
  }
  return s
}
const cloudOf = (state: State): Reality =>
  Object.fromEntries(state.resources.filter((r) => r.mode === 'managed').flatMap((r) => r.instances.map((i) => [realityKey(r.type, i.attributes.id as string), i.attributes] as const)))
const plan = (t: ModuleTree, o: { state?: State; reality?: Reality; vars?: Record<string, Value>; replace?: string[]; destroy?: boolean } = {}): PlanResult => {
  const state = o.state ?? emptyState()
  return planConfig({ files: t.root.files, tree: t, state, reality: o.reality ?? cloudOf(state), vars: o.vars ?? {}, ...(o.replace ? { replace: o.replace } : {}), ...(o.destroy ? { destroy: true } : {}) })
}
const actions = (r: PlanResult) => r.items.filter((i) => i.action !== 'noop').map((i) => `${i.action} ${i.address}`)
const sources = (t: ModuleTree) => Object.fromEntries([t.root.files, ...[...t.children.values()].map((c) => c.files.files)].flat().map((f) => [f.name, f.text]))

const NET = `variable "cidr" {}
resource "aws_vpc" "main" {
  cidr_block = var.cidr
}
output "vpc_id" {
  value = aws_vpc.main.id
}
`
const ROOT = `module "net" {
  source = "./modules/net"
  cidr   = "10.0.0.0/16"
}
resource "aws_subnet" "a" {
  vpc_id     = module.net.vpc_id
  cidr_block = "10.0.1.0/24"
}
resource "aws_s3_bucket" "logs" {
  bucket = "logs"
}
`
const vpc = { id: 'vpc-1', arn: 'arn:aws:ec2:us-east-1:123456789012:vpc/vpc-1', cidr_block: '10.0.0.0/16' }

describe('planConfig over a module tree', () => {
  it('(a) creates module resources at qualified addresses, ordered module first, with exact text', () => {
    const t = tree(ROOT, { net: NET })
    const r = plan(t)
    expect(r.diagnostics).toEqual([])
    expect(actions(r)).toEqual(['create aws_s3_bucket.logs', 'create aws_subnet.a', 'create module.net.aws_vpc.main'])
    const sub = r.items.find((i) => i.address === 'aws_subnet.a')!
    expect(sub.dependsOn).toEqual(['module.net.aws_vpc.main'])
    const vp = r.items.find((i) => i.module === 'module.net')!
    expect(vp).toMatchObject({ address: 'module.net.aws_vpc.main', resource: 'aws_vpc.main', type: 'aws_vpc', name: 'main', block: { file: 'modules/net/main.tf', line: 2, col: 1 } })
    const text = renderPlan(r, sources(t))
    expect(text).toContain('  # module.net.aws_vpc.main will be created\n  + resource "aws_vpc" "main" {')
    expect(text).toContain(
      [
        '  # module.net.aws_vpc.main will be created',
        '  + resource "aws_vpc" "main" {',
        '      + arn                       = (known after apply)',
        '      + cidr_block                = "10.0.0.0/16"',
        '      + default_security_group_id = (known after apply)',
        '      + enable_dns_hostnames      = false',
        '      + enable_dns_support        = true',
        '      + id                        = (known after apply)',
        '      + tags_all                  = (known after apply)',
        '    }',
      ].join('\n'),
    )
    expect(text).toContain('Plan: 3 to add, 0 to change, 0 to destroy.')
    expect(text.indexOf('# aws_s3_bucket.logs')).toBeLessThan(text.indexOf('# aws_subnet.a'))
    expect(text.indexOf('# aws_subnet.a')).toBeLessThan(text.indexOf('# module.net.aws_vpc.main'))
  })

  it('(b) module inputs: root variable with and without default, unknown propagation, output into a root resource', () => {
    const root = `variable "cidr" {
  default = "10.9.0.0/16"
}
module "net" {
  source = "./modules/net"
  cidr   = var.cidr
}
output "vpc" {
  value = module.net.vpc_id
}
`
    const r = plan(tree(root, { net: NET }))
    expect(r.diagnostics).toEqual([])
    expect(r.items[0].changes.find((c) => c.name === 'cidr_block')?.after).toBe('10.9.0.0/16')
    expect(r.outputs).toEqual([{ name: 'vpc', value: UNKNOWN, sensitive: false }])
    expect(plan(tree(root, { net: NET }), { vars: { cidr: '10.1.0.0/16' } }).items[0].changes.find((c) => c.name === 'cidr_block')?.after).toBe('10.1.0.0/16')
    // without a default and without a value: the root error, nothing planned
    const nodef = plan(tree(root.replace(/default = .*\n/, ''), { net: NET }))
    expect(nodef.diagnostics.map((d) => d.summary)).toEqual(['No value for required variable'])
    // an unknown input makes the dependent attribute unknown
    const unk = plan(tree(`resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\nmodule "net" {\n  source = "./modules/net"\n  cidr   = aws_s3_bucket.b.arn\n}\n`, { net: NET }))
    expect(unk.items.find((i) => i.module === 'module.net')!.changes.find((c) => c.name === 'cidr_block')?.after).toBe(UNKNOWN)
    expect(renderPlan(unk)).toContain('+ cidr_block                = (known after apply)')
  })

  it('(b) a module variable default applies when the call omits it, and module locals and outputs chain', () => {
    const child = `variable "cidr" {
  default = "10.5.0.0/16"
}
locals {
  c = var.cidr
}
resource "aws_vpc" "main" {
  cidr_block = local.c
}
output "cidr" {
  value = local.c
}
`
    const r = plan(tree(`module "net" {\n  source = "./modules/net"\n}\noutput "c" {\n  value = module.net.cidr\n}\n`, { net: child }))
    expect(r.diagnostics).toEqual([])
    expect(r.outputs[0].value).toBe('10.5.0.0/16')
    expect(r.items[0].changes.find((c) => c.name === 'cidr_block')?.after).toBe('10.5.0.0/16')
  })

  it('(c) the refactor without moved: destroy the root resource, create the module one', () => {
    const state = stateOf({ type: 'aws_vpc', name: 'main', attrs: vpc })
    const t = tree(`module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\n`, { net: NET })
    const r = plan(t, { state })
    expect(r.diagnostics).toEqual([])
    expect(actions(r)).toEqual(['destroy aws_vpc.main', 'create module.net.aws_vpc.main'])
    const text = renderPlan(r)
    expect(text).toContain('  # aws_vpc.main will be destroyed\n  # (because aws_vpc.main is not in configuration)')
    expect(text).toContain('  # module.net.aws_vpc.main will be created')
    expect(text).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
  })

  it('(c) prevent_destroy inside the module guards only that resource, located in the module file', () => {
    const guarded = NET.replace('cidr_block = var.cidr', 'cidr_block = var.cidr\n  lifecycle {\n    prevent_destroy = true\n  }')
    const state = stateOf({ module: 'module.net', type: 'aws_vpc', name: 'main', attrs: { ...vpc, cidr_block: '10.9.0.0/16' } })
    const t = tree(`module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\n`, { net: guarded })
    const r = plan(t, { state })
    expect(r.partial).toBe(true)
    expect(r.diagnostics).toHaveLength(1)
    expect(r.diagnostics[0]).toMatchObject({ summary: 'Instance cannot be destroyed', file: 'modules/net/main.tf', line: 2, context: 'resource "aws_vpc" "main"' })
    expect(r.diagnostics[0].detail).toContain('Resource module.net.aws_vpc.main has lifecycle.prevent_destroy set')
    expect(renderPlanErrors(r, sources(t))).toContain('on modules/net/main.tf line 2, in resource "aws_vpc" "main":')
    // a protected root resource moved into the module is not guarded: it is simply gone from the configuration
    const root = stateOf({ type: 'aws_vpc', name: 'main', attrs: vpc })
    expect(plan(tree(`module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\n`, { net: guarded }), { state: root }).diagnostics).toEqual([])
  })

  it('(d) removing the module call destroys its resources with the module-gone reason', () => {
    const state = stateOf({ module: 'module.net', type: 'aws_vpc', name: 'main', attrs: vpc }, { type: 'aws_s3_bucket', name: 'logs', attrs: { id: 'logs', bucket: 'logs', arn: 'arn:aws:s3:::logs' } })
    const r = plan(tree(`resource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n`), { state })
    expect(r.diagnostics).toEqual([])
    expect(r.items.find((i) => i.action === 'destroy')).toMatchObject({ address: 'module.net.aws_vpc.main', module: 'module.net', destroyReason: 'module-gone' })
    expect(renderPlan(r)).toContain('  # module.net.aws_vpc.main will be destroyed\n  # (because module.net is not in configuration)')
  })

  it('(d) a resource removed from a module that remains is not-in-configuration, unqualified', () => {
    const state = stateOf({ module: 'module.net', type: 'aws_vpc', name: 'old', attrs: vpc })
    const r = plan(tree(`module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\n`, { net: NET }), { state })
    expect(renderPlan(r)).toContain('  # module.net.aws_vpc.old will be destroyed\n  # (because aws_vpc.old is not in configuration)')
  })

  it('(e) drift in a module resource prints the qualified address', () => {
    const state = stateOf({ module: 'module.net', type: 'aws_vpc', name: 'main', attrs: vpc })
    const reality = { [realityKey('aws_vpc', 'vpc-1')]: { ...vpc, enable_dns_support: false } }
    const t = tree(`module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\noutput "dns" {\n  value = module.net.dns\n}\n`, { net: `${NET.replace('var.cidr', 'var.cidr\n  enable_dns_support = true')}output "dns" {\n  value = aws_vpc.main.enable_dns_support\n}\n` })
    const r = plan(t, { state, reality })
    expect(r.drift.map((d) => d.address)).toEqual(['module.net.aws_vpc.main'])
    const text = renderPlan(r)
    expect(text).toContain('# module.net.aws_vpc.main has changed')
    expect(text).toContain('resource "aws_vpc" "main" {')
    expect(text).toContain('# module.net.aws_vpc.main will be updated in-place')
    // deleted
    const gone = plan(t, { state, reality: {} })
    expect(renderPlan(gone)).toContain('# module.net.aws_vpc.main has been deleted')
  })

  it('(f) update and replace of a module resource', () => {
    const state = stateOf({ module: 'module.net', type: 'aws_vpc', name: 'main', attrs: vpc })
    const t = (cidr: string) => tree(`module "net" {\n  source = "./modules/net"\n  cidr   = "${cidr}"\n}\n`, { net: NET })
    const rep = plan(t('10.2.0.0/16'), { state })
    expect(actions(rep)).toEqual(['replace module.net.aws_vpc.main'])
    const text = renderPlan(rep)
    expect(text).toContain('  # module.net.aws_vpc.main must be replaced')
    expect(text).toContain('# forces replacement')
    const same = plan(t('10.0.0.0/16'), { state })
    expect(actions(same)).toEqual([])
    expect(same.items[0]).toMatchObject({ address: 'module.net.aws_vpc.main', action: 'noop' })
    const req = plan(t('10.0.0.0/16'), { state, replace: ['module.net.aws_vpc.main'] })
    expect(renderPlan(req)).toContain('# module.net.aws_vpc.main will be replaced, as requested')
    const tainted = plan(t('10.0.0.0/16'), { state: stateOf({ module: 'module.net', type: 'aws_vpc', name: 'main', attrs: vpc, status: 'tainted' }) })
    expect(renderPlan(tainted)).toContain('# module.net.aws_vpc.main is tainted, so must be replaced')
  })

  it('(g) two calls to the same directory are distinct instances with distinct state addresses', () => {
    const root = `module "a" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\nmodule "b" {\n  source = "./modules/net"\n  cidr   = "10.1.0.0/16"\n}\nresource "aws_subnet" "s" {\n  vpc_id     = module.b.vpc_id\n  cidr_block = "10.1.1.0/24"\n}\n`
    const t = tree(root, { a: NET, b: NET }, { a: 'net', b: 'net' })
    const g = buildGraph(t)
    expect([...g.nodes.keys()].filter((k) => k.includes('aws_vpc'))).toEqual(['module.a.aws_vpc.main', 'module.b.aws_vpc.main'])
    const r = plan(t)
    expect(r.diagnostics).toEqual([])
    expect(actions(r)).toEqual(['create aws_subnet.s', 'create module.a.aws_vpc.main', 'create module.b.aws_vpc.main'])
    expect(r.items.find((i) => i.address === 'module.b.aws_vpc.main')!.changes.find((c) => c.name === 'cidr_block')?.after).toBe('10.1.0.0/16')
    expect(r.items.find((i) => i.address === 'aws_subnet.s')!.dependsOn).toEqual(['module.b.aws_vpc.main'])
    // prior state of one instance only matches that instance
    const state = stateOf({ module: 'module.a', type: 'aws_vpc', name: 'main', attrs: vpc })
    expect(actions(plan(t, { state }))).toEqual(['create aws_subnet.s', 'create module.b.aws_vpc.main'])
  })

  it('(g) a syntax error in a shared directory is reported once', () => {
    const t = tree(`module "a" {\n  source = "./modules/net"\n  cidr = "x"\n}\nmodule "b" {\n  source = "./modules/net"\n  cidr = "y"\n}\n`, { a: 'resource "aws_vpc" {', b: 'resource "aws_vpc" {' }, { a: 'net', b: 'net' })
    const r = buildGraph(t)
    expect(r.diagnostics.length).toBeGreaterThan(0)
    const keys = r.diagnostics.map((d) => `${d.file}:${d.line}:${d.col}:${d.summary}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(r.diagnostics.filter((d) => d.file === 'modules/net/main.tf')).toHaveLength(1)
  })

  it('(h) count, for_each and nested calls are unsupported with clear diagnostics', () => {
    const c = plan(tree(`module "net" {\n  source = "./modules/net"\n  cidr   = "x"\n  count  = 2\n}\n`, { net: NET }))
    expect(c.diagnostics).toMatchObject([{ summary: 'Unsupported', detail: 'Module count and for_each are not supported by this lab yet.', file: 'main.tf', line: 4, context: 'module "net"' }])
    const f = plan(tree(`module "net" {\n  source = "./modules/net"\n  cidr   = "x"\n  for_each = { a = 1 }\n}\n`, { net: NET }))
    expect(f.diagnostics.map((d) => d.detail)).toEqual(['Module count and for_each are not supported by this lab yet.'])
    const n = plan(tree(`module "net" {\n  source = "./modules/net"\n  cidr   = "x"\n}\n`, { net: `${NET}module "inner" {\n  source = "./inner"\n}\n` }))
    expect(n.diagnostics).toMatchObject([{ summary: 'Unsupported', detail: 'Nested modules are not supported by this lab yet.', file: 'modules/net/main.tf', line: 8, context: 'module "inner"' }])
    expect(n.items).toEqual([])
  })

  it('(h) child diagnostics carry the module file and column', () => {
    const r = buildGraph(tree(`module "net" {\n  source = "./modules/net"\n  cidr   = "x"\n}\n`, { net: `variable "cidr" {}\nresource "aws_vpc" "main" {\n  cidr_block = var.nope\n}\n` }))
    expect(r.diagnostics).toMatchObject([{ summary: 'Reference to undeclared input variable', file: 'modules/net/main.tf', line: 3, col: 16 }])
  })

  it('(i) outputs, terraform.workspace and path.module', () => {
    const child = `variable "cidr" {}\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n  tags = {\n    ws  = terraform.workspace\n    dir = path.module\n  }\n}\n`
    const r = planConfig({
      ...{ files: [], tree: tree(`module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\noutput "w" {\n  value = [terraform.workspace, path.module]\n}\n`, { net: child }) },
      state: emptyState(),
      reality: {},
      vars: {},
      workspace: 'dev',
    })
    expect(r.diagnostics).toEqual([])
    expect(r.outputs).toEqual([{ name: 'w', value: ['dev', '.'], sensitive: false }])
    expect(r.items[0].changes.find((c) => c.name === 'tags')?.after).toEqual({ ws: 'dev', dir: 'modules/net' })
    expect(renderPlan(r)).toContain('Changes to Outputs:')
  })

  it('plan -destroy over module resources keeps the module address and block', () => {
    const state = stateOf({ module: 'module.net', type: 'aws_vpc', name: 'main', attrs: vpc })
    const r = plan(tree(`module "net" {\n  source = "./modules/net"\n  cidr   = "x"\n}\n`, { net: NET }), { state, destroy: true })
    expect(r.items).toMatchObject([{ address: 'module.net.aws_vpc.main', module: 'module.net', resource: 'aws_vpc.main', block: { file: 'modules/net/main.tf' } }])
  })
})
