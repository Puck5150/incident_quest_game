import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('postgres-lock-queue')
const R = 'ALTER ROLE analyst2 SET idle_in_transaction_session_timeout'

describe('postgres-lock-queue', () => {
  it('terminating or cancelling alone never completes: prevention is required', () => {
    for (const p of sc.solution_paths) expect(p).toEqual(expect.arrayContaining(['migration-lock-timeout', 'analyst-timeout', 'analyst-replica']))
    expect(sc.solution_paths.map((p) => p[0]).sort()).toEqual(['cancel-migration', 'terminate-idle'])
  })
  it.each([
    `${R} = '5min';`,
    `${R} = '5 min'`,
    `${R} TO '300s'`,
    `${R} = 60000`,
    `alter role analyst2 set idle_in_transaction_session_timeout = '10min';`,
    `${R}  =  '2min' ;`.replace(' ;', ';'),
  ])('credits a bounded timeout: %s', (c) => expect(credit(c)?.id).toBe('analyst-timeout'))
  it.each([`${R} = 0;`, `${R} = '0';`, `${R} = DEFAULT`, `${R} TO '0s'`])('disabling it is wrong: %s', (c) =>
    expect(credit(c)).toMatchObject({ id: 'analyst-timeout-off', kind: 'wrong' }))
  it.each([
    `${R} = '2h';`,
    `${R} = '11min';`,
    `${R} = '5min'; DROP TABLE orders;`,
    `${R} = '5min', statement_timeout = 0;`,
    `ALTER ROLE postgres SET idle_in_transaction_session_timeout = '5min';`,
    `ALTER ROLE analyst2 SET lock_timeout = '5min';`,
    `ALTER SYSTEM SET idle_in_transaction_session_timeout = '5min';`,
  ])('does not credit %s', (c) => expect(credit(c)?.id).not.toBe('analyst-timeout'))
  it('still credits the incident steps by their exact pid', () => {
    expect(credit('SELECT pg_terminate_backend(58210);')?.id).toBe('terminate-idle')
    expect(credit('SELECT pg_cancel_backend(60977)')?.id).toBe('cancel-migration')
    expect(credit('SELECT pg_terminate_backend(61002);')).toBeUndefined()
  })
})
