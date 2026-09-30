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
import { CanvasChallengeSchema } from '../src/schema/canvas.ts'
import { evaluateCanvas } from '../src/game/canvas.ts'
import { MultiCanvasSchema, resolveProvider, unresolvedTokens } from '../src/schema/multi.ts'
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

  it('_canvas_template.yaml is valid: reference passes, counter-example fails exactly as listed', () => {
    const errors: string[] = []
    const c = check(path.join(CONTENT, '_canvas_template.yaml'), CanvasChallengeSchema, errors)
    expect(errors).toEqual([])
    c!.reference_designs.forEach((d) => expect(evaluateCanvas(c!, d.design).pass).toBe(true))
    c!.counter_examples.forEach((x) =>
      expect(evaluateCanvas(c!, x.design).tests.filter((t) => !t.pass).map((t) => t.id)).toEqual(x.fails),
    )
  })

  it('_pick_cloud_template.yaml resolves and passes on every provider', () => {
    const errors: string[] = []
    const m = check(path.join(CONTENT, '_pick_cloud_template.yaml'), MultiCanvasSchema, errors)
    expect(errors).toEqual([])
    m!.providers.forEach((p) => {
      const c = CanvasChallengeSchema.parse(resolveProvider(m!, p))
      expect(unresolvedTokens(c)).toEqual([])
      c.reference_designs.forEach((d) => expect(evaluateCanvas(c, d.design).pass).toBe(true))
      c.counter_examples.forEach((x) =>
        expect(evaluateCanvas(c, x.design).tests.filter((t) => !t.pass).map((t) => t.id)).toEqual(x.fails),
      )
    })
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

  it('a canvas counter-example that no longer fails what it claims', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iq-content-'))
    fs.copyFileSync(path.join(CONTENT, 'tracks.yaml'), path.join(dir, 'tracks.yaml'))
    fs.mkdirSync(path.join(dir, 'cloud-design'))
    const original = fs.readFileSync(path.join(CONTENT, 'cloud-design/aws-checkout-canvas.yaml'), 'utf8')
    // Turn the "async replica" counter-example's link into sync: it now passes.
    fs.writeFileSync(
      path.join(dir, 'cloud-design/aws-checkout-canvas.yaml'),
      original.replace('- { from: db-1, to: db-2, kind: async }', '- { from: db-1, to: db-2, kind: sync }'),
    )
    expect(() => loadContent(dir)).toThrow(/counter-example "An async replica instead of a synchronous standby" should fail \[az1-outage\] but fails \[\]/)
  })

  it('missing sources', () => {
    expect(loadMutated((y) => y.slice(0, y.indexOf('sources:')))).toThrow(/sources/)
  })
})
