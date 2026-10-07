import { describe, expect, it } from 'vitest'
import { buildGraph } from '../src/game/terraform/graph.ts'

const g = (text: string) => buildGraph([{ name: 'main.tf', text }])

const CHAIN = `
variable "region" {}
locals {
  tags = { env = var.region }
}
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = local.tags
}
resource "aws_subnet" "a" {
  vpc_id = aws_vpc.main.id
}
output "subnet" {
  value = aws_subnet.a.id
}
`

describe('graph', () => {
  it('names every node and orders dependencies first', () => {
    const r = g(CHAIN)
    expect(r.diagnostics).toEqual([])
    expect([...r.nodes.keys()].sort()).toEqual(['aws_subnet.a', 'aws_vpc.main', 'local.tags', 'output.subnet', 'var.region'])
    expect(r.nodes.get('aws_subnet.a')!.deps).toEqual(['aws_vpc.main'])
    expect(r.order).toEqual(['var.region', 'local.tags', 'aws_vpc.main', 'aws_subnet.a', 'output.subnet'])
  })

  it('reads depends_on, data and module references as dependencies', () => {
    const r = g(`
data "aws_ami" "x" {}
module "net" {
  source = "./net"
}
resource "aws_vpc" "main" {}
resource "aws_instance" "a" {
  ami        = data.aws_ami.x.id
  subnet_id  = module.net.subnet_id
  depends_on = [aws_vpc.main]
}
`)
    expect(r.diagnostics).toEqual([])
    expect(r.nodes.get('aws_instance.a')!.deps.sort()).toEqual(['aws_vpc.main', 'data.aws_ami.x', 'module.net'])
  })

  it('does not treat ignore_changes names as references', () => {
    const r = g('resource "aws_instance" "a" {\n  ami = "x"\n  lifecycle {\n    ignore_changes = [tags, ami]\n  }\n}\n')
    expect(r.diagnostics).toEqual([])
    expect(r.nodes.get('aws_instance.a')!.deps).toEqual([])
  })

  it('does not flag each, count, self, path, terraform, provider or providers references', () => {
    const r = g(`
resource "aws_s3_bucket" "b" {
  for_each = toset(["a", "b"])
  provider = aws.west
  bucket   = "\${each.key}-\${terraform.workspace}-\${path.module}"
}
resource "aws_subnet" "s" {
  count = 2
  cidr  = cidrsubnet("10.0.0.0/16", 8, count.index)
}
module "m" {
  source    = "./m"
  providers = { aws = aws.west }
}
`)
    expect(r.diagnostics).toEqual([])
  })

  it('reports undeclared references with the Terraform wording', () => {
    const r = g('resource "aws_subnet" "a" {\n  vpc_id = aws_vpc.nope.id\n  x = var.zip\n  y = local.q\n  z = module.m.o\n  w = data.aws_ami.d.id\n}\n')
    const by = (s: string) => r.diagnostics.find((d) => d.summary === s)!
    expect(by('Reference to undeclared resource')).toMatchObject({ file: 'main.tf', line: 2 })
    expect(r.diagnostics.map((d) => d.detail)).toEqual(
      expect.arrayContaining([
        'A managed resource "aws_vpc" "nope" has not been declared in the root module.',
        'An input variable with the name "zip" has not been declared. This variable can be declared with a variable "zip" {} block.',
        'A local value with the name "q" has not been declared.',
        'No module call named "m" is declared in the root module.',
        'A data resource "aws_ami" "d" has not been declared in the root module.',
      ]),
    )
  })

  it('reports a bare resource type as an invalid reference', () => {
    const r = g('resource "aws_subnet" "a" {\n  x = aws_vpc\n}\n')
    expect(r.diagnostics[0]).toMatchObject({ summary: 'Invalid reference', line: 2 })
  })

  it('reports a cycle, naming only the nodes in it', () => {
    const r = g(`
resource "aws_security_group" "a" {
  ingress = aws_security_group.b.id
}
resource "aws_security_group" "b" {
  ingress = aws_security_group.a.id
}
resource "aws_instance" "web" {
  sg = aws_security_group.a.id
}
`)
    expect(r.diagnostics).toEqual([
      { severity: 'error', summary: 'Cycle: aws_security_group.a, aws_security_group.b', detail: '', file: '', line: 0, col: 0 },
    ])
    expect(r.order).toEqual([])
  })

  it('reports a resource that depends on itself, and terminates', () => {
    const r = g('resource "x" "a" {\n  depends_on = [x.a]\n}\n')
    expect(r.diagnostics.map((d) => d.summary)).toEqual(['Cycle: x.a'])
  })

  it('reports duplicate declarations', () => {
    const r = g('resource "aws_vpc" "main" {}\nresource "aws_vpc" "main" {}\nvariable "v" {}\nvariable "v" {}\n')
    expect(r.diagnostics.map((d) => d.summary)).toEqual(['Duplicate resource "aws_vpc" configuration', 'Duplicate variable declaration'])
    expect(r.diagnostics[0].detail).toBe('A aws_vpc resource named "main" was already declared at main.tf:1,1. Resource names must be unique per type in each module.')
  })

  it('reports a block with the wrong number of labels', () => {
    expect(g('resource "aws_vpc" {}\n').diagnostics[0]).toMatchObject({ summary: 'Invalid resource block', line: 1 })
  })

  it('combines files and passes syntax errors through', () => {
    const r = buildGraph([
      { name: 'a.tf', text: 'resource "x" "a" {}\n' },
      { name: 'b.tf', text: 'resource "x" "b" {\n  depends_on = [x.a]\n}\n' },
      { name: 'c.tf', text: 'resource "x" "c" {\n  oops\n}\n' },
    ])
    expect(r.nodes.get('x.b')!.deps).toEqual(['x.a'])
    expect(r.diagnostics[0]).toMatchObject({ file: 'c.tf', summary: 'Argument or block definition required' })
  })

  it('treats dynamic block iterators as local, keeping outer references', () => {
    const r = g(`
variable "rules" {}
resource "aws_vpc" "main" {}
resource "aws_security_group" "s" {
  dynamic "ingress" {
    for_each = var.rules
    content {
      port = ingress.value.port
      vpc  = aws_vpc.main.id
    }
  }
}
`)
    expect(r.diagnostics).toEqual([])
    expect(r.nodes.get('aws_security_group.s')!.deps).toEqual(['aws_vpc.main', 'var.rules'])
  })

  it('handles a custom dynamic iterator', () => {
    const r = g('variable "rules" {}\nresource "x" "s" {\n  dynamic "ingress" {\n    for_each = var.rules\n    iterator = rule\n    content {\n      port = rule.value.port\n    }\n  }\n}\n')
    expect(r.diagnostics).toEqual([])
  })

  it('does not treat variable types or self-referencing validation as references', () => {
    expect(g('variable "x" {\n  type = string\n}\n').diagnostics).toEqual([])
    expect(g('variable "x" {\n  type = list(object({ a = string, b = optional(number) }))\n}\n').diagnostics).toEqual([])
    expect(g('variable "r" {\n  validation {\n    condition = var.r > 0\n    error_message = "x"\n  }\n}\n').diagnostics).toEqual([])
  })

  it('reports interpolation references at the string position', () => {
    const r = g('resource "aws_instance" "web" {\n  tags = {\n    Name = "web-${var.nope}"\n  }\n}\n')
    expect(r.diagnostics[0].summary).toBe('Reference to undeclared input variable')
    expect(r.diagnostics[0].line).toBe(3)
  })

  it('survives a very long operator chain', () => {
    const r = g(`locals {\n  v = ${Array(5000).fill('1').join('+')}\n}\n`)
    expect(r.diagnostics[0].summary).toBe('Unsupported nesting depth')
  })
})

