import { describe, expect, it } from 'vitest'
import { buildGraph } from '../src/game/terraform/graph.ts'
import type { ModuleTree } from '../src/game/terraform/modules.ts'

type F = { name: string; text: string }
// root files plus child modules by call name; each child is a list of files named by lab-relative path
const tree = (root: string, children: Record<string, string> = {}): ModuleTree => ({
  root: { dir: '', files: [{ name: 'main.tf', text: root }] },
  children: new Map(
    Object.entries(children).map(([name, text]): [string, ModuleTree['children'] extends Map<string, infer V> ? V : never] => [
      name,
      { call: { name, source: `./modules/${name}`, pos: { line: 1, col: 1 }, file: 'main.tf', moduleDir: '' }, files: { dir: `modules/${name}`, files: [{ name: `modules/${name}/main.tf`, text }] as F[] } },
    ]),
  ),
})

const ROOT = `variable "cidr" {
  default = "10.0.0.0/16"
}
module "net" {
  source = "./modules/net"
  cidr   = var.cidr
}
resource "aws_subnet" "a" {
  vpc_id = module.net.vpc_id
}
`
const NET = `variable "cidr" {}
resource "aws_vpc" "main" {
  cidr_block = var.cidr
}
output "vpc_id" {
  value = aws_vpc.main.id
}
`

describe('module references', () => {
  it('parse and resolve: module.net.vpc_id and module.net["a"].vpc_id name the output node', () => {
    const r = buildGraph(tree(ROOT.replace('module.net.vpc_id', 'module.net["a"].vpc_id'), { net: NET }))
    expect(r.diagnostics).toEqual([])
    expect(r.nodes.get('aws_subnet.a')!.refs.map((x) => x.path)).toEqual([['module', 'net', 'vpc_id']])
    expect(r.nodes.get('aws_subnet.a')!.deps).toEqual(['module.net.output.vpc_id'])
    const plain = buildGraph(tree(ROOT, { net: NET }))
    expect(plain.nodes.get('aws_subnet.a')!.deps).toEqual(['module.net.output.vpc_id'])
  })

  it('a whole-object reference depends on every output', () => {
    const r = buildGraph(tree(ROOT.replace('module.net.vpc_id', 'module.net'), { net: NET + 'output "other" {\n  value = 1\n}\n' }))
    expect(r.nodes.get('aws_subnet.a')!.deps).toEqual(['module.net.output.other', 'module.net.output.vpc_id'])
  })
})

describe('module graph', () => {
  const r = buildGraph(tree(ROOT, { net: NET }))

  it('addresses every module object with the module path', () => {
    expect(r.diagnostics).toEqual([])
    expect([...r.nodes.keys()].sort()).toEqual(['aws_subnet.a', 'module.net', 'module.net.aws_vpc.main', 'module.net.output.vpc_id', 'module.net.var.cidr', 'var.cidr'])
    const v = r.nodes.get('module.net.var.cidr')!
    expect([v.module, v.local, v.kind, v.file]).toEqual(['module.net', 'var.cidr', 'variable', 'modules/net/main.tf'])
    const call = r.nodes.get('module.net')!
    expect([call.module, call.local, call.kind, call.child]).toEqual(['', 'module.net', 'module', 'module.net'])
    expect(r.nodes.get('aws_subnet.a')!.module).toBe('')
    expect(r.blocks.map((b) => b.file)).toEqual(['main.tf', 'main.tf', 'main.tf', 'modules/net/main.tf', 'modules/net/main.tf', 'modules/net/main.tf'])
  })

  it('resolves dependencies across the boundary in both directions', () => {
    const d = (a: string) => r.nodes.get(a)!.deps
    expect(d('module.net')).toEqual([])
    expect(d('module.net.var.cidr')).toEqual(['module.net', 'var.cidr']) // the call argument, in the parent scope
    expect(d('module.net.aws_vpc.main')).toEqual(['module.net', 'module.net.var.cidr'])
    expect(d('module.net.output.vpc_id')).toEqual(['module.net', 'module.net.aws_vpc.main'])
    expect(d('aws_subnet.a')).toEqual(['module.net.output.vpc_id'])
    expect(r.nodes.get('module.net.var.cidr')!.arg).toMatchObject({ file: 'main.tf', pos: { line: 6 } })
    expect(r.nodes.get('var.cidr')!.arg).toBeUndefined()
  })

  it('orders dependencies first', () => {
    expect(r.order).toEqual(['module.net', 'var.cidr', 'module.net.var.cidr', 'module.net.aws_vpc.main', 'module.net.output.vpc_id', 'aws_subnet.a'])
  })

  it('the call depends on count, for_each and depends_on, not on its arguments', () => {
    const g = buildGraph(tree(`variable "n" {}\nresource "aws_x" "y" {}\nmodule "net" {\n  source = "./modules/net"\n  count = var.n\n  depends_on = [aws_x.y]\n  cidr = var.n\n}\n`, { net: NET }))
    expect(g.diagnostics).toEqual([])
    expect(g.nodes.get('module.net')!.deps).toEqual(['aws_x.y', 'var.n'])
    expect(g.nodes.get('module.net.var.cidr')!.deps).toEqual(['module.net', 'var.n'])
  })

  it('the same name in two modules is fine, and a locals or data reference resolves inside its module', () => {
    const g = buildGraph(tree(`${ROOT}locals {\n  x = 1\n}\ndata "aws_ami" "a" {}\n`, { net: `${NET}locals {\n  x = 2\n}\ndata "aws_ami" "a" {}\nresource "aws_instance" "i" {\n  ami = data.aws_ami.a.id\n  tags = local.x\n}\n` }))
    expect(g.diagnostics).toEqual([])
    expect(g.nodes.get('module.net.aws_instance.i')!.deps).toEqual(['module.net', 'module.net.data.aws_ami.a', 'module.net.local.x'])
  })
})

