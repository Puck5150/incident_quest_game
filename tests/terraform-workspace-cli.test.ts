import { describe, expect, it } from 'vitest'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import type { TerraformBlock } from '../src/schema/scenario.ts'

const DIR = '/home/you/infra'
const VPC_TF = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const BUCKET_TF = 'resource "aws_s3_bucket" "b" {\n  bucket = "legacy"\n}\n'
const VPC = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1', tags_all: {} } }
const BUCKET = { type: 'aws_s3_bucket', name: 'b', attrs: { id: 'legacy', arn: 'arn:legacy', bucket: 'legacy', force_destroy: false, bucket_domain_name: 'legacy.s3', tags_all: {} } }
const VPC9 = { ...VPC, attrs: { ...VPC.attrs, id: 'vpc-9', arn: 'arn:vpc-9' } }
const LOCK = { id: '9db590f1-b6fe-c5f2-2678-8804f089deba', who: 'ci@runner-7', created: '2026-10-08 09:14:02.123456789 +0000 UTC' }
// default (current) tracks the VPC and bucket; dev tracks another VPC; prod has no state file.
const WS = { dev: { state: [VPC9] }, prod: {} }

// The CliContext harness from terraform-lock-cli.test.ts, with three workspaces by default.
function world(tf: Partial<TerraformBlock> = {}, o: { cwd?: string; main?: string } = {}) {
  const lab = labFromScenario({ files: [{ path: 'main.tf', content: o.main ?? VPC_TF + BUCKET_TF }], state: [VPC, BUCKET], workspaces: WS, ...tf } as TerraformBlock, DIR, '/home/you')
  const disk: Record<string, string> = {}
  for (const f of lab.files) disk[f.path] = f.content
  disk[`${DIR}/.terraform.lock.hcl`] = LOCK_FILE
  const ctx: CliContext = {
    lab,
    cwd: o.cwd ?? DIR,
    mainHost: true,
    env: {},
    taken: new Set(),
    listFiles: async (dir) => Object.entries(disk).filter(([p]) => p.slice(0, p.lastIndexOf('/')) === dir).map(([p, text]) => ({ name: p.slice(p.lastIndexOf('/') + 1), text })),
    readFile: async (p) => disk[p],
    write: async (dir, name, text) => void (disk[`${dir}/${name}`] = text),
  }
  return { ctx, lab, disk, run: (...args: string[]) => runTerraform(args, ctx) }
}

const NEW = (name: string) =>
  `Created and switched to workspace "${name}"!\n\nYou're now on a new, empty workspace. Workspaces isolate their state,\nso if you run "terraform plan" Terraform will not see any existing state\nfor this configuration.`
const snapshot = (w: ReturnType<typeof world>) =>
  JSON.stringify({ ws: w.lab.workspace, all: [...w.lab.workspaces], state: w.lab.state, has: w.lab.hasState, reality: w.lab.reality, n: w.lab.workspacesCreated, disk: w.disk })

describe('terraform workspace show and list', () => {
  it('lists every workspace alphabetically with the current one starred', async () => {
    const w = world()
    expect((await w.run('workspace', 'show')).stdout).toBe('default')
    expect((await w.run('workspace', 'list')).stdout).toBe('* default\n  dev\n  prod\n')
    await w.run('workspace', 'select', 'dev')
    expect((await w.run('workspace', 'show')).stdout).toBe('dev')
    expect((await w.run('workspace', 'list')).stdout).toBe('  default\n* dev\n  prod\n')
  })

  it('keeps the single-workspace output', async () => {
    const w = world({ workspaces: undefined })
    expect((await w.run('workspace', 'list')).stdout).toBe('* default\n')
  })
})

