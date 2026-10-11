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
  it.each([
    'az storage container set-permission -n invoices --account-name shopdocsprod --public-access=off',
    'az storage container set-permission --name=invoices --account-name=shopdocsprod --public-access=off',
  ])('credits the valid spelling %s', (c) => expect(credit(c)?.id).toBe('private-container'))
  it.each([
    'az storage container set-permission -n invoices -n product-images --account-name shopdocsprod --public-access off',
    'az storage container set-permission -n invoices --name invoices --account-name shopdocsprod --public-access off',
    'az storage container set-permission -n product-images --account-name shopdocsprod --public-access off',
    'az storage container set-permission -n invoices --account-name shopdocsprod --public-access=off;id',
  ])('does not credit %s', (c) => expect(credit(c)?.id).not.toBe('private-container'))
  it.each([
    'az storage account update -n shopdocsprod -g rg-shop-prod --allow-blob-public-access false',
    'az storage account update -g rg-shop-prod --allow-blob-public-access=false --name shopdocsprod',
  ])('account-wide switch is wrong in any flag order: %s', (c) => expect(credit(c)).toMatchObject({ id: 'account-off-now', kind: 'wrong' }))
  it('the verification command flips once the account guardrail is taken', () => {
    const q = 'az storage account show -n shopdocsprod -g rg-shop-prod --query allowBlobPublicAccess'
    const cmds = sc.terminal!.commands.filter((x) => x.match === q)
    expect(cmds[0].when_actions).toEqual(['disallow-account-anon'])
    expect(cmds[0].output.trim()).toBe('false')
    expect(cmds[1].output.trim()).toBe('true')
  })
})
