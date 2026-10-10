import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('dns-resolution-failure')
const rx = new RegExp(sc.actions.find((a) => a.id === 'update-resolv')!.file!.matches, 'm')

describe('dns-resolution-failure', () => {
  it('requires the inventory and running the role as well as the hand edit', () => expect(sc.solution_paths).toEqual([['update-resolv', 'add-to-inventory', 'run-role']]))
  it.each(['search example.com\nnameserver 10.0.0.2\nnameserver 10.0.0.3\n', 'nameserver 10.0.0.3\nnameserver 10.0.0.2'])('accepts a resolv.conf with both new resolvers', (f) => expect(rx.test(f)).toBe(true))
  it.each([
    'nameserver 10.0.0.53\nnameserver 10.0.0.2\nnameserver 10.0.0.3\n',
    'nameserver 10.0.0.2\nnameserver 10.0.0.53\nnameserver 10.0.0.3\n',
    'nameserver 10.0.0.2\n',
    'nameserver 10.0.0.2\nnameserver 10.0.0.53\n',
    'search example.com\nnameserver 10.0.0.53\n',
  ])('rejects %j', (f) => expect(rx.test(f)).toBe(false))
})
