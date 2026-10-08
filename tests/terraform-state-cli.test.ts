import { describe, expect, it } from 'vitest'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import type { TerraformBlock } from '../src/schema/scenario.ts'

const DIR = '/home/you/infra'
const VPC_TF = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const BUCKET_TF = 'resource "aws_s3_bucket" "b" {\n  bucket = "legacy"\n}\n'
const VPC = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1', tags_all: {} } }
const BUCKET = { type: 'aws_s3_bucket', name: 'b', attrs: { id: 'legacy', arn: 'arn:legacy', bucket: 'legacy', force_destroy: false, bucket_domain_name: 'legacy.s3', tags_all: {} } }

// The CliContext harness from terraform-apply-cli.test.ts: an in-memory disk and a lab.
function world(tf: Partial<TerraformBlock> = {}) {
  const lab = labFromScenario({ files: [{ path: 'main.tf', content: VPC_TF + BUCKET_TF }], state: [VPC, BUCKET], ...tf } as TerraformBlock, DIR, '/home/you')
  const disk: Record<string, string> = {}
  for (const f of lab.files) disk[f.path] = f.content
  disk[`${DIR}/.terraform.lock.hcl`] = LOCK_FILE
  const ctx: CliContext = {
    lab,
    cwd: DIR,
    mainHost: true,
    env: {},
    taken: new Set(),
    listFiles: async (dir) => Object.entries(disk).filter(([p]) => p.slice(0, p.lastIndexOf('/')) === dir).map(([p, text]) => ({ name: p.slice(p.lastIndexOf('/') + 1), text })),
    readFile: async (p) => disk[p],
    write: async (dir, name, text) => void (disk[`${dir}/${name}`] = text),
  }
  return { ctx, lab, disk, run: (...args: string[]) => runTerraform(args, ctx) }
}

// Runs a command that must fail and checks the lab's state did not move.
async function refused(w: ReturnType<typeof world>, ...args: string[]) {
  const before = JSON.stringify(w.lab.state)
  const r = await w.run(...args)
  expect(r.exitCode, args.join(' ')).toBe(1)
  expect(JSON.stringify(w.lab.state), args.join(' ')).toBe(before)
  return r
}
const NO_STATE =
  'No state file was found!\n\nState management commands require a state file. Run this command in a directory where Terraform has been run or use the -state flag to point the command to a specific state location.'
const NO_CHANGES = 'No changes. Your infrastructure matches the configuration.'

describe('the baseline world', () => {
  it('plans no changes', async () => {
    expect((await world().run('plan')).stdout).toContain(NO_CHANGES)
  })
})

