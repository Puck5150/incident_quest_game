import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-lambda-vpc-public-subnet')
const U = 'aws lambda update-function-configuration --function-name order-webhook --vpc-config SubnetIds=subnet-0priva,subnet-0privb,SecurityGroupIds=sg-0webhook'

describe('aws-lambda-vpc-public-subnet', () => {
  it('credits only the exact private-subnet move', () => {
    expect(actionFor(sc, U)?.id).toBe('private-subnets')
    for (const c of [`${U}; echo`, U.replace('subnet-0priva', 'subnet-0puba'), U.replace('sg-0webhook', 'sg-0default'), `${U} --timeout 900`, `${U} && x`]) expect(actionFor(sc, c)?.id).not.toBe('private-subnets')
  })
  it('keeps detaching the VPC destructive and the hypothesis text honest about egress', () => {
    expect(sc.actions.find((a) => a.id === 'detach-vpc')?.kind).toBe('destructive')
    expect(sc.hypotheses.find((h) => h.id === 'security-group')?.feedback).toMatch(/least-privilege/)
  })
})
