// The opt-in read_load rule: the database's read load after a failure, and
// what a live, linked cache takes off it. Uses the real AWS canvas challenge's
// palette and layout plus a test cache part and hand-built checks, so no
// shipped challenge is needed.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { evaluateCanvas } from '../src/game/canvas.ts'
import type { CanvasChallenge, Design } from '../src/schema/canvas.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const base = canvases.find((x) => x.id === 'aws-checkout-canvas')!

const reach = ['serve', 'write-store'] as ('serve' | 'write-store')[]
const check = { reach, read_load: { traffic: 2, hit: 0.9, db_capacity: 1 } }
const c: CanvasChallenge = {
  ...base,
  palette: [
    ...base.palette,
    { id: 'cache', label: 'Cache', short: 'cache', scope: 'zonal', roles: ['cache'], capacity: 0, cost: 2, facts: ['A test cache.'] },
  ],
  stress_tests: [
    { id: 'sale', label: 'Sale', event: { none: true }, check },
    { id: 'zone-a', label: 'A', event: { zone_outage: 'use1-az1' }, check },
    { id: 'zone-b', label: 'B', event: { zone_outage: 'use1-az2' }, check },
    { id: 'cache-failure', label: 'Cache', event: { single_failure: 'cache' }, check },
  ],
}

const T = (from: string, to: string) => ({ from, to, kind: 'traffic' as const })
const plain: Design = {
  nodes: [
    { id: 'alb', type: 'alb', lane: 'use1' },
    { id: 'web-1', type: 'ec2-web', lane: 'use1-az1' },
    { id: 'web-2', type: 'ec2-web', lane: 'use1-az2' },
    { id: 'db-1', type: 'rds', lane: 'use1-az1' },
    { id: 'db-2', type: 'rds', lane: 'use1-az2' },
  ],
  edges: [T('users', 'alb'), T('alb', 'web-1'), T('alb', 'web-2'), T('web-1', 'db-1'), T('web-2', 'db-1'), { from: 'db-1', to: 'db-2', kind: 'sync' }],
}
const plus = (nodes: Design['nodes'], edges: Design['edges']): Design => ({ nodes: [...plain.nodes, ...nodes], edges: [...plain.edges, ...edges] })
const cache = (id: string, lane: string) => ({ id, type: 'cache', lane })
const run = (d: Design, ch = c) => Object.fromEntries(evaluateCanvas(ch, d).tests.map((t) => [t.id, t]))

describe('read_load', () => {
  it('with no cache the database sees every read, and the reason says so', () => {
    const r = run(plain)
    expect(r.sale.pass).toBe(false)
    expect(r.sale.reasons).toEqual(['db-1 would see 2× normal reads but can take 1× (there is no cache in the design).'])
  })

  it('a cache linked from every server takes the load off the database', () => {
    const d = plus([cache('cache-1', 'use1-az1')], [T('web-1', 'cache-1'), T('web-2', 'cache-1')])
    expect(run(d).sale.pass).toBe(true)
  })

  it('a zone outage that removes the only cache fails, and the standby is the one named', () => {
    const d = plus([cache('cache-1', 'use1-az1')], [T('web-1', 'cache-1'), T('web-2', 'cache-1')])
    const r = run(d)
    expect(r['zone-a'].reasons).toEqual(['db-2 would see 2× normal reads but can take 1× (cache-1 was lost).'])
    expect(r['zone-b'].pass).toBe(true)
  })

  it('losing the only cache fails, naming the cache that failed', () => {
    const d = plus([cache('cache-1', 'use1-az1')], [T('web-1', 'cache-1'), T('web-2', 'cache-1')])
    expect(run(d)['cache-failure'].reasons).toEqual(['If cache-1 fails: db-1 would see 2× normal reads but can take 1× (cache-1 was lost).'])
  })

  it('two caches, every server linked to both, survive losing a zone or a cache', () => {
    const d = plus(
      [cache('cache-1', 'use1-az1'), cache('cache-2', 'use1-az2')],
      [T('web-1', 'cache-1'), T('web-1', 'cache-2'), T('web-2', 'cache-1'), T('web-2', 'cache-2')],
    )
    const r = run(d)
    expect(Object.values(r).every((t) => t.pass)).toBe(true)
  })

  it('partial links: only the linked servers are shielded, and the others are named', () => {
    const d = plus([cache('cache-1', 'use1-az1')], [T('web-1', 'cache-1')])
    const r = run(d)
    expect(r.sale.reasons).toEqual(['db-1 would see 1.1× normal reads but can take 1× (web-2 is not linked to a surviving cache).'])
  })

  it('a cache nothing links to shields nothing', () => {
    const d = plus([cache('cache-1', 'use1-az1')], [])
    expect(run(d).sale.reasons).toEqual([
      'db-1 would see 2× normal reads but can take 1× (web-1, web-2 are not linked to a surviving cache).',
    ])
  })

  it('direction matters: a link from the cache to a server, or from the database to the cache, shields nothing', () => {
    const d = plus([cache('cache-1', 'use1-az1')], [T('cache-1', 'web-1'), T('cache-1', 'web-2'), T('db-1', 'cache-1')])
    expect(run(d).sale.pass).toBe(false)
  })

  it('unnamed zone: a design that hides its only cache in a zone no test names still fails', () => {
    const d = plus([cache('cache-1', 'usw2-az1')], [T('web-1', 'cache-1'), T('web-2', 'cache-1')])
    const r = run(d)
    expect(r['zone-a'].pass).toBe(false)
    expect(r['zone-a'].reasons[0]).toMatch(/^A zone you used but no test names \(us-west-2a\) fails: db-1 would see 2× normal reads/)
  })

  it('adds no read-load line when nothing serves, or when there is no database', () => {
    const noWeb: Design = { nodes: [plain.nodes[3]], edges: [] }
    const noDb: Design = { nodes: plain.nodes.slice(0, 3), edges: [T('users', 'alb'), T('alb', 'web-1'), T('alb', 'web-2')] }
    for (const d of [noWeb, noDb]) {
      const reasons = Object.values(run(d)).flatMap((t) => t.reasons)
      expect(reasons.length).toBeGreaterThan(0)
      expect(reasons.some((x) => /would see/.test(x))).toBe(false)
    }
  })

  it('a check without read_load is unchanged, with or without a cache in the design', () => {
    const noLoad: CanvasChallenge = { ...c, stress_tests: c.stress_tests.map((t) => ({ ...t, check: { reach } })) }
    const d = plus([cache('cache-1', 'use1-az1')], [])
    for (const design of [plain, d]) expect(Object.values(run(design, noLoad)).every((t) => t.pass)).toBe(true)
  })
})
