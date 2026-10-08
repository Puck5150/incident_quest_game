import { describe, expect, it } from 'vitest'
import { emptyState, type State, type StateResource } from '../src/game/terraform/state.ts'
import { outputsText, showState, stateShow } from '../src/game/terraform/views.ts'

const res = (type: string, name: string, attrs: Record<string, unknown>, o: { key?: string | number; mode?: 'managed' | 'data'; status?: 'tainted' } = {}): StateResource => ({
  mode: o.mode ?? 'managed',
  type,
  name,
  provider: 'p',
  instances: [{ ...(o.key === undefined ? {} : { index_key: o.key }), ...(o.status ? { status: o.status } : {}), attributes: attrs as never }],
})
const text = (...ls: string[]) => ls.join('\n')

describe('stateShow', () => {
  it('prints aligned sorted attributes, maps, and omits nulls', () => {
    const r = res('aws_vpc', 'main', { id: 'vpc-1', cidr_block: '10.0.0.0/16', tags: { Name: 'main', Env: 'prod' }, kms: null, count: 3, ok: true })
    expect(stateShow(r, r.instances[0])).toBe(
      text(
        '# aws_vpc.main:',
        'resource "aws_vpc" "main" {',
        '    cidr_block = "10.0.0.0/16"',
        '    count      = 3',
        '    id         = "vpc-1"',
        '    ok         = true',
        '    tags       = {',
        '        "Env"  = "prod"',
        '        "Name" = "main"',
        '    }',
        '}',
      ),
    )
  })

  it('prints lists, objects inside lists, empty collections and keyed/tainted/data headers', () => {
    const r = res('aws_security_group', 'web', { id: 'sg-1', ids: [], ingress: [{ from_port: 22, to_port: 22, cidr_blocks: ['10.0.0.0/8'] }], names: ['a', 'b'] }, { key: 'x', status: 'tainted' })
    expect(stateShow(r, r.instances[0])).toBe(
      text(
        '# aws_security_group.web["x"]: (tainted)',
        'resource "aws_security_group" "web" {',
        '    id      = "sg-1"',
        '    ids     = []',
        '    ingress = [',
        '        {',
        '            cidr_blocks = [',
        '                "10.0.0.0/8",',
        '            ]',
        '            from_port   = 22',
        '            to_port     = 22',
        '        },',
        '    ]',
        '    names   = [',
        '        "a",',
        '        "b",',
        '    ]',
        '}',
      ),
    )
    const d = res('aws_ami', 'x', { id: 'ami-1' }, { mode: 'data' })
    expect(stateShow(d, d.instances[0]).split('\n').slice(0, 2)).toEqual(['# data.aws_ami.x:', 'data "aws_ami" "x" {'])
  })

  it('masks sensitive attributes', () => {
    const r = res('aws_db_instance', 'd', { id: 'db-1', password: 'hunter2' })
    const out = stateShow(r, r.instances[0], (a) => a === 'password')
    expect(out).toContain('    password = (sensitive value)')
    expect(out).not.toContain('hunter2')
  })
})

describe('showState', () => {
  it('prints every instance sorted by address, or says the state is empty', () => {
    const s: State = { ...emptyState(), resources: [res('aws_vpc', 'b', { id: '2' }), res('aws_vpc', 'a', { id: '1' })] }
    const out = showState(s)
    expect(out.indexOf('# aws_vpc.a:')).toBeLessThan(out.indexOf('# aws_vpc.b:'))
    expect(out).toContain('}\n\n# aws_vpc.b:')
    expect(showState(emptyState())).toBe('The state file is empty. No resources are represented.')
  })
})

describe('outputsText', () => {
  const outs = { b: { value: { k: 'v' } }, a: { value: 'x' }, pw: { value: 'secret', sensitive: true }, n: { value: 3 } }

  it('lists all outputs sorted, hiding sensitive ones', () => {
    expect(outputsText(outs)).toEqual({
      stdout: text('a = "x"', 'b = {', '    "k" = "v"', '}', 'n = 3', 'pw = <sensitive>'),
      stderr: '',
      exitCode: 0,
    })
  })

  it('prints one output in hcl, raw and json forms, including a sensitive one', () => {
    expect(outputsText(outs, 'a').stdout).toBe('"x"')
    expect(outputsText(outs, 'a', 'raw').stdout).toBe('x')
    expect(outputsText(outs, 'b', 'json').stdout).toBe('{\n  "k": "v"\n}')
    expect(outputsText(outs, 'pw').stdout).toBe('"secret"')
    expect(outputsText(outs, 'b').stdout).toBe(text('{', '    "k" = "v"', '}'))
  })

  it('warns when there are no outputs and errors for a missing name', () => {
    const none = outputsText({})
    expect(none.exitCode).toBe(0)
    expect(none.stderr).toContain('Warning: No outputs found')
    const missing = outputsText(outs, 'zzz')
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('Error: Output "zzz" not found')
  })
})
