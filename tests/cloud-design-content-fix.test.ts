// Regression tests for the strict cloud-design audit: weak (convenient but
// insecure or fragile) combinations must fail; the secure ones must pass.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { evaluate } from '../src/game/challenge.ts'
import type { Challenge, Picks } from '../src/schema/challenge.ts'

const content = loadContent(path.resolve(import.meta.dirname, '../content'))
const get = (id: string): Challenge => content.challenges.find((x) => x.id === id)!
const failed = (c: Challenge, picks: Picks) => {
  const e = evaluate(c, picks)
  return [...e.tests.filter((t) => !t.pass).map((t) => t.id), ...(e.withinBudget ? [] : ['budget'])]
}
const ok = (c: Challenge, picks: Picks) => expect(failed(c, picks)).toEqual([])

describe('edge services need a locked origin', () => {
  it('Azure TV ad: Front Door with the app left open fails; locked passes', () => {
    const c = get('azure-tv-ad-marketing-site')
    expect(failed(c, { edge: 'front-door', origin: 'origin-open', web: 'zone-redundant' })).toEqual(['origin-bypass'])
    ok(c, { edge: 'front-door', origin: 'origin-locked', web: 'zone-redundant' })
    ok(c, { edge: 'front-door', origin: 'origin-locked', web: 'two-regions' })
  })
  for (const p of ['aws', 'azure', 'gcp'] as const)
    it(`traffic-spike-any-cloud [${p}]`, () => {
      const c = content.multis.find((m) => m.id === 'traffic-spike-any-cloud')!.variants[p] as Challenge
      expect(failed(c, { edge: 'cdn', origin: 'origin-open', web: 'multi-zone-group' })).toEqual(['origin-bypass'])
      ok(c, { edge: 'cdn', origin: 'origin-locked', web: 'multi-zone-group' })
      ok(c, { edge: 'cdn', origin: 'origin-locked', web: 'two-regions' })
    })
})

describe('azure-vnet-network-layout storage path', () => {
  const c = get('azure-vnet-network-layout')
  const base = { web: 'web-appgw', database: 'db-private', outbound: 'nat-v2' }
  it('a service endpoint alone does not close the public endpoint', () => {
    expect(failed(c, { ...base, storage: 'storage-service-endpoint' })).toEqual(['internet-scan'])
  })
  it('endpoint + deny firewall, or a private endpoint, passes', () => {
    ok(c, { ...base, storage: 'storage-endpoint-firewall' })
    ok(c, { ...base, storage: 'storage-private-endpoint' })
  })
})

describe('azure-entra-groups-access licensing', () => {
  const c = get('azure-entra-groups-access')
  const base = { membership: 'assign-dynamic', admins: 'admins-least' }
  it('Conditional Access (P1 for everyone) and security defaults both pass within budget', () => {
    ok(c, { ...base, signin: 'signin-ca' })
    ok(c, { ...base, signin: 'signin-defaults' })
  })
  it('Conditional Access costs more than security defaults', () => {
    expect(evaluate(c, { ...base, signin: 'signin-ca' }).cost).toBeGreaterThan(evaluate(c, { ...base, signin: 'signin-defaults' }).cost)
  })
  it('standing Global Admins and password-only still fail', () => {
    expect(failed(c, { ...base, admins: 'admins-global', signin: 'signin-ca' })).toContain('phish')
    expect(failed(c, { ...base, signin: 'signin-password' })).toEqual(expect.arrayContaining(['phish', 'mfa']))
  })
})

describe('aws-clickstream-ingestion retention', () => {
  const c = get('aws-clickstream-ingestion')
  const base = { ingest: 'ingest-kds-ondemand', delivery: 'delivery-firehose' }
  it('default 24 h retention cannot replay a day with margin', () => {
    expect(failed(c, { ...base, retention: 'retention-default' })).toEqual(['replay'])
  })
  it('extended retention passes within budget', () => ok(c, { ...base, retention: 'retention-extended' }))
})

describe('gcp-iam-groups-access phishing resistance', () => {
  const c = get('gcp-iam-groups-access')
  const base = { who: 'grant-dynamic', roles: 'role-bq' }
  it('2SV that allows codes and prompts still fails the phishing test', () => {
    expect(failed(c, { ...base, signin: 'signin-2sv' })).toEqual(['phish'])
  })
  it('security keys / passkeys pass', () => ok(c, { ...base, signin: 'signin-keys' }))
})

describe('public images are rejected on containers', () => {
  it('AWS: public Docker Hub fails the audit as well as pulls', () => {
    const c = get('aws-containers-platform')
    const f = failed(c, { platform: 'run-ecs-fargate', registry: 'reg-dockerhub', secrets: 'secret-sm' })
    expect(f).toEqual(expect.arrayContaining(['pulls', 'audit']))
  })
  it('GCP: public Docker Hub fails', () => {
    const c = get('gcp-containers-platform')
    expect(failed(c, { platform: 'run-cloud-run', registry: 'reg-dockerhub', secrets: 'secret-manager' })).toContain('pulls')
  })
})

describe('gcp-clickstream-ingestion', () => {
  it('a Cloud SQL table is still not a feed or a replay log', () => {
    const c = get('gcp-clickstream-ingestion')
    expect(failed(c, { ingest: 'ingest-sql', delivery: 'delivery-bq-sub' })).toEqual(expect.arrayContaining(['viral', 'fan-out', 'replay']))
  })
})
