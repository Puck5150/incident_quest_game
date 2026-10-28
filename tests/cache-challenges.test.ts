// The three cache-before-the-sale challenges: each cloud's cache is modelled from that
// cloud's own documentation, so the scope differs, and so do the tests.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const get = (id: string) => canvases.find((x) => x.id === id)!

const shape = {
  aws: { id: 'aws-cache-before-the-sale', scope: 'zonal', tests: ['sale', 'zone-a', 'zone-b', 'vm-failure', 'db-host', 'cache-failure'] },
  azure: { id: 'azure-cache-before-the-sale', scope: 'regional', tests: ['sale', 'zone-a', 'zone-b', 'vm-failure', 'db-host'] },
  gcp: { id: 'gcp-cache-before-the-sale', scope: 'zonal', tests: ['sale', 'zone-a', 'zone-b', 'vm-failure', 'db-host', 'cache-failure'] },
} as const

for (const [provider, want] of Object.entries(shape))
  describe(`${provider} cache-before-the-sale`, () => {
    const c = get(want.id)
    const cache = c.palette.find((p) => p.id === 'cache')!

    it('is that cloud\'s challenge, in the cloud design track', () => {
      expect(c.provider).toBe(provider)
      expect(c.track).toBe('cloud-design')
    })
    it(`models its cache as a ${want.scope} part with the cache role alone`, () => {
      expect(cache.scope).toBe(want.scope)
      expect(cache.roles).toEqual(['cache'])
    })
    it('has the tests that cloud\'s documented behavior supports, all judging read load', () => {
      expect(c.stress_tests.map((t) => t.id)).toEqual(want.tests)
      c.stress_tests.forEach((t) => expect(t.check.read_load).toEqual({ traffic: 2, hit: 0.9, db_capacity: 1 }))
    })
    it('lists only its own cloud\'s documentation', () => {
      const host = { aws: 'docs.aws.amazon.com', azure: 'learn.microsoft.com', gcp: 'docs.cloud.google.com' }[provider]!
      c.sources.forEach((s) => expect(new URL(s.url).host).toBe(host))
    })
  })
