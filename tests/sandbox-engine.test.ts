// The sandbox adapter and checks against the real engine. The sandbox file is
// built inline here; tests/sandbox-content.test.ts covers the shipped files.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { resolveSandbox, runCheck, sandboxChecks, validateDesign, SANDBOX_MAX_NODES, SPIKE } from '../src/game/sandbox.ts'
import type { SandboxChallenge, SandboxFile } from '../src/schema/sandbox.ts'
import type { Design } from '../src/schema/canvas.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const base = canvases.find((c) => c.id === 'aws-checkout-canvas')!

const file: SandboxFile = {
  type: 'sandbox',
  id: 'aws-sandbox',
  provider: 'aws',
  title: 'AWS design sandbox',
  extends: 'aws-checkout-canvas',
  layout: {
    regions: [
      { id: 'use1', label: 'us-east-1', zones: [{ id: 'use1-az1', label: 'us-east-1a' }, { id: 'use1-az2', label: 'us-east-1b' }] },
      { id: 'usw2', label: 'us-west-2', zones: [{ id: 'usw2-az1', label: 'us-west-2a' }, { id: 'usw2-az2', label: 'us-west-2b' }] },
    ],
    global: true,
  },
  palette: [
    { id: 'sqs', label: 'Amazon SQS queue', short: 'SQS', scope: 'regional', roles: ['neutral'], capacity: 0, cost: 1, facts: ['A message queue.'] },
    { id: 'cdn', label: 'Amazon CloudFront', short: 'CDN', scope: 'global', roles: ['neutral'], capacity: 0, cost: 2, facts: ['A CDN.'] },
  ],
  sources: [{ title: 'Example', url: 'https://example.com', retrieved: '2026-10-27' }],
}
const resolved = resolveSandbox(file, base)
if (typeof resolved === 'string') throw new Error(resolved)
const c: SandboxChallenge = resolved

const node = (id: string, type: string, lane: string) => ({ id, type, lane })
const traffic = (from: string, to: string) => ({ from, to, kind: 'traffic' as const })

// Load balancer, two web servers and two databases (sync standby) across two zones of one region.
const twoZone: Design = {
  nodes: [
    node('alb-1', 'alb', 'use1'),
    node('web-1', 'ec2-web', 'use1-az1'),
    node('web-2', 'ec2-web', 'use1-az2'),
    node('rds-1', 'rds', 'use1-az1'),
    node('rds-2', 'rds', 'use1-az2'),
  ],
  edges: [
    traffic('users', 'alb-1'),
    traffic('alb-1', 'web-1'),
    traffic('alb-1', 'web-2'),
    traffic('web-1', 'rds-1'),
    traffic('web-2', 'rds-1'),
    { from: 'rds-1', to: 'rds-2', kind: 'sync' },
  ],
}
// Everything in one zone.
const oneZone: Design = {
  nodes: [node('alb-1', 'alb', 'use1'), node('web-1', 'ec2-web', 'use1-az1'), node('rds-1', 'rds', 'use1-az1')],
  edges: [traffic('users', 'alb-1'), traffic('alb-1', 'web-1'), traffic('web-1', 'rds-1')],
}

const outcome = (d: Design) => Object.fromEntries(sandboxChecks(c, d).map((t) => [t.id, runCheck(c, d, t.id)!.pass]))

describe('resolveSandbox', () => {
  it('merges the base palette with the extras and carries the sandbox node cap', () => {
    expect(c.palette.map((p) => p.id)).toEqual([...base.palette.map((p) => p.id), 'sqs', 'cdn'])
    expect(c.max_nodes).toBe(SANDBOX_MAX_NODES)
    expect(c.layout.regions).toHaveLength(2)
    expect(c.provider).toBe('aws')
  })

  it('refuses duplicate ids among its own extra parts', () => {
    expect(resolveSandbox({ ...file, palette: [file.palette[0], file.palette[0]] }, base)).toMatch(/sqs/)
  })

  it('refuses a base from another cloud or a colliding palette id', () => {
    const azure = canvases.find((x) => x.provider === 'azure')!
    expect(resolveSandbox(file, azure)).toMatch(/aws/)
    expect(resolveSandbox({ ...file, palette: [{ ...file.palette[0], id: 'alb' }] }, base)).toMatch(/alb/)
  })
})

describe('sandboxChecks', () => {
  it('offers nothing for an empty design or one with only neutral parts', () => {
    expect(sandboxChecks(c, { nodes: [], edges: [] })).toEqual([])
    expect(sandboxChecks(c, { nodes: [node('sqs-1', 'sqs', 'use1')], edges: [] })).toEqual([])
  })

  it('builds the menu from what the design uses', () => {
    expect(sandboxChecks(c, twoZone).map((t) => t.id)).toEqual([
      'zone-use1-az1',
      'zone-use1-az2',
      'region-use1',
      'one-alb',
      'one-ec2-web',
      'one-rds',
      'spike',
    ])
  })

  it('gives a neutral-only type no "lose any one" check', () => {
    const withQueue: Design = { ...twoZone, nodes: [...twoZone.nodes, node('sqs-1', 'sqs', 'use1')] }
    expect(sandboxChecks(c, withQueue).some((t) => t.id === 'one-sqs')).toBe(false)
  })

  it('only requires roles the design contains, and the spike only with a web tier', () => {
    const noDb: Design = { nodes: [node('alb-1', 'alb', 'use1'), node('web-1', 'ec2-web', 'use1-az1')], edges: [traffic('users', 'alb-1'), traffic('alb-1', 'web-1')] }
    const checks = sandboxChecks(c, noDb)
    expect(checks.every((t) => !t.check.reach.includes('write-store'))).toBe(true)
    expect(outcome(noDb)['zone-use1-az1']).toBe(false) // the only web server is gone, not "no database"
    expect(runCheck(c, noDb, 'zone-use1-az1')!.reasons.join(' ')).not.toMatch(/database/i)
    const dbOnly: Design = { nodes: [node('rds-1', 'rds', 'use1-az1')], edges: [] }
    expect(sandboxChecks(c, dbOnly).some((t) => t.id === 'spike')).toBe(false)
    expect(sandboxChecks(c, dbOnly).every((t) => t.check.reach.join() === 'write-store')).toBe(true)
  })
})

