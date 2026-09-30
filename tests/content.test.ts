// Every scenario in /content must pass the same validation the build uses.
// The "rejects" tests prove the validator actually catches broken files.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { check, loadContent } from '../vite-plugin-content.ts'
import { ScenarioSchema } from '../src/schema/scenario.ts'

const CONTENT = path.resolve(import.meta.dirname, '../content')

describe('content', () => {
  it('all scenarios are valid', () => {
    const { scenarios } = loadContent(CONTENT)
    expect(scenarios.length).toBeGreaterThan(0)
  })

  it('_template.yaml is itself a valid scenario', () => {
    const errors: string[] = []
    check(path.join(CONTENT, '_template.yaml'), ScenarioSchema, errors)
    expect(errors).toEqual([])
  })
})

describe('validator rejects', () => {
  // Build a throwaway content folder with the real tracks.yaml and one
  // mutated copy of full-disk.yaml.
  function loadMutated(mutate: (yaml: string) => string, filename = 'full-disk.yaml') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iq-content-'))
    fs.copyFileSync(path.join(CONTENT, 'tracks.yaml'), path.join(dir, 'tracks.yaml'))
    fs.mkdirSync(path.join(dir, 'linux'))
    const original = fs.readFileSync(path.join(CONTENT, 'linux/full-disk.yaml'), 'utf8')
    fs.writeFileSync(path.join(dir, 'linux', filename), mutate(original))
    return () => loadContent(dir)
  }

  it('YAML syntax errors', () => {
    expect(loadMutated((y) => y + '\nbroken: [unclosed\n')).toThrow(/full-disk\.yaml/)
  })

  it('solution path pointing at an unknown action', () => {
    expect(loadMutated((y) => y.replace('[truncate-log, fix-logrotate]', '[truncate-log, typo]'))).toThrow(
      /"typo" is not an action with kind: fix/,
    )
  })

  it('id not matching filename', () => {
    expect(loadMutated((y) => y, 'renamed.yaml')).toThrow(/must match the filename/)
  })

  it('missing sources', () => {
    expect(loadMutated((y) => y.slice(0, y.indexOf('sources:')))).toThrow(/sources/)
  })
})
