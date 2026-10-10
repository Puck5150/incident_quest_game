import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('evicted-checkout-major')

describe('evicted-checkout-major', () => {
  it('requires namespace guardrails, the CronJob template fix and the sized limits', () => {
    expect(atStage(sc, 0).solution_paths).toEqual([['set-resources', 'namespace-defaults']])
    expect(atStage(sc, 2).solution_paths).toEqual([['capture-resources', 'run-capture']])
  })
  it('the one-off Job alone is not enough', () => expect(atStage(sc, 2).solution_paths.flat()).toContain('capture-resources'))
  it('credits the exact create-job command only', () => {
    const st = atStage(sc, 2)
    expect(actionFor(st, 'kubectl create job capture-reconcile-manual --from=cronjob/capture-reconcile -n shop')?.id).toBe('run-capture')
    expect(actionFor(st, 'kubectl create job capture-reconcile-manual --from=cronjob/capture-reconcile -n shop; id')?.id).not.toBe('run-capture')
  })
  it('credits only a bounded HPA maximum', () => {
    const st = atStage(sc, 1)
    const p = (n: number) => `kubectl patch hpa checkout -n shop -p '{"spec":{"maxReplicas":${n}}}'`
    expect(actionFor(st, p(12))?.id).toBe('raise-max')
    for (const n of [6, 100, 21]) expect(actionFor(st, p(n))?.id).not.toBe('raise-max')
  })
})
