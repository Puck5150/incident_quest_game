import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc } = load('postgres-too-many-clients')

describe('postgres-too-many-clients', () => {
  it('no single mitigation completes it', () => {
    expect(sc.solution_paths).toEqual([
      ['pooler', 'pooler-compat', 'pooler-auth', 'connection-budget'],
      ['smaller-pool', 'connection-budget'],
    ])
  })
  it('an unauthenticated pooler is a wrong action', () => {
    expect(sc.actions.find((a) => a.id === 'pooler-open')?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'max-1000')?.kind).toBe('wrong')
  })
})
