import { describe, expect, it } from 'vitest'
import { UNKNOWN } from '../src/game/terraform/eval.ts'
import type { PlanItem } from '../src/game/terraform/plan.ts'
import { resourceBlock } from '../src/game/terraform/render.ts'

const ch = (name: string, before: unknown, after: unknown, extra: { forcesReplacement?: boolean; sensitive?: boolean } = {}) =>
  ({ name, before, after, forcesReplacement: false, sensitive: false, ...extra }) as PlanItem['changes'][number]
const item = (o: Partial<PlanItem> & Pick<PlanItem, 'action'>): PlanItem => ({ address: 'aws_instance.web', type: 'aws_instance', name: 'web', changes: [], ...o })
const text = (...ls: string[]) => ls.join('\n')

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
        '      ~ ami = "ami-1" -> "ami-2" # forces replacement',
        '      ~ id  = "i-1" -> (known after apply)',
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

  it('renders a changed nested block list', () => {
    const out = resourceBlock(
      item({ action: 'update', address: 'aws_security_group.web', type: 'aws_security_group', name: 'web', changes: [ch('ingress', [{ from_port: 22, to_port: 22 }], [{ from_port: 22, to_port: 2222 }])], unchanged: { id: 'sg-1' } }),
    )
    expect(out).toBe(
      text(
        '  # aws_security_group.web will be updated in-place',
        '  ~ resource "aws_security_group" "web" {',
        '        id      = "sg-1"',
        '      ~ ingress {',
        '          ~ to_port = 22 -> 2222',
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

  it('renders a pure move', () => {
    expect(resourceBlock(item({ action: 'noop', address: 'aws_db_instance.primary', type: 'aws_db_instance', name: 'primary', movedFrom: 'aws_db_instance.orders', unchanged: { id: 'db-1', engine: 'postgres' } }))).toBe(
      text(
        '  # aws_db_instance.orders has moved to aws_db_instance.primary',
        '    resource "aws_db_instance" "primary" {',
        '        id = "db-1"',
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

  it('renders forget as a single resource row', () => {
    expect(resourceBlock(item({ action: 'forget', address: 'aws_vpc.old', type: 'aws_vpc', name: 'old' }))).toBe(
      text('  # aws_vpc.old will no longer be managed by Terraform, but will not be destroyed', '  # (destroy = false is set in the configuration)', '    resource "aws_vpc" "old" {}'),
    )
  })
})