describe('runCheck', () => {
  it('a two-zone design survives losing either zone and a spike, but not a region or its only load balancer', () => {
    expect(outcome(twoZone)).toEqual({
      'zone-use1-az1': true,
      'zone-use1-az2': true,
      'region-use1': false,
      'one-alb': false,
      'one-ec2-web': true,
      'one-rds': true,
      spike: true,
    })
  })

  it('a one-zone design fails the zone check for that zone, with a reason', () => {
    const r = runCheck(c, oneZone, 'zone-use1-az1')!
    expect(r.pass).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/web server/)
    expect(r.down).toEqual(expect.arrayContaining(['web-1', 'rds-1']))
  })

  it('one zone check reports only that zone, not other occupied zones', () => {
    const r = runCheck(c, twoZone, 'zone-use1-az2')!
    expect(r.pass).toBe(true)
    expect(r.reasons).toEqual([])
  })

  it('an unknown check id gives undefined', () => {
    expect(runCheck(c, twoZone, 'nope')).toBeUndefined()
  })

  it('a neutral part in front of the load balancer (or a chain of them) changes nothing', () => {
    const front: Design = {
      nodes: [...twoZone.nodes, node('cdn-1', 'cdn', 'global'), node('cdn-2', 'cdn', 'global')],
      edges: [...twoZone.edges.filter((e) => e.from !== 'users'), traffic('users', 'cdn-1'), traffic('cdn-1', 'alb-1')],
    }
    expect(outcome(front)).toEqual(outcome(twoZone))
    const chain: Design = {
      nodes: front.nodes,
      edges: [...twoZone.edges.filter((e) => e.from !== 'users'), traffic('users', 'cdn-1'), traffic('cdn-1', 'cdn-2'), traffic('cdn-2', 'alb-1')],
    }
    expect(outcome(chain)).toEqual(outcome(twoZone))
  })

  it('a queue between the load balancer and a web server does not make it reachable', () => {
    const viaQueue: Design = {
      nodes: [node('alb-1', 'alb', 'use1'), node('sqs-1', 'sqs', 'use1'), node('web-1', 'ec2-web', 'use1-az1'), node('web-2', 'ec2-web', 'use1-az2')],
      edges: [traffic('users', 'alb-1'), traffic('alb-1', 'web-1'), traffic('alb-1', 'sqs-1'), traffic('sqs-1', 'web-2')],
    }
    expect(outcome(viaQueue)['zone-use1-az1']).toBe(false) // web-2 is only behind the queue, so it can't take over
  })

  it('pins the spike: one web server is 2x, short of 3x', () => {
    expect(outcome(oneZone).spike).toBe(false)
    expect(sandboxChecks(c, twoZone).find((t) => t.id === 'spike')!.check.capacity).toBe(SPIKE)
  })

  it('neutral parts neither help nor hurt a result', () => {
    const withQueue: Design = { nodes: [...twoZone.nodes, node('sqs-1', 'sqs', 'use1')], edges: [...twoZone.edges, traffic('web-1', 'sqs-1')] }
    expect(outcome(withQueue)).toEqual(outcome(twoZone))
  })
})

describe('validateDesign', () => {
  it('accepts a design the editor could have built', () => {
    expect(validateDesign(c, twoZone)).toBeUndefined()
  })

  it.each([
    ['an unknown part', { nodes: [node('x-1', 'lambda', 'use1')], edges: [] }, /lambda/],
    ['a part in the wrong kind of lane', { nodes: [node('web-1', 'ec2-web', 'use1')], edges: [] }, /can't go in/],
    ['a duplicate id', { nodes: [node('a', 'alb', 'use1'), node('a', 'alb', 'use1')], edges: [] }, /Duplicate/],
    ['the reserved id', { nodes: [node('users', 'alb', 'use1')], edges: [] }, /reserved/],
    ['a link to nowhere', { nodes: [node('alb-1', 'alb', 'use1')], edges: [traffic('alb-1', 'ghost')] }, /ghost/],
    ['a link from nowhere', { nodes: [node('alb-1', 'alb', 'use1')], edges: [traffic('ghost', 'alb-1')] }, /ghost/],
    [
      'replication between non-databases',
      { nodes: [node('alb-1', 'alb', 'use1'), node('web-1', 'ec2-web', 'use1-az1')], edges: [{ from: 'alb-1', to: 'web-1', kind: 'sync' as const }] },
      /two databases/,
    ],
  ])('rejects %s', (_name, d, message) => {
    expect(validateDesign(c, d as Design)).toMatch(message)
  })

  it('accepts exactly the cap', () => {
    const at: Design = { nodes: Array.from({ length: SANDBOX_MAX_NODES }, (_, i) => node(`w-${i}`, 'ec2-web', 'use1-az1')), edges: [] }
    expect(validateDesign(c, at)).toBeUndefined()
  })

  it('rejects a design over the cap', () => {
    const many: Design = { nodes: Array.from({ length: SANDBOX_MAX_NODES + 1 }, (_, i) => node(`w-${i}`, 'ec2-web', 'use1-az1')), edges: [] }
    expect(validateDesign(c, many)).toMatch(/40/)
  })
})
