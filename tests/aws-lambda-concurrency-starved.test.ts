import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-lambda-concurrency-starved')
const U = '6b1f2c9e-3a44-4d0e-9a1b-5c7d8e9f0a12'
const E = (v: string) => `aws lambda update-event-source-mapping --uuid ${U} --scaling-config ${v}`
const R = (fn: string, n: string | number) => `aws lambda put-function-concurrency --function-name ${fn} --reserved-concurrent-executions ${n}`

describe('aws-lambda-concurrency-starved', () => {
  it('requires cap, reservation and alarm', () => expect(sc.solution_paths).toEqual([['cap-backfill', 'reserve-checkout', 'alarm-concurrency']]))
  it.each([E('MaximumConcurrency=50'), E('MaximumConcurrency=20'), E('MaximumConcurrency=300'), E("'MaximumConcurrency=100'"), E(`'{"MaximumConcurrency":50}'`), E(`'{"MaximumConcurrency": 75}'`)])('credits %s', (c) =>
    expect(actionFor(sc, c)?.id).toBe('cap-backfill'),
  )
  it.each([
    E('MaximumConcurrency=1'),
    E('MaximumConcurrency=0'),
    E('MaximumConcurrency=2'),
    E('MaximumConcurrency=301'),
    E('MaximumConcurrency=999'),
    E('MaximumConcurrency=50; aws lambda delete-function --function-name x'),
    `${E('MaximumConcurrency=50')} && echo`,
    E('MaximumConcurrency=$X'),
    E('MaximumConcurrency=050'),
    `${E('MaximumConcurrency=50')} --enabled`,
    E('MaximumConcurrency=50').replace(U, 'ffffffff-0000-0000-0000-000000000000'),
  ])('does not credit %s', (c) => expect(actionFor(sc, c)?.id).not.toBe('cap-backfill'))
  it.each([R('thumbnail-backfill', 100), R('thumbnail-backfill', 1)])('flags a reserved cap on the queue consumer as wrong: %s', (c) =>
    expect(actionFor(sc, c)).toMatchObject({ id: 'cap-backfill-reserved', kind: 'wrong' }),
  )
  it.each([200, 300, 450, 500])('credits checkout reservation %s', (n) => expect(actionFor(sc, R('checkout-api', n))?.id).toBe('reserve-checkout'))
  it.each([0, 5, 99, 150, 199])('flags under-sized checkout reservation %s', (n) => expect(actionFor(sc, R('checkout-api', n))).toMatchObject({ id: 'reserve-checkout-small', kind: 'wrong' }))
  it.each([501, 900, 999, 1000, 5000])('flags oversized checkout reservation %s', (n) => expect(actionFor(sc, R('checkout-api', n))).toMatchObject({ id: 'reserve-checkout-big', kind: 'wrong' }))
  it.each([`${R('checkout-api', 300)}; echo`, `${R('checkout-api', 300)} && x`, R('checkout-api', '0300'), R('checkout-api', '$N')])('does not credit %s', (c) => expect(actionFor(sc, c)?.id).not.toBe('reserve-checkout'))
})
