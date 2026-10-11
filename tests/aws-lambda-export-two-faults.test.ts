import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-lambda-export-two-faults')
const s1 = atStage(sc, 0)
const s2 = atStage(sc, 1)
const T = (n: string | number) => `aws lambda update-function-configuration --function-name order-export --timeout ${n}`
const AU = 'aws ec2 authorize-security-group-ingress --group-id sg-0ordersdb --protocol tcp --port 5432'

describe('aws-lambda-export-two-faults', () => {
  it('stage 1 credits only the SG-to-SG reference', () => {
    expect(actionFor(s1, `${AU} --source-group sg-0export`)?.id).toBe('allow-export')
    for (const c of [`${AU} --cidr 10.0.0.0/16`, `${AU} --cidr 0.0.0.0/0`, `${AU} --source-group sg-0export; echo`, `${AU} --source-group sg-0api`]) expect(actionFor(s1, c)?.id).not.toBe('allow-export')
  })
  it('stage 2 requires the alarm too', () => expect(s2.solution_paths).toEqual([['raise-timeout', 'alarm-export-failure']]))
  it.each([30, 60, 120, 299, 300])('credits timeout %s', (n) => expect(actionFor(s2, T(n))?.id).toBe('raise-timeout'))
  it.each([0, 3, 10, 29])('flags %s as too short', (n) => expect(actionFor(s2, T(n))).toMatchObject({ id: 'timeout-too-short', kind: 'wrong' }))
  it.each([301, 500, 900])('flags %s as too long', (n) => expect(actionFor(s2, T(n))).toMatchObject({ id: 'timeout-too-long', kind: 'wrong' }))
  it.each([`${T(30)}; echo`, `${T(30)} && x`, T('030'), T('$T'), `${T(30)} --memory-size 10240`])('does not credit %s', (c) => expect(actionFor(s2, c)?.id).not.toBe('raise-timeout'))
})
