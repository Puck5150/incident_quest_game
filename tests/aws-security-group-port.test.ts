import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-security-group-port')
const AU = 'aws ec2 authorize-security-group-ingress --group-id sg-0reports --protocol tcp'
const RV = 'aws ec2 revoke-security-group-ingress --group-id sg-0reports --protocol tcp --port 443 --cidr 0.0.0.0/0'

describe('aws-security-group-port', () => {
  it('requires removing the stray world-open 443 rule', () => expect(sc.solution_paths).toEqual([['allow-from-alb', 'remove-443-world']]))
  it('credits the exact revoke', () => expect(actionFor(sc, RV)?.id).toBe('remove-443-world'))
  it.each([`${RV}; echo`, `${RV} && x`, RV.replace('443', '22'), RV.replace('0.0.0.0/0', '203.0.113.0/24'), RV.replace('sg-0reports', 'sg-0alb'), RV.replace('0.0.0.0', '0x0.0.0.0'), RV.replace('0.0.0.0/0', '0a0b0c0/0')])('does not credit %s', (c) =>
    expect(actionFor(sc, c)?.id).not.toBe('remove-443-world'),
  )
  it('credits only the SG-to-SG reference for 8080', () => {
    expect(actionFor(sc, `${AU} --port 8080 --source-group sg-0alb`)?.id).toBe('allow-from-alb')
    for (const c of [`${AU} --port 8080 --cidr 0.0.0.0/0`, `${AU} --port 8080 --source-group sg-0alb; echo`, `${AU} --port 22 --source-group sg-0alb`]) expect(actionFor(sc, c)?.id).not.toBe('allow-from-alb')
    expect(actionFor(sc, `${AU} --port 8080 --cidr 0.0.0.0/0`)?.kind).toBe('wrong')
  })
})
