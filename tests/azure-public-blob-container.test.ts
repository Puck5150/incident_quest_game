import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('azure-public-blob-container')
const B = 'az storage container set-permission --name invoices --account-name shopdocsprod --public-access off'

describe('azure-public-blob-container', () => {
  it.each([B, 'az storage container set-permission --public-access off --account-name shopdocsprod --name invoices', `${B} --auth-mode login`])('credits %s', (c) =>
    expect(credit(c)?.id).toBe('private-container'),
  )
  it.each([
    `${B}; az storage container set-permission --name invoices --account-name shopdocsprod --public-access container`,
    `${B} && echo`,
    `${B} --public-access container`,
    `${B} --name product-images`,
    `${B} --account-name other`,
    `${B} --sas-token abc`,
    `${B} | tee x`,
    `${B} $(id)`,
    'az storage container set-permission --name invoices --account-name shopdocsprod --public-access blob',
    'az storage container set-permission --name product-images --account-name shopdocsprod --public-access off',
  ])('does not credit %s', (c) => expect(credit(c)?.id).not.toBe('private-container'))
  it('container-only fix never completes it: exposure assessment and the account guardrail are required', () => {
    expect(sc.solution_paths).toEqual([['private-container', 'fix-module', 'assess-exposure', 'disallow-account-anon']])
    expect(sc.actions.find((a) => a.id === 'account-off-now')!.kind).toBe('wrong')
  })
})
