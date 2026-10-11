import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('gcp-scan-ingest-major')
const stage = sc.stages!.find((s) => s.id === 'perimeter')!
const a = (id: string) => stage.actions.find((x) => x.id === id)!
const fileOk = (text: string) => new RegExp(a('ingress-file').file!.matches, 'm').test(text)
const base = 'gcloud access-context-manager perimeters update pr_datalake'

describe('gcp-scan-ingest-major', () => {
  it('binds workload identity with either flag order', () => {
    const m = '--member "serviceAccount:apps-prod.svc.id.goog[scans/scan-ingest]"'
    const r = '--role roles/iam.workloadIdentityUser'
    const c = 'gcloud iam service-accounts add-iam-policy-binding scan-ingest@apps-prod.iam.gserviceaccount.com'
    expect(credit(`${c} ${r} ${m}`)?.id).toBe('bind-wi')
    expect(credit(`${c} ${m} ${r}`)?.id).toBe('bind-wi')
    expect(credit(`${c} ${r} ${m} ${m}`)).toBeUndefined()
  })
  it('requires the narrow file and the additive command', () => {
    expect(stage.solution_paths).toEqual([['ingress-file', 'ingress-rule']])
  })
  it('credits only the narrow file', () => {
    expect(fileOk(a('ingress-file').file!.after)).toBe(true)
    expect(fileOk(sc.stages![0].files![0].content)).toBe(false)
    const good = a('ingress-file').file!.after
    expect(fileOk(good.replace('serviceAccount:scan-ingest@apps-prod.iam.gserviceaccount.com', 'serviceAccount:*'))).toBe(false)
    expect(fileOk(good.replace('projects/731904428156', '*'))).toBe(false)
    expect(fileOk(good.replace('google.storage.objects.create', '*'))).toBe(false)
    expect(fileOk(good.replace('- resource: projects/412345678901', "- accessLevel: '*'"))).toBe(false)
    expect(fileOk(good + '    - projects/999\n')).toBe(false)
    expect(fileOk(good.replace('identities:', 'identityType: ANY_IDENTITY\n    identities:'))).toBe(false)
  })
  it('credits --add-ingress-policies in either order, never --set or extras', () => {
    const p = '--policy=518273645190'
    const f = '--add-ingress-policies=ingress.yaml'
    expect(credit(`${base} ${p} ${f}`)?.id).toBe('ingress-rule')
    expect(credit(`${base} ${f} --policy 518273645190`)?.id).toBe('ingress-rule')
    expect(credit(`${base} ${p} --set-ingress-policies=ingress.yaml`)?.id).toBe('set-ingress')
    expect(credit(`${base} ${p} ${f} ${f}`)).toBeUndefined()
    expect(credit(`${base} ${p} ${f}; rm x`)).toBeUndefined()
    expect(credit(`${base} ${p}`)).toBeUndefined()
  })
  it('alerts on the dead-letter backlog', () => {
    expect(sc.stages!.find((s) => s.id === 'replay')!.solution_paths).toEqual([['redrive', 'dlq-alert']])
  })
})
