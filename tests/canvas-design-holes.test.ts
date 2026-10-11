// Regression tests for the strict audit's canvas holes: single-zone designs
// hidden in an unnamed zone, no entry point, users->db, lb->db write paths,
// and servers that can't reach the database still counting as capacity.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { evaluateCanvas } from '../src/game/canvas.ts'
import type { Design } from '../src/schema/canvas.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const get = (id: string) => canvases.find((x) => x.id === id)!
const failed = (id: string, d: Design) =>
  evaluateCanvas(get(id), d)
    .tests.filter((t) => !t.pass)
    .map((t) => t.id)
const T = (from: string, to: string) => ({ from, to, kind: 'traffic' as const })
const nodes = (type: string, lane: string, ...ids: string[]) => ids.map((id) => ({ id, type, lane }))

describe('every canvas reference design still passes', () => {
  for (const c of canvases)
    c.reference_designs.forEach((r) =>
      it(`${c.id}: ${r.name}`, () => {
        const e = evaluateCanvas(c, r.design)
        expect(e.tests.filter((t) => !t.pass)).toEqual([])
        expect(e.withinBudget).toBe(true)
      }),
    )
})

describe('audit probes now fail', () => {
  it('AWS: everything in one zone of the second Region', () => {
    const d: Design = {
      nodes: [...nodes('alb', 'use1', 'alb'), ...nodes('ec2-web', 'usw2-az1', 'w1', 'w2', 'w3'), ...nodes('rds', 'usw2-az1', 'db')],
      edges: [T('users', 'alb'), T('alb', 'w1'), T('alb', 'w2'), T('alb', 'w3'), T('w1', 'db'), T('w2', 'db'), T('w3', 'db')],
    }
    const bad = failed('aws-checkout-canvas', d)
    expect(bad).toEqual(expect.arrayContaining(['az1-outage', 'az2-outage']))
  })

  it('Azure: two app instances and a sync pair in one West US 2 zone', () => {
    const d: Design = {
      nodes: [...nodes('front-door', 'global', 'fd'), ...nodes('app-instance', 'wus2-z1', 'a1', 'a2'), ...nodes('pg', 'wus2-z1', 'p1', 'p2')],
      edges: [T('users', 'fd'), T('fd', 'a1'), T('fd', 'a2'), T('a1', 'p1'), T('a2', 'p1'), { from: 'p1', to: 'p2', kind: 'sync' }],
    }
    expect(failed('azure-portal-canvas', d)).toEqual(expect.arrayContaining(['zone-1', 'zone-2', 'zone-3', 'app-failure']))
  })

  it('Azure: exactly two instances across zones fail the app-instance test', () => {
    const c = get('azure-portal-canvas')
    const two: Design = {
      nodes: [...nodes('front-door', 'global', 'fd'), ...nodes('app-instance', 'eus2-z1', 'a1'), ...nodes('app-instance', 'eus2-z2', 'a2'), ...nodes('pg', 'eus2-z1', 'p1'), ...nodes('pg', 'eus2-z2', 'p2')],
      edges: [T('users', 'fd'), T('fd', 'a1'), T('fd', 'a2'), T('a1', 'p1'), T('a2', 'p1'), { from: 'p1', to: 'p2', kind: 'sync' }],
    }
    expect(failed(c.id, two)).toContain('app-failure')
  })

  it('users straight to web servers (no load balancer) fails everywhere', () => {
    const c = get('aws-checkout-canvas')
    const ref = c.reference_designs[0].design
    const d: Design = {
      nodes: ref.nodes.filter((n) => n.id !== 'alb'),
      edges: [...ref.edges.filter((e) => e.from !== 'users' && e.from !== 'alb'), ...['web-1', 'web-2', 'web-3', 'web-4'].map((w) => T('users', w))],
    }
    const e = evaluateCanvas(c, d)
    expect(e.tests.every((t) => !t.pass)).toBe(true)
    expect(e.tests[0].reasons.join(' ')).toMatch(/put a load balancer/)
  })

  it('users straight to the database fails, even with a load balancer in front', () => {
    const c = get('gcp-signup-canvas')
    const ref = c.reference_designs[1].design
    const d: Design = { nodes: ref.nodes, edges: [...ref.edges, T('users', 'sql-1')] }
    expect(evaluateCanvas(c, d).tests.every((t) => !t.pass)).toBe(true)
  })

  it('a load balancer linked to the database does not make the application write', () => {
    const c = get('gcp-signup-canvas')
    const ref = c.reference_designs[1].design
    const d: Design = { nodes: ref.nodes, edges: [...ref.edges.filter((e) => !e.from.startsWith('vm')), T('lb', 'sql-1')] }
    const e = evaluateCanvas(c, d)
    expect(e.tests.every((t) => !t.pass)).toBe(true)
    expect(e.tests[0].reasons.join(' ')).toMatch(/connected to the database/)
  })

  it('GCP: VMs that cannot reach the database add no capacity', () => {
    const c = get('gcp-signup-canvas')
    const ref = c.reference_designs[1].design
    const d: Design = { nodes: ref.nodes, edges: ref.edges.filter((e) => e.from !== 'vm-1' && e.from !== 'vm-4') }
    expect(failed(c.id, d)).toEqual(expect.arrayContaining(['zone-a', 'zone-b', 'vm-failure']))
  })

  it('GCP: Cloud Run is public by design, so users -> Cloud Run is fine', () => {
    expect(failed('gcp-signup-canvas', get('gcp-signup-canvas').reference_designs[0].design)).toEqual([])
  })
})

