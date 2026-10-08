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
      stdout: text('a = "x"', 'b = {', '  "k" = "v"', '}', 'n = 3', 'pw = <sensitive>'),
      stderr: '',
      exitCode: 0,
    })
  })

  it('prints one output in hcl, raw and compact json forms, including a sensitive one', () => {
    expect(outputsText(outs, 'a').stdout).toBe('"x"')
    expect(outputsText(outs, 'a', 'raw').stdout).toBe('x')
    expect(outputsText(outs, 'n', 'raw').stdout).toBe('3')
    expect(outputsText(outs, 'b', 'json').stdout).toBe('{"k":"v"}')
    expect(outputsText(outs, 'pw').stdout).toBe('"secret"')
    expect(outputsText(outs, 'b').stdout).toBe(text('{', '  "k" = "v"', '}'))
  })

  it('indents two spaces without aligning map keys, lists one element per row, object attributes in lists quoted too', () => {
    const o = { tags: { value: { Name: 'x', LongerKey: 'y' } }, ids: { value: ['a', 'b'] }, rules: { value: [{ port: 22, cidrs: ['10.0.0.0/8'] }] } }
    expect(outputsText(o, 'tags').stdout).toBe(text('{', '  "LongerKey" = "y"', '  "Name" = "x"', '}'))
    expect(outputsText(o, 'ids').stdout).toBe(text('[', '  "a",', '  "b",', ']'))
    expect(outputsText(o, 'rules').stdout).toBe(text('[', '  {', '    "cidrs" = [', '      "10.0.0.0/8",', '    ]', '    "port" = 22', '  },', ']'))
    expect(outputsText(o).stdout.split('\n').slice(0, 5)).toEqual(['ids = [', '  "a",', '  "b",', ']', 'rules = ['])
  })

  it('prints -json for all outputs as one object with sensitive, type and value', () => {
    const r = outputsText({ a: { value: 'x' }, n: { value: 3, sensitive: true }, l: { value: ['q'] } }, undefined, 'json')
    expect(JSON.parse(r.stdout)).toEqual({ a: { sensitive: false, type: 'string', value: 'x' }, l: { sensitive: false, type: 'dynamic', value: ['q'] }, n: { sensitive: true, type: 'number', value: 3 } })
    expect(r.stdout.startsWith('{\n  "a": {\n    "sensitive": false,\n    "type": "string",\n    "value": "x"\n  },')).toBe(true)
  })

  it('rejects -raw without a name and -raw of a collection', () => {
    const none = outputsText(outs, undefined, 'raw')
    expect(none.exitCode).toBe(1)
    expect(none.stderr).toContain('Error: Raw output format is only supported for single outputs')
    const coll = outputsText(outs, 'b', 'raw')
    expect(coll.exitCode).toBe(1)
    expect(coll.stderr).toContain('Error: Unsupported value for raw output')
    expect(coll.stderr.replace(/\n│ /g, ' ')).toContain('but output value "b" is not of a type that can be rendered as plain text.')
  })

  it('warns on stdout when there are no outputs and errors for a missing name', () => {
    const none = outputsText({})
    expect(none.exitCode).toBe(0)
    expect(none.stderr).toBe('')
    expect(none.stdout).toContain('Warning: No outputs found')
    const missing = outputsText(outs, 'zzz')
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('Error: Output "zzz" not found')
  })
})
