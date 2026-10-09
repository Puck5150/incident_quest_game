import { describe, expect, it } from 'vitest'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import type { TerraformBlock } from '../src/schema/scenario.ts'

const DIR = '/home/you/infra'
const VPC_TF = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const BUCKET_TF = 'resource "aws_s3_bucket" "b" {\n  bucket = "legacy"\n}\n'
const VPC = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1', tags_all: {} } }
const BUCKET = { type: 'aws_s3_bucket', name: 'b', attrs: { id: 'legacy', arn: 'arn:legacy', bucket: 'legacy', force_destroy: false, bucket_domain_name: 'legacy.s3', tags_all: {} } }
const LOCK_ID = '9db590f1-b6fe-c5f2-2678-8804f089deba'
const LOCK = { id: LOCK_ID, who: 'ci@runner-7', created: '2026-10-08 09:14:02.123456789 +0000 UTC' }

// The CliContext harness from terraform-state-cli.test.ts, with a held lock by default.
function world(tf: Partial<TerraformBlock> = { lock: LOCK }, o: { stdin?: string; confirm?: CliContext['confirm'] } = {}) {
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
    ...(o.stdin === undefined ? {} : { stdin: o.stdin }),
    ...(o.confirm === undefined ? {} : { confirm: o.confirm }),
    listFiles: async (dir) => Object.entries(disk).filter(([p]) => p.slice(0, p.lastIndexOf('/')) === dir).map(([p, text]) => ({ name: p.slice(p.lastIndexOf('/') + 1), text })),
    readFile: async (p) => disk[p],
    write: async (dir, name, text) => void (disk[`${dir}/${name}`] = text),
  }
  return { ctx, lab, disk, run: (...args: string[]) => runTerraform(args, ctx) }
}

// Written as lines so the box's "│ " blank lines keep their trailing space.
const lockError = (o: { message?: string; operation?: string; path?: string; info?: string } = {}) =>
  [
    '╷',
    '│ Error: Error acquiring the state lock',
    '│ ',
    `│ Error message: ${o.message ?? 'resource temporarily unavailable'}`,
    '│ Lock Info:',
    `│   ID:        ${LOCK_ID}`,
    `│   Path:      ${o.path ?? 'terraform.tfstate'}`,
    `│   Operation: ${o.operation ?? 'OperationTypeApply'}`,
    '│   Who:       ci@runner-7',
    '│   Version:   1.9.8',
    '│   Created:   2026-10-08 09:14:02.123456789 +0000 UTC',
    `│   Info:      ${o.info ?? ''}`,
    '│ ',
    '│ ',
    '│ Terraform acquires a state lock to protect the state from being written',
    '│ by multiple users at the same time. Please resolve the issue above and try',
    '│ again. For most commands, you can disable locking with the "-lock=false"',
    '│ flag, but this is not recommended.',
    '╵',
  ].join('\n')

const PROMPT =
  "Do you really want to force-unlock?\n  Terraform will remove the lock on the remote state.\n  This will allow local Terraform commands to modify this state, even though it\n  may still be in use. Only 'yes' will be accepted to confirm.\n\n  Enter a value: "
const UNLOCKED = 'Terraform state has been successfully unlocked!\n\nThe state has been unlocked, and Terraform commands should now be able to\nobtain a new lock on the remote state.'
const NO_CHANGES = 'No changes. Your infrastructure matches the configuration.'

const snapshot = (w: ReturnType<typeof world>) =>
  JSON.stringify({ state: w.lab.state, reality: w.lab.reality, hasState: w.lab.hasState, plans: [...w.lab.savedPlans.keys()], lock: w.lab.lock, disk: w.disk })

const LOCKED: string[][] = [
  ['plan'],
  ['plan', '-out=p.tfplan'],
  ['plan', '-lock=true'],
  ['plan', '-lock-timeout=30s'],
  ['apply'],
  ['apply', '-auto-approve'],
  ['destroy', '-auto-approve'],
  ['refresh'],
  ['import', 'aws_s3_bucket.b', 'legacy'],
  ['taint', 'aws_vpc.main'],
  ['untaint', 'aws_vpc.main'],
  ['state', 'mv', 'aws_s3_bucket.b', 'aws_s3_bucket.c'],
  ['state', 'rm', 'aws_s3_bucket.b'],
  ['state', 'rm', '-lock-timeout=5s', 'aws_s3_bucket.b'],
]

