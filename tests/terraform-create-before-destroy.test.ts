import { describe, expect, it } from 'vitest'
import { executeApply, type ApplyContext } from '../src/game/terraform/apply.ts'
import type { Value } from '../src/game/terraform/eval.ts'
import { planConfig } from '../src/game/terraform/plan.ts'
import { realityKey, type Reality } from '../src/game/terraform/refresh.ts'
import { renderPlan } from '../src/game/terraform/render.ts'
import { stateRemove } from '../src/game/terraform/state-ops.ts'
import { emptyState, findInstance, listAddresses, stateJson, type State } from '../src/game/terraform/state.ts'

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]'
type Seed = { type: string; name: string; attrs: Record<string, Value>; deps?: string[] }
const stateOf = (...seeds: Seed[]): State => {
  const s = emptyState()
  for (const x of seeds) s.resources.push({ mode: 'managed', type: x.type, name: x.name, provider: AWS, instances: [{ attributes: x.attrs, ...(x.deps ? { dependencies: x.deps } : {}) }] })
  return s
}
const cloudOf = (state: State): Reality =>
  Object.fromEntries(state.resources.flatMap((r) => r.instances.map((i) => [realityKey(r.type, i.attributes.id as string), structuredClone(i.attributes)] as const)))
const ctx = (o: Partial<ApplyContext> = {}): ApplyContext => ({ faults: [], taken: new Set(), attempts: new Map(), seed: '1', ...o })
const run = (tf: string, o: { state?: State; reality?: Reality; ctx?: Partial<ApplyContext> } = {}) => {
  const state = o.state ?? emptyState()
  return executeApply({ files: [{ name: 'main.tf', text: tf }], state, reality: o.reality ?? cloudOf(state), vars: {} }, ctx(o.ctx))
}
const ops = (r: { steps: { op: string; address: string; ok: boolean }[] }) => r.steps.map((s) => `${s.ok ? '' : '!'}${s.op} ${s.address}`)

const SG = { id: 'sg-9', arn: 'arn:sg-9', name: 'web-v1', description: 'Managed by Terraform', vpc_id: null, ingress: [], egress: [] }
const APP = { id: 'i-1', arn: 'arn:i-1', ami: 'ami-1', instance_type: 't3.micro', tags: { sg: 'sg-9' }, tags_all: { sg: 'sg-9' } }
const world = () => stateOf({ type: 'aws_security_group', name: 'web', attrs: SG }, { type: 'aws_instance', name: 'app', attrs: APP, deps: ['aws_security_group.web'] })
const tf = (cbd: boolean) => `
resource "aws_security_group" "web" {
  name = "web-v2"
${cbd ? '  lifecycle {\n    create_before_destroy = true\n  }\n' : ''}}
resource "aws_instance" "app" {
  ami           = "ami-1"
  instance_type = "t3.micro"
  tags          = { sg = aws_security_group.web.id }
}
`
const stuck = { at: 'aws_security_group.web', on: 'delete' as const, error: 'deleting Security Group (sg-9): DependencyViolation: resource sg-9 has a dependent object' }

