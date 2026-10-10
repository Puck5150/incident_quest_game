import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-single-az-database')
const M = 'aws rds modify-db-instance --db-instance-identifier shop-db-reports'

describe('aws-single-az-database', () => {
  it('requires every secure step', () => expect(sc.solution_paths).toEqual([['promote-replica', 'repoint-app', 'set-backup-retention', 'enable-multi-az', 'fence-old-primary', 'new-reports-replica']]))
  it.each([`${M} --multi-az --apply-immediately`, `${M} --apply-immediately --multi-az`])('credits %s', (c) => expect(actionFor(sc, c)?.id).toBe('enable-multi-az'))
  it('flags Multi-AZ without --apply-immediately as wrong', () => expect(actionFor(sc, `${M} --multi-az`)).toMatchObject({ id: 'multi-az-deferred', kind: 'wrong' }))
  it.each([`${M} --multi-az --apply-immediately; aws rds delete-db-instance --db-instance-identifier shop-db-reports`, `${M} --no-multi-az --apply-immediately`, `${M} --multi-az --apply-immediately && x`])('does not credit %s', (c) =>
    expect(actionFor(sc, c)?.id).not.toBe('enable-multi-az'),
  )
  it.each([7, 14, 35])('credits backup retention %s', (n) => expect(actionFor(sc, `${M} --backup-retention-period ${n} --apply-immediately`)?.id).toBe('set-backup-retention'))
  it.each([`${M} --backup-retention-period 0 --apply-immediately`, `${M} --backup-retention-period 1 --apply-immediately`, `${M} --backup-retention-period 36 --apply-immediately`, `${M} --backup-retention-period 7`, `${M} --backup-retention-period 7 --apply-immediately; echo`])(
    'does not credit %s',
    (c) => expect(actionFor(sc, c)?.id).not.toBe('set-backup-retention'),
  )
  it('credits stopping, not deleting or rebooting, the old primary', () => {
    expect(actionFor(sc, 'aws rds stop-db-instance --db-instance-identifier shop-db')?.id).toBe('fence-old-primary')
    expect(actionFor(sc, 'aws rds stop-db-instance --db-instance-identifier shop-db-reports')?.id).not.toBe('fence-old-primary')
    expect(actionFor(sc, 'aws rds delete-db-instance --db-instance-identifier shop-db --skip-final-snapshot')).toMatchObject({ kind: 'destructive' })
    expect(actionFor(sc, 'aws rds reboot-db-instance --db-instance-identifier shop-db')).toMatchObject({ kind: 'wrong' })
  })
  const R = (id: string, src = 'shop-db-reports') => `aws rds create-db-instance-read-replica --db-instance-identifier ${id} --source-db-instance-identifier ${src}`
  it.each([R('shop-db-analytics'), `${R('shop-db-analytics')} --db-instance-class db.t3.medium`])('credits %s', (c) => expect(actionFor(sc, c)?.id).toBe('new-reports-replica'))
  it.each([R('shop-db-reports'), R('shop-db'), R('shop-db-analytics', 'shop-db'), `${R('shop-db-analytics')}; echo`, `${R('x')} --publicly-accessible`])('does not credit %s', (c) =>
    expect(actionFor(sc, c)?.id).not.toBe('new-reports-replica'),
  )
})
