import { describe, expect, it } from 'vitest'
import type { Value } from '../src/game/terraform/eval.ts'
import { realityKey, type Reality } from '../src/game/terraform/refresh.ts'
import { emptyState, findInstance, listAddresses, type State } from '../src/game/terraform/state.ts'
import { importObject, parseAddress, stateMove, stateRemove, taintInstance, untaintInstance } from '../src/game/terraform/state-ops.ts'

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]'
type Seed = { type: string; name: string; key?: string | number; attrs: Record<string, Value>; deps?: string[]; mode?: 'managed' | 'data'; tainted?: true }
const stateOf = (...seeds: Seed[]): State => {
  const s = emptyState()
  s.serial = 7
  for (const x of seeds) {
    const mode = x.mode ?? 'managed'
    let r = s.resources.find((r) => r.mode === mode && r.type === x.type && r.name === x.name)
    if (!r) {
      r = { mode, type: x.type, name: x.name, provider: AWS, instances: [] }
      s.resources.push(r)
    }
    r.instances.push({
      ...(x.key === undefined ? {} : { index_key: x.key }),
      attributes: x.attrs,
      ...(x.tainted ? { status: 'tainted' as const } : {}),
      ...(x.deps ? { dependencies: x.deps } : {}),
    })
  }
  return s
}
// Runs op on a state and checks the input was not mutated.
const pure = <T>(state: State, op: (s: State) => T): T => {
  const copy = structuredClone(state)
  const r = op(state)
  expect(state).toEqual(copy)
  return r
}
const fail = (summary: string, detail: string) => ({ ok: false, summary, detail })

const NET = () =>
  stateOf(
    { type: 'aws_vpc', name: 'old', attrs: { id: 'vpc-1' } },
    { type: 'aws_subnet', name: 'a', attrs: { id: 'subnet-1' }, deps: ['aws_vpc.old'] },
    { type: 'aws_s3_bucket', name: 'b', key: 'a', attrs: { id: 'bkt-a' } },
    { type: 'aws_s3_bucket', name: 'b', key: 'z', attrs: { id: 'bkt-z' } },
    { type: 'aws_instance', name: 'web', key: 0, attrs: { id: 'i-0' } },
    { type: 'aws_instance', name: 'web', key: 1, attrs: { id: 'i-1' } },
    { type: 'aws_ami', name: 'img', attrs: { id: 'ami-1' }, mode: 'data' },
  )

describe('parseAddress', () => {
  it('accepts managed, numeric key, string key and data addresses', () => {
    expect(parseAddress('aws_x.y')).toEqual({ ok: true, mode: 'managed', type: 'aws_x', name: 'y' })
    expect(parseAddress('aws_x.y[0]')).toEqual({ ok: true, mode: 'managed', type: 'aws_x', name: 'y', key: 0 })
    expect(parseAddress('aws_x.y["k"]')).toEqual({ ok: true, mode: 'managed', type: 'aws_x', name: 'y', key: 'k' })
    expect(parseAddress('data.aws_x.y')).toEqual({ ok: true, mode: 'data', type: 'aws_x', name: 'y' })
  })
  it('rejects module addresses, bare types, broken keys and empty text', () => {
    for (const t of ['module.m.aws_x.y', 'aws_x', 'aws_x.y[', '', 'var.x', 'aws_x.y[-1]', 'aws_x.y["k]']) expect(parseAddress(t)).toEqual({ ok: false })
  })
})

