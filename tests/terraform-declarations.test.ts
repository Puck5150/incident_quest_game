import { describe, expect, it } from 'vitest'
import { importsOf, removedOf } from '../src/game/terraform/declarations.ts'
import { parseHcl } from '../src/game/terraform/parse.ts'

const blocks = (hcl: string) => {
  const r = parseHcl('main.tf', hcl)
  if (r.diagnostics.length) throw new Error(r.diagnostics[0].summary)
  return r.blocks
}

describe('removedOf', () => {
  it('defaults to destroying, and reads lifecycle destroy = false', () => {
    const r = removedOf(blocks('removed {\n  from = aws_vpc.a\n}\nremoved {\n  from = aws_vpc.b\n  lifecycle {\n    destroy = false\n  }\n}\n'))
    expect(r.diagnostics).toEqual([])
    expect(r.removals.map((x) => [x.from, x.destroy])).toEqual([
      [{ type: 'aws_vpc', name: 'a' }, true],
      [{ type: 'aws_vpc', name: 'b' }, false],
    ])
    expect(r.removals[0]).toMatchObject({ file: 'main.tf', pos: { line: 1 } })
  })

  it('reports a missing or keyed from, a non-literal destroy, and unknown lifecycle arguments', () => {
    expect(removedOf(blocks('removed {\n}\n')).diagnostics[0]).toMatchObject({ summary: 'Missing required argument', detail: 'The argument "from" is required, but no definition was found.' })
    expect(removedOf(blocks('removed {\n  from = aws_vpc.a[0]\n}\n')).diagnostics[0].summary).toBe('Invalid "from" address')
    expect(removedOf(blocks('removed {\n  from = aws_vpc.a\n  lifecycle {\n    destroy = var.x\n  }\n}\n')).diagnostics[0].summary).toBe('Variables not allowed')
    expect(removedOf(blocks('removed {\n  from = aws_vpc.a\n  lifecycle {\n    destroy = "no"\n  }\n}\n')).diagnostics[0].summary).toBe('Unsuitable value type')
    expect(removedOf(blocks('removed {\n  from = aws_vpc.a\n  lifecycle {\n    nope = true\n  }\n}\n')).diagnostics[0]).toMatchObject({ summary: 'Unsupported argument', detail: 'An argument named "nope" is not expected here.' })
  })
})

describe('importsOf', () => {
  it('reads the target address and the id expression, with positions', () => {
    const r = importsOf(blocks('import {\n  to = aws_s3_bucket.b["x"]\n  id = "legacy-${var.env}"\n}\n'))
    expect(r.diagnostics).toEqual([])
    expect(r.imports).toHaveLength(1)
    expect(r.imports[0]).toMatchObject({ to: { type: 'aws_s3_bucket', name: 'b', key: 'x' }, file: 'main.tf', pos: { line: 1 }, idPos: { line: 3 } })
    expect(r.imports[0].id.kind).toBe('tmpl')
  })

  it('reports missing arguments and a bad target', () => {
    expect(importsOf(blocks('import {\n  to = aws_vpc.a\n}\n')).diagnostics[0]).toMatchObject({ summary: 'Missing required argument', detail: 'The argument "id" is required, but no definition was found.' })
    expect(importsOf(blocks('import {\n  id = "x"\n}\n')).diagnostics[0].detail).toContain('"to"')
    expect(importsOf(blocks('import {\n  to = var.x\n  id = "x"\n}\n')).diagnostics[0].summary).toBe('Invalid "to" address')
  })
})