describe('a held state lock', () => {
  for (const args of LOCKED) {
    it(`stops terraform ${args.join(' ')} with the exact lock error and changes nothing`, async () => {
      const w = world(undefined, { stdin: 'yes\n' })
      const before = snapshot(w)
      const r = await w.run(...args)
      expect(r).toMatchObject({ exitCode: 1, stdout: '', stderr: lockError() })
      expect(snapshot(w)).toBe(before)
    })
  }

  it('stops applying a saved plan', async () => {
    const w = world({})
    expect((await w.run('plan', '-out=p.tfplan')).exitCode).toBe(0)
    w.lab.lock = { id: LOCK_ID, who: 'ci@runner-7', created: LOCK.created, operation: 'OperationTypePlan', path: 'env:/prod/terraform.tfstate', info: 'nightly drift job', message: 'ConditionalCheckFailedException' }
    const before = snapshot(w)
    const r = await w.run('apply', 'p.tfplan')
    expect(r).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: lockError({ operation: 'OperationTypePlan', path: 'env:/prod/terraform.tfstate', info: 'nightly drift job', message: 'ConditionalCheckFailedException' }),
    })
    expect(snapshot(w)).toBe(before)
  })

  it('uses the scenario lock fields', async () => {
    const w = world({ lock: { ...LOCK, operation: 'OperationTypePlan', info: 'x', message: 'busy' } })
    expect((await w.run('plan')).stderr).toBe(lockError({ operation: 'OperationTypePlan', info: 'x', message: 'busy' }))
  })

  it('is ignored by commands that do not lock', async () => {
    const w = world()
    const before = snapshot(w)
    for (const args of [['init'], ['validate'], ['version'], ['show'], ['output'], ['state', 'list'], ['state', 'show', 'aws_vpc.main'], ['state', 'pull'], ['workspace', 'show'], ['workspace', 'list'], ['fmt']]) {
      const r = await w.run(...args)
      expect(r.stderr, args.join(' ')).not.toContain('state lock')
      if (args[0] !== 'fmt') expect(r.exitCode, args.join(' ')).toBe(0)
    }
    expect(w.lab.lock).toBeDefined()
    expect(snapshot(w)).toBe(before)
  })

  it('-lock=false runs the command normally', async () => {
    const w = world()
    const plan = await w.run('plan', '-lock=false')
    expect(plan.exitCode).toBe(0)
    expect(plan.stdout).toContain(NO_CHANGES)
    expect((await w.run('apply', '-lock=false', '-auto-approve')).exitCode).toBe(0)
    expect((await w.run('refresh', '-lock=false')).exitCode).toBe(0)
    expect(await w.run('taint', '-lock=false', 'aws_vpc.main')).toMatchObject({ exitCode: 0, stdout: 'Resource instance aws_vpc.main has been marked as tainted.' })
    expect((await w.run('untaint', '-lock=false', 'aws_vpc.main')).exitCode).toBe(0)
    expect((await w.run('state', 'mv', '-lock=false', 'aws_s3_bucket.b', 'aws_s3_bucket.c')).exitCode).toBe(0)
    expect(await w.run('state', 'rm', '-lock=false', 'aws_s3_bucket.c')).toMatchObject({ exitCode: 0, stdout: 'Removed aws_s3_bucket.c\nSuccessfully removed 1 resource instance(s).' })
    expect((await w.run('import', '-lock=false', 'aws_s3_bucket.b', 'legacy')).exitCode).toBe(0)
    expect((await w.run('destroy', '-lock=false', '-auto-approve')).exitCode).toBe(0)
    expect(w.lab.state.resources).toEqual([])
    expect(w.lab.lock?.id).toBe(LOCK_ID)
    // the destroy ran past the held lock: its history lines say so
    expect(w.lab.history).toEqual(['delete aws_s3_bucket.b (lock bypassed)', 'delete aws_vpc.main (lock bypassed)'])
  })

  it('marks nothing as bypassed when there is no lock to bypass', async () => {
    const w = world({})
    w.disk[`${DIR}/main.tf`] = VPC_TF
    expect((await w.run('apply', '-lock=false', '-auto-approve')).exitCode).toBe(0)
    expect(w.lab.history).toEqual(['delete aws_s3_bucket.b'])
  })

  it('argument and configuration errors come before the lock error', async () => {
    const w = world()
    const flag = await w.run('plan', '-nope')
    expect(flag.stderr).toContain('flag provided but not defined: -nope')
    expect(flag.stderr).not.toContain('state lock')
    expect((await w.run('state', 'mv', 'aws_s3_bucket.b')).stderr).toBe('Exactly two arguments expected.')
    expect((await w.run('taint')).stderr).toBe('Exactly one argument expected.')
    expect((await w.run('import', 'aws_s3_bucket.zz', 'x')).stderr).toContain('does not exist in the configuration')
    expect((await w.run('state', 'mv', 'nope', 'aws_s3_bucket.c')).stderr).toContain('Invalid source address')
    for (const args of [['state', 'rm', 'aws_s3_bucket.b', 'nope'], ['taint', 'nope'], ['untaint', 'nope']]) {
      const r = await w.run(...args)
      expect(r.stderr, args.join(' ')).toContain('Error: Invalid address')
      expect(r.stderr, args.join(' ')).toContain('nope is not a valid resource instance address.')
      expect(r.stderr, args.join(' ')).not.toContain('state lock')
    }
    expect((await w.run('apply', 'missing.tfplan')).stderr).toContain('Failed to load "missing.tfplan" as a plan file')
    expect((await w.run('plan', '-var=nope=1')).stderr).toContain('Value for undeclared variable')
    delete w.disk[`${DIR}/.terraform.lock.hcl`]
    expect((await w.run('plan')).stderr).toContain('Inconsistent dependency lock file')
    delete w.disk[`${DIR}/main.tf`]
    expect((await w.run('plan')).stderr).toContain('No configuration files')
    expect(w.lab.lock?.id).toBe(LOCK_ID)
  })

  it('state lookups (no such object) come after the lock error', async () => {
    const w = world()
    for (const args of [['state', 'rm', 'aws_s3_bucket.zz'], ['taint', 'aws_s3_bucket.zz'], ['untaint', 'aws_s3_bucket.zz']]) expect((await w.run(...args)).stderr, args.join(' ')).toContain('Error acquiring the state lock')
  })

  it('configuration (graph) errors come before the lock error for plan, apply and destroy', async () => {
    const w = world()
    w.disk[`${DIR}/main.tf`] = `${VPC_TF}${BUCKET_TF}output "x" {\n  value = var.missing\n}\n`
    const before = snapshot(w)
    for (const args of [['plan'], ['apply', '-auto-approve'], ['destroy', '-auto-approve']]) {
      const r = await w.run(...args)
      expect(r.exitCode, args[0]).toBe(1)
      expect(r.stderr, args[0]).toContain('Error: Reference to undeclared input variable')
      expect(r.stderr, args[0]).not.toContain('state lock')
    }
    expect(snapshot(w)).toBe(before)
  })

  it('is not held outside the lab directory', async () => {
    const w = world()
    w.disk['/tmp/main.tf'] = VPC_TF
    w.disk['/tmp/.terraform.lock.hcl'] = LOCK_FILE
    const r = await w.run('-chdir=/tmp', 'plan')
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')
    expect((await w.run('-chdir=/tmp', 'apply', '-auto-approve')).exitCode).toBe(0)
    const unlock = await w.run('-chdir=/tmp', 'force-unlock', '-force', LOCK_ID)
    expect(unlock.stderr).toContain('unexpected end of JSON input')
    expect(w.lab.lock?.id).toBe(LOCK_ID)
  })

  it('beats import\'s "already managed" error, since the state is read under the lock', async () => {
    const free = await world({}).run('import', 'aws_s3_bucket.b', 'legacy')
    expect(free.stderr).toContain('Error: Resource already managed by Terraform')
    expect(await world().run('import', 'aws_s3_bucket.b', 'legacy')).toMatchObject({ exitCode: 1, stdout: '', stderr: lockError() })
  })

  it('is never left behind by a failed apply', async () => {
    const w = world({ faults: [{ at: 'aws_s3_bucket.n', on: 'create', error: 'creating S3 Bucket: api error Throttling', times: 1 }] })
    w.disk[`${DIR}/main.tf`] = `${VPC_TF}${BUCKET_TF}resource "aws_s3_bucket" "n" {\n  bucket = "new"\n}\n`
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(1)
    expect(w.lab.lock).toBeUndefined()
    expect((await w.run('plan')).exitCode).toBe(0)
  })
})

