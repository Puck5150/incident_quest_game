import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('full-disk')

describe('full-disk', () => {
  it('requires truncation and the logrotate fix; the alert is a debrief follow-up', () => expect(sc.solution_paths).toEqual([['truncate-log', 'fix-logrotate']]))
  it('credits truncation in place, not rm of the held-open file', () => {
    expect(actionFor(sc, ': > /var/log/app/app.log')?.id).toBe('truncate-log')
    expect(actionFor(sc, 'sudo truncate -s 0 /var/log/app/app.log')?.id).toBe('truncate-log')
    expect(actionFor(sc, 'sudo rm /var/log/app/app.log')).toMatchObject({ id: 'rm-log', kind: 'wrong' })
    expect(actionFor(sc, 'sudo reboot')?.kind).toBe('destructive')
  })
})