describe('terraform state mv', () => {
  it('moves a resource and bumps the serial', async () => {
    const w = world()
    const r = await w.run('state', 'mv', 'aws_s3_bucket.b', 'aws_s3_bucket.c')
    expect(r).toMatchObject({ exitCode: 0, stderr: '', stdout: 'Move "aws_s3_bucket.b" to "aws_s3_bucket.c"\nSuccessfully moved 1 object(s).' })
    expect(w.lab.state.serial).toBe(13)
    expect((await w.run('state', 'list')).stdout).toBe('aws_s3_bucket.c\naws_vpc.main')
  })

  it('-dry-run says what it would move and changes nothing', async () => {
    const w = world()
    const before = JSON.stringify(w.lab.state)
    const r = await w.run('state', 'mv', '-dry-run', 'aws_s3_bucket.b', 'aws_s3_bucket.c')
    expect(r).toMatchObject({ exitCode: 0, stdout: 'Would move "aws_s3_bucket.b" to "aws_s3_bucket.c"' })
    expect(JSON.stringify(w.lab.state)).toBe(before)
  })

  it('refuses wrong argument counts, missing sources, other types and no state', async () => {
    const w = world()
    expect((await refused(w, 'state', 'mv', 'aws_s3_bucket.b')).stderr).toBe('Exactly two arguments expected.')
    const missing = await refused(w, 'state', 'mv', 'aws_s3_bucket.x', 'aws_s3_bucket.y')
    expect(missing.stderr).toContain('Error: Invalid source address')
    expect(missing.stderr).toContain('Cannot move aws_s3_bucket.x: does not match anything in the current state.')
    expect((await refused(w, 'state', 'mv', 'aws_s3_bucket.b', 'aws_vpc.b')).stderr).toContain('resource types must match')
    expect((await refused(w, 'state', 'mv', '-bogus', 'aws_s3_bucket.b', 'aws_s3_bucket.c')).stderr).toContain('flag provided but not defined: -bogus')
    const none = world({ state: undefined })
    expect((await refused(none, 'state', 'mv', 'aws_s3_bucket.b', 'aws_s3_bucket.c')).stderr).toBe(NO_STATE)
  })

  it('accepts and ignores lock and state-path flags', async () => {
    const w = world()
    const r = await w.run('state', 'mv', '-lock=false', '-lock-timeout=5s', '-state=x.tfstate', '-backup=y', '-no-color', 'aws_s3_bucket.b', 'aws_s3_bucket.c')
    expect(r.exitCode).toBe(0)
    expect(w.lab.state.serial).toBe(13)
  })

  it('does nothing outside the lab directory', async () => {
    const w = world()
    const before = JSON.stringify(w.lab.state)
    const r = await w.run('-chdir=/tmp', 'state', 'mv', 'aws_s3_bucket.b', 'aws_s3_bucket.c')
    expect(r).toMatchObject({ exitCode: 1, stderr: NO_STATE })
    expect(JSON.stringify(w.lab.state)).toBe(before)
  })

  it('after a rename in the configuration, the moved state plans no changes', async () => {
    const DB_TF = 'resource "aws_db_instance" "orders" {\n  identifier     = "orders"\n  engine         = "postgres"\n  instance_class = "db.t3.micro"\n  username       = "app"\n  password       = "hunter22"\n}\n'
    const DB = {
      type: 'aws_db_instance',
      name: 'old',
      attrs: { id: 'db-1', arn: 'arn:db-1', identifier: 'orders', engine: 'postgres', engine_version: '16.3', instance_class: 'db.t3.micro', allocated_storage: 20, storage_encrypted: false, kms_key_id: '', db_name: '', username: 'app', password: 'hunter22', multi_az: false, skip_final_snapshot: false, endpoint: 'orders.x:5432', tags: {}, tags_all: {} },
    }
    const w = world({ files: [{ path: 'main.tf', content: DB_TF }], state: [DB] })
    expect((await w.run('plan')).stdout).toContain('aws_db_instance.old will be destroyed')
    expect((await w.run('state', 'mv', 'aws_db_instance.old', 'aws_db_instance.orders')).exitCode).toBe(0)
    expect((await w.run('plan')).stdout).toContain(NO_CHANGES)
  })
})

describe('terraform state rm', () => {
  it('removes an instance; the next plan creates it and an import brings it back', async () => {
    const w = world()
    const r = await w.run('state', 'rm', 'aws_s3_bucket.b')
    expect(r).toMatchObject({ exitCode: 0, stderr: '', stdout: 'Removed aws_s3_bucket.b\nSuccessfully removed 1 resource instance(s).' })
    expect(w.lab.state.serial).toBe(13)
    expect((await w.run('plan')).stdout).toContain('# aws_s3_bucket.b will be created')
    const imp = await w.run('import', 'aws_s3_bucket.b', 'legacy')
    expect(imp).toMatchObject({
      exitCode: 0,
      stderr: '',
      stdout: `aws_s3_bucket.b: Importing from ID "legacy"...
aws_s3_bucket.b: Import prepared!
  Prepared aws_s3_bucket for import
aws_s3_bucket.b: Refreshing state... [id=legacy]

Import successful!

The resources that were imported are shown above. These resources are now in
your Terraform state and will henceforth be managed by Terraform.`,
    })
    expect(w.lab.state.serial).toBe(14)
    expect((await w.run('plan')).stdout).toContain(NO_CHANGES)
  })

  it('-dry-run lists what it would remove and changes nothing', async () => {
    const w = world()
    const before = JSON.stringify(w.lab.state)
    expect(await w.run('state', 'rm', '-dry-run', 'aws_s3_bucket.b', 'aws_vpc.main')).toMatchObject({ exitCode: 0, stdout: 'Would remove aws_vpc.main\nWould remove aws_s3_bucket.b' })
    expect(JSON.stringify(w.lab.state)).toBe(before)
  })

  it('refuses no addresses, no matches and no state', async () => {
    const w = world()
    expect((await refused(w, 'state', 'rm')).stderr).toBe('At least one address is required.')
    expect((await refused(w, 'state', 'rm', 'aws_s3_bucket.nope')).stderr).toBe('No matching objects found.')
    expect((await refused(world({ state: undefined }), 'state', 'rm', 'aws_s3_bucket.b')).stderr).toBe(NO_STATE)
    expect((await refused(w, '-chdir=/tmp', 'state', 'rm', 'aws_s3_bucket.b')).stderr).toBe(NO_STATE)
  })
})

