import { describe, expect, it } from 'vitest'
import { UNKNOWN } from '../src/game/terraform/eval.ts'
import type { PlanItem, PlanResult } from '../src/game/terraform/plan.ts'
import { renderPlan, resourceBlock } from '../src/game/terraform/render.ts'
import { emptyState, type State } from '../src/game/terraform/state.ts'

const ch = (name: string, before: unknown, after: unknown, extra: { forcesReplacement?: boolean; sensitive?: boolean } = {}) =>
  ({ name, before, after, forcesReplacement: false, sensitive: false, ...extra }) as PlanItem['changes'][number]
const item = (o: Partial<PlanItem> & Pick<PlanItem, 'action'>): PlanItem => ({ address: 'aws_instance.web', type: 'aws_instance', name: 'web', changes: [], ...o })
const text = (...ls: string[]) => ls.join('\n')
const stateWith = (type: string, name: string, attributes: Record<string, unknown>): State => {
  const s = emptyState()
  s.resources.push({ mode: 'managed', type, name, provider: 'p', instances: [{ attributes: attributes as never }] })
  return s
}

describe('resourceBlock: create', () => {
  it('renders aligned additions with unknown values and maps', () => {
    const out = resourceBlock(item({ action: 'create', changes: [ch('ami', undefined, 'ami-1'), ch('arn', undefined, UNKNOWN), ch('tags', undefined, { Name: 'web' })] }))
    expect(out).toBe(
      text(
        '  # aws_instance.web will be created',
        '  + resource "aws_instance" "web" {',
        '      + ami  = "ami-1"',
        '      + arn  = (known after apply)',
        '      + tags = {',
        '          + "Name" = "web"',
        '        }',
        '    }',
      ),
    )
  })

  it('hides sensitive values', () => {
    const out = resourceBlock(item({ action: 'create', changes: [ch('password', undefined, 'hunter2', { sensitive: true })] }))
    expect(out).toContain('      + password = (sensitive value)')
    expect(out).not.toContain('hunter2')
  })
})

describe('resourceBlock: update and replace', () => {
  it('shows changes, the id as context, and a hidden count', () => {
    const out = resourceBlock(item({ action: 'update', changes: [ch('instance_type', 't3.micro', 't3.small')], unchanged: { id: 'i-1', ami: 'ami-1', arn: 'arn:i-1' } }))
    expect(out).toBe(
      text(
        '  # aws_instance.web will be updated in-place',
        '  ~ resource "aws_instance" "web" {',
        '        id            = "i-1"',
        '      ~ instance_type = "t3.micro" -> "t3.small"',
        '        # (2 unchanged attributes hidden)',
        '    }',
      ),
    )
  })

  it('shows a replacement with the forcing attribute and recomputed values', () => {
    const out = resourceBlock(
      item({ action: 'replace', changes: [ch('ami', 'ami-1', 'ami-2', { forcesReplacement: true }), ch('id', 'i-1', UNKNOWN)], unchanged: { instance_type: 't3.micro' } }),
    )
    expect(out).toBe(
      text(
        '  # aws_instance.web must be replaced',
        '-/+ resource "aws_instance" "web" {',
        '      ~ ami           = "ami-1" -> "ami-2" # forces replacement',
        '      ~ id            = "i-1" -> (known after apply)',
        '        # (1 unchanged attribute hidden)',
        '    }',
      ),
    )
  })

  it('uses +/- for create_before_destroy and the right header for each reason', () => {
    const base = { action: 'replace' as const, changes: [ch('id', 'i-1', UNKNOWN)] }
    expect(resourceBlock(item({ ...base, createBeforeDestroy: true }))).toContain('+/- resource "aws_instance" "web" {')
    expect(resourceBlock(item({ ...base, reason: 'tainted' }))).toContain('  # aws_instance.web is tainted, so must be replaced')
    expect(resourceBlock(item({ ...base, reason: 'requested' }))).toContain('  # aws_instance.web will be replaced, as requested')
    expect(resourceBlock(item({ ...base, reason: 'triggered', triggeredBy: ['aws_vpc.main'] }))).toContain('  # aws_instance.web will be replaced due to changes in replace_triggered_by')
  })

  it('hides sensitive changes on both sides', () => {
    const out = resourceBlock(item({ action: 'update', changes: [ch('password', 'old', 'new', { sensitive: true })], unchanged: {} }))
    expect(out).toContain('      ~ password = (sensitive value)')
    expect(out).not.toContain('old')
  })

  it('aligns over hidden attributes and always shows name and tags in full', () => {
    const n = (s: string) => s.padEnd(26)
    const out = resourceBlock(
      item({
        action: 'update',
        changes: [ch('instance_type', 't3.micro', 't3.small')],
        unchanged: { a_very_long_unchanged_name: 'x', ami: 'a', name: 'web', tags: { Name: 'web', Env: 'prod' } },
      }),
    )
    expect(out).toBe(
      text(
        '  # aws_instance.web will be updated in-place',
        '  ~ resource "aws_instance" "web" {',
        `      ~ ${n('instance_type')} = "t3.micro" -> "t3.small"`,
        `        ${n('name')} = "web"`,
        `        ${n('tags')} = {`,
        '            "Env"  = "prod"',
        '            "Name" = "web"',
        '        }',
        '        # (2 unchanged attributes hidden)',
        '    }',
      ),
    )
  })

  it('shows the unchanged keys of a changed tags map as context, with no hidden line', () => {
    const out = resourceBlock(item({ action: 'update', changes: [ch('tags', { Name: 'web', Env: 'prod' }, { Name: 'web', Env: 'dev' })], unchanged: {} }))
    expect(out).toContain(text('      ~ tags = {', '          ~ "Env"  = "prod" -> "dev"', '            "Name" = "web"', '        }'))
    expect(out).not.toContain('unchanged')
  })

  it('renders a changed nested block list', () => {
    const out = resourceBlock(
      item({ action: 'update', address: 'aws_security_group.web', type: 'aws_security_group', name: 'web', changes: [ch('ingress', [{ from_port: 22, to_port: 22 }], [{ from_port: 22, to_port: 2222 }])], unchanged: { id: 'sg-1' } }),
    )
    expect(out).toBe(
      text(
        '  # aws_security_group.web will be updated in-place',
        '  ~ resource "aws_security_group" "web" {',
        '        id = "sg-1"',
        '',
        '      ~ ingress {',
        '          ~ to_port   = 22 -> 2222',
        '            # (1 unchanged attribute hidden)',
        '        }',
        '    }',
      ),
    )
  })
})

