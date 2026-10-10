import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('azure-orders-backlog-major')
const C = 'az functionapp scale config set -g rg-fulfil -n func-fulfil --maximum-instance-count 2'
describe('azure-orders-backlog-major', () => {
  it.each([C, 'az functionapp scale config set --maximum-instance-count 1 --resource-group rg-fulfil --name func-fulfil'])('credits %s', (c) =>
    expect(credit(c)?.id).toBe('cap-concurrency'),
  )
  it.each([
    `${C}; az functionapp delete -g rg-fulfil -n func-fulfil`,
    `${C} && echo`,
    'az functionapp scale config set -g rg-fulfil -n func-fulfil --maximum-instance-count 20',
    'az functionapp scale config set -g rg-fulfil -n func-fulfil --maximum-instance-count 3',
    `${C} --maximum-instance-count 100`,
    `${C} -g rg-shop`,
    `${C} --always-ready-instances 5`,
    `${C} $(id)`,
  ])('does not credit %s', (c) => expect(credit(c)?.id).not.toBe('cap-concurrency'))
  it('needs both halves of the cap, the SAS cleanup and the 429 backoff', () => {
    expect(sc.solution_paths).toEqual([['grant-identity', 'remove-sas']])
    expect(sc.stages![0].solution_paths).toEqual([['cap-concurrency', 'cap-calls', 'backoff-429']])
  })
})
