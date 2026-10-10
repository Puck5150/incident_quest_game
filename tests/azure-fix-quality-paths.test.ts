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
  it('a stopgap RU raise never completes alone', () => {
    expect(paths('azure-cosmos-hot-partition')[0].every((p) => p.length > 1)).toBe(true)
  })
  // Weak routes are wrong/destructive actions, never part of any solution path.
  it.each([
    ['azure-cosmos-hot-partition', ['autoscale', 'more-workers', 'recreate-container']],
    ['azure-front-door-host-header', ['override-header', 'disable-waf']],
    ['azure-nsg-rule-priority', ['ssh-from-anywhere', 'delete-baseline', 'allow-at-400']],
    ['azure-vnet-peering-one-way', ['open-nsg', 'public-db']],
    ['azure-slot-swap-connection-string', ['edit-prod-only', 'wipe-staging']],
  ])('%s weak routes are not fixes and not in any path', (id, weak) => {
    const { sc, actions } = load(id)
    const inPath = new Set([sc, ...(sc.stages ?? [])].flatMap((p) => p.solution_paths.flat()))
    for (const w of weak) {
      expect(['wrong', 'destructive']).toContain(actions.find((a) => a.id === w)!.kind)
      expect(inPath.has(w)).toBe(false)
    }
  })
  it('the nsg priority matcher rejects loosened edits', () => {
    const { credit } = load('azure-nsg-rule-priority')
    const R = 'az network nsg rule update -g rg-batch --nsg-name nsg-batch -n Allow-SSH-Office --priority 150'
    expect(credit(R)?.id).toBe('reprioritize')
    for (const c of [`${R} --source-address-prefixes '*'`, `${R}; id`, R.replace('150', '250'), R.replace('150', '99')]) expect(credit(c)?.id).not.toBe('reprioritize')
  })

})
