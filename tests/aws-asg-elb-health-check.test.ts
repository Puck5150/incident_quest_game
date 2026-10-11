import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-asg-elb-health-check')
const U = 'aws autoscaling update-auto-scaling-group --auto-scaling-group-name web-asg --health-check-type ELB'

describe('aws-asg-elb-health-check', () => {
  it('requires the maintenance policy and alarm', () => expect(sc.solution_paths).toEqual([['elb-health-check', 'maintenance-policy', 'alarm-unhealthy']]))
  it.each([`${U} --health-check-grace-period=300`, `${U} --health-check-grace-period 300`, `${U} --health-check-grace-period 100`, `${U} --health-check-grace-period 999`, `${U} --health-check-grace-period 1000`, `${U} --health-check-grace-period 1800`])('credits %s', (c) => expect(actionFor(sc, c)?.id).toBe('elb-health-check'))
  it.each([`${U} --health-check-grace-period 0`, `${U} --health-check-grace-period 30`, `${U} --health-check-grace-period 99`])('flags a boot-less grace period as wrong: %s', (c) =>
    expect(actionFor(sc, c)).toMatchObject({ id: 'grace-zero', kind: 'wrong' }),
  )
  it.each([U, `${U} --health-check-grace-period 300; echo`, `${U} --health-check-grace-period 300 && x`, `${U} --health-check-grace-period 0300`, U.replace('ELB', 'EC2')])('does not credit %s', (c) =>
    expect(actionFor(sc, c)?.id).not.toBe('elb-health-check'),
  )
  it('flags a bare ELB switch and over-long grace periods as wrong', () => {
    expect(actionFor(sc, U)).toMatchObject({ id: 'grace-unset', kind: 'wrong' })
    for (const n of [1801, 3600, 86400, 10000]) expect(actionFor(sc, `${U} --health-check-grace-period ${n}`)).toMatchObject({ id: 'grace-too-long', kind: 'wrong' })
  })
})