describe('terraform force-unlock', () => {
  it('needs exactly one argument', async () => {
    for (const args of [[], [LOCK_ID, 'x'], ['-force']]) {
      const w = world()
      expect(await w.run('force-unlock', ...args)).toMatchObject({ exitCode: 1, stdout: '', stderr: 'Expected a single argument: LOCK_ID' })
      expect(w.lab.lock?.id).toBe(LOCK_ID)
    }
  })

  // The S3 backend with a DynamoDB table (Terraform 1.9): plain error lines, the mismatch with the held lock's info.
  const NO_LOCK = `Failed to unlock state: failed to retrieve lock info for lock ID "${LOCK_ID}": unexpected end of JSON input`
  const MISMATCH = [
    `Failed to unlock state: lock ID "abc" does not match existing lock ("${LOCK_ID}")`,
    'Lock Info:',
    `  ID:        ${LOCK_ID}`,
    '  Path:      terraform.tfstate',
    '  Operation: OperationTypeApply',
    '  Who:       ci@runner-7',
    '  Version:   1.9.8',
    '  Created:   2026-10-08 09:14:02.123456789 +0000 UTC',
    '  Info:      ',
  ].join('\n')

  it('refuses when no lock is held, after the question unless -force', async () => {
    expect(await world({}).run('force-unlock', '-force', LOCK_ID)).toMatchObject({ exitCode: 1, stdout: '', stderr: NO_LOCK })
    expect(await world({}, { stdin: 'yes\n' }).run('force-unlock', LOCK_ID)).toMatchObject({ exitCode: 1, stdout: `${PROMPT}yes\n\n`, stderr: NO_LOCK })
  })

  it('refuses the wrong lock id, after the question unless -force', async () => {
    const w = world(undefined, { stdin: 'yes\n' })
    expect(await w.run('force-unlock', 'abc')).toMatchObject({ exitCode: 1, stdout: `${PROMPT}yes\n\n`, stderr: MISMATCH })
    expect(await w.run('force-unlock', '-force', 'abc')).toMatchObject({ exitCode: 1, stdout: '', stderr: MISMATCH })
    expect(w.lab.lock?.id).toBe(LOCK_ID)
  })

  it('asks before it knows whether the lock exists or matches', async () => {
    const asked: string[] = []
    const none = world({}, { confirm: async (p) => (asked.push(p), 'no') })
    expect(await none.run('force-unlock', LOCK_ID)).toMatchObject({ exitCode: 1, stderr: '', stdout: `${PROMPT}no\n\nforce-unlock cancelled.` })
    const wrong = world(undefined, { confirm: async (p) => (asked.push(p), 'no') })
    expect(await wrong.run('force-unlock', 'abc')).toMatchObject({ exitCode: 1, stderr: '', stdout: `${PROMPT}no\n\nforce-unlock cancelled.` })
    expect(asked).toEqual([PROMPT, PROMPT])
    expect(wrong.lab.lock?.id).toBe(LOCK_ID)
  })

  it('a declined answer keeps the lock', async () => {
    const w = world(undefined, { stdin: 'no\n' })
    expect(await w.run('force-unlock', LOCK_ID)).toMatchObject({ exitCode: 1, stderr: '', stdout: `${PROMPT}no\n\nforce-unlock cancelled.` })
    expect(w.lab.lock?.id).toBe(LOCK_ID)
    expect((await w.run('plan')).stderr).toBe(lockError())
  })

  it('no way to answer cancels', async () => {
    const w = world()
    expect(await w.run('force-unlock', LOCK_ID)).toMatchObject({ exitCode: 1, stdout: `${PROMPT}\n\nforce-unlock cancelled.` })
    const hook = world(undefined, { confirm: async () => undefined })
    expect((await hook.run('force-unlock', LOCK_ID)).stdout).toBe(`${PROMPT}\n\nforce-unlock cancelled.`)
    expect(hook.lab.lock?.id).toBe(LOCK_ID)
  })

  it('yes on stdin releases the lock and plan works again', async () => {
    const w = world(undefined, { stdin: 'yes\n' })
    const r = await w.run('force-unlock', LOCK_ID)
    expect(r).toMatchObject({ exitCode: 0, stderr: '', stdout: `${PROMPT}yes\n\n${UNLOCKED}` })
    expect(w.lab.lock).toBeUndefined()
    const plan = await w.run('plan')
    expect(plan.exitCode).toBe(0)
    expect(plan.stdout).toContain(NO_CHANGES)
  })

  it('asks through the confirm hook with the exact prompt', async () => {
    const asked: string[] = []
    const w = world(undefined, { confirm: async (p) => (asked.push(p), 'yes') })
    expect((await w.run('force-unlock', LOCK_ID)).stdout).toBe(`${PROMPT}yes\n\n${UNLOCKED}`)
    expect(asked).toEqual([PROMPT])
    expect(w.lab.lock).toBeUndefined()
  })

  it('-force skips the question', async () => {
    let asked = false
    const w = world(undefined, { confirm: async () => ((asked = true), 'no') })
    expect(await w.run('force-unlock', '-force', LOCK_ID)).toMatchObject({ exitCode: 0, stdout: UNLOCKED })
    expect(asked).toBe(false)
    expect(w.lab.lock).toBeUndefined()
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
  })

  it('takes only -force', async () => {
    const w = world(undefined, { stdin: 'yes\n' })
    for (const flag of ['-nope', '-lock=false', '-lock-timeout=5s', '-state=x', '-no-color']) {
      const name = flag.split('=')[0]
      expect(await w.run('force-unlock', flag, LOCK_ID), flag).toMatchObject({ exitCode: 1, stdout: '', stderr: `╷\n│ Error: Failed to parse command-line flags\n│ \n│ flag provided but not defined: ${name}\n╵` })
    }
    expect(w.lab.lock?.id).toBe(LOCK_ID)
    expect((await w.run('force-unlock', '--force', LOCK_ID)).stdout).toBe(UNLOCKED)
  })
})
