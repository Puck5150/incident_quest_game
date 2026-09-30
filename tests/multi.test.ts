import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { MultiCanvasSchema, resolveProvider, unresolvedTokens } from '../src/schema/multi.ts'
import { newProgress, recordResult } from '../src/game/progress.ts'

const CONTENT = path.resolve(import.meta.dirname, '../content')
const FILE = path.join(CONTENT, 'cloud-design/zone-resilient-checkout.yaml')
const multi = MultiCanvasSchema.parse(parse(fs.readFileSync(FILE, 'utf8')))

describe('resolveProvider', () => {
  it('fills names, lanes and tokens for each provider', () => {
    const aws = resolveProvider(multi, 'aws')
    const azure = resolveProvider(multi, 'azure')
    expect(aws.provider).toBe('aws')
    expect(aws.palette.find((p) => p.id === 'db')!.label).toBe('RDS for PostgreSQL instance')
    expect(azure.palette.find((p) => p.id === 'db')!.label).toBe('Azure Database for PostgreSQL flexible server')
    expect(azure.layout.regions[0].zones.map((z) => z.label)).toEqual(['Zone 1', 'Zone 2'])
    expect(aws.stress_tests[0].label).toBe('us-east-1a fails')
    expect(aws.brief).toMatch(/Build the same small checkout on AWS: .* in us-east-1\./s)
    expect(azure.hints.answer).toMatch(/Application Gateway v2, and a Azure Database for PostgreSQL flexible server primary/)
    expect(unresolvedTokens(aws)).toEqual([])
  })

  it('applies per-provider overrides', () => {
    const tweaked = { ...multi, overrides: { gcp: { palette: { vm: { capacity: 3 } } } } }
    expect(resolveProvider(tweaked, 'gcp').palette.find((p) => p.id === 'vm')!.capacity).toBe(3)
    expect(resolveProvider(tweaked, 'aws').palette.find((p) => p.id === 'vm')!.capacity).toBe(1)
  })

  it('reports tokens that could not be filled', () => {
    const typo = { ...multi, brief: 'On {provider} in {zone:r9-z}.' }
    expect(unresolvedTokens(resolveProvider(typo, 'aws'))).toEqual(['{zone:r9-z}'])
  })
})

it('the build fails when a design only breaks on one cloud', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iq-content-'))
  fs.copyFileSync(path.join(CONTENT, 'tracks.yaml'), path.join(dir, 'tracks.yaml'))
  fs.mkdirSync(path.join(dir, 'cloud-design'))
  // On GCP only, web servers get half the capacity: the reference no longer survives a zone.
  const original = fs.readFileSync(FILE, 'utf8')
  fs.writeFileSync(
    path.join(dir, 'cloud-design/zone-resilient-checkout.yaml'),
    original + '\noverrides:\n  gcp:\n    palette:\n      vm: { capacity: 0.5 }\n',
  )
  const run = () => loadContent(dir)
  expect(run).toThrow(/zone-resilient-checkout\.yaml \[gcp\]: reference design "Recommended" fails: zone-a, zone-b, vm-failure/)
  expect(run).not.toThrow(/\[aws\]/)
})

it('progress remembers every cloud a challenge was completed on', () => {
  const score = { total: 100, clean: true, hintsUsed: 0 }
  let p = recordResult(newProgress(), 'x', score, new Date(), 'aws').progress
  p = recordResult(p, 'x', score, new Date(), 'gcp').progress
  p = recordResult(p, 'x', score, new Date(), 'aws').progress
  expect(p.completed.x.providers).toEqual(['aws', 'gcp'])
  expect(recordResult(newProgress(), 'y', score, new Date()).progress.completed.y.providers).toBeUndefined()
})