describe('stateMove', () => {
  it('moves a whole resource and rewrites dependencies on it', () => {
    const s = NET()
    const r = pure(s, (x) => stateMove(x, 'aws_vpc.old', 'aws_vpc.new'))
    if (!r.ok) throw new Error(r.summary)
    expect(r.moved).toEqual([{ from: 'aws_vpc.old', to: 'aws_vpc.new' }])
    expect(r.state.serial).toBe(8)
    expect(r.state.resources[0].name).toBe('new')
    expect(findInstance(r.state, 'aws_vpc.new')!.instance.attributes).toEqual({ id: 'vpc-1' })
    expect(findInstance(r.state, 'aws_vpc.old')).toBeUndefined()
    expect(findInstance(r.state, 'aws_subnet.a')!.instance.dependencies).toEqual(['aws_vpc.new'])
  })
  it('moves every instance of a keyed resource, keeping keys, in address order', () => {
    const r = pure(NET(), (x) => stateMove(x, 'aws_instance.web', 'aws_instance.app'))
    if (!r.ok) throw new Error(r.summary)
    expect(r.moved).toEqual([
      { from: 'aws_instance.web[0]', to: 'aws_instance.app[0]' },
      { from: 'aws_instance.web[1]', to: 'aws_instance.app[1]' },
    ])
    expect(r.state.resources.map((x) => `${x.type}.${x.name}`)).toEqual(['aws_vpc.old', 'aws_subnet.a', 'aws_s3_bucket.b', 'aws_instance.app', 'aws_ami.img'])
  })
  it('moves one keyed instance to a new resource placed after the source', () => {
    const r = pure(NET(), (x) => stateMove(x, 'aws_s3_bucket.b["a"]', 'aws_s3_bucket.c["a"]'))
    if (!r.ok) throw new Error(r.summary)
    expect(r.moved).toEqual([{ from: 'aws_s3_bucket.b["a"]', to: 'aws_s3_bucket.c["a"]' }])
    expect(r.state.serial).toBe(8)
    expect(r.state.resources.map((x) => `${x.type}.${x.name}`)).toEqual(['aws_vpc.old', 'aws_subnet.a', 'aws_s3_bucket.b', 'aws_s3_bucket.c', 'aws_instance.web', 'aws_ami.img'])
    expect(findInstance(r.state, 'aws_s3_bucket.c["a"]')!.instance.attributes.id).toBe('bkt-a')
    expect(findInstance(r.state, 'aws_s3_bucket.b["z"]')).toBeDefined()
  })
  it('moves a keyed instance to a new key on the same resource', () => {
    const r = pure(NET(), (x) => stateMove(x, 'aws_instance.web[1]', 'aws_instance.web[5]'))
    if (!r.ok) throw new Error(r.summary)
    expect(listAddresses(r.state).filter((a) => a.startsWith('aws_instance'))).toEqual(['aws_instance.web[0]', 'aws_instance.web[5]'])
    expect(findInstance(r.state, 'aws_instance.web[5]')!.instance.attributes.id).toBe('i-1')
  })
  it('moves a lone keyed instance to a keyless address, dropping the emptied source', () => {
    const s = stateOf({ type: 'aws_vpc', name: 'v', key: 0, attrs: { id: 'vpc-1' } }, { type: 'aws_subnet', name: 'a', attrs: { id: 's' }, deps: ['aws_vpc.v'] })
    const r = pure(s, (x) => stateMove(x, 'aws_vpc.v[0]', 'aws_vpc.w'))
    if (!r.ok) throw new Error(r.summary)
    expect(listAddresses(r.state)).toEqual(['aws_subnet.a', 'aws_vpc.w'])
    expect(r.state.resources[0].instances[0].index_key).toBeUndefined()
    expect(findInstance(r.state, 'aws_subnet.a')!.instance.dependencies).toEqual(['aws_vpc.w'])
  })
  it('refuses a keyless target when the resource has other instances', () => {
    expect(pure(NET(), (x) => stateMove(x, 'aws_instance.web[1]', 'aws_instance.web'))).toEqual(
      fail('Invalid target address', 'Cannot move to aws_instance.web: aws_instance.web already has instances with keys, so it has no unkeyed instance.'),
    )
  })
  it('moves a resource with one unkeyed instance into an indexed resource', () => {
    const r = pure(NET(), (x) => stateMove(x, 'aws_vpc.old', 'aws_vpc.old[0]'))
    expect(r).toMatchObject({ ok: true, moved: [{ from: 'aws_vpc.old', to: 'aws_vpc.old[0]' }] })
    if (!r.ok) return
    expect(findInstance(r.state, 'aws_vpc.old[0]')?.instance.attributes.id).toBe('vpc-1')
    expect(findInstance(r.state, 'aws_vpc.old')).toBeUndefined()
    const each = pure(NET(), (x) => stateMove(x, 'aws_vpc.old', 'aws_vpc.new["a"]'))
    expect(each).toMatchObject({ ok: true, moved: [{ from: 'aws_vpc.old', to: 'aws_vpc.new["a"]' }] })
    if (!each.ok) return
    expect(listAddresses(each.state)).toContain('aws_vpc.new["a"]')
    expect(findInstance(each.state, 'aws_subnet.a')?.instance.dependencies).toEqual(['aws_vpc.new'])
  })
  it('refuses a keyed target for a whole resource with several or keyed instances', () => {
    expect(pure(NET(), (x) => stateMove(x, 'aws_instance.web', 'aws_instance.x[0]'))).toEqual(fail('Invalid target address', 'Cannot move aws_instance.web to aws_instance.x[0]: the target must also be a whole resource.'))
    const one = stateOf({ type: 'aws_instance', name: 'web', key: 0, attrs: { id: 'i-0' } })
    expect(pure(one, (x) => stateMove(x, 'aws_instance.web', 'aws_instance.x[0]'))).toEqual(fail('Invalid target address', 'Cannot move aws_instance.web to aws_instance.x[0]: the target must also be a whole resource.'))
  })
  it('refuses an existing destination', () => {
    expect(pure(NET(), (x) => stateMove(x, 'aws_instance.web[0]', 'aws_instance.web[1]'))).toEqual(
      fail('Invalid target address', 'Cannot move to aws_instance.web[1]: there is already a resource instance at that address in the current state.'),
    )
    expect(pure(NET(), (x) => stateMove(x, 'aws_s3_bucket.b', 'aws_s3_bucket.b'))).toEqual(
      fail('Invalid target address', 'Cannot move to aws_s3_bucket.b: there is already a resource instance at that address in the current state.'),
    )
  })
  it('refuses a missing source', () => {
    expect(pure(NET(), (x) => stateMove(x, 'aws_vpc.gone', 'aws_vpc.new'))).toEqual(fail('Invalid source address', 'Cannot move aws_vpc.gone: does not match anything in the current state.'))
    expect(pure(NET(), (x) => stateMove(x, 'aws_instance.web[9]', 'aws_instance.web[10]'))).toEqual(
      fail('Invalid source address', 'Cannot move aws_instance.web[9]: does not match anything in the current state.'),
    )
  })
  it('refuses a type change', () => {
    expect(pure(NET(), (x) => stateMove(x, 'aws_vpc.old', 'aws_subnet.b'))).toEqual(fail('Invalid target address', 'Cannot move to aws_subnet.b: resource types must match (aws_vpc and aws_subnet).'))
  })
  it('refuses a mode change', () => {
    expect(pure(NET(), (x) => stateMove(x, 'data.aws_ami.img', 'aws_ami.img'))).toEqual(
      fail('Invalid target address', 'Cannot move data.aws_ami.img to aws_ami.img: a data resource can be moved only to another data resource address.'),
    )
  })
  it('refuses unparseable addresses', () => {
    expect(pure(NET(), (x) => stateMove(x, 'aws_vpc.old', 'module.m.aws_vpc.old'))).toEqual(
      fail('Invalid target address', 'Cannot move to module.m.aws_vpc.old: address is not a valid resource instance or resource address.'),
    )
    expect(pure(NET(), (x) => stateMove(x, 'aws_vpc', 'aws_vpc.new'))).toEqual(fail('Invalid source address', 'Cannot move aws_vpc: address is not a valid resource instance or resource address.'))
  })
})

