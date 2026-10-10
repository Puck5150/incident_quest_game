import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('nginx-permission-denied')
const credit = (cmd: string) => sc.actions.find((a) => a.match_regex !== undefined && new RegExp(a.match_regex).test(cmd))

describe('nginx-permission-denied', () => {
  it.each([
    'sudo chown -R www-data:www-data /srv/www/promo',
    'chown -R www-data:www-data /srv/www/promo/',
    'sudo chown www-data /srv/www/promo',
    'chown www-data:www-data /srv/www/promo',
    'sudo chown -R www-data: /srv/www/promo',
  ])('credits %s as the fix', (c) => expect(credit(c)?.id).toBe('chown-dir'))

  it.each(['sudo chmod 755 /srv/www/promo', 'chmod o+rx /srv/www/promo', 'chmod a+rx /srv/www/promo/', 'chmod go+rx /srv/www/promo'])(
    'treats %s as wrong, not a fix',
    (c) => expect(credit(c)).toMatchObject({ id: 'chmod-open', kind: 'wrong' }),
  )

  it('keeps 777 destructive and chown-dir the only fix', () => {
    expect(credit('sudo chmod -R 777 /srv/www/promo')?.kind).toBe('destructive')
    expect(sc.actions.filter((a) => a.kind === 'fix').map((a) => a.id)).toEqual(['chown-dir'])
    expect(sc.solution_paths).toEqual([['chown-dir']])
  })
})
