// The canvas graph engine: events, failover, reachability, capacity, and the
// sentences it produces. Uses the real AWS canvas challenge plus small edits.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { evaluateCanvas } from '../src/game/canvas.ts'
import type { CanvasChallenge, Design } from '../src/schema/canvas.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const c = canvases.find((x) => x.id === 'aws-checkout-canvas')!
const ref = c.reference_designs[0].design
const counter = (name: string) => c.counter_examples.find((x) => x.name.startsWith(name))!.design
const result = (d: Design, test: string, ch: CanvasChallenge = c) =>
  evaluateCanvas(ch, d).tests.find((t) => t.id === test)!
const without = (d: Design, drop: (e: Design['edges'][number]) => boolean): Design => ({
  nodes: d.nodes,
  edges: d.edges.filter((e) => !drop(e)),
})

describe('evaluateCanvas', () => {
  it('the reference design passes everything within budget', () => {
    const e = evaluateCanvas(c, ref)
    expect(e.tests.every((t) => t.pass)).toBe(true)
    expect(e.cost).toBe(9)
    expect(e.pass).toBe(true)
  })

  it('a zone outage takes out everything in that zone, and says so', () => {
    const r = result(counter('Everything in one zone'), 'az1-outage')
    expect(r.pass).toBe(false)
    expect(r.down.sort()).toEqual(['db-1', 'web-1', 'web-2'])
    expect(r.reasons).toEqual([
      'every web server was lost (web-1, web-2).',
      'db-1 was lost and has no standby, so nothing can accept writes.',
      'no serving capacity survives; 3× is needed.',
    ])
  })

  it('a sync standby takes over; an async replica does not', () => {
    expect(result(ref, 'az1-outage').pass).toBe(true)
    expect(result(counter('An async replica'), 'az1-outage').reasons).toEqual([
      'db-1 was lost, and db-2 is an async replica: it needs manual promotion and could be missing recent writes.',
    ])
  })

  it('checks capacity that survives, not capacity deployed', () => {
    expect(result(counter('One web server per zone'), 'az1-outage').reasons).toEqual([
      'only 2× of the 3× traffic needed can be served (web-2).',
    ])
  })

  it('single failures are tried one component at a time, and name the culprit', () => {
    const r = result(counter('Everything in one zone'), 'web-failure')
    expect(r.reasons[0]).toBe('If web-1 fails: only 2× of the 3× traffic needed can be served (web-2).')
    expect(r.down).toEqual(['web-1'])
  })

  it('apps reach the writer through the database endpoint, even after failover', () => {
    // Web servers only point at db-1; when db-1 dies, db-2 is still reached via the endpoint.
    expect(result(ref, 'az1-outage').pass).toBe(true)
    const noDbLinks = without(ref, (e) => e.to === 'db-1' && e.kind === 'traffic')
    expect(result(noDbLinks, 'sale').reasons).toEqual([
      'nothing that users can reach is connected to the database (db-1).',
    ])
  })

  it('web servers must actually be reachable from users', () => {
    const noEntry = without(ref, (e) => e.from === 'users')
    expect(result(noEntry, 'sale').reasons[0]).toBe('no surviving web server is connected to users.')
  })

  it('two unreplicated databases would split the data', () => {
    const split = without(ref, (e) => e.kind === 'sync')
    expect(result(split, 'sale').reasons).toContain(
      '2 separate databases with no replication between them: orders would be split across db-1 and db-2.',
    )
  })

  it('a design with no database fails write checks', () => {
    const noDb: Design = { nodes: ref.nodes.filter((n) => n.type !== 'rds'), edges: ref.edges.filter((e) => !e.to.startsWith('db')) }
    expect(result(noDb, 'sale').reasons).toContain('there is no database for orders.')
  })

  it('a region outage removes that Region’s zonal and regional components', () => {
    const regional: CanvasChallenge = {
      ...c,
      stress_tests: [{ id: 'region', label: 'us-east-1 fails', event: { region_outage: 'use1' }, check: { reach: ['serve'] } }],
    }
    const r = result(ref, 'region', regional)
    expect(r.pass).toBe(false)
    expect(r.down).toContain('alb')
    expect(r.down).toHaveLength(7)
  })

  it('flags over-engineering and budget', () => {
    const e = evaluateCanvas(c, counter('Everything, plus disaster recovery'))
    expect(e.overkill).toHaveLength(1)
    expect(e.withinBudget).toBe(false)
    expect(e.tests.every((t) => t.pass)).toBe(true)
  })
})