describe('create_before_destroy ordering', () => {
  it('creates the new object, updates dependents, then deletes the old one', () => {
    const r = run(tf(true), { state: world() })
    expect(r.errors).toEqual([])
    expect(ops(r)).toEqual(['create aws_security_group.web', 'update aws_instance.app', 'delete aws_security_group.web'])
    const [created, , deleted] = r.steps
    expect(created.id).not.toBe('sg-9')
    expect(deleted.id).toBe('sg-9')
    expect(findInstance(r.state, 'aws_instance.app')!.instance.attributes.tags).toEqual({ sg: created.id })
    expect(findInstance(r.state, 'aws_security_group.web')!.instance.deposed).toBeUndefined()
    expect(r.reality[realityKey('aws_security_group', 'sg-9')]).toBeUndefined()
    expect(r.counts).toEqual({ imported: 0, added: 1, changed: 1, destroyed: 1 })
  })

  it('keeps delete-then-create for a plain replace (the delete hits the dependent first)', () => {
    const r = run(tf(false), { state: world() })
    expect(ops(r)).toEqual(['!delete aws_security_group.web'])
    expect(r.errors[0].summary).toContain('DependencyViolation')
    expect(findInstance(r.state, 'aws_security_group.web')!.instance).toEqual({ attributes: SG })
  })

  it('a failed delete leaves the new object and a deposed old one, and nothing else is lost', () => {
    const r = run(tf(true), { state: world(), ctx: { faults: [stuck] } })
    expect(ops(r)).toEqual(['create aws_security_group.web', 'update aws_instance.app', '!delete aws_security_group.web'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ summary: stuck.error, context: 'resource "aws_security_group" "web"', address: 'aws_security_group.web' })
    const inst = findInstance(r.state, 'aws_security_group.web')!.instance
    expect(inst.attributes.id).toBe(r.steps[0].id)
    expect(inst.deposed).toEqual([{ key: expect.stringMatching(/^[0-9a-f]{8}$/), attributes: SG }])
    expect(r.reality[realityKey('aws_security_group', 'sg-9')]).toBeDefined()
    expect(r.reality[realityKey('aws_security_group', r.steps[0].id!)]).toBeDefined()
    expect(r.counts).toEqual({ imported: 0, added: 1, changed: 1, destroyed: 0 })
  })

  it('the next apply retries the deposed delete and clears it', () => {
    const first = run(tf(true), { state: world(), ctx: { faults: [stuck] } })
    const again = run(tf(true), { state: first.state, reality: first.reality })
    expect(again.errors).toEqual([])
    expect(ops(again)).toEqual(['delete aws_security_group.web'])
    expect(again.steps[0].id).toBe('sg-9')
    const inst = findInstance(again.state, 'aws_security_group.web')!.instance
    expect(inst.attributes.id).toBe(first.steps[0].id)
    expect(inst.deposed).toBeUndefined()
    expect(again.reality[realityKey('aws_security_group', 'sg-9')]).toBeUndefined()
    expect(again.counts.destroyed).toBe(1)
  })

  it('a failed create changes nothing', () => {
    const r = run(tf(true), { state: world(), ctx: { faults: [{ at: 'aws_security_group.web', on: 'create', error: 'creating Security Group (web-v2): boom' }] } })
    expect(ops(r)).toEqual(['!create aws_security_group.web'])
    expect(findInstance(r.state, 'aws_security_group.web')!.instance).toEqual({ attributes: SG })
    expect(r.counts).toEqual({ imported: 0, added: 0, changed: 0, destroyed: 0 })
  })

  it('a CBD resource that is not replaced behaves as before', () => {
    const same = tf(true).replace('web-v2', 'web-v1')
    const r = run(same, { state: world() })
    expect(r.steps.map((s) => s.op)).not.toContain('delete')
    expect(findInstance(r.state, 'aws_security_group.web')!.instance.deposed).toBeUndefined()
  })
})

describe('deposed objects in plan, destroy and state', () => {
  const left = () => {
    const r = run(tf(true), { state: world(), ctx: { faults: [stuck] } })
    return { state: r.state, reality: r.reality, key: findInstance(r.state, 'aws_security_group.web')!.instance.deposed![0].key }
  }

  it('plans a destroy of the deposed object', () => {
    const { state, reality, key } = left()
    const p = planConfig({ files: [{ name: 'main.tf', text: tf(true) }], state, reality, vars: {} })
    expect(p.items.filter((i) => i.action !== 'noop').map((i) => [i.address, i.action, i.deposed])).toEqual([['aws_security_group.web', 'destroy', key]])
    const text = renderPlan(p)
    expect(text).toContain(`# aws_security_group.web (deposed object ${key}) will be destroyed`)
    expect(text).toContain('# (left over from a partially-failed replacement of this instance)')
    expect(text).toContain('Plan: 0 to add, 0 to change, 1 to destroy.')
  })

  it('terraform destroy removes deposed objects too', () => {
    const { state, reality } = left()
    const r = executeApply({ files: [{ name: 'main.tf', text: tf(true) }], state, reality, vars: {}, destroy: true }, ctx())
    expect(r.errors).toEqual([])
    expect(r.state.resources).toEqual([])
    expect(r.reality).toEqual({})
  })

  it('state pull keeps the deposed object; state rm of the address removes both', () => {
    const { state, key } = left()
    expect(JSON.parse(stateJson(state)).resources.find((r: { type: string }) => r.type === 'aws_security_group').instances.map((i: { deposed?: string }) => i.deposed)).toEqual([undefined, key])
    expect(listAddresses(state)).toEqual(['aws_instance.app', 'aws_security_group.web'])
    const rm = stateRemove(state, ['aws_security_group.web'])
    expect(rm.ok && listAddresses(rm.state)).toEqual(['aws_instance.app'])
  })
})
