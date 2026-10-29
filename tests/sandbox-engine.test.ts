// The sandbox adapter and checks against the real engine. The sandbox file is
// built inline here; tests/sandbox-content.test.ts covers the shipped files.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { resolveSandbox, runCheck, sandboxChecks, validateDesign, readsJudged, edgeJudged, EDGE_SHARE, EDGE_HIT, SANDBOX_MAX_NODES, SPIKE, READ_HIT, DB_READS } from '../src/game/sandbox.ts'
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
    { id: 'elasticache', label: 'ElastiCache cache node', short: 'cache', scope: 'zonal', roles: ['cache'], capacity: 0, cost: 2, facts: ['A cache.'] },
    { id: 'edge', label: 'Edge', short: 'edge', scope: 'global', roles: ['route'], capacity: 0, cost: 2, facts: ['An edge.'], caching: { label: 'Caching', default: true, facts: ['Caches.'] } },
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
    expect(c.palette.map((p) => p.id)).toEqual([...base.palette.map((p) => p.id), 'sqs', 'cdn', 'elasticache', 'edge'])
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

  describe('neutral parts are contracted away', () => {
    const worker = (via: Design['nodes'], links: Design['edges']): Design => ({
      nodes: [node('alb-1', 'alb', 'use1'), node('web-1', 'ec2-web', 'use1-az1'), node('web-2', 'ec2-web', 'use1-az2'), node('rds-1', 'rds', 'use1-az1'), ...via],
      edges: [traffic('users', 'alb-1'), traffic('alb-1', 'web-1'), traffic('web-2', 'rds-1'), traffic('web-1', 'rds-1'), ...links],
    })
    const direct = worker([], [traffic('web-1', 'web-2')])

    it('a queue between a web server and a worker acts as a direct link', () => {
      const q = worker([node('sqs-1', 'sqs', 'use1')], [traffic('web-1', 'sqs-1'), traffic('sqs-1', 'web-2')])
      expect(outcome(q)).toEqual(outcome(direct))
    })

    it('a queue between the load balancer and a web server acts as a direct link', () => {
      const viaQueue: Design = {
        nodes: [node('alb-1', 'alb', 'use1'), node('sqs-1', 'sqs', 'use1'), node('web-1', 'ec2-web', 'use1-az1'), node('web-2', 'ec2-web', 'use1-az2')],
        edges: [traffic('users', 'alb-1'), traffic('alb-1', 'web-1'), traffic('alb-1', 'sqs-1'), traffic('sqs-1', 'web-2')],
      }
      const plain: Design = { nodes: viaQueue.nodes.filter((n) => n.id !== 'sqs-1'), edges: [traffic('users', 'alb-1'), traffic('alb-1', 'web-1'), traffic('alb-1', 'web-2')] }
      expect(outcome(viaQueue)).toEqual(outcome(plain))
    })

    it('a chain of two neutrals, or a neutral cycle, still terminates and acts as a direct link', () => {
      const chain = worker([node('sqs-1', 'sqs', 'use1'), node('sqs-2', 'sqs', 'use1')], [traffic('web-1', 'sqs-1'), traffic('sqs-1', 'sqs-2'), traffic('sqs-2', 'web-2')])
      expect(outcome(chain)).toEqual(outcome(direct))
      const cycle = worker(
        [node('sqs-1', 'sqs', 'use1'), node('sqs-2', 'sqs', 'use1')],
        [traffic('web-1', 'sqs-1'), traffic('sqs-1', 'sqs-2'), traffic('sqs-2', 'sqs-1'), traffic('sqs-2', 'web-2')],
      )
      expect(outcome(cycle)).toEqual(outcome(direct))
    })

    it('a cache hanging off a web server changes nothing', () => {
      const cached = { nodes: [...twoZone.nodes, node('sqs-1', 'sqs', 'use1')], edges: [...twoZone.edges, traffic('web-1', 'sqs-1')] }
      expect(outcome(cached)).toEqual(outcome(twoZone))
    })

    it('a zone holding only neutral parts offers no check', () => {
      const d: Design = { ...twoZone, nodes: [...twoZone.nodes, node('sqs-1', 'sqs', 'usw2-az1')] }
      expect(sandboxChecks(c, d).map((t) => t.id)).toEqual(sandboxChecks(c, twoZone).map((t) => t.id))
    })
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

describe('a cache judges the database, only when the design can be read-loaded', () => {
  // Two caches, one per zone, both linked from both web servers.
  const caches = [node('cache-1', 'elasticache', 'use1-az1'), node('cache-2', 'elasticache', 'use1-az2')]
  const linkAll = ['web-1', 'web-2'].flatMap((w) => ['cache-1', 'cache-2'].map((k) => traffic(w, k)))
  const cached: Design = { nodes: [...twoZone.nodes, ...caches], edges: [...twoZone.edges, ...linkAll] }
  const unlinked: Design = { nodes: [...twoZone.nodes, ...caches], edges: twoZone.edges }
  const reasons = (d: Design, id: string) => runCheck(c, d, id)!.reasons.join(' ')

  it('pins the scenario numbers and when reads are judged', () => {
    expect([READ_HIT, DB_READS, SPIKE]).toEqual([0.9, 1, 3])
    expect(readsJudged(c, cached)).toBe(true)
    expect(readsJudged(c, twoZone)).toBe(false) // no cache
    expect(readsJudged(c, { nodes: twoZone.nodes.filter((n) => n.type !== 'rds').concat(caches), edges: [] })).toBe(false) // no database
    expect(readsJudged(c, { nodes: twoZone.nodes.filter((n) => n.type !== 'ec2-web').concat(caches), edges: [] })).toBe(false) // no web server
  })

  it('no cache: no check carries read_load and the labels are untouched', () => {
    expect(sandboxChecks(c, twoZone).every((t) => !t.check.read_load)).toBe(true)
    expect(sandboxChecks(c, twoZone).every((t) => !/reads at/.test(t.label))).toBe(true)
  })

  it('a cache in each zone, every server linked to both, survives everything the same design survives, and losing any one cache', () => {
    expect(outcome(cached)).toEqual({
      'zone-use1-az1': true,
      'zone-use1-az2': true,
      'region-use1': false,
      'one-alb': false,
      'one-ec2-web': true,
      'one-rds': true,
      'one-elasticache': true,
      spike: true,
    })
  })

  it('every check carries spike-level reads and says so, except the spike which already says 3x', () => {
    const checks = sandboxChecks(c, cached)
    for (const t of checks) expect(t.check.read_load).toEqual({ traffic: SPIKE, hit: READ_HIT, db_capacity: DB_READS })
    for (const t of checks.filter((x) => x.id !== 'spike')) expect(t.label, t.id).toMatch(/, reads at 3×$/)
    expect(checks.find((t) => t.id === 'spike')!.label).toBe(`Traffic spike: ${SPIKE}× normal`)
    expect(checks.find((t) => t.id === 'spike')!.check.capacity).toBe(SPIKE)
  })

  it('unlinked caches shield nothing: every check fails and the reason names the web servers', () => {
    expect(Object.values(outcome(unlinked)).every((p) => !p)).toBe(true)
    expect(reasons(unlinked, 'spike')).toContain('rds-1 would see 3× normal reads but can take 1× (web-1, web-2 are not linked to a surviving cache).')
  })

  it('partial links: only the linked server is shielded and the reason names the other', () => {
    const partial: Design = { nodes: unlinked.nodes, edges: [...twoZone.edges, traffic('web-1', 'cache-1'), traffic('web-1', 'cache-2')] }
    expect(outcome(partial).spike).toBe(false)
    expect(reasons(partial, 'spike')).toMatch(/web-2 is not linked to a surviving cache/)
    expect(reasons(partial, 'spike')).not.toMatch(/web-1/)
  })

  it('losing the only cache fails, and a cache alone in its zone and region gets its own checks', () => {
    const lone: Design = {
      nodes: [...twoZone.nodes, node('cache-1', 'elasticache', 'usw2-az1')],
      edges: [...twoZone.edges, traffic('web-1', 'cache-1'), traffic('web-2', 'cache-1')],
    }
    const ids = sandboxChecks(c, lone).map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining(['zone-usw2-az1', 'region-usw2', 'one-elasticache']))
    for (const id of ['zone-usw2-az1', 'region-usw2', 'one-elasticache']) {
      expect(runCheck(c, lone, id)!.pass, id).toBe(false)
      expect(reasons(lone, id), id).toMatch(/cache-1 was lost/)
    }
    expect(outcome(lone)['zone-use1-az1']).toBe(true) // the cache lives in the other region
  })

  it('direction matters: a cache linked only from the database, or straight from users, shields nothing', () => {
    const fromDb: Design = { nodes: unlinked.nodes, edges: [...twoZone.edges, traffic('rds-1', 'cache-1')] }
    expect(reasons(fromDb, 'spike')).toMatch(/web-1, web-2 are not linked to a surviving cache/)
    const fromUsers: Design = { nodes: unlinked.nodes, edges: [...twoZone.edges, traffic('users', 'cache-1')] }
    expect(runCheck(c, fromUsers, 'spike')!.pass).toBe(false)
    expect(reasons(fromUsers, 'spike')).toMatch(/users connect straight to the cache/)
  })

  it('an inline cache (no direct web-to-database link) is judged, and the spike fails on the unreachable database', () => {
    const inline: Design = {
      nodes: [node('alb-1', 'alb', 'use1'), node('web-1', 'ec2-web', 'use1-az1'), node('cache-1', 'elasticache', 'use1-az1'), node('rds-1', 'rds', 'use1-az1')],
      edges: [traffic('users', 'alb-1'), traffic('alb-1', 'web-1'), traffic('web-1', 'cache-1'), traffic('cache-1', 'rds-1')],
    }
    expect(readsJudged(c, inline)).toBe(true)
    const r = runCheck(c, inline, 'spike')!
    expect(r.pass).toBe(false)
    expect(r.reasons.join(' ')).toContain('nothing that users can reach is connected to the database')
  })

  describe('an inert cache (no database, or no web server) changes nothing', () => {
    const noDb: Design = { nodes: [node('alb-1', 'alb', 'use1'), node('web-1', 'ec2-web', 'use1-az1')], edges: [traffic('users', 'alb-1'), traffic('alb-1', 'web-1')] }
    const noWeb: Design = { nodes: [node('rds-1', 'rds', 'use1-az1')], edges: [] }
    it.each([
      ['no database', noDb],
      ['no web server', noWeb],
    ])('%s', (_name, plain) => {
      const withCache: Design = { nodes: [...plain.nodes, node('cache-1', 'elasticache', 'use1-az2')], edges: [...plain.edges, ...(plain === noDb ? [traffic('web-1', 'cache-1')] : [])] }
      expect(sandboxChecks(c, withCache).map((t) => t.id)).toEqual(sandboxChecks(c, plain).map((t) => t.id)) // no zone check for the cache's zone, no one-elasticache
      expect(sandboxChecks(c, withCache).every((t) => !t.check.read_load)).toBe(true)
      expect(outcome(withCache)).toEqual(outcome(plain))
    })
  })

  it('a saved design that contains a cache still opens', () => {
    expect(validateDesign(c, cached)).toBeUndefined()
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

  it.each([
    ['a link to itself', [traffic('alb-1', 'alb-1')], /itself/],
    ['a duplicate link', [traffic('users', 'alb-1'), traffic('users', 'alb-1')], /already exists/],
    ['two replication sources', [{ from: 'rds-1', to: 'rds-3', kind: 'sync' as const }, { from: 'rds-2', to: 'rds-3', kind: 'async' as const }], /already replicates/],
    ['a replication cycle', [{ from: 'rds-1', to: 'rds-2', kind: 'sync' as const }, { from: 'rds-2', to: 'rds-1', kind: 'sync' as const }], /other way/],
  ])('rejects %s as the editor would', (_name, edges, message) => {
    const nodes = [node('alb-1', 'alb', 'use1'), node('rds-1', 'rds', 'use1-az1'), node('rds-2', 'rds', 'use1-az2'), node('rds-3', 'rds', 'usw2-az1')]
    expect(validateDesign(c, { nodes, edges })).toMatch(message)
  })

  it('rejects an empty component id', () => {
    expect(validateDesign(c, { nodes: [node('', 'alb', 'use1')], edges: [] })).toMatch(/empty/)
  })

  it('rejects a design over the cap', () => {
    const many: Design = { nodes: Array.from({ length: SANDBOX_MAX_NODES + 1 }, (_, i) => node(`w-${i}`, 'ec2-web', 'use1-az1')), edges: [] }
    expect(validateDesign(c, many)).toMatch(/40/)
  })
})

describe('an edge judges the traffic spike only when the design has a caching part and a web server', () => {
  const edgeIn = (webs: string[], extra: Design['edges'] = []): Design => ({
    nodes: [node('edge-1', 'edge', 'global'), node('alb-1', 'alb', 'use1'), ...webs.map((w) => node(w, 'ec2-web', 'use1-az1')), node('rds-1', 'rds', 'use1-az1')],
    edges: [traffic('users', 'edge-1'), traffic('edge-1', 'alb-1'), ...webs.flatMap((w) => [traffic('alb-1', w), traffic(w, 'rds-1')]), ...extra],
  })
  const spike = (d: Design) => sandboxChecks(c, d).find((t) => t.id === 'spike')!

  it('pins the scenario numbers', () => {
    expect(EDGE_SHARE).toBe(0.5)
    expect(EDGE_HIT).toBe(0.9)
  })

  it('edgeJudged needs a caching part and a web server', () => {
    expect(edgeJudged(c, twoZone)).toBe(false)
    expect(edgeJudged(c, { nodes: [node('edge-1', 'edge', 'global')], edges: [] })).toBe(false)
    expect(edgeJudged(c, edgeIn(['web-1']))).toBe(true)
  })

  it('only the spike check carries edge_load, and its label does not change', () => {
    const checks = sandboxChecks(c, edgeIn(['web-1']))
    expect(checks.filter((t) => t.check.edge_load).map((t) => t.id)).toEqual(['spike'])
    expect(spike(edgeIn(['web-1'])).check.edge_load).toEqual({ share: EDGE_SHARE, hit: EDGE_HIT })
    expect(spike(edgeIn(['web-1'])).label).toBe('Traffic spike: 3× normal')
  })

  it('a design with no caching part gets exactly the checks it always got', () => {
    expect(spike(twoZone).check).toEqual({ reach: ['serve', 'write-store'], capacity: SPIKE })
  })

  it('an edge in front of one web server lets it survive the spike; without one it does not', () => {
    expect(runCheck(c, edgeIn(['web-1']), 'spike')!.pass).toBe(true) // 3x x 0.55 = 1.65x, one server carries 2x
    expect(runCheck(c, { ...oneZone }, 'spike')!.pass).toBe(false) // 3x on one 2x server
  })

  it('a bypass link means no discount', () => {
    const r = runCheck(c, edgeIn(['web-1'], [traffic('users', 'alb-1')]), 'spike')!
    expect(r.pass).toBe(false)
    expect(r.reasons.join(' ')).toContain('users can also reach web-1 without passing edge-1.')
  })

  it('an edge is a global route part: it gets a "Lose any one" check and no zone or region check of its own', () => {
    const ids = sandboxChecks(c, edgeIn(['web-1'])).map((t) => t.id)
    expect(ids).toContain('one-edge')
    expect(ids).not.toContain('zone-global')
    expect(runCheck(c, edgeIn(['web-1']), 'one-edge')!.pass).toBe(false) // it is the only way in
  })

  it('a caching part with no web server adds no edge_load', () => {
    const d: Design = { nodes: [node('edge-1', 'edge', 'global'), node('rds-1', 'rds', 'use1-az1')], edges: [] }
    expect(sandboxChecks(c, d).some((t) => t.check.edge_load)).toBe(false)
  })

  it('keeps the cache rule independent: a design with both still judges reads', () => {
    const d = edgeIn(['web-1'])
    d.nodes.push(node('cache-1', 'elasticache', 'use1-az1'))
    d.edges.push(traffic('web-1', 'cache-1'))
    const checks = sandboxChecks(c, d)
    expect(checks.every((t) => t.check.read_load)).toBe(true)
    expect(spike(d).check.edge_load).toBeDefined()
  })

  it('saved designs without a caching choice still validate', () => {
    expect(validateDesign(c, edgeIn(['web-1']))).toBeUndefined()
  })
})

describe('the real Azure sandbox: a second entry path around Front Door', () => {
  const az = loadContent(path.resolve(import.meta.dirname, '../content')).sandboxes.find((s) => s.provider === 'azure')!
  const design = (second: boolean): Design => ({
    nodes: [
      node('tm', 'traffic-manager', 'global'),
      { ...node('fd', 'front-door', 'global'), caching: true },
      node('agw', 'app-gateway', 'eus2'),
      node('app', 'app-instance', 'eus2-z1'),
      node('pg', 'pg', 'eus2-z1'),
    ],
    edges: [traffic('users', 'tm'), traffic('tm', 'fd'), traffic('fd', 'agw'), traffic('agw', 'app'), traffic('app', 'pg'), ...(second ? [traffic('tm', 'agw')] : [])],
  })
  it('the spike passes behind Front Door; a path around it withholds the discount and the one-front-door check', () => {
    expect(runCheck(az, design(false), 'spike')!.pass).toBe(true)
    const direct = runCheck(az, design(false), 'one-front-door')!
    expect(direct.pass).toBe(false)
    expect(direct.reasons).toEqual(['If fd fails: no surviving web server is connected to users.', 'If fd fails: nothing that users can reach is connected to the database (pg).'])
    const around = runCheck(az, design(true), 'spike')!
    expect(around.pass).toBe(false)
    expect(around.reasons).toContain('users can also reach app without passing fd.')
    expect(runCheck(az, design(true), 'one-front-door')!.pass).toBe(true)
  })
})

describe('overlays', () => {
  const overlay = { id: 'alb', caching: { label: 'Caching', default: false, facts: ['A fact.'] } }
  it('add a caching setting to an inherited route part', () => {
    const r = resolveSandbox({ ...file, overlays: [overlay] }, base)
    if (typeof r === 'string') throw new Error(r)
    expect(r.palette.find((p) => p.id === 'alb')!.caching).toEqual(overlay.caching)
    expect(base.palette.find((p) => p.id === 'alb')!.caching).toBeUndefined() // the base is not mutated
  })

  it('are refused for an unknown part, a repeated part, a part that already has a setting, or a part that is not a route', () => {
    expect(resolveSandbox({ ...file, overlays: [{ ...overlay, id: 'nope' }] }, base)).toMatch(/"nope".*not in/)
    expect(resolveSandbox({ ...file, overlays: [overlay, overlay] }, base)).toMatch(/more than once/)
    const cached = { ...base, palette: base.palette.map((p) => (p.id === 'alb' ? { ...p, caching: overlay.caching } : p)) }
    expect(resolveSandbox({ ...file, overlays: [overlay] }, cached)).toMatch(/already has a caching setting/)
    expect(resolveSandbox({ ...file, overlays: [{ ...overlay, id: 'ec2-web' }] }, base)).toMatch(/isn't a route part/)
  })
})
