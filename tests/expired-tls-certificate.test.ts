import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('expired-tls-certificate')

describe('expired-tls-certificate', () => {
  it('requires the port 80 reopen, the renewal and expiry monitoring', () => expect(sc.solution_paths).toEqual([['allow-80', 'renew', 'add-expiry-monitor']]))
  it('credits only a plain certbot renew', () => {
    expect(actionFor(sc, 'sudo certbot renew')?.id).toBe('renew')
    expect(actionFor(sc, 'sudo certbot renew --force-renewal; id')?.id).not.toBe('renew')
  })
  it('curl -k stays destructive', () => expect(sc.actions.find((a) => a.id === 'skip-verify')?.kind).toBe('destructive'))
})