describe('graph: blocks and import dependencies', () => {
  it('exposes every parsed top-level block', () => {
    const r = g('resource "aws_vpc" "a" {}\nmoved {\n  from = aws_vpc.old\n  to   = aws_vpc.a\n}\n')
    expect(r.blocks.map((b) => b.type)).toEqual(['resource', 'moved'])
  })

  it('makes the target resource depend on what an import id references, and does not treat moved/import addresses as references', () => {
    const r = g('variable "name" {\n  default = "x"\n}\nresource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\nimport {\n  to = aws_s3_bucket.b\n  id = var.name\n}\nmoved {\n  from = aws_s3_bucket.gone\n  to   = aws_s3_bucket.b\n}\n')
    expect(r.diagnostics).toEqual([])
    expect(r.nodes.get('aws_s3_bucket.b')!.deps).toEqual(['var.name'])
    expect(r.order).toEqual(['var.name', 'aws_s3_bucket.b'])
  })

  it('reports an undeclared variable used by an import id', () => {
    const r = g('resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\nimport {\n  to = aws_s3_bucket.b\n  id = var.nope\n}\n')
    expect(r.diagnostics[0].summary).toBe('Reference to undeclared input variable')
  })

  it('reports an undeclared variable in an import id against the import block file', () => {
    const r = buildGraph([
      { name: 'main.tf', text: 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n' },
      { name: 'imports.tf', text: 'import {\n  to = aws_s3_bucket.b\n  id = var.nope\n}\n' },
    ])
    expect(r.diagnostics[0]).toMatchObject({ summary: 'Reference to undeclared input variable', file: 'imports.tf', line: 3 })
  })
})