describe('terraform workspace new', () => {
  it('creates an empty workspace and switches to it', async () => {
    const w = world()
    const r = await w.run('workspace', 'new', 'stage')
    expect(r).toMatchObject({ stdout: NEW('stage'), stderr: '', exitCode: 0 })
    expect(w.lab.workspace).toBe('stage')
    expect(w.lab.hasState).toBe(false)
    expect(w.lab.state).toMatchObject({ serial: 0, lineage: '00000000-0000-4000-8000-000000000010', terraform_version: '1.9.8', resources: [] })
    expect([...w.lab.workspaces.keys()].sort()).toEqual(['default', 'dev', 'prod'])
    expect((await w.run('workspace', 'list')).stdout).toBe('  default\n  dev\n  prod\n* stage\n')
    const list = await w.run('state', 'list')
    expect(list.exitCode).toBe(1)
    expect(list.stderr).toContain('No state file was found!')
    await w.run('workspace', 'new', 'qa')
    expect(w.lab.state.lineage).toBe('00000000-0000-4000-8000-000000000011')
  })

  it('does not reuse a lineage after a delete', async () => {
    const w = world()
    await w.run('workspace', 'new', 'a')
    await w.run('workspace', 'select', 'default')
    await w.run('workspace', 'delete', 'a')
    await w.run('workspace', 'new', 'a')
    expect(w.lab.state.lineage).toBe('00000000-0000-4000-8000-000000000011')
  })

  it('plans creates for everything and collides with the shared cloud on apply', async () => {
    const w = world()
    const reality = JSON.stringify(w.lab.reality)
    await w.run('workspace', 'new', 'stage')
    expect(JSON.stringify(w.lab.reality)).toBe(reality)
    const plan = await w.run('plan')
    expect(plan.stdout).toContain('# aws_vpc.main will be created')
    expect(plan.stdout).toContain('# aws_s3_bucket.b will be created')
    expect(plan.stdout).toContain('Plan: 2 to add, 0 to change, 0 to destroy.')
    const apply = await w.run('apply', '-auto-approve')
    expect(apply.exitCode).toBe(1)
    expect(apply.stderr).toContain('BucketAlreadyOwnedByYou')
  })

  it('refuses an existing name and an invalid one', async () => {
    const w = world()
    const before = snapshot(w)
    for (const name of ['dev', 'default']) expect(await w.run('workspace', 'new', name)).toMatchObject({ stdout: '', stderr: `Workspace "${name}" already exists`, exitCode: 1 })
    const bad = await w.run('workspace', 'new', 'a/b')
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toBe(
      '╷\n│ Error: Invalid workspace name\n│ \n│ The workspace name "a/b" is not allowed. The name must contain only URL safe\n│ characters, and no path separators.\n╵',
    )
    expect((await w.run('workspace', 'new')).stderr).toBe('Expected a single argument: NAME.')
    expect(snapshot(w)).toBe(before)
  })

  it('handles a __proto__ workspace name as an ordinary name', async () => {
    const w = world()
    expect((await w.run('workspace', 'new', '__proto__')).exitCode).toBe(0)
    await w.run('workspace', 'select', 'default')
    expect((await w.run('workspace', 'list')).stdout).toBe('  __proto__\n* default\n  dev\n  prod\n')
    expect((await w.run('workspace', 'delete', '__proto__')).stdout).toBe('Deleted workspace "__proto__"!')
  })

  it('is locked; -lock=false skips the lock', async () => {
    const w = world({ lock: LOCK })
    const r = await w.run('workspace', 'new', 'stage')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Error: Error acquiring the state lock')
    expect(w.lab.workspace).toBe('default')
    expect((await w.run('workspace', 'new', '-lock=false', 'stage')).stdout).toBe(NEW('stage'))
  })
})

