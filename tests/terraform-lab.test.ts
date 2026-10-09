import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { ScenarioSchema, type TerraformBlock } from '../src/schema/scenario.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import { realityKey } from '../src/game/terraform/refresh.ts'
import { listAddresses } from '../src/game/terraform/state.ts'

const base = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@'))!
const withTf = (tf: unknown) => ScenarioSchema.safeParse({ ...structuredClone(base), terraform: tf })
const issues = (tf: unknown) => {
  const r = withTf(tf)
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}
const VPC = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', cidr_block: '10.0.0.0/16' } }
const FILE = { path: 'main.tf', content: 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n' }

describe('the terraform block in the scenario schema', () => {
  it('accepts a minimal block and a full one', () => {
    expect(issues({ files: [FILE] })).toEqual([])
    expect(
      issues({
        dir: '~/infra',
        version: '1.9.8',
        initialized: false,
        files: [FILE],
        vars: { region: 'us-east-1' },
        state: [VPC, { mode: 'data', type: 'aws_ami', name: 'x', attrs: { id: 'ami-1' } }],
        outputs: { id: { value: 'vpc-1' } },
        cloud: { patch: [{ type: 'aws_vpc', id: 'vpc-1', set: { tags: { Owner: 'ops' } } }], add: [{ type: 'aws_s3_bucket', attrs: { id: 'legacy', bucket: 'legacy' } }] },
        evidence: [{ evidence: 'plan-forces', command: 'plan', contains: 'forces replacement' }],
      }),
    ).toEqual([])
  })

  it('rejects unknown fields, an unsafe file path and an empty file list', () => {
    expect(issues({ files: [FILE], bogus: 1 })).not.toEqual([])
    expect(issues({ files: [{ path: '/etc/main.tf', content: '' }] }).join()).toMatch(/relative/)
    expect(issues({ files: [{ path: '../main.tf', content: '' }] }).join()).toMatch(/relative/)
    expect(issues({ files: [] })).not.toEqual([])
  })

  it('checks state, cloud and evidence across fields', () => {
    expect(issues({ files: [FILE], state: [{ type: 'aws_nope', name: 'x', attrs: { id: 'x' } }] }).join()).toMatch(/aws_nope/)
    expect(issues({ files: [FILE], state: [{ type: 'aws_vpc', name: 'main', attrs: { cidr_block: 'x' } }] }).join()).toMatch(/id/)
    expect(issues({ files: [FILE], state: [VPC, VPC] }).join()).toMatch(/duplicate/)
    expect(issues({ files: [FILE], state: [VPC], cloud: { delete: [{ type: 'aws_vpc', id: 'vpc-9' }] } }).join()).toMatch(/vpc-9/)
    expect(issues({ files: [FILE], cloud: { add: [{ type: 'aws_s3_bucket', attrs: { bucket: 'x' } }] } }).join()).toMatch(/id/)
    expect(issues({ files: [FILE], evidence: [{ evidence: 'a', command: 'plan', contains: 'x' }, { evidence: 'a', command: 'show', contains: 'y' }] }).join()).toMatch(/duplicate/)
  })

  it('validates faults', () => {
    const act = base.actions[0].id
    const f = { at: 'aws_s3_bucket.b', on: 'create', error: 'AccessDenied', times: 1, if: { attr: 'bucket', equals: 'x' }, until_actions: [act] }
    const bad = (o: object) => issues({ files: [FILE], faults: [{ ...f, ...o }] })
    expect(issues({ files: [FILE], faults: [f, { at: 'aws_s3_bucket.b["k"]', on: 'delete', error: 'e' }] })).toEqual([])
    expect(bad({ at: 'Bad' })).not.toEqual([])
    expect(bad({ on: 'read' })).not.toEqual([])
    expect(bad({ times: 0 })).not.toEqual([])
    expect(bad({ error: '' })).not.toEqual([])
    expect(bad({ until_actions: ['nope'] }).join()).toMatch(/unknown action "nope"/)
    expect(bad({ extra: 1 })).not.toEqual([])
    expect(bad({ if: { attr: 'bucket', matches: '^x-[0-9]+$' } })).toEqual([])
    expect(bad({ if: { attr: 'bucket', matches: '(' } }).join()).toMatch(/terraform\.faults\.0\.if\.matches: invalid regex/)
    expect(bad({ if: { attr: 'bucket', equals: 'x', matches: 'x' } })).not.toEqual([])
    expect(bad({ if: { attr: 'bucket', matches: '' } })).not.toEqual([])
  })

  it('needs a terminal', () => {
    const r = ScenarioSchema.safeParse({ ...structuredClone(base), terminal: undefined, terraform: { files: [FILE] } })
    expect(r.success).toBe(false)
  })
})

describe('labFromScenario', () => {
  const tf = (o: Partial<TerraformBlock> = {}): TerraformBlock => ({ files: [FILE], ...o }) as TerraformBlock

  it('resolves the directory and puts files under it', () => {
    const lab = labFromScenario(tf({ dir: '~/infra' }), '/home/you/work', '/home/you')
    expect(lab.dir).toBe('/home/you/infra')
    expect(lab.files).toEqual([{ path: '/home/you/infra/main.tf', content: FILE.content }])
    expect(labFromScenario(tf(), '/home/you/work', '/home/you').dir).toBe('/home/you/work')
    expect(labFromScenario(tf({ dir: '/srv/tf' }), '/home/you/work', '/home/you').dir).toBe('/srv/tf')
    expect(labFromScenario(tf({ dir: 'sub' }), '/home/you/work', '/home/you').dir).toBe('/home/you/work/sub')
  })

  it('has sensible defaults', () => {
    const lab = labFromScenario(tf(), '/w', '/h')
    expect(lab).toMatchObject({ version: '1.9.8', initialized: true, hasState: false, vars: {} })
    expect(lab.state.resources).toEqual([])
    expect(labFromScenario(tf({ initialized: false, version: '1.5.7', state: [] }), '/w', '/h')).toMatchObject({ initialized: false, version: '1.5.7', hasState: true })
  })

  it('builds state with providers, keys, taint and data sources', () => {
    const lab = labFromScenario(
      tf({
        state: [
          VPC,
          { type: 'aws_s3_bucket', name: 'b', key: 'a', attrs: { id: 'b-a', bucket: 'b-a' } },
          { type: 'aws_s3_bucket', name: 'b', key: 'b', status: 'tainted', attrs: { id: 'b-b', bucket: 'b-b' } },
          { mode: 'data', type: 'aws_ami', name: 'x', attrs: { id: 'ami-1' } },
        ],
        outputs: { id: { value: 'vpc-1' }, secret: { value: 'x', sensitive: true } },
      }),
      '/w',
      '/h',
    )
    expect(listAddresses(lab.state)).toEqual(['aws_s3_bucket.b["a"]', 'aws_s3_bucket.b["b"]', 'aws_vpc.main', 'data.aws_ami.x'])
    expect(lab.state.resources[0].provider).toBe('provider["registry.terraform.io/hashicorp/aws"]')
    expect(lab.state.resources.find((r) => r.name === 'b')!.instances[1].status).toBe('tainted')
    expect(lab.state.outputs).toEqual({ id: { value: 'vpc-1' }, secret: { value: 'x', sensitive: true } })
    expect(lab.state).toMatchObject({ version: 4, serial: 12, terraform_version: '1.9.8' })
  })

  it('makes the cloud match state, then applies patch, delete and add', () => {
    const plain = labFromScenario(tf({ state: [VPC] }), '/w', '/h')
    expect(plain.reality).toEqual({ [realityKey('aws_vpc', 'vpc-1')]: { id: 'vpc-1', cidr_block: '10.0.0.0/16' } })
    const lab = labFromScenario(
      tf({
        state: [VPC, { type: 'aws_subnet', name: 's', attrs: { id: 'subnet-1', vpc_id: 'vpc-1' } }],
        cloud: {
          patch: [{ type: 'aws_vpc', id: 'vpc-1', set: { tags: { Owner: 'ops' } } }],
          delete: [{ type: 'aws_subnet', id: 'subnet-1' }],
          add: [{ type: 'aws_s3_bucket', attrs: { id: 'legacy', bucket: 'legacy' } }],
        },
      }),
      '/w',
      '/h',
    )
    expect(lab.reality).toEqual({
      [realityKey('aws_vpc', 'vpc-1')]: { id: 'vpc-1', cidr_block: '10.0.0.0/16', tags: { Owner: 'ops' } },
      [realityKey('aws_s3_bucket', 'legacy')]: { id: 'legacy', bucket: 'legacy' },
    })
    expect(lab.state.resources.map((r) => r.name)).toEqual(['main', 's'])
  })

  it('applies add first, so a patch or delete can aim at an added object', () => {
    const lab = labFromScenario(
      tf({
        state: [VPC],
        cloud: {
          add: [{ type: 'aws_s3_bucket', attrs: { id: 'legacy', bucket: 'legacy' } }, { type: 'aws_s3_bucket', attrs: { id: 'gone', bucket: 'gone' } }],
          patch: [{ type: 'aws_s3_bucket', id: 'legacy', set: { acl: 'private' } }],
          delete: [{ type: 'aws_s3_bucket', id: 'gone' }],
        },
      }),
      '/w',
      '/h',
    )
    expect(lab.reality[realityKey('aws_s3_bucket', 'legacy')]).toEqual({ id: 'legacy', bucket: 'legacy', acl: 'private' })
    expect(Object.keys(lab.reality)).not.toContain(realityKey('aws_s3_bucket', 'gone'))
  })

  it('copies faults and starts attempts and savedPlans empty', () => {
    const faults = [{ at: 'aws_vpc.main', on: 'create' as const, error: 'boom' }]
    const lab = labFromScenario(tf({ faults }), '/w', '/h')
    expect(lab.faults).toEqual(faults)
    expect(lab.faults).not.toBe(faults)
    expect(lab.faults[0]).not.toBe(faults[0])
    expect(lab.attempts.size).toBe(0)
    expect(lab.savedPlans.size).toBe(0)
  })

  it('does not alias the scenario data', () => {
    const block = tf({ state: [VPC] })
    const lab = labFromScenario(block, '/w', '/h')
    ;(lab.state.resources[0].instances[0].attributes as Record<string, unknown>).cidr_block = 'changed'
    expect(block.state![0].attrs.cidr_block).toBe('10.0.0.0/16')
  })
})

describe('labFromScenario: dependencies', () => {
  it('derives dependencies from ids found in attributes', () => {
    const lab = labFromScenario(
      { files: [FILE], state: [VPC, { type: 'aws_subnet', name: 's', attrs: { id: 'subnet-1', vpc_id: 'vpc-1', nested: { ids: ['x', 'subnet-9'] } } }, { type: 'aws_instance', name: 'i', attrs: { id: 'i-1', subnet_id: 'subnet-1', vpc_ids: [{ v: 'vpc-1' }] } }] } as TerraformBlock,
      '/w',
      '/h',
    )
    const deps = Object.fromEntries(lab.state.resources.map((r) => [`${r.type}.${r.name}`, r.instances[0].dependencies]))
    expect(deps).toEqual({ 'aws_vpc.main': undefined, 'aws_subnet.s': ['aws_vpc.main'], 'aws_instance.i': ['aws_subnet.s', 'aws_vpc.main'] })
  })
})

describe('lock, workspace, workspaces', () => {
  const LOCK = { id: 'abc-1', who: 'ci@runner', created: '2026-10-08 09:00:00 UTC' }
  const WS = { dev: { state: [VPC] }, prod: { state: [{ ...VPC, attrs: { id: 'vpc-9', cidr_block: '10.9.0.0/16' } }] } }
  const bad = (extra: object) => issues({ files: [FILE], ...extra })

  it('accepts a valid fixture', () => {
    expect(bad({ lock: { ...LOCK, operation: 'OperationTypePlan', path: 's.tfstate', info: 'x', message: 'm' }, workspace: 'dev', workspaces: WS })).toEqual([])
  })

  it('rejects bad locks, workspaces and workspace states', () => {
    for (const k of ['id', 'who', 'created']) expect(bad({ lock: { ...LOCK, [k]: undefined } })).not.toEqual([])
    expect(bad({ lock: { ...LOCK, extra: 1 } })).not.toEqual([])
    expect(bad({ workspace: 'a b' })).not.toEqual([])
    expect(bad({ workspace: 'prod' }).join()).toMatch(/terraform\.workspace:/)
    expect(bad({ workspace: 'prod', workspaces: { dev: {} } })).not.toEqual([])
    expect(bad({ workspaces: { default: {} } })).not.toEqual([])
    expect(bad({ workspaces: { dev: { state: [{ ...VPC, attrs: { id: 5 } }] } } }).join()).toMatch(/terraform\.workspaces\.dev\.state\.0\.attrs: needs a string id/)
    expect(bad({ workspaces: { dev: { state: [VPC, VPC] } } }).join()).toMatch(/terraform\.workspaces\.dev\.state\.1: duplicate/)
    expect(bad({ workspaces: { dev: { extra: 1 } } })).not.toEqual([])
  })

  it('accepts the new evidence commands', () => {
    const evidence = ['apply', 'destroy', 'import', 'taint', 'untaint', 'refresh', 'force-unlock', 'state mv', 'state rm', 'workspace new', 'workspace select', 'workspace delete'].map((command, i) => ({ evidence: `e${i}`, command, contains: 'x' }))
    expect(bad({ evidence })).toEqual([])
  })

  it('lab: defaults without the new fields', () => {
    const lab = labFromScenario({ files: [FILE], state: [VPC] } as TerraformBlock, '/w', '/h')
    expect(lab.workspace).toBe('default')
    expect(lab.workspaces.size).toBe(0)
    expect(lab.lock).toBeUndefined()
  })

  it('lab: fills lock defaults', () => {
    const lab = labFromScenario({ files: [FILE], lock: LOCK } as TerraformBlock, '/w', '/h')
    expect(lab.lock).toEqual({ ...LOCK, operation: 'OperationTypeApply', path: 'terraform.tfstate', info: '', message: 'resource temporarily unavailable' })
  })

  it('lab: current workspace is in lab.state, the rest in the map', () => {
    const lab = labFromScenario({ files: [FILE], state: [VPC], workspace: 'dev', workspaces: WS } as TerraformBlock, '/w', '/h')
    expect(lab.workspace).toBe('dev')
    expect(lab.state.lineage).toBe('00000000-0000-4000-8000-000000000002')
    expect(listAddresses(lab.state)).toEqual(['aws_vpc.main'])
    expect([...lab.workspaces.keys()].sort()).toEqual(['default', 'prod'])
    expect(lab.workspaces.get('default')!.state.lineage).toBe('00000000-0000-4000-8000-000000000001')
    expect(lab.workspaces.get('prod')!.state.lineage).toBe('00000000-0000-4000-8000-000000000003')
    expect(lab.workspaces.get('prod')!.state.serial).toBe(12)
    expect(lab.workspaces.get('prod')!.hasState).toBe(true)
  })

  it('lab: reality is the union of every workspace, then cloud edits apply', () => {
    const lab = labFromScenario(
      { files: [FILE], state: [VPC], workspace: 'dev', workspaces: WS, cloud: { patch: [{ type: 'aws_vpc', id: 'vpc-9', set: { cidr_block: '1.1.1.1/32' } }], delete: [{ type: 'aws_vpc', id: 'vpc-1' }], add: [{ type: 'aws_s3_bucket', attrs: { id: 'b' } }] } } as TerraformBlock,
      '/w',
      '/h',
    )
    expect(Object.keys(lab.reality).sort()).toEqual([realityKey('aws_s3_bucket', 'b'), realityKey('aws_vpc', 'vpc-9')].sort())
    expect(lab.reality[realityKey('aws_vpc', 'vpc-9')]!.cidr_block).toBe('1.1.1.1/32')
    const all = labFromScenario({ files: [FILE], state: [VPC], workspaces: WS } as TerraformBlock, '/w', '/h')
    expect(Object.keys(all.reality)).toEqual([realityKey('aws_vpc', 'vpc-1'), realityKey('aws_vpc', 'vpc-9')])
  })

  it('schema: cloud patch/delete may target an object that exists only in a non-default workspace', () => {
    expect(bad({ state: [VPC], workspaces: WS, cloud: { patch: [{ type: 'aws_vpc', id: 'vpc-9', set: { a: 1 } }], delete: [{ type: 'aws_vpc', id: 'vpc-9' }] } })).toEqual([])
    expect(bad({ state: [VPC], workspaces: WS, cloud: { patch: [{ type: 'aws_vpc', id: 'vpc-nope', set: {} }] } }).join()).toMatch(/no object with id "vpc-nope"/)
  })

  it('lab: __proto__ is just a workspace name', () => {
    // zod silently drops a __proto__ record key (never a prototype write): the key is accepted but gone, so selecting it as the workspace is rejected...
    expect(bad({ workspaces: { ['__proto__']: { state: [VPC] } } })).toEqual([])
    expect(bad({ workspace: '__proto__' }).join()).toMatch(/not a key/)
    // ...and a hand-built block still works through the lab.
    const lab = labFromScenario({ files: [FILE], workspace: '__proto__', workspaces: Object.fromEntries([['__proto__', { state: [VPC] }]]) } as TerraformBlock, '/w', '/h')
    expect(lab.workspace).toBe('__proto__')
    expect(lab.workspaces.has('default')).toBe(true)
  })
})

describe('done_when in the scenario schema', () => {
  const staged = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.stages && s.terminal)!
  const tf = { files: [FILE], state: [VPC] }
  // terraform: null means no terraform block
  const dw = (p: unknown, terraform: unknown = tf) => {
    const s = structuredClone(base)
    s.actions[0] = { ...s.actions[0], done_when: p } as (typeof s.actions)[number]
    const r = ScenarioSchema.safeParse({ ...s, terraform: terraform ?? undefined })
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
  }

  it('accepts one action per leaf and an all with a not', () => {
    const leaves = [
      { plan_clean: true },
      { plan_has: { no_destroy: ['aws_vpc.main', 'aws_s3_bucket.b["x"]', 'aws_instance.web[0]'] } },
      { state_has: 'aws_vpc.main' },
      { state_lacks: 'data.aws_ami.x' },
      { lock_free: true },
      { reality_has: { type: 'aws_vpc', id: 'vpc-1', attr: 'cidr_block', equals: '10.0.0.0/16' } },
      { reality_has: { type: 'aws_s3_bucket', id: 'b' } },
      { reality_lacks: { type: 'aws_vpc', id: 'vpc-2' } },
      { applied: { op: 'import', address: 'aws_vpc.main' } },
      { file_contains: { path: '/home/ops/infra/main.tf', matches: '^\\s*prevent_destroy\\s*=\\s*true' } },
      { not: { state_has: 'aws_vpc.old' } },
      { all: [{ plan_clean: true }, { not: { lock_free: true } }] },
      { any: [{ state_has: 'aws_vpc.main' }, { applied: { op: 'forget', address: 'aws_vpc.main' } }] },
    ]
    for (const p of leaves) expect(dw(p), JSON.stringify(p)).toEqual([])
  })

  it('needs a terraform block, at the top level and in stages', () => {
    expect(dw({ plan_clean: true }, null)).toEqual(['actions.0.done_when: done_when needs a terraform block'])
    const s = structuredClone(staged)
    s.stages![0].actions[0] = { ...s.stages![0].actions[0], done_when: { plan_clean: true } } as (typeof s.actions)[number]
    const r = ScenarioSchema.safeParse(s)
    expect(r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual(['stages.0.actions.0.done_when: done_when needs a terraform block'])
  })

  it('rejects malformed predicates', () => {
    expect(dw({ plan_clear: true })).not.toEqual([])
    expect(dw({ plan_clean: true, lock_free: true })).not.toEqual([])
    expect(dw({ plan_clean: false })).not.toEqual([])
    expect(dw({ all: [] })).not.toEqual([])
    expect(dw({ all: [{ all: [{ plan_clean: true }] }] })).not.toEqual([])
    expect(dw({ not: { not: { plan_clean: true } } })).not.toEqual([])
    expect(dw({ applied: { op: 'read', address: 'aws_vpc.main' } })).not.toEqual([])
    expect(dw({ reality_lacks: { type: 'aws_vpc', id: '' } })).not.toEqual([])
    expect(dw({ file_contains: { path: 'main.tf', matches: 'x' } }).join()).toMatch(/absolute/)
  })

  it('checks addresses, reality types and regexes, with paths at done_when', () => {
    expect(dw({ state_has: 'Bad' })).toEqual(['actions.0.done_when.state_has: must be a resource or instance address like aws_s3_bucket.b, aws_s3_bucket.b["x"], module.net.aws_x.y, module.net["a"].aws_x.y or a bare module.net'])
    expect(dw({ all: [{ applied: { op: 'create', address: 'aws_vpc' } }] }).join()).toMatch(/^actions\.0\.done_when\.all\.0\.applied\.address: must be a resource/)
    expect(dw({ plan_has: { no_destroy: ['aws_vpc.main', 'nope'] } }).join()).toMatch(/^actions\.0\.done_when\.plan_has\.no_destroy\.1: /)
    expect(dw({ reality_has: { type: 'aws_nope', id: 'x' } })).toEqual(['actions.0.done_when.reality_has.type: "aws_nope" is not a resource type the Terraform lab models'])
    expect(dw({ any: [{ not: { reality_lacks: { type: 'aws_nope', id: 'x' } } }] })).toEqual([
      'actions.0.done_when.any.0.not.reality_lacks.type: "aws_nope" is not a resource type the Terraform lab models',
    ])
    expect(dw({ file_contains: { path: '/x/main.tf', matches: '(' } }).join()).toMatch(/^actions\.0\.done_when\.file_contains\.matches: invalid regex/)
  })
})
