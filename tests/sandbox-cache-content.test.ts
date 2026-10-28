// The sandbox's cache parts: judged (role cache), the right scope for each cloud's
// service, explained, and sourced only from that cloud's own documentation.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'

const { sandboxes } = loadContent(path.resolve(import.meta.dirname, '../content'))
const host = (url: string) => new URL(url).hostname

// Scope follows each service as its own documentation describes it.
const expected = {
  aws: { scope: 'zonal', hosts: ['docs.aws.amazon.com'] },
  azure: { scope: 'regional', hosts: ['learn.microsoft.com'] },
  gcp: { scope: 'zonal', hosts: ['cloud.google.com', 'docs.cloud.google.com'] },
} as const

describe.each(sandboxes.map((s) => [s.provider, s] as const))('%s sandbox cache part', (provider, s) => {
  const want = expected[provider as keyof typeof expected]
  const part = s.palette.find((p) => p.roles.includes('cache'))

  it('exists, carries only the cache role, has the cloud-specific scope and explains itself', () => {
    expect(part, 'a cache part').toBeDefined()
    expect(part!.roles).toEqual(['cache'])
    expect(part!.scope).toBe(want.scope)
    expect(part!.facts.length).toBeGreaterThan(0)
  })

  it('is the only part with the cache role (the canvas parts keep their own roles)', () => {
    expect(s.palette.filter((x) => x.roles.includes('cache'))).toHaveLength(1)
  })

  it("cites only this cloud's own documentation", () => {
    for (const src of s.sources) expect(want.hosts, src.url).toContain(host(src.url))
  })
})