describe('terraform taint and untaint', () => {
  it('taint forces a replacement and untaint clears it', async () => {
    const w = world()
    expect(await w.run('taint', 'aws_vpc.main')).toMatchObject({ exitCode: 0, stderr: '', stdout: 'Resource instance aws_vpc.main has been marked as tainted.' })
    expect(w.lab.state.serial).toBe(13)
    const plan = (await w.run('plan')).stdout
    expect(plan).toContain('# aws_vpc.main is tainted, so must be replaced')
    expect(plan).toContain('-/+ resource "aws_vpc" "main"')
    expect(await w.run('untaint', 'aws_vpc.main')).toMatchObject({ exitCode: 0, stderr: '', stdout: 'Resource instance aws_vpc.main has been successfully untainted.' })
    expect(w.lab.state.serial).toBe(14)
    expect((await w.run('plan')).stdout).toContain(NO_CHANGES)
  })

  it('refuses missing instances, untainted instances, data sources and wrong argument counts', async () => {
    const w = world()
    const missing = await refused(w, 'taint', 'aws_vpc.nope')
    expect(missing.stderr).toContain('Error: No such resource instance')
    expect(missing.stderr).toContain('There is no resource instance with the address aws_vpc.nope in the current\n│ state.')
    expect((await refused(w, 'untaint', 'aws_vpc.main')).stderr).toContain('Error: Resource instance is not tainted')
    expect((await refused(w, 'taint', 'data.aws_vpc.main')).stderr).toContain('Data sources cannot be tainted.')
    expect((await refused(w, 'taint')).stderr).toBe('Exactly one argument expected.')
    expect((await refused(w, 'untaint', 'a.b', 'c.d')).stderr).toBe('Exactly one argument expected.')
    const none = await refused(world({ state: undefined }), 'taint', 'aws_vpc.main')
    expect(none.stderr).toContain('Error: No state file was found!')
    expect(none.stderr).toContain('State management commands require a state file.')
    expect((await refused(w, '-chdir=/tmp', 'taint', 'aws_vpc.main')).stderr).toContain('Error: No state file was found!')
  })

  it('-allow-missing turns a missing instance into a quiet success', async () => {
    const w = world()
    const before = JSON.stringify(w.lab.state)
    expect(await w.run('taint', '-allow-missing', 'aws_vpc.nope')).toMatchObject({ exitCode: 0, stdout: '', stderr: '' })
    expect(JSON.stringify(w.lab.state)).toBe(before)
  })
})