describe('module diagnostics', () => {
  const diag = (root: string, net: string) => buildGraph(tree(root, { net })).diagnostics

  it('undeclared references inside a module name that module', () => {
    const d = diag(ROOT, `${NET}resource "aws_x" "y" {\n  a = aws_nope.z.id\n  b = var.nope\n  c = local.nope\n  d = module.nope.x\n  e = data.aws_nope.q.id\n}\n`)
    expect(d.map((x) => [x.summary, x.detail, x.file, x.line])).toEqual([
      ['Reference to undeclared resource', 'A managed resource "aws_nope" "z" has not been declared in module.net.', 'modules/net/main.tf', 9],
      ['Reference to undeclared input variable', 'An input variable with the name "nope" has not been declared. This variable can be declared with a variable "nope" {} block.', 'modules/net/main.tf', 10],
      ['Reference to undeclared local value', 'A local value with the name "nope" has not been declared.', 'modules/net/main.tf', 11],
      ['Reference to undeclared module', 'No module call named "nope" is declared in module.net.', 'modules/net/main.tf', 12],
      ['Reference to undeclared resource', 'A data resource "aws_nope" "q" has not been declared in module.net.', 'modules/net/main.tf', 13],
    ])
  })

  it('keeps the root module wording in the root', () => {
    const d = diag(`${ROOT}resource "aws_x" "y" {\n  a = aws_nope.z.id\n  m = module.nope.x\n}\n`, NET)
    expect(d.map((x) => [x.detail, x.file, x.line])).toEqual([
      ['A managed resource "aws_nope" "z" has not been declared in the root module.', 'main.tf', 12],
      ['No module call named "nope" is declared in the root module.', 'main.tf', 13],
    ])
  })

  it('a call missing a variable without a default', () => {
    const d = diag(ROOT.replace('  cidr   = var.cidr\n', ''), NET)
    expect(d).toEqual([{ severity: 'error', summary: 'Missing required argument', detail: 'The argument "cidr" is required, but no definition was found.', file: 'main.tf', line: 4, col: 1, context: 'module "net"' }])
  })

  it('a variable with a default may be left out', () => {
    expect(diag(ROOT.replace('  cidr   = var.cidr\n', ''), NET.replace('variable "cidr" {}', 'variable "cidr" {\n  default = "x"\n}'))).toEqual([])
  })

  it('an input the child does not declare', () => {
    const d = diag(ROOT.replace('  cidr   = var.cidr\n', '  cidr   = var.cidr\n  bogus  = 1\n'), NET)
    expect(d).toEqual([{ severity: 'error', summary: 'Unsupported argument', detail: 'An argument named "bogus" is not expected here.', file: 'main.tf', line: 7, col: 3, context: 'module "net"' }])
  })

  it('a reference to an undeclared module output', () => {
    const d = diag(ROOT.replace('module.net.vpc_id', 'module.net.bogus'), NET)
    expect(d).toEqual([{ severity: 'error', summary: 'Unsupported attribute', detail: 'This object does not have an attribute named "bogus".', file: 'main.tf', line: 9, col: 12 }])
  })

  it('duplicates are scoped to the module and name the module file', () => {
    const d = diag(ROOT, `${NET}resource "aws_vpc" "main" {}\n`)
    expect(d.map((x) => [x.summary, x.detail, x.file, x.line])).toEqual([['Duplicate resource "aws_vpc" configuration', 'A aws_vpc resource named "main" was already declared at modules/net/main.tf:2,1. Resource names must be unique per type in each module.', 'modules/net/main.tf', 8]])
  })
})

