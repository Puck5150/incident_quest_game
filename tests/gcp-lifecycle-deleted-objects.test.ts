import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('gcp-lifecycle-deleted-objects')
const r = 'gcloud storage restore "gs://acme-user-docs/**"'
describe('gcp-lifecycle-deleted-objects', () => {
  it('requires clear, bounded restore, the exports rule and guards', () => {
    expect(sc.solution_paths).toEqual([['stop-rule', 'bulk-restore', 'exports-rule', 'protect-docs']])
  })
  it('restore must start inside the incident window', () => {
    for (const l of [`${r} --async --deleted-after-time=2026-09-30T16:40:00Z`, `${r} --deleted-after-time 2026-09-30T16:41:00Z --async`, `${r} --async --deleted-after-time=2026-09-30T16:40:00Z --deleted-before-time=2026-10-02T09:00:00Z`])
      expect(credit(l)?.id).toBe('bulk-restore')
    for (const l of [`${r} --async --deleted-after-time=2020-01-01T00:00:00Z`, `${r} --async`, `${r} --async --deleted-after-time=2026-09-30T16:40:99Z`, `${r} --deleted-after-time=2026-09-30T16:40:00Z --deleted-before-time=2026-10-02T99:99:99Z`, `${r} --async --async --deleted-after-time=2026-09-30T16:40:00Z`, `${r} --deleted-after-time=2026-09-30T16:40:00Z; true`])
      expect(credit(l)?.id).not.toBe('bulk-restore')
  })
  it('the exports rule goes to the exports bucket, never back on the documents', () => {
    expect(credit('gcloud storage buckets update gs://acme-exports --lifecycle-file=exports-cleanup.json')?.id).toBe('exports-rule')
    expect(credit('gcloud storage buckets update gs://acme-user-docs --lifecycle-file=exports-cleanup.json')?.id).toBe('reapply-docs')
    expect(credit('gcloud storage buckets update gs://acme-user-docs --lifecycle-file=safe-docs.json')?.id).not.toBe('reapply-docs')
  })
})
