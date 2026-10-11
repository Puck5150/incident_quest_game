import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('gcp-firewall-network-tag')
describe('gcp-firewall-network-tag', () => {
  it('both routes still need the template, and allow-all stays destructive', () => {
    expect(sc.solution_paths).toEqual([['add-tag', 'template'], ['sa-target', 'template']])
    expect(sc.actions.find((a) => a.id === 'allow-all')?.kind).toBe('destructive')
  })
  it('add-tags is strict', () => {
    expect(credit('gcloud compute instances add-tags app-3 --zone us-central1-a --tags app')?.id).toBe('add-tag')
    expect(credit('gcloud compute instances add-tags app-3 --zone=us-central1-a --tags=app')?.id).toBe('add-tag')
    expect(credit('gcloud compute instances add-tags app-3 --zone us-central1-a --tags app,db')).toBeUndefined()
  })
})