describe('terraform import', () => {
  it('imports an object that exists only in the cloud', async () => {
    const w = world({ files: [{ path: 'main.tf', content: VPC_TF + BUCKET_TF + 'resource "aws_s3_bucket" "extra" {\n  bucket = "extra"\n}\n' }], cloud: { add: [{ type: 'aws_s3_bucket', attrs: { ...BUCKET.attrs, id: 'extra', arn: 'arn:extra', bucket: 'extra' } }] } })
    const r = await w.run('import', 'aws_s3_bucket.extra', 'extra')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Import successful!')
    expect(w.lab.state.serial).toBe(13)
    expect((await w.run('plan')).stdout).toContain(NO_CHANGES)
  })

  it('refuses undeclared resources, managed addresses, unknown ids and wrong argument counts', async () => {
    const w = world({ cloud: { add: [{ type: 'aws_s3_bucket', attrs: { ...BUCKET.attrs, id: 'other' } }] } })
    const undeclared = await refused(w, 'import', 'aws_s3_bucket.z', 'other')
    expect(undeclared.stderr).toContain('Error: Resource address "aws_s3_bucket.z" does not exist in the configuration.')
    expect(undeclared.stderr).toContain('resource "aws_s3_bucket" "z" {')
    expect((await refused(w, 'import', 'aws_s3_bucket.b', 'other')).stderr).toContain('Error: Resource already managed by Terraform')
    await w.run('state', 'rm', 'aws_s3_bucket.b')
    const ghost = await refused(w, 'import', 'aws_s3_bucket.b', 'ghost')
    expect(ghost.stderr).toContain('Error: Cannot import non-existent remote object')
    expect((await refused(w, 'import', 'aws_s3_bucket.b')).stderr).toBe('Exactly two arguments expected.')
    expect((await refused(w, 'import', '-var=nope=1', 'aws_s3_bucket.b', 'legacy')).stderr).toContain('Value for undeclared variable')
  })

  it('a keyed address must be an instance the configuration produces', async () => {
    const COUNT_TF = 'resource "aws_s3_bucket" "c" {\n  count  = 1\n  bucket = "b${count.index}"\n}\n'
    const EACH_TF = 'resource "aws_s3_bucket" "e" {\n  for_each = toset(["x"])\n  bucket   = each.key\n}\n'
    const w = world({ files: [{ path: 'main.tf', content: VPC_TF + BUCKET_TF + COUNT_TF + EACH_TF }], cloud: { add: [{ type: 'aws_s3_bucket', attrs: { ...BUCKET.attrs, id: 'b0', bucket: 'b0' } }, { type: 'aws_s3_bucket', attrs: { ...BUCKET.attrs, id: 'x', bucket: 'x' } }] } })
    for (const [a, id] of [['aws_s3_bucket.c[5]', 'b0'], ['aws_s3_bucket.e["y"]', 'x'], ['aws_s3_bucket.b["x"]', 'x']]) {
      const err = (await refused(w, 'import', a, id)).stderr
      expect(err).toContain('Error: Configuration for import target does not exist')
      expect(err).toContain(`The configuration for the given import target ${a} does not`)
    }
    expect((await w.run('import', 'aws_s3_bucket.c[0]', 'b0')).exitCode).toBe(0)
    expect((await w.run('import', 'aws_s3_bucket.e["x"]', 'x')).exitCode).toBe(0)
    expect((await w.run('state', 'list')).stdout).toContain('aws_s3_bucket.c[0]\naws_s3_bucket.e["x"]')
  })

  it('accepts a keyed address when count cannot be evaluated yet', async () => {
    const UNKNOWN_TF = 'resource "aws_s3_bucket" "u" {\n  count  = length(aws_vpc.main.arn) > 0 ? 1 : 0\n  bucket = "u"\n}\n'
    const w = world({ files: [{ path: 'main.tf', content: VPC_TF + BUCKET_TF + UNKNOWN_TF }], state: [BUCKET], cloud: { add: [{ type: 'aws_s3_bucket', attrs: { ...BUCKET.attrs, id: 'u', bucket: 'u' } }] } })
    expect((await w.run('plan')).exitCode).toBe(1)
    expect((await w.run('import', 'aws_s3_bucket.u[3]', 'u')).exitCode).toBe(0)
  })

  it('needs a configuration and does nothing outside the lab directory', async () => {
    const w = world()
    w.disk[`/tmp/main.tf`] = BUCKET_TF
    w.disk[`/tmp/.terraform.lock.hcl`] = LOCK_FILE
    expect((await refused(w, '-chdir=/tmp', 'import', 'aws_s3_bucket.b', 'legacy')).stderr).toContain('Error: Cannot import non-existent remote object')
    expect((await refused(w, '-chdir=/home', 'import', 'aws_s3_bucket.b', 'legacy')).stderr).toContain('Error: No configuration files')
  })
})

