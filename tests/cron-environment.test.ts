import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('cron-environment')

describe('cron-environment', () => {
  it('every route also requires the missing-backup alert', () => {
    expect(sc.solution_paths.length).toBeGreaterThan(0)
    for (const p of sc.solution_paths) expect(p).toContain('backup-alert')
  })
  it('credits both the crontab PATH and the full-path script as the fix', () => {
    expect(sc.solution_paths.map((p) => p[0]).sort()).toEqual(['crontab-path', 'fullpath-script'])
  })
  it('root crontab and symlinking stay non-fixes', () => {
    expect(sc.actions.find((a) => a.id === 'run-as-root')?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'link-everything')?.kind).toBe('destructive')
  })
})