describe('module cycles', () => {
  it('a module output feeding its own input is a cycle', () => {
    const g = buildGraph(tree(ROOT.replace('var.cidr\n}', 'module.net.vpc_id\n}'), { net: NET }))
    expect(g.order).toEqual([])
    expect(g.diagnostics.map((d) => d.summary)).toEqual(['Cycle: module.net.aws_vpc.main, module.net.output.vpc_id, module.net.var.cidr'])
  })

  it('a cycle across the boundary through a parent resource', () => {
    const g = buildGraph(tree(`module "net" {\n  source = "./modules/net"\n  cidr = aws_subnet.a.cidr_block\n}\nresource "aws_subnet" "a" {\n  vpc_id = module.net.vpc_id\n}\n`, { net: NET }))
    expect(g.order).toEqual([])
    expect(g.diagnostics.map((d) => d.summary)).toEqual(['Cycle: aws_subnet.a, module.net.aws_vpc.main, module.net.output.vpc_id, module.net.var.cidr'])
  })

  it('no false cycle when a module uses a parent value only for another output', () => {
    const g = buildGraph(tree(`resource "aws_a" "a" {\n  x = module.m.one\n}\nmodule "m" {\n  source = "./modules/m"\n  in = aws_a.a.id\n}\n`, { m: 'variable "in" {}\noutput "one" {\n  value = 1\n}\noutput "two" {\n  value = var.in\n}\n' }))
    expect(g.diagnostics).toEqual([])
    expect(g.order.length).toBe(g.nodes.size)
  })
})

describe('own-property safety', () => {
  it('__proto__ as module name and as variable name', () => {
    const g = buildGraph(tree('module "__proto__" {\n  source = "./modules/__proto__"\n  __proto__ = 1\n}\nresource "aws_x" "y" {\n  a = module.__proto__.__proto__\n}\n', Object.fromEntries([['__proto__', 'variable "__proto__" {}\noutput "__proto__" {\n  value = var.__proto__\n}\n']])))
    expect(g.diagnostics).toEqual([])
    expect(g.nodes.get('aws_x.y')!.deps).toEqual(['module.__proto__.output.__proto__'])
    expect(g.nodes.get('module.__proto__.output.__proto__')!.deps).toEqual(['module.__proto__', 'module.__proto__.var.__proto__'])
  })
})

describe('root-only compatibility', () => {
  const CHAIN = 'variable "region" {}\nlocals {\n  tags = { env = var.region }\n}\nresource "aws_vpc" "main" {\n  tags = local.tags\n}\nresource "aws_subnet" "a" {\n  vpc_id = aws_vpc.main.id\n}\noutput "subnet" {\n  value = aws_subnet.a.id\n}\nmodule "net" {\n  source = "./net"\n  x = aws_vpc.main.id\n}\nresource "aws_i" "i" {\n  s = module.net.subnet_id\n}\n'
  it.each([CHAIN, 'resource "aws_x" "y" {\n  a = aws_nope.z.id\n}\nresource "aws_x" "y" {}\n', 'resource "a" "b" {\n  c = d.e.f\n}\nresource "d" "e" {\n  g = a.b.x\n}\n'])('flat files and a childless tree give the same graph', (text) => {
    const files = [{ name: 'main.tf', text }]
    const flat = buildGraph(files)
    expect(buildGraph(tree(text))).toEqual(flat)
    expect(flat.nodes.get('aws_i.i')?.deps ?? []).toEqual(flat.nodes.has('aws_i.i') ? ['module.net'] : [])
    expect([...flat.nodes.values()].every((n) => n.module === '' && n.local === n.address)).toBe(true)
  })

  it('an unloaded call keeps its argument dependencies', () => {
    const g = buildGraph([{ name: 'main.tf', text: 'resource "aws_x" "y" {}\nmodule "net" {\n  source = "./net"\n  a = aws_x.y.id\n}\n' }])
    expect(g.nodes.get('module.net')!.deps).toEqual(['aws_x.y'])
    expect(g.nodes.get('module.net')!.child).toBeUndefined()
  })
})
