import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('azure-rbac-wrong-scope')
const P = '3f9c0e21-6b7a-4d8e-9f10-2c3d4e5f6a7b'
const SITE = '/subscriptions/2222-aa/resourceGroups/rg-web-prod/providers/Microsoft.Web/sites/web-prod'
const A = `az role assignment create --assignee ${P}`

describe('azure-rbac-wrong-scope', () => {
  it.each([
    `${A} --role "Website Contributor" --scope ${SITE}`,
    `az role assignment create --scope ${SITE} --role 'Website Contributor' --assignee ${P} --assignee-principal-type ServicePrincipal`,
  ])('credits the narrow role on the site: %s', (c) => expect(credit(c)?.id).toBe('assign-prod'))
  it.each([
    [`${A} --role Contributor --scope /subscriptions/2222-aa/resourceGroups/rg-web-prod`, 'contributor-rg', 'wrong'],
    [`${A} --role "Contributor" --scope ${SITE}`, 'contributor-rg', 'wrong'],
    [`${A} --role Contributor --scope /subscriptions/2222-aa`, 'subscription-contributor', 'wrong'],
    [`${A} --role Owner --scope /subscriptions/2222-aa`, 'owner-subscription', 'destructive'],
  ])('flags the broad grant %s', (c, id, kind) => expect(credit(c)).toMatchObject({ id, kind }))
  it.each([
    `${A} --role "Website Contributor" --scope /subscriptions/2222-aa/resourceGroups/rg-web-prod`,
    `${A} --role "Website Contributor" --scope /subscriptions/2222-aa/resourceGroups/rg-web-staging/providers/Microsoft.Web/sites/web-prod`,
    `${A} --role "Website Contributor" --scope ${SITE}; ${A} --role Owner --scope /subscriptions/2222-aa`,
    `${A} --role "Website Contributor" --scope ${SITE} && echo`,
    `${A} --role "Website Contributor" --role Owner --scope ${SITE}`,
    `${A} --role "Website Contributor" --scope ${SITE} --scope /subscriptions/2222-aa`,
    `${A} --role "Website Contributor" --scope ${SITE} $(id)`,
    `az role assignment create --assignee evil --role "Website Contributor" --scope ${SITE}`,
  ])('does not credit %s', (c) => expect(credit(c)?.id).not.toBe('assign-prod'))
  it('also requires dropping the long-lived secret', () => {
    expect(sc.solution_paths).toEqual([['assign-prod', 'use-federated-credential']])
  })
})
