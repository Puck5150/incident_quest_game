import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-nat-gateway-cost')
const M = 'aws ec2 modify-vpc-endpoint --vpc-endpoint-id vpce-0s3gw --policy-document'
const good = `{"Statement":[{"Effect":"Allow","Principal":"*","Action":["s3:GetObject","s3:PutObject","s3:ListBucket"],"Resource":["arn:aws:s3:::acme-media-*","arn:aws:s3:::acme-media-*/*"]}]}`
const C = 'aws ec2 create-vpc-endpoint --vpc-id vpc-0shop --service-name com.amazonaws.us-east-1.s3 --route-table-ids rtb-0private'

describe('aws-nat-gateway-cost', () => {
  it('requires the scoped endpoint policy', () => expect(sc.solution_paths).toEqual([['s3-endpoint', 'endpoint-policy', 'budget-alert']]))
  it('credits the scoped policy', () => expect(actionFor(sc, `${M} '${good}'`)?.id).toBe('endpoint-policy'))
  it.each([
    `${M} '{"Statement":[{"Effect":"Allow","Principal":"*","Action":"*","Resource":"*"}]}'`,
    `${M} '{"Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:*","Resource":"arn:aws:s3:::acme-media-*"}]}'`,
    `${M} '{"Statement":[{"Effect":"Allow","Principal":"*","Action":["s3:GetObject"],"Resource":["*"]}]}'`,
    `${M} '{"Statement":[{"Effect":"Allow","Principal":"*","Action":["s3:GetObject"],"Resource":"arn:aws:s3:::other-bucket/*"}]}'`,
    `${M} '${good}'; aws ec2 delete-vpc-endpoints --vpc-endpoint-ids vpce-0s3gw`,
    `${M} '${good}' && echo`,
    `${M} '$(cat /etc/passwd)'`,
    `${M} '${good}' --reset-policy`,
  ])('does not credit %s', (c) => expect(actionFor(sc, c)?.id).not.toBe('endpoint-policy'))
  it('flags allow-all as wrong', () => expect(actionFor(sc, `${M} '{"Statement":[{"Effect":"Allow","Principal":"*","Action":"*","Resource":"*"}]}'`)).toMatchObject({ id: 'endpoint-policy-wide', kind: 'wrong' }))
  it('still credits the endpoint creation, not a leaky variant', () => {
    expect(actionFor(sc, C)?.id).toBe('s3-endpoint')
    expect(actionFor(sc, `${C}; echo`)?.id).not.toBe('s3-endpoint')
  })
})
