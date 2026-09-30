// Every scenario in /content must pass the same validation the build uses.
// The "rejects" tests prove the validator actually catches broken files.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { check, loadContent } from '../vite-plugin-content.ts'
import { ScenarioSchema } from '../src/schema/scenario.ts'
import { ChallengeSchema } from '../src/schema/challenge.ts'
import { evaluate } from '../src/game/challenge.ts'
import { newSession, step, type GameEvent } from '../src/game/engine.ts'

const CONTENT = path.resolve(import.meta.dirname, '../content')

describe('content', () => {
  it('all scenarios are valid', () => {
    const { scenarios } = loadContent(CONTENT)
    expect(scenarios.length).toBeGreaterThan(0)
  })

  // Every solution path must actually resolve through the real engine.
  it.each(loadContent(CONTENT).scenarios.flatMap((s) => s.solution_paths.map((p) => [s.id, p, s] as const)))(
    '%s is winnable via %j',
    (_id, path, s) => {
      const correct = s.hypotheses.find((h) => h.correct)!.id
      const events: GameEvent[] = [
        { type: 'START', at: 0 },
        { type: 'DECLARE_HYPOTHESIS', id: correct, at: 1 },
        ...path.map((id, i): GameEvent => ({ type: 'TAKE_ACTION', id, at: 2 + i })),
        { type: 'CLOSE_INCIDENT', at: 100 },
      ]
      expect(events.reduce((sess, e) => step(s, sess, e), newSession()).phase).toBe('resolved')
    },
  )

  it('_challenge_template.yaml is itself a valid challenge whose reference design passes', () => {
    const errors: string[] = []
    const c = check(path.join(CONTENT, '_challenge_template.yaml'), ChallengeSchema, errors)
    expect(errors).toEqual([])
    c!.reference_designs.forEach((d) => expect(evaluate(c!, d.picks).pass).toBe(true))
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

  it('a challenge whose reference design fails its own stress tests', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iq-content-'))
    fs.copyFileSync(path.join(CONTENT, 'tracks.yaml'), path.join(dir, 'tracks.yaml'))
    fs.mkdirSync(path.join(dir, 'cloud-design'))
    const original = fs.readFileSync(path.join(CONTENT, 'cloud-design/aws-checkout-az-resilience.yaml'), 'utf8')
    fs.writeFileSync(
      path.join(dir, 'cloud-design/aws-checkout-az-resilience.yaml'),
      original.replace('picks: { compute: asg-multi-az, database: rds-multi-az }', 'picks: { compute: ec2-single, database: rds-multi-az }'),
    )
    expect(() => loadContent(dir)).toThrow(/reference design "Recommended" fails: az-outage, sale-traffic/)
  })

  it('missing sources', () => {
    expect(loadMutated((y) => y.slice(0, y.indexOf('sources:')))).toThrow(/sources/)
  })
})