describe('stateRemove', () => {
  it('removes one instance', () => {
    const r = pure(NET(), (x) => stateRemove(x, ['aws_instance.web[0]']))
    if (!r.ok) throw new Error(r.summary)
    expect(r.removed).toEqual(['aws_instance.web[0]'])
    expect(r.state.serial).toBe(8)
    expect(findInstance(r.state, 'aws_instance.web[1]')).toBeDefined()
  })
  it('removes a whole keyed resource via a keyless address', () => {
    const r = pure(NET(), (x) => stateRemove(x, ['aws_s3_bucket.b']))
    if (!r.ok) throw new Error(r.summary)
    expect(r.removed).toEqual(['aws_s3_bucket.b["a"]', 'aws_s3_bucket.b["z"]'])
    expect(r.state.resources.some((x) => x.name === 'b')).toBe(false)
  })
  it('removes several addresses at once in state order, data sources included, leaving dependencies alone', () => {
    const r = pure(NET(), (x) => stateRemove(x, ['data.aws_ami.img', 'aws_vpc.old', 'aws_vpc.old']))
    if (!r.ok) throw new Error(r.summary)
    expect(r.removed).toEqual(['aws_vpc.old', 'data.aws_ami.img'])
    expect(findInstance(r.state, 'aws_subnet.a')!.instance.dependencies).toEqual(['aws_vpc.old'])
  })
  it('reports when nothing matches', () => {
    expect(pure(NET(), (x) => stateRemove(x, ['aws_vpc.gone', 'aws_instance.web[7]', 'nonsense']))).toEqual(fail('No matching objects found.', ''))
  })
})

