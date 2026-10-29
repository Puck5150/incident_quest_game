// The sandbox's edge parts, per cloud: the right role and scope for each cloud's service,
// the caching setting the cloud's own docs describe, and sources only from that cloud's docs.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'

const { sandboxes } = loadContent(path.resolve(import.meta.dirname, '../content'))
const sandbox = (provider: string) => sandboxes.find((s) => s.provider === provider)!
const part = (provider: string, id: string) => sandbox(provider).palette.find((p) => p.id === id)
const host = (url: string) => new URL(url).hostname

describe('aws', () => {
  const s = sandbox('aws')
  const p = part('aws', 'cloudfront')

  it('CloudFront is a global route part that caches by default', () => {
    expect(p, 'cloudfront').toBeDefined()
    expect(p!.roles).toEqual(['route'])
    expect(p!.scope).toBe('global')
    expect(p!.caching?.default).toBe(true)
    expect(p!.caching?.label).toBeTruthy()
    expect(p!.facts.length).toBeGreaterThan(0)
    expect(p!.caching!.facts.length).toBeGreaterThan(0)
  })

  it("cites only AWS's own documentation", () => {
    for (const src of s.sources) expect(['docs.aws.amazon.com'], src.url).toContain(host(src.url))
  })
})

describe('azure', () => {
  const s = sandbox('azure')
  const fd = part('azure', 'front-door')
  const tm = part('azure', 'traffic-manager')

  it('Front Door carries a caching setting that is off to start, added by an overlay (the canvas part is untouched)', () => {
    expect(fd!.roles).toEqual(['route'])
    expect(fd!.scope).toBe('global')
    expect(fd!.caching?.default).toBe(false)
    expect(fd!.caching?.label).toBe('Enable caching')
    expect(fd!.caching!.facts.length).toBeGreaterThan(0)
  })

  it('Traffic Manager is a global route part with no caching setting of its own', () => {
    expect(tm, 'traffic-manager').toBeDefined()
    expect(tm!.roles).toEqual(['route'])
    expect(tm!.scope).toBe('global')
    expect(tm!.caching).toBeUndefined()
    expect(tm!.facts.length).toBeGreaterThan(0)
  })

  it("cites only Microsoft's own documentation", () => {
    for (const src of s.sources) expect(['learn.microsoft.com'], src.url).toContain(host(src.url))
  })
})
