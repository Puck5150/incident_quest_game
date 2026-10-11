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
  it.each([
    'az functionapp scale config set -g rg-fulfil -n func-fulfil --maximum-instance-count=2',
    'az functionapp scale config set --resource-group=rg-fulfil --name=func-fulfil --maximum-instance-count=1',
  ])('credits the valid spelling %s', (c) => expect(credit(c)?.id).toBe('cap-concurrency'))
  it.each([
    'az functionapp scale config set -g rg-fulfil -n func-fulfil --maximum-instance-count=2 --maximum-instance-count=1',
    'az functionapp scale config set -g rg-fulfil -n func-fulfil --maximum-instance-count=5',
    'az functionapp scale config set -g rg-fulfil -n func-fulfil --maximum-instance-count=2;id',
  ])('does not credit %s', (c) => expect(credit(c)?.id).not.toBe('cap-concurrency'))
  it('the scale-config check flips once the cap is taken', () => {
    const q = sc.stages![0].terminal!.commands.filter((x) => x.match === 'az functionapp scale config show -g rg-fulfil -n func-fulfil')
    expect(q[0].when_actions).toEqual(['cap-concurrency'])
    expect(q[0].output).toContain('"maximumInstanceCount": 2')
  })
})
