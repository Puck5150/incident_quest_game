// The opt-in read_load check field and the cache role: what the schema accepts and refuses.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { CanvasChallengeSchema } from '../src/schema/canvas.ts'
import { ROLES } from '../src/schema/constants.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const base = canvases.find((x) => x.id === 'aws-checkout-canvas')!

const withCheck = (check: unknown) => {
  const c = structuredClone(base) as Record<string, unknown> & { stress_tests: { check: unknown }[] }
  c.stress_tests[0].check = check
  return CanvasChallengeSchema.safeParse(c)
}
const both = ['serve', 'write-store']
const rl = { traffic: 2, hit: 0.9, db_capacity: 1 }
const messages = (r: ReturnType<typeof withCheck>) => (r.success ? [] : r.error.issues.map((i) => i.message))

describe('read_load', () => {
  it('cache is a role', () => {
    expect(ROLES).toContain('cache')
  })

  it('is accepted when reach has serve and write-store', () => {
    expect(withCheck({ reach: both, read_load: rl }).success).toBe(true)
  })

  it('is optional: a check without it is unchanged', () => {
    expect(withCheck({ reach: both, capacity: 2 }).success).toBe(true)
  })

  it('is refused when reach lacks serve or write-store', () => {
    expect(messages(withCheck({ reach: ['serve'], read_load: rl }))).toContain('read_load needs both serve and write-store in reach')
    expect(messages(withCheck({ reach: ['write-store'], read_load: rl }))).toContain('read_load needs both serve and write-store in reach')
  })

  it('refuses a hit rate outside (0, 1) and non-positive numbers', () => {
    for (const bad of [{ ...rl, hit: 0 }, { ...rl, hit: 1 }, { ...rl, hit: 1.5 }, { ...rl, traffic: 0 }, { ...rl, db_capacity: -1 }])
      expect(withCheck({ reach: both, read_load: bad }).success).toBe(false)
  })

  it('refuses unknown fields inside read_load', () => {
    expect(withCheck({ reach: both, read_load: { ...rl, extra: 1 } }).success).toBe(false)
  })
})

describe('the cache role', () => {
  const withRoles = (roles: string[]) => {
    const c = structuredClone(base) as Record<string, unknown> & { palette: { roles: string[] }[] }
    c.palette[0].roles = roles
    return CanvasChallengeSchema.safeParse(c)
  }
  it('is accepted on its own', () => {
    expect(withRoles(['cache']).success).toBe(true)
  })
  it('is refused together with another role', () => {
    const r = withRoles(['cache', 'serve'])
    expect(r.success).toBe(false)
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toContain('a cache part has no other role')
  })
})
