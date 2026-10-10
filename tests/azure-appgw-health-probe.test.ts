import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('azure-appgw-health-probe')
const P = 'az network application-gateway probe update -g rg-portal --gateway-name agw-portal -n probe-portal --path /healthz'
describe('azure-appgw-health-probe', () => {
  it.each([P, 'az network application-gateway probe update --path /healthz --name probe-portal --gateway-name agw-portal --resource-group rg-portal'])('credits %s', (c) =>
    expect(credit(c)?.id).toBe('update-probe'),
  )
  it.each([
    `${P} --match-status-codes 200-499`,
    `${P} --host evil.example`,
    `${P} --min-servers 2`,
    `${P}; az vm restart -g rg-portal -n a`,
    `${P} && echo`,
    `${P} --path /health`,
    `${P} $(id)`,
    'az network application-gateway probe update -g rg-portal --gateway-name agw-portal -n probe-portal --path /healthz2',
    'az network application-gateway probe update -g rg-other --gateway-name agw-portal -n probe-portal --path /healthz',
  ])('does not credit %s', (c) => expect(credit(c)?.id).not.toBe('update-probe'))
  it('loosening the probe is destructive', () => expect(credit(`${P} --match-status-codes 200-499`)).toMatchObject({ id: 'widen-probe', kind: 'destructive' }))
  it('needs the IaC step', () => expect(sc.solution_paths).toEqual([['update-probe', 'probe-in-iac']]))
})
