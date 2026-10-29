// The opt-in edge_load rule: a live, caching edge answers part of the traffic before it
// reaches the web servers, but only when every reachable web server sits behind one.
// Uses the real AWS canvas palette plus a test edge part and hand-built checks.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { evaluateCanvas } from '../src/game/canvas.ts'
import type { CanvasChallenge, Design } from '../src/schema/canvas.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const base = canvases.find((x) => x.id === 'aws-checkout-canvas')!

const reach = ['serve', 'write-store'] as ('serve' | 'write-store')[]
const edgeLoad = { share: 0.5, hit: 0.9 }
const c: CanvasChallenge = {
  ...base,
  palette: [
    ...base.palette,
    {
      id: 'edge',
      label: 'Edge',
      short: 'edge',
      scope: 'global',
      roles: ['route'],
      capacity: 0,
      cost: 2,
      facts: ['A test edge.'],
      caching: { label: 'Caching', default: true, facts: ['A test setting.'] },
    },
  ],
  stress_tests: [
    { id: 'spike', label: 'Spike', event: { none: true }, check: { reach, capacity: 6, edge_load: edgeLoad } },
    { id: 'plain', label: 'Plain', event: { none: true }, check: { reach, capacity: 6 } },
    { id: 'edge-failure', label: 'Edge', event: { single_failure: 'edge' }, check: { reach, capacity: 6, edge_load: edgeLoad } },
  ],
}

const T = (from: string, to: string) => ({ from, to, kind: 'traffic' as const })
const web = (id: string, lane = 'use1-az1') => ({ id, type: 'ec2-web', lane })
// users -> edge -> alb -> web(s) -> db
const behindEdge = (webs: string[], edge: Partial<Design['nodes'][number]> = {}): Design => ({
  nodes: [{ id: 'edge-1', type: 'edge', lane: 'global', ...edge }, { id: 'alb', type: 'alb', lane: 'use1' }, ...webs.map((w) => web(w)), { id: 'db-1', type: 'rds', lane: 'use1-az1' }],
  edges: [T('users', 'edge-1'), T('edge-1', 'alb'), ...webs.flatMap((w) => [T('alb', w), T(w, 'db-1')])],
})
const noEdge = (webs: string[]): Design => ({
  nodes: [{ id: 'alb', type: 'alb', lane: 'use1' }, ...webs.map((w) => web(w)), { id: 'db-1', type: 'rds', lane: 'use1-az1' }],
  edges: [T('users', 'alb'), ...webs.flatMap((w) => [T('alb', w), T(w, 'db-1')])],
})
const run = (d: Design) => Object.fromEntries(evaluateCanvas(c, d).tests.map((t) => [t.id, t]))

describe('edge_load', () => {
  it('with no caching-capable part the check is exactly as before', () => {
    const r = run(noEdge(['web-1', 'web-2']))
    expect(r.spike.pass).toBe(false)
    expect(r.spike.reasons).toEqual(['only 4× of the 6× traffic needed can be served (web-1, web-2).'])
    expect(r.spike.reasons).toEqual(r.plain.reasons)
  })

  it('a live caching edge in front of every server lowers what the servers must carry', () => {
    const r = run(behindEdge(['web-1', 'web-2']))
    expect(r.spike.pass).toBe(true) // 6x x (1 - 0.45) = 3.3x, and two servers carry 4x
    expect(r.plain.pass).toBe(false) // the same design without edge_load still needs the full 6x
  })

  it('a caching part with default off and no node setting is off: the discount is withheld and the reason says so', () => {
    const off: CanvasChallenge = { ...c, palette: c.palette.map((p) => (p.id === 'edge' ? { ...p, caching: { ...p.caching!, default: false } } : p)) }
    const r = Object.fromEntries(evaluateCanvas(off, behindEdge(['web-1', 'web-2'])).tests.map((t) => [t.id, t]))
    expect(r.spike.reasons).toEqual(['only 4× of the 6× traffic needed can be served (web-1, web-2).', 'caching is off on edge-1.'])
  })

  it('and a design that is still short says how much it needed after the edge', () => {
    const r = run(behindEdge(['web-1']))
    expect(r.spike.pass).toBe(false)
    expect(r.spike.reasons).toEqual(['only 2× of the 3.3× traffic needed (6× minus the 45% that the edge answers) can be served (web-1).'])
  })

  it('caching switched off on the edge gives no discount and says so', () => {
    const r = run(behindEdge(['web-1', 'web-2'], { caching: false }))
    expect(r.spike.pass).toBe(false)
    expect(r.spike.reasons).toEqual(['only 4× of the 6× traffic needed can be served (web-1, web-2).', 'caching is off on edge-1.'])
  })

  it('a link from users straight to the load balancer bypasses the edge: no discount, and the reason names the servers', () => {
    const d = behindEdge(['web-1', 'web-2'])
    d.edges.push(T('users', 'alb'))
    const r = run(d)
    expect(r.spike.pass).toBe(false)
    expect(r.spike.reasons).toEqual(['only 4× of the 6× traffic needed can be served (web-1, web-2).', 'users can also reach web-1, web-2 without passing edge-1.'])
  })

  it('losing the only edge cuts users off: the reachability reasons and the edge is named as lost', () => {
    const r = run(behindEdge(['web-1', 'web-2']))['edge-failure']
    expect(r.pass).toBe(false)
    const text = r.reasons.join(' ')
    expect(text).toContain('no surviving web server is connected to users.')
    expect(text).toContain("edge-1 was lost, so it can't answer requests.")
  })
})
