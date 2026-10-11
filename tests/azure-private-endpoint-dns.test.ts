import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('azure-private-endpoint-dns')
const L = (v: string) => `az network private-dns link vnet create -g rg-net -z privatelink.blob.core.windows.net -n link-app -v ${v} -e false`
describe('azure-private-endpoint-dns', () => {
  it.each(['vnet-app', '/subscriptions/1/resourceGroups/rg-app/providers/Microsoft.Network/virtualNetworks/vnet-app'])('credits linking %s', (v) =>
    expect(credit(L(v))?.id).toBe('link-zone'),
  )
  it.each([
    L('vnet-hub'),
    L('/subscriptions/1/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/vnet-hub'),
    L('vnet-app;id'),
    L('$(id)'),
    L('vnet-app') + ' && echo',
    L('vnet-app').replace('false', 'true'),
  ])('does not credit %s', (c) => expect(credit(c)?.id).not.toBe('link-zone'))
  it('needs IaC', () => expect(sc.solution_paths).toEqual([['link-zone', 'zone-in-iac']]))
})
