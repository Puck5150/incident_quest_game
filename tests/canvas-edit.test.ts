import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { addNode, connect, disconnect, emptyDesign, lanesFor, moveNode, removeNode, targets } from '../src/game/canvasEdit.ts'
import type { Design } from '../src/schema/canvas.ts'

const c = loadContent(path.resolve(import.meta.dirname, '../content')).canvases.find((x) => x.id === 'aws-checkout-canvas')!
const ok = (r: Design | string): Design => {
  if (typeof r === 'string') throw new Error(r)
  return r
}

describe('canvas editing', () => {
  it('places components only in lanes that match their scope', () => {
    expect(lanesFor(c, 'alb').map((l) => l.id)).toEqual(['use1', 'usw2'])
    expect(lanesFor(c, 'ec2-web').map((l) => l.id)).toEqual(['use1-az1', 'use1-az2', 'usw2-az1'])
    expect(addNode(c, emptyDesign(), 'alb', 'use1-az1')).toBe("Application Load Balancer can't go in us-east-1a.")
  })

  it('names components from their short label, filling gaps', () => {
    let d = ok(addNode(c, emptyDesign(), 'ec2-web', 'use1-az1'))
    d = ok(addNode(c, d, 'ec2-web', 'use1-az2'))
    expect(d.nodes.map((n) => n.id)).toEqual(['web-1', 'web-2'])
    d = ok(addNode(c, removeNode(d, 'web-1'), 'ec2-web', 'use1-az1'))
    expect(d.nodes.map((n) => n.id)).toEqual(['web-2', 'web-1'])
  })

  it('caps a design at 12 components', () => {
    let d = emptyDesign()
    for (let i = 0; i < 12; i++) d = ok(addNode(c, d, 'ec2-web', 'use1-az1'))
    expect(addNode(c, d, 'ec2-web', 'use1-az1')).toBe('A design can have at most 12 components.')
  })

  it('moves within scope and removes a component with its links', () => {
    let d = ok(addNode(c, emptyDesign(), 'ec2-web', 'use1-az1'))
    d = ok(moveNode(c, d, 'web-1', 'use1-az2'))
    expect(d.nodes[0].lane).toBe('use1-az2')
    expect(moveNode(c, d, 'web-1', 'use1')).toBe("web-1 can't go in us-east-1 (regional).")
    d = ok(connect(c, d, 'users', 'web-1', 'traffic'))
    expect(removeNode(d, 'web-1')).toEqual({ nodes: [], edges: [] })
  })

  it('enforces link rules', () => {
    let d = ok(addNode(c, emptyDesign(), 'ec2-web', 'use1-az1'))
    d = ok(addNode(c, d, 'rds', 'use1-az1'))
    d = ok(addNode(c, d, 'rds', 'use1-az2'))
    expect(connect(c, d, 'web-1', 'web-1', 'traffic')).toBe("A component can't link to itself.")
    expect(connect(c, d, 'web-1', 'rds-2', 'sync')).toBe('Replication links join two databases.')
    d = ok(connect(c, d, 'rds-1', 'rds-2', 'sync'))
    expect(connect(c, d, 'rds-1', 'rds-2', 'sync')).toBe('That link already exists.')
    expect(connect(c, d, 'rds-2', 'rds-1', 'async')).toBe('Those two databases are already linked the other way.')
    expect(targets(c, d, 'web-1', 'traffic')).toEqual(['rds-1', 'rds-2'])
    expect(targets(c, d, 'users', 'traffic')).toEqual(['web-1', 'rds-1', 'rds-2'])
    expect(disconnect(d, 0).edges).toEqual([])
  })
})
