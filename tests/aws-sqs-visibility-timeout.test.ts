import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-sqs-visibility-timeout')
const V = (n: string | number) => `aws sqs set-queue-attributes --queue-url https://sqs.us-east-1.amazonaws.com/111122223333/invoice-jobs --attributes VisibilityTimeout=${n}`

describe('aws-sqs-visibility-timeout', () => {
  it('requires timeout, atomic idempotency and a DLQ', () => expect(sc.solution_paths).toEqual([['raise-timeout', 'idempotent', 'dlq']]))
  it.each([90, 99, 180, 300, 600])('credits %s', (n) => expect(actionFor(sc, V(n))?.id).toBe('raise-timeout'))
  it.each([0, 1, 31, 45, 89])('flags %s as too low', (n) => expect(actionFor(sc, V(n))).toMatchObject({ id: 'timeout-too-low', kind: 'wrong' }))
  it.each([601, 900, 43200, 99999])('flags %s as too high', (n) => expect(actionFor(sc, V(n))).toMatchObject({ id: 'timeout-too-high', kind: 'wrong' }))
  it.each([`${V(180)}; aws sqs purge-queue --queue-url x`, `${V(180)} && echo`, V('0180'), V('$T'), V('180 VisibilityTimeout=0'), V('')])('does not credit %s', (c) => expect(actionFor(sc, c)?.id).not.toBe('raise-timeout'))
  it('check-then-send is wrong, atomic claim is the fix', () => {
    expect(sc.actions.find((a) => a.id === 'check-then-send')?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'idempotent')?.label).toMatch(/atomic/i)
  })
})
