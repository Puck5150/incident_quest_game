import { describe, expect, it } from 'vitest'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import { evalPredicate } from '../src/game/terraform/predicates.ts'
import type { TerraformBlock } from '../src/schema/scenario.ts'

const DIR = '/home/you/infra'
const TF = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n\nresource "aws_s3_bucket" "b" {\n  bucket = "legacy"\n}\n'
const VPC = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1', tags_all: {} } }
const BUCKET = { type: 'aws_s3_bucket', name: 'b', attrs: { id: 'legacy', arn: 'arn:legacy', bucket: 'legacy', force_destroy: false, bucket_domain_name: 'legacy.s3', tags_all: {} } }
const LOCK = { id: '9db590f1-b6fe-c5f2-2678-8804f089deba', who: 'ci@runner-7', created: '2026-10-08 09:14:02.123456789 +0000 UTC' }
const MARK = ' (lock bypassed)'

function world(locked = true) {
  const lab = labFromScenario({ files: [{ path: 'main.tf', content: TF }], state: [VPC, BUCKET], ...(locked ? { lock: LOCK } : {}) } as TerraformBlock, DIR, '/home/you')
  const disk: Record<string, string> = { [`${DIR}/main.tf`]: TF, [`${DIR}/.terraform.lock.hcl`]: LOCK_FILE }
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
  const bypassed = () => evalPredicate({ lock_bypassed: true }, { state: lab.state, reality: lab.reality, ...(lab.lock ? { lock: lab.lock } : {}), history: lab.history, plan: () => undefined, readFile: async () => undefined })
  return { lab, bypassed, run: (...args: string[]) => runTerraform(args, ctx) }
}

// Each state-writing command with the history line it leaves.
const WRITES: [string, string[], string][] = [
  ['state rm', ['state', 'rm', 'aws_s3_bucket.b'], 'state-rm aws_s3_bucket.b'],
  ['state mv', ['state', 'mv', 'aws_s3_bucket.b', 'aws_s3_bucket.c'], 'state-mv aws_s3_bucket.b'],
  ['taint', ['taint', 'aws_vpc.main'], 'taint aws_vpc.main'],
  ['untaint', ['untaint', 'aws_vpc.main'], 'untaint aws_vpc.main'],
  ['import', ['import', 'aws_s3_bucket.b', 'legacy'], 'import aws_s3_bucket.b'],
  ['workspace new', ['workspace', 'new', 'dev'], 'workspace-new dev'],
  ['workspace delete', ['workspace', 'delete', 'dev'], 'workspace-delete dev'],
]

describe('lock-bypass marker for state-writing commands', () => {
  for (const [name, args, line] of WRITES) {
    // delete needs an existing non-active workspace; untaint needs a tainted instance
    const prep = async (w: ReturnType<typeof world>) => {
      if (name === 'workspace delete') {
        await w.run('workspace', 'new', '-lock=false', 'dev')
        await w.run('workspace', 'select', 'default')
        w.lab.history.length = 0
      }
      if (name === 'import') await w.run('state', 'rm', '-lock=false', 'aws_s3_bucket.b')
      if (name === 'untaint') await w.run('taint', '-lock=false', 'aws_vpc.main')
      w.lab.history.length = 0
    }
    const withFlag = (a: string[]) => {
      const n = a[0] === 'state' || a[0] === 'workspace' ? 2 : 1
      return [...a.slice(0, n), '-lock=false', ...a.slice(n)]
    }

    it(`${name}: marked when -lock=false ran past a held lock`, async () => {
      const w = world()
      await prep(w)
      expect((await w.run(...withFlag(args))).exitCode).toBe(0)
      expect(w.lab.history).toEqual([line + MARK])
      expect(await w.bypassed()).toBe(true)
    })
    it(`${name}: unmarked line when the lock is free`, async () => {
      const w = world(false)
      await prep(w)
      expect((await w.run(...withFlag(args))).exitCode).toBe(0)
      expect(w.lab.history).toEqual([line])
      expect(await w.bypassed()).toBe(false)
    })
    it(`${name}: lock error without -lock=false records nothing`, async () => {
      const w = world()
      await prep(w)
      const r = await w.run(...args)
      expect(r.exitCode).toBe(1)
      expect(r.stderr + r.stdout).toContain('Error acquiring the state lock')
      expect(w.lab.history).toEqual([])
    })
  }

  it('a command that fails after the lock check records nothing', async () => {
    const w = world()
    expect((await w.run('state', 'rm', '-lock=false', 'aws_s3_bucket.nope')).exitCode).toBe(1)
    expect((await w.run('taint', '-lock=false', 'aws_s3_bucket.nope')).exitCode).toBe(1)
    expect(w.lab.history).toEqual([])
    expect(await w.bypassed()).toBe(false)
  })

  it('read-only commands record nothing', async () => {
    const w = world()
    await w.run('state', 'list')
    await w.run('show')
    await w.run('plan', '-lock=false')
    await w.run('workspace', 'list')
    expect(w.lab.history).toEqual([])
    expect(await w.bypassed()).toBe(false)
  })

  it('apply -lock=false past a held lock satisfies the leaf', async () => {
    const w = world()
    await w.run('destroy', '-lock=false', '-auto-approve')
    expect(w.lab.history.every((h) => h.endsWith(MARK))).toBe(true)
    expect(await w.bypassed()).toBe(true)
  })
})
