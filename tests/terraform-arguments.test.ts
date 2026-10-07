import { describe, expect, it } from 'vitest'
import { lifecycleOf, resourceArguments } from '../src/game/terraform/arguments.ts'
import { EvalError, type Scope, type Value } from '../src/game/terraform/eval.ts'
import { parseHcl } from '../src/game/terraform/parse.ts'

const block = (body: string) => {
  const r = parseHcl('main.tf', `resource "aws_security_group" "web" {\n${body}\n}`)
  if (r.diagnostics.length) throw new Error(r.diagnostics[0].summary)
  return r.blocks[0]
}
const scope = (vars: Record<string, Value> = {}): Scope => ({
  ref(path) {
    if (path[0] === 'var' && Object.hasOwn(vars, path[1])) return vars[path[1]]
    if (path[0] === 'each') return { key: 'k', value: 'v' }
    throw new EvalError('Reference to undeclared value', path.join('.'))
  },
})

describe('resourceArguments', () => {
  it('evaluates arguments and skips meta-arguments and lifecycle', () => {
    const r = resourceArguments(block('  name = "web-${var.env}"\n  count = 2\n  depends_on = [x.y]\n  provider = aws.west\n  lifecycle {\n    prevent_destroy = true\n  }'), scope({ env: 'prod' }))
    expect(r).toEqual({ ok: true, args: { name: 'web-prod' } })
  })

  it('turns nested blocks into lists of objects, in order, including blocks inside blocks', () => {
    const r = resourceArguments(block('  ingress {\n    from_port = 22\n    cidr_blocks = ["10.0.0.0/8"]\n  }\n  ingress {\n    from_port = 80\n    rule {\n      note = "web"\n    }\n  }'), scope())
    expect(r).toEqual({
      ok: true,
      args: {
        ingress: [
          { from_port: 22, cidr_blocks: ['10.0.0.0/8'] },
          { from_port: 80, rule: [{ note: 'web' }] },
        ],
      },
    })
  })

  it('reports a dynamic block as unsupported', () => {
    const r = resourceArguments(block('  dynamic "ingress" {\n    for_each = []\n  }'), scope())
    expect(r).toMatchObject({ ok: false, summary: 'Unsupported dynamic block', pos: { line: 2 } })
  })

  it('reports an evaluation error at the argument that caused it', () => {
    const r = resourceArguments(block('  name = "ok"\n  vpc_id = var.nope'), scope())
    expect(r).toMatchObject({ ok: false, summary: 'Reference to undeclared value', pos: { line: 3 } })
  })

  it('keeps an attribute named __proto__ as an ordinary key', () => {
    const r = resourceArguments(block('  __proto__ = 1'), scope())
    expect(r.ok && Object.keys(r.args)).toEqual(['__proto__'])
    expect(r.ok && Object.getPrototypeOf(r.args)).toBe(Object.prototype)
  })
})

describe('lifecycleOf', () => {
  const lc = (body: string) => lifecycleOf(block(`  lifecycle {\n${body}\n  }`))

  it('has defaults when there is no lifecycle block', () => {
    expect(lifecycleOf(block('  name = "x"'))).toEqual({ ok: true, lifecycle: { ignoreChanges: [], preventDestroy: false, createBeforeDestroy: false, replaceTriggeredBy: [] } })
  })

  it('reads ignore_changes in every common spelling', () => {
    const names = (src: string) => {
      const r = lc(`    ignore_changes = ${src}`)
      return r.ok ? r.lifecycle.ignoreChanges : r
    }
    expect(names('[tags, desired_count]')).toEqual(['tags', 'desired_count'])
    expect(names('["tags"]')).toEqual(['tags'])
    expect(names('[tags["Name"], user_data]')).toEqual(['tags', 'user_data'])
    expect(names('all')).toBe('all')
    expect(names('[all]')).toBe('all')
    expect(names('["all"]')).toBe('all')
  })

  it('reads prevent_destroy, create_before_destroy and replace_triggered_by', () => {
    const r = lc('    prevent_destroy = true\n    create_before_destroy = true\n    replace_triggered_by = [aws_vpc.main, aws_subnet.a.id]')
    expect(r).toMatchObject({ ok: true, lifecycle: { preventDestroy: true, createBeforeDestroy: true, replaceTriggeredBy: ['aws_vpc.main', 'aws_subnet.a'] } })
  })

  it('rejects a variable in prevent_destroy, a bad ignore_changes, an unknown argument, or two lifecycle blocks', () => {
    expect(lc('    prevent_destroy = var.x')).toMatchObject({ ok: false, summary: 'Variables not allowed' })
    expect(lc('    ignore_changes = 5')).toMatchObject({ ok: false, summary: 'Invalid ignore_changes argument' })
    expect(lc('    nope = 1')).toMatchObject({ ok: false, summary: 'Unsupported argument', detail: 'An argument named "nope" is not expected here.' })
    expect(lifecycleOf(block('  lifecycle {\n  }\n  lifecycle {\n  }'))).toMatchObject({ ok: false, summary: 'Duplicate lifecycle block' })
  })
})