describe('terraform refresh', () => {
  it('saves what the cloud holds now and bumps the serial once', async () => {
    const w = world({ cloud: { patch: [{ type: 'aws_s3_bucket', id: 'legacy', set: { force_destroy: true } }] }, outputs: { vpc_id: { value: 'vpc-1' } } })
    const r = await w.run('refresh')
    expect(r).toMatchObject({ exitCode: 0, stderr: '', stdout: 'aws_s3_bucket.b: Refreshing state... [id=legacy]\naws_vpc.main: Refreshing state... [id=vpc-1]\n\nOutputs:\n\nvpc_id = "vpc-1"' })
    expect(w.lab.state.serial).toBe(13)
    expect(w.lab.state.resources.find((x) => x.name === 'b')?.instances[0].attributes.force_destroy).toBe(true)
    expect((await w.run('refresh')).exitCode).toBe(0)
    expect(w.lab.state.serial).toBe(13)
  })

  it('prints only the refresh lines when there are no outputs, and leaves an unchanged state alone', async () => {
    const w = world()
    expect(await w.run('refresh')).toMatchObject({ exitCode: 0, stdout: 'aws_s3_bucket.b: Refreshing state... [id=legacy]\naws_vpc.main: Refreshing state... [id=vpc-1]' })
    expect(w.lab.state.serial).toBe(12)
  })

  it('plans no resource changes, so a blocked replacement does not stop it', async () => {
    const PROTECTED = 'resource "aws_vpc" "main" {\n  cidr_block = "10.9.0.0/16"\n\n  lifecycle {\n    prevent_destroy = true\n  }\n}\n'
    const w = world({ files: [{ path: 'main.tf', content: PROTECTED + BUCKET_TF }], cloud: { patch: [{ type: 'aws_s3_bucket', id: 'legacy', set: { force_destroy: true } }] } })
    expect((await w.run('plan')).stderr).toContain('prevent_destroy')
    const r = await w.run('refresh')
    expect(r).toMatchObject({ exitCode: 0, stderr: '', stdout: 'aws_s3_bucket.b: Refreshing state... [id=legacy]\naws_vpc.main: Refreshing state... [id=vpc-1]' })
    expect(w.lab.state.resources.find((x) => x.name === 'b')?.instances[0].attributes.force_destroy).toBe(true)
    expect(w.lab.state.serial).toBe(13)
  })

  it('does nothing outside the lab directory', async () => {
    const w = world({ cloud: { patch: [{ type: 'aws_s3_bucket', id: 'legacy', set: { force_destroy: true } }] } })
    w.disk[`/tmp/main.tf`] = BUCKET_TF
    w.disk[`/tmp/.terraform.lock.hcl`] = LOCK_FILE
    const before = JSON.stringify(w.lab.state)
    expect((await w.run('-chdir=/tmp', 'refresh')).exitCode).toBe(0)
    expect(JSON.stringify(w.lab.state)).toBe(before)
  })
})

describe('evidence', () => {
  it('matches each new command by name', async () => {
    const evidence = [
      { command: 'state mv', contains: 'Successfully moved', evidence: 'mv' },
      { command: 'state rm', contains: 'Successfully removed', evidence: 'rm' },
      { command: 'taint', contains: 'marked as tainted', evidence: 'taint' },
      { command: 'untaint', contains: 'successfully untainted', evidence: 'untaint' },
      { command: 'import', contains: 'Import successful', evidence: 'import' },
      { command: 'refresh', contains: 'Refreshing state', evidence: 'refresh' },
    ]
    const w = world({ evidence } as Partial<TerraformBlock>)
    expect((await w.run('state', 'mv', 'aws_s3_bucket.b', 'aws_s3_bucket.c')).evidence).toEqual(['evidence:mv'])
    expect((await w.run('state', 'rm', 'aws_s3_bucket.c')).evidence).toEqual(['evidence:rm'])
    expect((await w.run('taint', 'aws_vpc.main')).evidence).toEqual(['evidence:taint'])
    expect((await w.run('untaint', 'aws_vpc.main')).evidence).toEqual(['evidence:untaint'])
    expect((await w.run('import', 'aws_s3_bucket.b', 'legacy')).evidence).toEqual(['evidence:import'])
    const refresh = await w.run('refresh')
    expect(refresh.evidence).toEqual(['evidence:refresh'])
    expect(refresh.ran).toBe('')
  })
})