describe('taint / untaint', () => {
  it('taints, idempotently, bumping serial each time', () => {
    const r = pure(NET(), (x) => taintInstance(x, 'aws_instance.web[0]'))
    if (!r.ok) throw new Error(r.summary)
    expect(findInstance(r.state, 'aws_instance.web[0]')!.instance.status).toBe('tainted')
    expect(r.state.serial).toBe(8)
    const again = pure(r.state, (x) => taintInstance(x, 'aws_instance.web[0]'))
    if (!again.ok) throw new Error(again.summary)
    expect(findInstance(again.state, 'aws_instance.web[0]')!.instance.status).toBe('tainted')
    expect(again.state.serial).toBe(9)
  })
  it('refuses unknown instances and data sources', () => {
    expect(pure(NET(), (x) => taintInstance(x, 'aws_instance.web'))).toEqual(fail('No such resource instance', 'There is no resource instance with the address aws_instance.web in the current state.'))
    expect(pure(NET(), (x) => taintInstance(x, 'data.aws_ami.img'))).toEqual(fail('Invalid resource address', 'Data sources cannot be tainted.'))
    expect(pure(NET(), (x) => untaintInstance(x, 'aws_vpc.gone'))).toEqual(fail('No such resource instance', 'There is no resource instance with the address aws_vpc.gone in the current state.'))
  })
  it('untaints, removing status', () => {
    const s = stateOf({ type: 'aws_vpc', name: 'v', attrs: { id: 'vpc-1' }, tainted: true })
    const r = pure(s, (x) => untaintInstance(x, 'aws_vpc.v'))
    if (!r.ok) throw new Error(r.summary)
    expect(r.state.resources[0].instances[0]).toEqual({ attributes: { id: 'vpc-1' } })
    expect(r.state.serial).toBe(8)
  })
  it('refuses to untaint a healthy instance', () => {
    expect(pure(NET(), (x) => untaintInstance(x, 'aws_vpc.old'))).toEqual(fail('Resource instance is not tainted', 'Resource instance aws_vpc.old is not tainted.'))
  })
})

describe('importObject', () => {
  const reality = (): Reality => ({ [realityKey('aws_s3_bucket', 'logs')]: { id: 'logs', bucket: 'logs', tags: { team: 'ops' } } })
  it('imports a copy of the remote object into a new resource', () => {
    const real = reality()
    const r = pure(NET(), (x) => importObject(x, real, 'aws_s3_bucket.logs', 'logs', true))
    if (!r.ok) throw new Error(r.summary)
    expect(r.state.serial).toBe(8)
    const got = findInstance(r.state, 'aws_s3_bucket.logs')!
    expect(got.resource.provider).toBe(AWS)
    expect(got.instance).toEqual({ attributes: { id: 'logs', bucket: 'logs', tags: { team: 'ops' } } })
    ;(got.instance.attributes.tags as Record<string, Value>).team = 'changed'
    expect(real).toEqual(reality())
  })
  it('imports a keyed instance into an existing resource', () => {
    const r = pure(NET(), (x) => importObject(x, reality(), 'aws_s3_bucket.b["logs"]', 'logs', true))
    if (!r.ok) throw new Error(r.summary)
    expect(r.state.resources.filter((x) => x.name === 'b')).toHaveLength(1)
    expect(findInstance(r.state, 'aws_s3_bucket.b["logs"]')!.instance.attributes.id).toBe('logs')
  })
  it('refuses undeclared, already-managed, missing and data addresses', () => {
    expect(pure(NET(), (x) => importObject(x, reality(), 'aws_s3_bucket.logs[0]', 'logs', false))).toEqual(
      fail(
        'Resource address "aws_s3_bucket.logs" does not exist in the configuration.',
        'Before importing this resource, please create its configuration in the root module. For example:\n\nresource "aws_s3_bucket" "logs" {\n  # (resource arguments)\n}',
      ),
    )
    expect(pure(NET(), (x) => importObject(x, reality(), 'aws_vpc.old', 'logs', true))).toEqual(
      fail(
        'Resource already managed by Terraform',
        'Terraform is already managing a remote object for aws_vpc.old. To import to this address you must first remove the existing object from the state.',
      ),
    )
    expect(pure(NET(), (x) => importObject(x, reality(), 'aws_s3_bucket.logs', 'nope', true))).toEqual(
      fail(
        'Cannot import non-existent remote object',
        'While attempting to import an existing object to "aws_s3_bucket.logs", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider\'s configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.',
      ),
    )
    expect(pure(NET(), (x) => importObject(x, reality(), 'data.aws_ami.other', 'ami-1', true))).toEqual(fail('Invalid resource address', 'Data sources cannot be imported.'))
  })
})
