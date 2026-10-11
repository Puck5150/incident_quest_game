import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('azure-vnet-peering-one-way')
const P = (r: string) => `az network vnet peering create -g rg-data --vnet-name vnet-data -n data-to-app --remote-vnet ${r} --allow-vnet-access`
describe('azure-vnet-peering-one-way', () => {
  it.each(['vnet-app', '/subscriptions/1/resourceGroups/rg-app/providers/Microsoft.Network/virtualNetworks/vnet-app'])('credits %s', (r) => expect(credit(P(r))?.id).toBe('create-other-side'))
  it.each([P('vnet-other'), P('vnet-app;id'), P('$(id)'), `${P('vnet-app')} --allow-forwarded-traffic`, `${P('vnet-app')} && echo`])('does not credit %s', (c) =>
    expect(credit(c)?.id).not.toBe('create-other-side'),
  )
  it('requires scoping the NSG', () => expect(sc.solution_paths).toEqual([['create-other-side', 'scope-nsg']]))
})