describe('terraform workspace select', () => {
  it('swaps states and preserves each', async () => {
    const w = world()
    const defaultState = w.lab.state
    expect(await w.run('workspace', 'select', 'dev')).toMatchObject({ stdout: 'Switched to workspace "dev".', exitCode: 0 })
    expect((await w.run('state', 'list')).stdout).toBe('aws_vpc.main')
    expect(w.lab.state.lineage).toBe('00000000-0000-4000-8000-000000000002')
    await w.run('taint', 'aws_vpc.main')
    const devState = w.lab.state
    await w.run('workspace', 'select', 'default')
    expect(w.lab.state).toBe(defaultState)
    expect((await w.run('state', 'list')).stdout).toBe('aws_s3_bucket.b\naws_vpc.main')
    await w.run('workspace', 'select', 'dev')
    expect(w.lab.state).toBe(devState)
    expect(w.lab.workspaces.get('default')!.state).toBe(defaultState)
  })

  it('selecting the current workspace still succeeds', async () => {
    const w = world()
    const before = snapshot(w)
    expect((await w.run('workspace', 'select', 'default')).stdout).toBe('Switched to workspace "default".')
    expect(snapshot(w)).toBe(before)
  })

  it('a workspace without a state file has no state', async () => {
    const w = world()
    await w.run('workspace', 'select', 'prod')
    expect((await w.run('state', 'list')).stderr).toContain('No state file was found!')
  })

  it('refuses an unknown workspace, or creates it with -or-create', async () => {
    const w = world()
    const before = snapshot(w)
    expect(await w.run('workspace', 'select', 'stage')).toMatchObject({
      stdout: '',
      stderr: 'Workspace "stage" doesn\'t exist.\n\nYou can create this workspace with the "new" subcommand \nor include the "-or-create" flag with the "select" subcommand.',
      exitCode: 1,
    })
    expect(snapshot(w)).toBe(before)
    expect((await w.run('workspace', 'select', '-or-create', 'stage')).stdout).toBe(NEW('stage'))
    expect(w.lab.workspace).toBe('stage')
    expect((await w.run('workspace', 'select', '-or-create', 'dev')).stdout).toBe('Switched to workspace "dev".')
  })

  it('is never locked', async () => {
    const w = world({ lock: LOCK })
    expect((await w.run('workspace', 'select', 'dev')).exitCode).toBe(0)
    expect((await w.run('workspace', 'list')).exitCode).toBe(0)
    expect((await w.run('workspace', 'show')).exitCode).toBe(0)
  })
})

describe('terraform.workspace', () => {
  it('evaluates to the current workspace name in plan and apply', async () => {
    const main = 'resource "aws_s3_bucket" "logs" {\n  bucket = "logs-${terraform.workspace}"\n}\n'
    const w = world({ state: undefined, workspaces: { dev: {} } }, { main })
    expect((await w.run('plan')).stdout).toContain('"logs-default"')
    await w.run('workspace', 'select', 'dev')
    const plan = await w.run('plan')
    expect(plan.stdout).toContain('"logs-dev"')
    expect(plan.stdout).not.toContain('logs-default')
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
    expect(w.lab.state.resources[0].instances[0].attributes.bucket).toBe('logs-dev')
  })
})

