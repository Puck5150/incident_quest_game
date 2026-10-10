import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

// Preventive/cleanup steps are required in the credited path, not optional debrief text.
const paths = (id: string) => {
  const { sc } = load(id)
  return [sc, ...(sc.stages ?? [])].map((p) => p.solution_paths)
}
describe('azure fix-quality required paths', () => {
  it.each([
    ['azure-slot-swap-key-vault-two-faults', [[['grant-prod-rbac']], [['add-policy', 'revoke-staging-prod']]]],
    ['azure-slot-swap-connection-string', [[['swap-back', 'sticky-setting', 'migrate-orders', 'clean-staging-data']]]],
    ['azure-app-sql-two-faults', [[['allow-outbound-ips', 'firewall-iac']]]],
    ['azure-front-door-host-header', [[['custom-domain', 'bind-certificate', 'lock-origin', 'fix-bicep']]]],
    ['azure-nsg-rule-priority', [[['reprioritize', 'nsg-in-iac']]]],
    ['azure-cosmos-hot-partition', [[['raise-rus', 'new-partition-key', 'lower-rus', 'alert-hot-partition']]]],
    ['azure-policy-allowed-locations', [[['allowed-region'], ['exemption-process']]]],
  ])('%s', (id, want) => {
    const got = paths(id)
    for (let i = 0; i < want.length; i++) expect(got[i]).toEqual(want[i])
  })
  it('a stopgap RU raise and a hand SG edit never complete alone', () => {
    expect(paths('azure-cosmos-hot-partition')[0].every((p) => p.length > 1)).toBe(true)
  })
})
