// TF7b: incidents with a terraform: block answer terraform from the simulator, so none may script a
// terraform command; incidents without one must not script terraform output either.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'

const content = loadContent(path.resolve(import.meta.dirname, '../content'))
const incidents = content.scenarios

const scriptedTerraform = (s: (typeof incidents)[number]) =>
  (s.terminal?.commands ?? [])
    .map((c) => c.match ?? c.match_regex ?? c.example ?? '')
    .filter((m) => /^\^?\s*(\()?terraform\b/.test(m))

describe('no scripted terraform', () => {
  it('there are simulator incidents to check', () => {
    expect(incidents.filter((s) => s.terraform).length).toBeGreaterThan(20)
  })
  it('incidents with a terraform: block script no terraform command', () => {
    for (const s of incidents.filter((x) => x.terraform)) expect(scriptedTerraform(s), s.id).toEqual([])
  })
  it('incidents without a terraform: block script no terraform output', () => {
    for (const s of incidents.filter((x) => !x.terraform)) expect(scriptedTerraform(s), s.id).toEqual([])
  })
})