describe('resourceBlock: destroy, move, import, forget', () => {
  const gone = [ch('ami', 'ami-1', null), ch('id', 'i-1', null), ch('tags', null, null)]

  it('renders a destroy with its reason', () => {
    expect(resourceBlock(item({ action: 'destroy', address: 'aws_instance.old', name: 'old', changes: gone, destroyReason: 'not-in-config' }))).toBe(
      text(
        '  # aws_instance.old will be destroyed',
        '  # (because aws_instance.old is not in configuration)',
        '  - resource "aws_instance" "old" {',
        '      - ami = "ami-1" -> null',
        '      - id  = "i-1" -> null',
        '    }',
      ),
    )
  })

  it('explains count and for_each destroys', () => {
    const b = { action: 'destroy' as const, type: 'aws_s3_bucket', name: 'b', changes: [ch('id', 'x', null)] }
    expect(resourceBlock(item({ ...b, address: 'aws_s3_bucket.b[2]', key: 2, destroyReason: 'count-index' }))).toContain('  # (because index [2] is out of range for count)')
    expect(resourceBlock(item({ ...b, address: 'aws_s3_bucket.b["c"]', key: 'c', destroyReason: 'for-each-key' }))).toContain('  # (because key ["c"] is not in for_each map)')
  })

  it('explains wrong-repetition destroys by the instance key type', () => {
    const b = { action: 'destroy' as const, type: 'aws_s3_bucket', name: 'b', changes: [ch('id', 'x', null)], destroyReason: 'wrong-repetition' as const }
    expect(resourceBlock(item({ ...b, address: 'aws_s3_bucket.b' }))).toContain('  # (because resource uses count or for_each)')
    expect(resourceBlock(item({ ...b, address: 'aws_s3_bucket.b[0]', key: 0 }))).toContain('  # (because resource does not use count)')
    expect(resourceBlock(item({ ...b, address: 'aws_s3_bucket.b["a"]', key: 'a' }))).toContain('  # (because resource does not use for_each)')
  })

  it('renders a pure move', () => {
    expect(resourceBlock(item({ action: 'noop', address: 'aws_db_instance.primary', type: 'aws_db_instance', name: 'primary', movedFrom: 'aws_db_instance.orders', unchanged: { id: 'db-1', engine: 'postgres' } }))).toBe(
      text(
        '  # aws_db_instance.orders has moved to aws_db_instance.primary',
        '    resource "aws_db_instance" "primary" {',
        '        id     = "db-1"',
        '        # (1 unchanged attribute hidden)',
        '    }',
      ),
    )
  })

  it('renders an import, and notes the import and the move on changed items', () => {
    expect(resourceBlock(item({ action: 'noop', address: 'aws_s3_bucket.b', type: 'aws_s3_bucket', name: 'b', importing: 'legacy', unchanged: { id: 'legacy' } }))).toContain('  # aws_s3_bucket.b will be imported')
    const upd = resourceBlock(item({ action: 'update', importing: 'legacy', movedFrom: 'aws_instance.old', changes: [ch('a', 1, 2)], unchanged: {} }))
    expect(upd).toContain('  # (moved from aws_instance.old)')
    expect(upd).toContain('  # (imported from "legacy")')
  })

  it('renders an imported object in full: blank symbols, no hidden line', () => {
    const imp = item({ action: 'noop', address: 'aws_s3_bucket.b', type: 'aws_s3_bucket', name: 'b', importing: 'legacy', unchanged: { id: 'legacy', bucket: 'legacy', force_destroy: false, region: null } })
    expect(resourceBlock(imp)).toBe(
      text(
        '  # aws_s3_bucket.b will be imported',
        '    resource "aws_s3_bucket" "b" {',
        '        bucket        = "legacy"',
        '        force_destroy = false',
        '        id            = "legacy"',
        '    }',
      ),
    )
  })

  it('renders forget with a . row, one-space comments and an unchanged body', () => {
    const f = item({ action: 'forget', address: 'aws_vpc.old', type: 'aws_vpc', name: 'old', unchanged: { id: 'vpc-1', tags: { Name: 'old' }, cidr_block: '10.0.0.0/16', arn: 'a', extra: null } })
    expect(resourceBlock(f)).toBe(
      text(
        ' # aws_vpc.old will no longer be managed by Terraform, but will not be destroyed',
        ' # (destroy = false is set in the configuration)',
        ' . resource "aws_vpc" "old" {',
        '        id         = "vpc-1"',
        '        tags       = {',
        '            "Name" = "old"',
        '        }',
        '        # (2 unchanged attributes hidden)',
        '    }',
      ),
    )
  })
})