describe('reference-design cost wording (gcp)', () => {
  it('states the real costs', () => {
    const c = get('gcp-signup-canvas')
    expect(c.reference_designs.map((r) => evaluateCanvas(c, r.design).cost)).toEqual([8, 9])
    expect(c.debrief.summary).not.toMatch(/same cost/i)
    expect(c.reference_designs[1].why).not.toMatch(/same cost/i)
  })
})

describe('legitimate designs still pass', () => {
  const ok = (id: string, d: Design) => expect(failed(id, d)).toEqual([])
  const sync = (from: string, to: string) => ({ from, to, kind: 'sync' as const })
  const awsWebs = (az1: string[], az2: string[]) => [...nodes('ec2-web', 'use1-az1', ...az1), ...nodes('ec2-web', 'use1-az2', ...az2)]

  it('AWS: web servers split across primary and standby', () => {
    const ws = ['w1', 'w2', 'w3', 'w4']
    ok('aws-checkout-canvas', {
      nodes: [...nodes('alb', 'use1', 'alb'), ...awsWebs(['w1', 'w2'], ['w3', 'w4']), ...nodes('rds', 'use1-az1', 'd1'), ...nodes('rds', 'use1-az2', 'd2')],
      edges: [T('users', 'alb'), ...ws.map((w) => T('alb', w)), T('w1', 'd1'), T('w2', 'd1'), T('w3', 'd2'), T('w4', 'd2'), sync('d1', 'd2')],
    })
  })
  it('AWS: primary in az2', () => {
    const ws = ['w1', 'w2', 'w3', 'w4']
    ok('aws-checkout-canvas', {
      nodes: [...nodes('alb', 'use1', 'alb'), ...awsWebs(['w1', 'w2'], ['w3', 'w4']), ...nodes('rds', 'use1-az2', 'd1'), ...nodes('rds', 'use1-az1', 'd2')],
      edges: [T('users', 'alb'), ...ws.map((w) => T('alb', w)), ...ws.map((w) => T(w, 'd1')), sync('d1', 'd2')],
    })
  })
  it('Azure: Front Door then Application Gateway; Application Gateway alone', () => {
    const apps = ['a1', 'a2', 'a3']
    const base = [...nodes('app-instance', 'eus2-z1', 'a1'), ...nodes('app-instance', 'eus2-z2', 'a2'), ...nodes('app-instance', 'eus2-z3', 'a3'), ...nodes('pg', 'eus2-z1', 'p1'), ...nodes('pg', 'eus2-z2', 'p2')]
    const tail = [...apps.map((a) => T(a, 'p1')), sync('p1', 'p2')]
    ok('azure-portal-canvas', {
      nodes: [...nodes('front-door', 'global', 'fd'), ...nodes('app-gateway', 'eus2', 'ag'), ...base],
      edges: [T('users', 'fd'), T('fd', 'ag'), ...apps.map((a) => T('ag', a)), ...tail],
    })
    ok('azure-portal-canvas', {
      nodes: [...nodes('app-gateway', 'eus2', 'ag'), ...base],
      edges: [T('users', 'ag'), ...apps.map((a) => T('ag', a)), ...tail],
    })
  })
  it('GCP: Cloud Run behind a load balancer; linked only to the standby; Cloud Run plus VMs', () => {
    const sql = [...nodes('cloud-sql', 'usc1-a', 's1'), ...nodes('cloud-sql', 'usc1-b', 's2')]
    ok('gcp-signup-canvas', {
      nodes: [...nodes('lb', 'usc1', 'lb'), ...nodes('cloud-run', 'usc1', 'run'), ...sql],
      edges: [T('users', 'lb'), T('lb', 'run'), T('run', 's1'), sync('s1', 's2')],
    })
    ok('gcp-signup-canvas', {
      nodes: [...nodes('cloud-run', 'usc1', 'run'), ...sql],
      edges: [T('users', 'run'), T('run', 's2'), sync('s1', 's2')],
    })
    const e = evaluateCanvas(get('gcp-signup-canvas'), {
      nodes: [...nodes('lb', 'usc1', 'lb'), ...nodes('cloud-run', 'usc1', 'run'), ...nodes('vm', 'usc1-a', 'v1'), ...sql],
      edges: [T('users', 'lb'), T('users', 'run'), T('lb', 'v1'), T('run', 's1'), T('v1', 's1'), sync('s1', 's2')],
    })
    expect(e.tests.filter((t) => !t.pass)).toEqual([])
  })
})

describe('reason wording', () => {
  it('names the unnamed zone by label and gives one entry-point reason', () => {
    const c = get('aws-checkout-canvas')
    const d = c.counter_examples.find((x) => x.name.startsWith('Everything in one zone of another'))!.design
    expect(evaluateCanvas(c, d).tests[1].reasons[0]).toMatch(/A zone you used but no test names \(us-west-2a\) fails/)
    const open = c.counter_examples.find((x) => x.name.startsWith('Web servers open'))!.design
    expect(evaluateCanvas(c, open).tests[0].reasons).toEqual([
      'users connect straight to web-1, web-2, web-3, web-4; put a load balancer or other entry point in front.',
    ])
  })
})