describe('terraform workspace delete', () => {
  const box = (summary: string, ...detail: string[]) => ['╷', `│ Error: ${summary}`, '│ ', ...detail.map((l) => (l ? `│ ${l}` : '│ ')), '╵'].join('\n')

  it('refuses the active workspace and default', async () => {
    const w = world()
    const before = snapshot(w)
    expect((await w.run('workspace', 'delete', 'default')).stderr).toBe(
      box('Workspace is your active workspace', 'You cannot delete the currently active workspace. Please switch to another', 'workspace and try again.'),
    )
    await w.run('workspace', 'select', 'prod')
    const r = await w.run('workspace', 'delete', 'default')
    expect(r).toMatchObject({ stdout: '', stderr: box('Failed to delete workspace', "Can't delete default workspace"), exitCode: 1 })
    await w.run('workspace', 'select', 'default')
    expect(snapshot(w)).toBe(before)
  })

  it('refuses an unknown workspace', async () => {
    expect(await world().run('workspace', 'delete', 'stage')).toMatchObject({ stdout: '', stderr: 'Workspace "stage" doesn\'t exist.', exitCode: 1 })
  })

  it('refuses a non-empty workspace without -force', async () => {
    const w = world()
    await w.run('workspace', 'select', 'dev')
    await w.run('workspace', 'select', 'default')
    const before = snapshot(w)
    const r = await w.run('workspace', 'delete', 'dev')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toBe(
      box(
        'Workspace is not empty',
        'Workspace "dev" is currently tracking the following resource instances:',
        '  - aws_vpc.main',
        '',
        'Deleting this workspace would cause Terraform to lose track of any',
        'associated remote objects, which would then require you to delete them',
        'manually outside of Terraform. You should destroy these objects with',
        'Terraform before deleting the workspace.',
        '',
        'If you want to delete this workspace anyway, and have destroyed these',
        'objects, use the -force option.',
      ),
    )
    expect(snapshot(w)).toBe(before)
    expect((await w.run('workspace', 'delete', '-force=false', 'dev')).exitCode).toBe(1)
    expect(await w.run('workspace', 'delete', '-force', 'dev')).toMatchObject({ stdout: 'Deleted workspace "dev"!', stderr: '', exitCode: 0 })
    expect((await w.run('workspace', 'list')).stdout).toBe('* default\n  prod\n')
    // The cloud objects remain.
    expect(Object.keys(w.lab.reality).some((k) => k.includes('vpc-9'))).toBe(true)
  })

  it('deletes an empty workspace', async () => {
    const w = world()
    expect((await w.run('workspace', 'delete', 'prod')).stdout).toBe('Deleted workspace "prod"!')
    expect([...w.lab.workspaces.keys()]).toEqual(['dev'])
  })

  it('is locked after the name checks; -lock=false skips the lock', async () => {
    const w = world({ lock: LOCK })
    expect((await w.run('workspace', 'delete', 'stage')).stderr).toBe('Workspace "stage" doesn\'t exist.')
    expect((await w.run('workspace', 'delete', 'prod')).stderr).toContain('Error: Error acquiring the state lock')
    expect(w.lab.workspaces.has('prod')).toBe(true)
    expect((await w.run('workspace', 'delete', '-lock=false', 'prod')).exitCode).toBe(0)
  })
})

describe('workspaces and saved plans', () => {
  it('refuses a saved plan applied from another workspace', async () => {
    const w = world({ state: undefined, workspaces: { dev: {} } })
    expect((await w.run('plan', '-out=p.tfplan')).exitCode).toBe(0)
    await w.run('workspace', 'select', 'dev')
    const before = snapshot(w)
    const r = await w.run('apply', 'p.tfplan')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Error: Saved plan is stale')
    expect(snapshot(w)).toBe(before)
    await w.run('workspace', 'select', 'default')
    expect((await w.run('apply', 'p.tfplan')).exitCode).toBe(0)
  })
})

describe('workspace commands outside the lab directory', () => {
  it('change nothing and see only default', async () => {
    const w = world({}, { cwd: '/home/you' })
    const before = snapshot(w)
    expect((await w.run('workspace', 'list')).stdout).toBe('* default\n')
    expect((await w.run('workspace', 'new', 'stage')).exitCode).toBe(0)
    expect((await w.run('workspace', 'select', 'dev')).exitCode).toBe(1)
    expect((await w.run('workspace', 'select', 'default')).exitCode).toBe(0)
    expect(snapshot(w)).toBe(before)
  })

  it('evidence matches the two-word command in the lab directory', async () => {
    const w = world({ evidence: [{ evidence: 'made-ws', command: 'workspace new', contains: 'Created and switched' }] })
    expect((await w.run('workspace', 'new', 'stage')).evidence).toEqual(['evidence:made-ws'])
  })
})
