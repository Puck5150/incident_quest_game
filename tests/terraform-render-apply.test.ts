import { describe, expect, it } from 'vitest'
import type { ApplyResult, ApplyStep } from '../src/game/terraform/apply.ts'
import { renderApplyEnd, renderApplyErrors, renderProgress } from '../src/game/terraform/render-apply.ts'
import { emptyState } from '../src/game/terraform/state.ts'
import type { Diagnostic } from '../src/game/terraform/types.ts'

const mk = (steps: ApplyStep[], o: Partial<ApplyResult> = {}): ApplyResult =>
  ({ plan: {}, steps, errors: [], state: emptyState(), reality: {}, counts: { imported: 0, added: 0, changed: 0, destroyed: 0 }, ...o }) as unknown as ApplyResult

describe('renderProgress', () => {
  it('renders a create/update/delete/import/forget mix', () => {
    const r = mk([
      { address: 'aws_vpc.a', op: 'create', id: 'vpc-1', seconds: 1, ok: true },
      { address: 'aws_s3_bucket.b', op: 'update', id: 'b', seconds: 2, ok: true },
      { address: 'aws_s3_bucket.c', op: 'delete', id: 'c', seconds: 3, ok: true },
      { address: 'aws_s3_bucket.d', op: 'import', id: 'd', seconds: 0, ok: true },
      { address: 'aws_s3_bucket.e', op: 'forget', seconds: 0, ok: true },
    ])
    expect(renderProgress(r)).toBe(
      [
        'aws_vpc.a: Creating...',
        'aws_vpc.a: Creation complete after 1s [id=vpc-1]',
        'aws_s3_bucket.b: Modifying... [id=b]',
        'aws_s3_bucket.b: Modifications complete after 2s [id=b]',
        'aws_s3_bucket.c: Destroying... [id=c]',
        'aws_s3_bucket.c: Destruction complete after 3s',
        'aws_s3_bucket.d: Importing... [id=d]',
        'aws_s3_bucket.d: Import complete [id=d]',
      ].join('\n'),
    )
  })
  it('prints Still lines for a 130s create', () => {
    const lines = renderProgress(mk([{ address: 'aws_db_instance.d', op: 'create', id: 'orders', seconds: 130, ok: true }])).split('\n')
    expect(lines).toHaveLength(14)
    expect(lines[1]).toBe('aws_db_instance.d: Still creating... [10s elapsed]')
    expect(lines[6]).toBe('aws_db_instance.d: Still creating... [1m0s elapsed]')
    expect(lines[12]).toBe('aws_db_instance.d: Still creating... [2m0s elapsed]')
    expect(lines[13]).toBe('aws_db_instance.d: Creation complete after 2m10s [id=orders]')
  })
  it('puts ids on update/delete Still lines and none at exactly 10s', () => {
    expect(renderProgress(mk([{ address: 'x.a', op: 'update', id: 'i', seconds: 21, ok: true }]))).toContain('x.a: Still modifying... [id=i, 20s elapsed]')
    expect(renderProgress(mk([{ address: 'x.a', op: 'delete', id: 'i', seconds: 31, ok: true }]))).toContain('x.a: Still destroying... [id=i, 30s elapsed]')
    expect(renderProgress(mk([{ address: 'x.a', op: 'create', id: 'i', seconds: 10, ok: true }]))).not.toContain('Still')
  })
  it('failed steps print only the start line', () => {
    expect(renderProgress(mk([{ address: 'aws_subnet.a', op: 'create', seconds: 90, ok: false }]))).toBe('aws_subnet.a: Creating...')
    expect(renderProgress(mk([{ address: 'aws_vpc.a', op: 'delete', id: 'vpc-1', seconds: 90, ok: false }]))).toBe('aws_vpc.a: Destroying... [id=vpc-1]')
  })
})

describe('renderApplyEnd', () => {
  it('apply with imports', () => {
    expect(renderApplyEnd(mk([], { counts: { imported: 1, added: 0, changed: 0, destroyed: 0 } }), 'apply')).toBe('\nApply complete! Resources: 1 imported, 0 added, 0 changed, 0 destroyed.')
  })
  it('destroy', () => {
    expect(renderApplyEnd(mk([], { counts: { imported: 0, added: 0, changed: 0, destroyed: 4 } }), 'destroy')).toBe('\nDestroy complete! Resources: 4 destroyed.')
  })
  it('outputs, sensitive hidden', () => {
    const state = emptyState()
    state.outputs = { name: { value: 'x' }, pw: { value: 'secret', sensitive: true } }
    const out = renderApplyEnd(mk([], { state, counts: { imported: 0, added: 2, changed: 0, destroyed: 0 } }), 'apply')
    expect(out).toBe('\nApply complete! Resources: 2 added, 0 changed, 0 destroyed.\n\nOutputs:\n\nname = "x"\npw = <sensitive>')
  })
  it('empty when errors', () => {
    const d: Diagnostic = { severity: 'error', summary: 's', detail: '', file: '', line: 0, col: 0 }
    expect(renderApplyEnd(mk([], { errors: [d] }), 'apply')).toBe('')
  })
})

describe('renderApplyErrors', () => {
  it('boxes errors with source', () => {
    const d: Diagnostic = { severity: 'error', summary: 'boom', detail: 'bad', file: 'main.tf', line: 1, col: 1, context: 'resource "aws_s3_bucket" "b"', address: 'aws_s3_bucket.b' }
    const out = renderApplyErrors(mk([], { errors: [d, d] }), { 'main.tf': 'resource "aws_s3_bucket" "b" {}' })
    expect(out).toContain('│ Error: boom')
    expect(out).toContain('│   with aws_s3_bucket.b,')
    expect(out).toContain('│   on main.tf line 1, in resource "aws_s3_bucket" "b":')
    expect(out).toContain('│    1: resource "aws_s3_bucket" "b" {}')
    expect(out.split('╵\n\n╷')).toHaveLength(2)
  })
})
