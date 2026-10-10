import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('ssh-strictmodes')
const id = (c: string) => actionFor(sc, c)?.id
const D = '/var/lib/deploy-agent/tmp'

describe('ssh-strictmodes', () => {
  it('requires the home fix, the dedicated directory and pointing the app at it', () => expect(sc.solution_paths).toEqual([['fix-home', 'app-tempdir', 'point-app']]))
  it.each(['sudo chmod 755 /home/deploy', 'chmod go-w /home/deploy/', 'sudo chmod 750 /home/deploy'])('credits %s', (c) => expect(id(c)).toBe('fix-home'))
  it.each(['sudo chmod 775 /home/deploy', 'chmod 777 /home/deploy', 'sudo chmod 755 /home/deploy; id'])('does not credit %s', (c) => expect(id(c)).not.toBe('fix-home'))
  it.each([
    `sudo install -d -o deploy -g deploy -m 700 ${D}`,
    `install -d -m 0750 -o deploy ${D}/`,
    `sudo install -d -g deploy -o deploy -m 750 ${D}`,
  ])('credits %s', (c) => expect(id(c)).toBe('app-tempdir'))
  it.each([
    `sudo install -d -o root -m 700 ${D}`,
    `sudo install -d -o deploy -m 777 ${D}`,
    `sudo install -d -o deploy ${D}`,
    `sudo install -d -o deploy -o deploy -m 700 ${D}`,
    `sudo install -d -o deploy -m 700 /home/deploy`,
    `sudo install -d -o deploy -m 700 ${D}; id`,
    `sudo install -d -o deploy -m 700 -m 750 ${D}`,
  ])('does not credit %s', (c) => expect(id(c)).not.toBe('app-tempdir'))
  it.each(['sudo chmod 777 /var/lib/deploy-agent/tmp', 'chmod -R a+rwx /var/lib/deploy-agent'])('%s is wrong', (c) => expect(actionFor(sc, c)).toMatchObject({ id: 'tempdir-777', kind: 'wrong' }))
})
