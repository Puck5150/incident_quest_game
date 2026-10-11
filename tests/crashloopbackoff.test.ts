import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('crashloopbackoff')

describe('crashloopbackoff', () => {
  it('a rollback alone never completes it: the manifest in Git must be fixed', () => {
    expect(sc.solution_paths).toContainEqual(['fix-env'])
    expect(sc.solution_paths).toContainEqual(['rollback', 'fix-env'])
    expect(sc.solution_paths).not.toContainEqual(['rollback'])
  })
  it('keeps the typed rollback and the destructive deletes classified', () => {
    expect(actionFor(sc, 'kubectl rollout undo deployment/orders-api -n shop')?.id).toBe('rollback')
    expect(actionFor(sc, 'kubectl rollout undo deployment/orders-api -n shop; id')?.id).not.toBe('rollback')
    expect(actionFor(sc, 'kubectl delete deployment orders-api -n shop')?.kind).toBe('destructive')
  })
})

describe('crashloopbackoff spellings', () => {
  it.each(['kubectl -n shop rollout undo deploy/orders-api', 'kubectl rollout undo deployment/orders-api --to-revision=11 -n shop'])('credits %s', (c) => expect(actionFor(sc, c)?.id).toBe('rollback'))
  it('still rejects extras', () => expect(actionFor(sc, 'kubectl rollout undo deploy/orders-api --to-revision=x')?.id).not.toBe('rollback'))
})
