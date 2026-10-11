import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'
import { actionFor, step, type GameEvent } from '../src/game/engine.ts'
import { atStage } from '../src/schema/stages.ts'
import { fileFixed } from '../src/game/fileFix.ts'

const { sc, credit } = load('gcp-scan-ingest-major')
const stage = sc.stages!.find((s) => s.id === 'perimeter')!
const a = (id: string) => stage.actions.find((x) => x.id === id)!
const fix = a('ingress-file').file!
const ok = (t: string) => fileFixed(fix, t)
const good = fix.after
const base = 'gcloud access-context-manager perimeters update pr_datalake'
const p = '--policy=518273645190'
const f = '--set-ingress-policies=ingress.yaml'

describe('gcp-scan-ingest-major', () => {
  it('binds workload identity with either flag order', () => {
    const m = '--member "serviceAccount:apps-prod.svc.id.goog[scans/scan-ingest]"'
    const r = '--role roles/iam.workloadIdentityUser'
    const c = 'gcloud iam service-accounts add-iam-policy-binding scan-ingest@apps-prod.iam.gserviceaccount.com'
    expect(credit(`${c} ${r} ${m}`)?.id).toBe('bind-wi')
    expect(credit(`${c} ${m} ${r}`)?.id).toBe('bind-wi')
    expect(credit(`${c} ${r} ${m} ${m}`)).toBeUndefined()
  })
  it('requires the merged file and the apply command; no --add flag anywhere', () => {
    expect(stage.solution_paths).toEqual([['ingress-file', 'ingress-rule']])
    expect(JSON.stringify(sc)).not.toMatch(/add-ingress-policies/)
  })
  it('the starter draft and the broad files are refused', () => {
    expect(ok(sc.stages![0].files![0].content)).toBe(false)
    expect(ok(good)).toBe(true)
    const bypasses = [
      good.replace('google.storage.objects.create', '*'),
      good.replace('google.storage.objects.create\n', 'google.storage.objects.create\n                  - permission: storage.objects.get\n'),
      good + '- ingressFrom:\n    identities:\n    - allUsers\n    sources:\n    - resource: projects/1\n  ingressTo:\n    operations:\n    - serviceName: storage.googleapis.com\n      methodSelectors:\n      - method: google.storage.objects.create\n    resources:\n    - projects/731904428156\n',
      good.replace('- projects/731904428156\n', '- projects/731904428156\n                -  projects/999\n'),
      good + '---\n- ingressFrom: {}\n',
      good.replace('    identities:', '    access_level: x\n    identities:'),
      good.replace('- serviceAccount:scan-ingest@apps-prod.iam.gserviceaccount.com', '- serviceAccount:scan-ingest@apps-prod.iam.gserviceaccount.com\n                - domain:evil.com'),
      good.replace('ingressFrom:', '"ingressFrom":').replace('identities:', '"identities":\n                - allUsers\n                "x":'),
      good.slice(good.indexOf('- ingressFrom:', 5)), // dropped the BI policy
      good.replace('projects/412345678901', 'projects/*'),
    ]
    bypasses.forEach((b, i) => expect([i, ok(b)]).toEqual([i, false]))
  })
  it('accepts valid narrow spellings: flow style, quotes, comments, reordered policies', () => {
    const [bi, scan] = good.split(/^(?=- ingressFrom:)/m)
    expect(ok(scan + bi)).toBe(true)
    expect(ok('# policies with * and ANY_IDENTITY mentioned only in this comment\n' + good)).toBe(true)
    expect(ok(good.replaceAll('projects/731904428156', '"projects/731904428156"'))).toBe(true)
    const flow = `- {ingressFrom: {identities: [serviceAccount:bi-export@reporting-prod.iam.gserviceaccount.com], sources: [{resource: projects/580012345678}]}, ingressTo: {operations: [{serviceName: bigquery.googleapis.com, methodSelectors: [{method: google.cloud.bigquery.v2.TableDataService.List}]}], resources: [projects/731904428156]}}
- {ingressFrom: {identities: [serviceAccount:scan-ingest@apps-prod.iam.gserviceaccount.com], sources: [{resource: projects/412345678901}]}, ingressTo: {operations: [{serviceName: storage.googleapis.com, methodSelectors: [{method: google.storage.objects.create}]}], resources: [projects/731904428156]}}`
    expect(ok(flow)).toBe(true)
  })
  it('stays fast on pathological input', () => {
    const t = Date.now()
    expect(ok(good + '\n'.repeat(50000))).toBe(false) // over the length cap
    expect(ok(good + '\n'.repeat(3000))).toBe(true)
    expect(Date.now() - t).toBeLessThan(500)
  })
  it('credits --set-ingress-policies in either order and spelling, never extras', () => {
    for (const l of [`${base} ${p} ${f}`, `${base} ${f} --policy 518273645190`, `${base} ${p} --set-ingress-policies ./ingress.yaml`])
      expect(credit(l)?.id).toBe('ingress-rule')
    for (const l of [`${base} ${p} ${f} ${f}`, `${base} ${p} ${f}; rm x`, `${base} ${p}`, `${base} ${p} --set-ingress-policies=other.yaml`])
      expect(credit(l)?.id).not.toBe('ingress-rule')
    expect(credit(`${base} ${p} --clear-ingress-policies`)?.id).toBe('clear-ingress')
  })
  it('the engine never credits the typed apply itself: only the terminal, after reading the file', () => {
    const cur = atStage(sc, 1)
    const act = actionFor(cur, `${base} ${p} ${f}`)
    expect(act?.id).toBe('ingress-rule')
    expect(act?.requires_file).toBeDefined()
    const s0 = { phase: 'acting' as const, log: [] as GameEvent[] }
    const log: GameEvent[] = [{ type: 'START', at: 0 }]
    const s = step(sc, { ...s0, phase: 'acting', log }, { type: 'RUN_COMMAND', input: `${base} ${p} ${f}`, at: 1 })
    expect(s.log.some((e) => e.type === 'TAKE_ACTION')).toBe(false)
  })
  it('alerts on the dead-letter backlog', () => {
    expect(sc.stages!.find((s) => s.id === 'replay')!.solution_paths).toEqual([['redrive', 'dlq-alert']])
  })
})

describe('vpcsc ingress helper edge cases', () => {
  it('refuses aliases, non-lists and empty input', async () => {
    const { ingressPolicyOk } = await import('../src/game/vpcscIngress.ts')
    const spec = fix.ingress_policy!
    expect(ingressPolicyOk('', spec)).toBe(false)
    expect(ingressPolicyOk('a: 1', spec)).toBe(false)
    expect(ingressPolicyOk('- &x {}\n- *x', spec)).toBe(false)
    expect(ingressPolicyOk(good, spec)).toBe(true)
  })
})
