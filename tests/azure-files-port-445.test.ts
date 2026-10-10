import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc } = load('azure-files-port-445')
describe('azure-files-port-445', () => {
  it('opening 445 is a wrong action and never a route; public access must be disabled', () => {
    expect(sc.actions.find((a) => a.id === 'open-445-azure')!.kind).toBe('wrong')
    expect(sc.solution_paths).toEqual([['vpn-private-endpoint', 'disable-public-access']])
  })
})
