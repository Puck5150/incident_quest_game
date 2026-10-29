// The caching setting on a route part, the per-node caching choice and the opt-in
// edge_load check field: what the canvas schema accepts and refuses.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { CanvasChallengeSchema, DesignSchema } from '../src/schema/canvas.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const base = canvases.find((x) => x.id === 'aws-checkout-canvas')!
const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? [] : r.error!.issues.map((i) => i.message))

const withCheck = (check: unknown) => {
  const c = structuredClone(base) as Record<string, unknown> & { stress_tests: { check: unknown }[] }
  c.stress_tests[0].check = check
  return CanvasChallengeSchema.safeParse(c)
}
const both = ['serve', 'write-store']
const el = { share: 0.5, hit: 0.9 }

describe('edge_load', () => {
  it('is accepted with serve and capacity', () => {
    expect(withCheck({ reach: both, capacity: 3, edge_load: el }).success).toBe(true)
    expect(withCheck({ reach: ['serve'], capacity: 3, edge_load: el }).success).toBe(true)
  })

  it('is optional: a check without it is unchanged', () => {
    expect(withCheck({ reach: both, capacity: 3 }).success).toBe(true)
  })

  it('is refused without capacity or without serve in reach', () => {
    expect(messages(withCheck({ reach: both, edge_load: el }))).toContain('edge_load needs capacity and serve in reach')
    expect(messages(withCheck({ reach: ['write-store'], capacity: 3, edge_load: el }))).toContain('edge_load needs capacity and serve in reach')
  })

  it('refuses a share or hit outside (0, 1)', () => {
    for (const bad of [{ ...el, share: 0 }, { ...el, share: 1 }, { ...el, hit: 0 }, { ...el, hit: 1.2 }])
      expect(withCheck({ reach: both, capacity: 3, edge_load: bad }).success).toBe(false)
  })

  it('refuses unknown keys', () => {
    expect(withCheck({ reach: both, capacity: 3, edge_load: { ...el, extra: 1 } }).success).toBe(false)
  })
})

describe('the caching setting on a palette part', () => {
  const caching = { label: 'Caching', default: true, facts: ['A fact.'] }
  const withPart = (id: string, patch: object) => {
    const c = structuredClone(base)
    c.palette = c.palette.map((p) => (p.id === id ? { ...p, ...patch } : p))
    return CanvasChallengeSchema.safeParse(c)
  }

  it('is accepted on a route part', () => {
    expect(withPart('alb', { caching }).success).toBe(true)
  })

  it('is refused on a part without the route role', () => {
    expect(messages(withPart('ec2-web', { caching }))).toContain('caching only applies to a part with the route role')
  })

  it('needs a label, a default and at least one fact', () => {
    expect(withPart('alb', { caching: { ...caching, facts: [] } }).success).toBe(false)
    expect(withPart('alb', { caching: { label: 'Caching', facts: ['x'] } }).success).toBe(false)
    expect(withPart('alb', { caching: { ...caching, label: '' } }).success).toBe(false)
  })
})

describe('the per-node caching choice', () => {
  const node = { id: 'a', type: 'alb', lane: 'use1' }
  it('is optional and boolean', () => {
    expect(DesignSchema.safeParse({ nodes: [node], edges: [] }).success).toBe(true)
    expect(DesignSchema.safeParse({ nodes: [{ ...node, caching: false }], edges: [] }).success).toBe(true)
    expect(DesignSchema.safeParse({ nodes: [{ ...node, caching: 'yes' }], edges: [] }).success).toBe(false)
  })
})
