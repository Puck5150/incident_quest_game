// The shipped sandbox files: they resolve against their canvas challenge, only
// add neutral parts, and every part explains itself.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentKind, contentPlugin, loadContent } from '../vite-plugin-content.ts'
import { parseItem } from '../src/content/item.ts'

const dir = path.resolve(import.meta.dirname, '../content')
const content = loadContent(dir)

describe('contentKind', () => {
  it('recognises a sandbox file', () => {
    expect(contentKind('# comment\ntype: sandbox\nid: x\n')).toBe('sandbox')
    expect(contentKind('type: challenge\nmode: canvas\n')).toBe('canvas')
  })
})

describe('the preview page', () => {
  it('says sandbox files are checked by the build instead of misreading them as incidents', () => {
    const { item, errors } = parseItem('type: sandbox\nid: x\n', 'Your file')
    expect(item).toBeUndefined()
    expect(errors.join(' ')).toMatch(/sandbox files are checked by the build/)
  })
})

describe('sandbox files', () => {
  it('are loaded, never listed as playable challenges', () => {
    expect(content.sandboxes.length).toBeGreaterThan(0)
    for (const s of content.sandboxes) expect(content.canvases.some((c) => c.id === s.id)).toBe(false)
  })

  it.each(content.sandboxes.map((s) => [s.id, s] as const))('%s: extends a same-cloud canvas and adds only explained neutral parts', (_id, s) => {
    const raw = fs.readFileSync(path.join(dir, 'sandbox', `${s.id}.yaml`), 'utf8')
    expect(raw.split('\n')[0]).toBe('# yaml-language-server: $schema=../../schemas/sandbox.json')
    expect(s.provider).toBe(content.canvases.find((c) => c.id === (/^extends:\s*(\S+)/m.exec(raw) ?? [])[1])?.provider)
    const extras = s.palette.filter((p) => p.roles.includes('neutral'))
    expect(extras.length).toBeGreaterThanOrEqual(3)
    for (const p of extras) {
      expect(p.roles, p.id).toEqual(['neutral'])
      expect(p.facts.length, p.id).toBeGreaterThan(0)
    }
    expect(s.layout.global).toBe(true)
    expect(s.layout.regions).toHaveLength(2)
    for (const r of s.layout.regions) expect(r.zones, r.id).toHaveLength(2)
    expect(new Set(s.palette.map((p) => p.id)).size).toBe(s.palette.length)
  })

  it('a sandbox file whose extends names another cloud is rejected by the build', () => {
    const tmp = fs.mkdtempSync(path.join(import.meta.dirname, '.tmp-sb-'))
    try {
      fs.cpSync(dir, tmp, { recursive: true })
      const file = path.join(tmp, 'sandbox', 'aws-sandbox.yaml')
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('extends: aws-checkout-canvas', 'extends: azure-portal-canvas'))
      expect(() => loadContent(tmp)).toThrow(/aws-sandbox\.yaml.*not aws/s)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('the generated loadSandbox always returns a promise, resolving to undefined for a cloud with no sandbox', async () => {
    const plugin = contentPlugin(dir) as { load: (id: string) => string }
    const src = plugin.load('\0virtual:content')
    // Run the generated module's loader lines, with import() swapped for the sandbox's own data.
    const body = src
      .split('\n')
      .filter((l) => l.includes('sandboxLoaders'))
      .join('\n')
      .replace(/export const/g, 'const')
      .replace(/import\(/g, 'fakeImport(')
    const fakeImport = (id: string) => Promise.resolve({ default: { fetched: id } })
    const loadSandbox = new Function('fakeImport', `${body}\nreturn loadSandbox`)(fakeImport)
    const none = loadSandbox('azure')
    expect(typeof none.then).toBe('function')
    expect(await none).toBeUndefined()
    expect(await loadSandbox('aws')).toBeDefined()
  })
})
