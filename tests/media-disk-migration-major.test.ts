import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('media-disk-migration-major')
const st = atStage(sc, 2)
const id = (c: string) => actionFor(st, c)?.id

describe('media-disk-migration-major', () => {
  it('stage 3 needs copy, verified cleanup, unmount, fstab verify and the mount guard', () =>
    expect(st.solution_paths).toEqual([['recover-hidden', 'cleanup-hidden', 'umount-rootfs', 'verify-fstab', 'guard-service']]))
  it('credits the exact rsync and not variants', () => {
    expect(id('sudo rsync -a /mnt/rootfs/srv/media/ /srv/media/')).toBe('recover-hidden')
    for (const c of ['sudo rsync -a --delete /mnt/rootfs/srv/media/ /srv/media/', 'sudo rsync -r /mnt/rootfs/srv/media/ /srv/media/', 'sudo rsync -a /mnt/rootfs/srv/media/ /srv/media/; id'])
      expect(id(c)).not.toBe('recover-hidden')
  })
  it('credits umount and findmnt --verify', () => {
    expect(id('sudo umount /mnt/rootfs')).toBe('umount-rootfs')
    expect(id('findmnt --verify')).toBe('verify-fstab')
    expect(id('sudo umount /srv/media')).not.toBe('umount-rootfs')
  })
  it.each(['sudo rm -rf /srv/media/*', 'rm -rf /srv/media'])('%s on the live disk is destructive', (c) => expect(actionFor(st, c)).toMatchObject({ id: 'rm-new-disk', kind: 'destructive' }))
  it('does not auto-credit a typed delete of the hidden copy (click after verifying)', () => expect(id('sudo rm -rf /mnt/rootfs/srv/media/*')).toBeUndefined())
})
