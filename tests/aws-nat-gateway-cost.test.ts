import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-nat-gateway-cost')
const M = 'aws ec2 modify-vpc-endpoint --vpc-endpoint-id vpce-0s3gw --policy-document'
const stmt = (o: Record<string, unknown> = {}) => ({ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'], Resource: ['arn:aws:s3:::acme-media-*', 'arn:aws:s3:::acme-media-*/*'], ...o })
const doc = (...s: object[]) => JSON.stringify({ Version: '2012-10-17', Statement: s })
const q = (d: string) => `${M} '${d}'`
const C = 'aws ec2 create-vpc-endpoint --vpc-id vpc-0shop --service-name com.amazonaws.us-east-1.s3 --route-table-ids rtb-0private'

describe('aws-nat-gateway-cost', () => {
  it('requires the scoped endpoint policy', () => expect(sc.solution_paths).toEqual([['s3-endpoint', 'endpoint-policy', 'budget-alert']]))
  it.each([
    q(doc(stmt())),
    q(doc(stmt({ Action: 's3:GetObject' }), stmt({ Action: ['s3:PutObject', 's3:GetBucketLocation'] }))),
    q(doc(stmt({ Action: ['s3:getobject', 's3:putobject'] }))),
    q(JSON.stringify({ Statement: stmt() })),
    `${M} "${doc(stmt()).replaceAll('"', '\\"')}"`,
    `aws ec2 modify-vpc-endpoint --policy-document '${doc(stmt())}' --vpc-endpoint-id=vpce-0s3gw`,
    q(doc(stmt({ Principal: { AWS: '*' } }))),
    q(doc(stmt({ Principal: { AWS: ['*'] } }))),
    `${q(doc(stmt()))} --region us-east-1`,
    `aws --region eu-west-1 ec2 modify-vpc-endpoint --vpc-endpoint-id vpce-0s3gw --policy-document '${doc(stmt())}'`,
  ])('credits %s', (c) => expect(actionFor(sc, c)).toMatchObject({ id: 'endpoint-policy', kind: 'fix' }))

  const bad: Record<string, string> = {
    deny: q(doc(stmt({ Effect: 'Deny' }))),
    'action *': q(doc(stmt({ Action: ['s3:GetObject', 's3:PutObject', '*'] }))),
    'action s3:*': q(doc(stmt({ Action: ['s3:*'] }))),
    'action s3:Delete*': q(doc(stmt({ Action: ['s3:GetObject', 's3:PutObject', 's3:Delete*'] }))),
    'action s3:*Object': q(doc(stmt({ Action: ['s3:*Object'] }))),
    'resource *': q(doc(stmt({ Resource: ['arn:aws:s3:::acme-media-*', '*'] }))),
    'resource arn s3 *': q(doc(stmt({ Resource: ['arn:aws:s3:::acme-media-*', 'arn:aws:s3:::*'] }))),
    'extra bucket statement': q(doc(stmt(), stmt({ Action: 's3:PutObject', Resource: 'arn:aws:s3:::evil-bucket/*' }))),
    'other bucket only': q(doc(stmt({ Resource: 'arn:aws:s3:::other-bucket/*' }))),
    'prefix lookalike': q(doc(stmt({ Resource: 'arn:aws:s3:::acme-media-evil*/../*' }))),
    'NotAction': q(doc({ Effect: 'Allow', Principal: '*', NotAction: 's3:Delete*', Resource: 'arn:aws:s3:::acme-media-*' })),
    'principal service': q(doc(stmt({ Principal: { Service: '*' } }))),
    'principal mixed': q(doc(stmt({ Principal: { AWS: ['arn:aws:iam::111122223333:root', '*'] } }))),
    'missing required PutObject': q(doc(stmt({ Action: ['s3:GetObject'] }))),
  }
  it.each(Object.entries(bad))('flags %s as wrong, never credited', (_n, c) => {
    expect(actionFor(sc, c)?.id).not.toBe('endpoint-policy')
    expect(actionFor(sc, c)).toMatchObject({ id: 'endpoint-policy-wide', kind: 'wrong' })
  })
  it.each([
    ['malformed (missing brace)', q(doc(stmt()).slice(0, -1))],
    ['duplicate key', q(doc(stmt()).replace('"Effect":"Allow"', '"Effect":"Deny","Effect":"Allow"'))],
    ['second command', `${q(doc(stmt()))}; aws ec2 delete-vpc-endpoints --vpc-endpoint-ids vpce-0s3gw`],
    ['and-chain', `${q(doc(stmt()))} && echo`],
    ['substitution', `${M} "$(cat /etc/passwd)"`],
    ['backtick', `${M} '${doc(stmt())}' \`id\``],
    ['other endpoint', q(doc(stmt())).replace('vpce-0s3gw', 'vpce-0other')],
    ['bad region', `${q(doc(stmt()))} --region x;y`],
    ['two regions', `aws --region us-east-1 ec2 modify-vpc-endpoint --vpc-endpoint-id vpce-0s3gw --policy-document '${doc(stmt())}' --region us-west-2`],
    ['reset policy flag', `${q(doc(stmt()))} --reset-policy`],
    ['repeated policy-document', `${q(doc(stmt()))} --policy-document '${doc(stmt({ Action: '*' }))}'`],
    ['file://', `${M} file://endpoint-policy.json`],
    ['bare unquoted', `${M} ${doc(stmt())}`],
  ])('does not credit or flag %s', (_n, c) => {
    expect(actionFor(sc, c)?.id).not.toBe('endpoint-policy')
  })
  it('file:// gets a scripted note, not a verdict', () => expect(actionFor(sc, `${M} file://p.json`)).toBeUndefined())
  it('credits the endpoint creation with one region either side', () => {
    expect(actionFor(sc, `${C} --region us-east-1`)?.id).toBe('s3-endpoint')
    expect(actionFor(sc, C.replace('aws ec2', 'aws --region us-east-1 ec2'))?.id).toBe('s3-endpoint')
    expect(actionFor(sc, `${C.replace('aws ec2', 'aws --region us-east-1 ec2')} --region us-west-2`)?.id).toBe('s3-endpoint')
    expect(actionFor(sc, `${C} --region x;y`)?.id).not.toBe('s3-endpoint')
  })
  it('softened feedback', () => expect(sc.actions.find((a) => a.id === 'endpoint-policy')?.feedback).not.toMatch(/cannot use the endpoint to copy data out/))
  it('still credits the endpoint creation, not a leaky variant', () => {
    expect(actionFor(sc, C)?.id).toBe('s3-endpoint')
    expect(actionFor(sc, `${C}; echo`)?.id).not.toBe('s3-endpoint')
  })
})
