import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('nginx-permission-denied')
const id = (c: string) => actionFor(sc, c)?.id

describe('nginx-permission-denied', () => {
  it('needs both the group and the least-privilege mode', () => expect(sc.solution_paths).toEqual([['group-www', 'mode-750']]))

  it.each([
    'sudo chgrp -R www-data /srv/www/promo',
    'chgrp www-data /srv/www/promo/',
    'sudo chown -R :www-data /srv/www/promo',
    'sudo chown -R alice:www-data /srv/www/promo',
  ])('credits %s as the group step', (c) => expect(id(c)).toBe('group-www'))

  it.each([
    'sudo chmod -R u=rwX,g=rX,o= /srv/www/promo',
    'chmod -R g+rX,o-rwx /srv/www/promo/',
    'sudo chmod 750 /srv/www/promo',
  ])('credits %s as the mode step', (c) => expect(id(c)).toBe('mode-750'))

  it.each(['sudo chmod 0750 /srv/www/promo', 'sudo chmod -R --recursive g+rX,o-rwx /srv/www/promo'.replace('-R --recursive', '--recursive'), 'chmod u=rwx,g=rx,o= /srv/www/promo', 'sudo chmod --recursive u=rwX,g=rX,o= /srv/www/promo'])('credits %s as the mode step', (c) => expect(id(c)).toBe('mode-750'))
  it('credits chgrp --recursive', () => expect(id('sudo chgrp --recursive www-data /srv/www/promo')).toBe('group-www'))
  it.each(['sudo chmod -R 750 /srv/www/promo', 'sudo chmod 770 /srv/www/promo', 'chmod -R g+w /srv/www/promo', 'sudo chmod -R 0750 /srv/www/promo'])('gives teaching feedback for %s', (c) => expect(actionFor(sc, c)).toMatchObject({ id: 'chmod-loose', kind: 'wrong' }))
  it.each([
    'sudo chown -R www-data:www-data /srv/www/promo',
    'chown -R www-data:www-data /srv/www/promo/',
    'sudo chown www-data /srv/www/promo',
    'sudo chown -R www-data: /srv/www/promo',
  ])('treats %s as wrong: the worker would own its content', (c) => expect(actionFor(sc, c)).toMatchObject({ id: 'chown-www', kind: 'wrong' }))

  it.each(['sudo chmod 755 /srv/www/promo', 'chmod o+rx /srv/www/promo', 'chmod a+rx /srv/www/promo/', 'chmod go+rx /srv/www/promo'])(
    'treats %s as wrong, not a fix',
    (c) => expect(actionFor(sc, c)).toMatchObject({ id: 'chmod-open', kind: 'wrong' }),
  )

  it.each([
    'sudo chmod -R 750 /srv/www/promo; echo',
    'sudo chgrp -R www-data /srv/www/promo && x',
    'sudo chmod -R g+rwX,o-rwx /srv/www/promo',
    'sudo chmod -R 770 /srv/www/promo',
    'sudo chgrp -R www-data /srv/www',
    'sudo chmod 750 /srv/www/promo/..',
  ])('does not credit %s', (c) => expect(['group-www', 'mode-750']).not.toContain(id(c)))

  it('keeps 777 destructive and only the two least-privilege steps as fixes', () => {
    expect(actionFor(sc, 'sudo chmod -R 777 /srv/www/promo')?.kind).toBe('destructive')
    expect(sc.actions.filter((a) => a.kind === 'fix').map((a) => a.id)).toEqual(['group-www', 'mode-750'])
  })
})