const result = (o: Partial<PlanResult> = {}): PlanResult => ({
  diagnostics: [],
  warnings: [],
  drift: [],
  items: [],
  outputs: [],
  imported: 0,
  refreshed: emptyState(),
  summary: { add: 0, change: 0, destroy: 0 },
  ...o,
})

describe('renderPlan', () => {
  it('renders a create and a destroy with the legend, blocks and summary', () => {
    const r = result({
      items: [
        item({ action: 'create', address: 'aws_instance.new', name: 'new', changes: [ch('ami', undefined, 'ami-1')] }),
        item({ action: 'destroy', address: 'aws_instance.old', name: 'old', changes: [ch('ami', 'ami-0', null)], destroyReason: 'not-in-config' }),
      ],
      summary: { add: 1, change: 0, destroy: 1 },
    })
    expect(renderPlan(r)).toBe(
      text(
        'Terraform used the selected providers to generate the following execution',
        'plan. Resource actions are indicated with the following symbols:',
        '  + create',
        '  - destroy',
        '',
        'Terraform will perform the following actions:',
        '',
        '  # aws_instance.new will be created',
        '  + resource "aws_instance" "new" {',
        '      + ami = "ami-1"',
        '    }',
        '',
        '  # aws_instance.old will be destroyed',
        '  # (because aws_instance.old is not in configuration)',
        '  - resource "aws_instance" "old" {',
        '      - ami = "ami-0" -> null',
        '    }',
        '',
        'Plan: 1 to add, 0 to change, 1 to destroy.',
      ),
    )
  })

  it('lists the replace symbols, and only the ones used', () => {
    const r = result({ items: [item({ action: 'replace', changes: [ch('id', 'i-1', UNKNOWN)] })], summary: { add: 1, change: 0, destroy: 1 } })
    const out = renderPlan(r)
    expect(out).toContain('plan. Resource actions are indicated with the following symbols:\n-/+ destroy and then create replacement\n')
    expect(out).not.toContain('  + create')
    expect(renderPlan(result({ items: [item({ action: 'replace', createBeforeDestroy: true, changes: [ch('id', 'i-1', UNKNOWN)] })] }))).toContain('+/- create replacement and then destroy')
  })

  it('counts imports in the summary and leaves out the legend for a moves-only plan', () => {
    const moved = item({ action: 'noop', address: 'aws_db_instance.primary', type: 'aws_db_instance', name: 'primary', movedFrom: 'aws_db_instance.orders', unchanged: { id: 'db-1' } })
    const out = renderPlan(result({ items: [moved] }))
    expect(out.startsWith('Terraform will perform the following actions:\n\n  # aws_db_instance.orders has moved to aws_db_instance.primary')).toBe(true)
    expect(out.endsWith('Plan: 0 to add, 0 to change, 0 to destroy.')).toBe(true)
    const imp = item({ action: 'noop', importing: 'legacy', unchanged: { id: 'legacy' } })
    expect(renderPlan(result({ items: [imp], imported: 1 }))).toContain('Plan: 1 to import, 0 to add, 0 to change, 0 to destroy.')
  })

  it('says there are no changes, and hides the drift note when nothing else happens', () => {
    const plain = text('No changes. Your infrastructure matches the configuration.', '', 'Terraform has compared your real infrastructure against your configuration', 'and found no differences, so no changes are needed.')
    expect(renderPlan(result({ items: [item({ action: 'noop', unchanged: { id: 'i-1' } })] }))).toBe(plain)
    const drifted = renderPlan(result({ drift: [{ address: 'aws_vpc.main', kind: 'changed', changes: [{ name: 'tags', before: { A: '1' }, after: { A: '2' } }] }], refreshed: stateWith('aws_vpc', 'main', { id: 'vpc-1', tags: { A: '2' }, cidr_block: 'x' }) }))
    expect(drifted).toBe(plain)
  })

  it('prints only the output changes, an apply hint wrapped at 78 columns, and no actions header', () => {
    const refreshed = emptyState()
    refreshed.outputs = { same_long_name: { value: 1 }, a: { value: 'old' } }
    const out = renderPlan(result({ refreshed, outputs: [{ name: 'a', value: 'new', sensitive: false }, { name: 'same_long_name', value: 1, sensitive: false }] }))
    expect(out).toBe(
      text(
        'Changes to Outputs:',
        '  ~ a              = "old" -> "new"',
        '',
        'You can apply this plan to save these new output values to the Terraform',
        'state, without changing any real infrastructure.',
      ),
    )
    expect(out).not.toContain('Terraform will perform')
  })

  it('prints the legend header with no symbol lines for a forget-only plan', () => {
    const f = item({ action: 'forget', address: 'aws_vpc.old', type: 'aws_vpc', name: 'old', unchanged: { id: 'vpc-1' } })
    expect(renderPlan(result({ items: [f] })).split('\n\n')[0]).toBe(text('Terraform used the selected providers to generate the following execution', 'plan. Resource actions are indicated with the following symbols:'))
  })

  it('renders drift above the plan, for a changed and a deleted object', () => {
    const r = result({
      drift: [
        { address: 'aws_vpc.main', kind: 'changed', changes: [{ name: 'tags', before: { Name: 'main' }, after: { Name: 'main', Owner: 'ops' } }] },
        { address: 'aws_subnet.gone', kind: 'deleted', changes: [], before: { id: 'subnet-1', cidr_block: '10.0.1.0/24' } },
      ],
      refreshed: stateWith('aws_vpc', 'main', { id: 'vpc-1', tags: { Name: 'main', Owner: 'ops' }, cidr_block: '10.0.0.0/16' }),
      items: [item({ action: 'create', address: 'aws_subnet.gone', type: 'aws_subnet', name: 'gone', changes: [ch('cidr_block', undefined, '10.0.1.0/24')] })],
      summary: { add: 1, change: 0, destroy: 0 },
    })
    expect(renderPlan(r).split('\nTerraform used the selected providers')[0]).toBe(
      text(
        'Note: Objects have changed outside of Terraform',
        '',
        'Terraform detected the following changes made outside of Terraform since the',
        'last "terraform apply" which may have affected this plan:',
        '',
        '  # aws_vpc.main has changed',
        '  ~ resource "aws_vpc" "main" {',
        '        id         = "vpc-1"',
        '      ~ tags       = {',
        '            "Name"  = "main"',
        '          + "Owner" = "ops"',
        '        }',
        '        # (1 unchanged attribute hidden)',
        '    }',
        '',
        '  # aws_subnet.gone has been deleted',
        '  - resource "aws_subnet" "gone" {',
        '      - cidr_block = "10.0.1.0/24" -> null',
        '      - id         = "subnet-1" -> null',
        '    }',
        '',
        '',
        'Unless you have made equivalent changes to your configuration, or ignored the',
        'relevant attributes using ignore_changes, the following plan may include',
        'actions to undo or respond to these changes.',
        '',
        '─'.repeat(77),
        '',
      ),
    )
  })

  it('masks sensitive attributes in drift, changed and deleted', () => {
    const r = result({
      drift: [
        { address: 'aws_db_instance.db', kind: 'changed', changes: [{ name: 'password', before: 'oldpw', after: 'newpw' }] },
        { address: 'aws_db_instance.gone', kind: 'deleted', changes: [], before: { id: 'db-2', password: 'gonepw' } },
      ],
      refreshed: stateWith('aws_db_instance', 'db', { id: 'db-1', password: 'newpw', engine: 'postgres' }),
      items: [item({ action: 'create', changes: [ch('ami', undefined, 'a')] })],
      summary: { add: 1, change: 0, destroy: 0 },
    })
    const out = renderPlan(r)
    expect(out).toContain('      ~ password = (sensitive value)')
    expect(out).toContain('      - password = (sensitive value) -> null')
    for (const leak of ['oldpw', 'newpw', 'gonepw']) expect(out).not.toContain(leak)
  })

  it('masks outputs that were or are sensitive, including removed ones', () => {
    const refreshed = emptyState()
    refreshed.outputs = { gone_s: { value: 'x', sensitive: true }, flip: { value: 'old', sensitive: true } }
    const r = result({
      items: [item({ action: 'create', changes: [ch('ami', undefined, 'a')] })],
      outputs: [{ name: 'flip', value: 'new', sensitive: false }],
      refreshed,
      summary: { add: 1, change: 0, destroy: 0 },
    })
    expect(renderPlan(r).split('Changes to Outputs:\n')[1]).toBe(text('  ~ flip   = (sensitive value)', '  - gone_s = (sensitive value) -> null'))
  })

  it('shows output changes against the outputs already in state', () => {
    const refreshed = emptyState()
    refreshed.outputs = { name: { value: 'old' }, same: { value: 1 }, gone: { value: 'x' } }
    const r = result({
      items: [item({ action: 'create', changes: [ch('ami', undefined, 'a')] })],
      outputs: [
        { name: 'id', value: UNKNOWN, sensitive: false },
        { name: 'name', value: 'new', sensitive: false },
        { name: 'same', value: 1, sensitive: false },
        { name: 'secret', value: 'hunter2', sensitive: true },
      ],
      refreshed,
      summary: { add: 1, change: 0, destroy: 0 },
    })
    const out = renderPlan(r)
    expect(out.split('Plan: 1 to add, 0 to change, 0 to destroy.\n\n')[1]).toBe(
      text('Changes to Outputs:', '  - gone   = "x" -> null', '  + id     = (known after apply)', '  ~ name   = "old" -> "new"', '  + secret = (sensitive value)'),
    )
  })

  it('prints errors only, with the source line, and appends warnings after a plan', () => {
    const err = { severity: 'error' as const, summary: 'Bad', detail: 'short', file: 'main.tf', line: 2, col: 1, context: 'resource "a" "b"' }
    const out = renderPlan(result({ diagnostics: [err] }), { 'main.tf': 'x\n  oops\n' })
    expect(out).toBe(text('╷', '│ Error: Bad', '│ ', '│   on main.tf line 2, in resource "a" "b":', '│    2:   oops', '│ ', '│ short', '╵'))
    const warn = { severity: 'warning' as const, summary: 'Careful', detail: '', file: '', line: 0, col: 0 }
    const withWarning = renderPlan(result({ items: [item({ action: 'create', changes: [ch('a', undefined, 1)] })], summary: { add: 1, change: 0, destroy: 0 }, warnings: [warn] }))
    expect(withWarning.endsWith('\n\n╷\n│ Warning: Careful\n╵')).toBe(true)
  })
})
