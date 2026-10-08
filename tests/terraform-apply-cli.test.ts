import { describe, expect, it } from 'vitest'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import type { TerraformBlock } from '../src/schema/scenario.ts'

const DIR = '/home/you/infra'
const NET = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n\nresource "aws_subnet" "a" {\n  vpc_id     = aws_vpc.main.id\n  cidr_block = "10.0.1.0/24"\n}\n'
const DB = (protect: boolean) =>
  `resource "aws_db_instance" "main" {\n  identifier     = "orders"\n  engine         = "postgres"\n  instance_class = "db.t3.micro"\n  username       = "app"\n  password       = "hunter22"\n${protect ? '\n  lifecycle {\n    prevent_destroy = true\n  }\n' : ''}}\n`
const DB_STATE = {
  type: 'aws_db_instance',
  name: 'main',
  attrs: { id: 'db-1', arn: 'arn:db-1', identifier: 'orders', engine: 'postgres', engine_version: '16.3', instance_class: 'db.t3.micro', allocated_storage: 20, storage_encrypted: false, kms_key_id: '', db_name: '', username: 'app', password: 'hunter22', multi_az: false, skip_final_snapshot: false, endpoint: 'orders.x:5432', tags: {}, tags_all: {} },
}

// The CliContext harness from terraform-cli.test.ts: an in-memory disk and a lab.
function world(tf: Partial<TerraformBlock> = {}, o: { stdin?: string; confirm?: CliContext['confirm'] } = {}) {
  const lab = labFromScenario({ files: [{ path: 'main.tf', content: NET }], ...tf } as TerraformBlock, DIR, '/home/you')
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

const PLAN = `Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # aws_subnet.a will be created
  + resource "aws_subnet" "a" {
      + arn                     = (known after apply)
      + availability_zone       = (known after apply)
      + cidr_block              = "10.0.1.0/24"
      + id                      = (known after apply)
      + map_public_ip_on_launch = false
      + tags_all                = (known after apply)
      + vpc_id                  = (known after apply)
    }

  # aws_vpc.main will be created
  + resource "aws_vpc" "main" {
      + arn                       = (known after apply)
      + cidr_block                = "10.0.0.0/16"
      + default_security_group_id = (known after apply)
      + enable_dns_hostnames      = false
      + enable_dns_support        = true
      + id                        = (known after apply)
      + tags_all                  = (known after apply)
    }

Plan: 2 to add, 0 to change, 0 to destroy.`
const PROGRESS = `aws_vpc.main: Creating...
aws_vpc.main: Creation complete after 1s [id=vpc-06357f366]
aws_subnet.a: Creating...
aws_subnet.a: Creation complete after 1s [id=subnet-0ff41c09b]`
const DONE = 'Apply complete! Resources: 2 added, 0 changed, 0 destroyed.'
const APPLY_PROMPT = "\nDo you want to perform these actions?\n  Terraform will perform the actions described above.\n  Only 'yes' will be accepted to approve.\n\n  Enter a value: "
const DESTROY_PROMPT =
  "\nDo you really want to destroy all resources?\n  Terraform will destroy all your managed infrastructure, as shown above.\n  There is no undo. Only 'yes' will be accepted to confirm.\n\n  Enter a value: "

describe('terraform apply', () => {
  // Layout: with -auto-approve the progress follows the plan directly; the
  // completion line comes after a blank line.
  it('applies with -auto-approve and commits the world', async () => {
    const w = world()
    const r = await w.run('apply', '-auto-approve')
    expect(r.stdout).toBe(`${PLAN}\n${PROGRESS}\n\n${DONE}`)
    expect(r.stderr).toBe('')
    expect(r.exitCode).toBe(0)
    expect(r.ran).toBe('terraform apply')
    expect((await w.run('plan')).stdout).toContain('No changes.')
    expect((await w.run('state', 'list')).stdout).toBe('aws_subnet.a\naws_vpc.main')
  })

  // Layout: plan, blank line, the question, the answer on the prompt's line,
  // blank line, progress.
  it('applies on a piped yes, echoing the prompt and answer', async () => {
    const w = world({}, { stdin: 'yes\n' })
    const r = await w.run('apply')
    expect(r.stdout).toBe(`${PLAN}\n${APPLY_PROMPT}yes\n\n${PROGRESS}\n\n${DONE}`)
    expect(r.exitCode).toBe(0)
  })

  it('cancels on anything but exactly yes, changing nothing', async () => {
    for (const stdin of ['no\n', '', 'Yes\n']) {
      const w = world({}, { stdin })
      const serial = w.lab.state.serial
      const r = await w.run('apply')
      expect(r.stdout, JSON.stringify(stdin)).toBe(`${PLAN}\n${APPLY_PROMPT}${stdin.trim()}\n\nApply cancelled.`)
      expect(r.exitCode).toBe(1)
      expect(w.lab.state.serial).toBe(serial)
      expect(w.lab.hasState).toBe(false)
      expect(w.lab.attempts.size).toBe(0)
    }
  })

  it('cancels when there is no way to ask', async () => {
    const r = await world().run('apply')
    expect(r.stdout).toBe(`${PLAN}\n${APPLY_PROMPT}\n\nApply cancelled.`)
    expect(r.exitCode).toBe(1)
  })

  it('asks through the confirm hook, showing the plan and the exact prompt', async () => {
    const asked: string[] = []
    const yes = world({}, { confirm: async (p) => (asked.push(p), 'yes') })
    const r0 = await yes.run('apply')
    expect(r0.exitCode).toBe(0)
    // The hook sees what the player must see to decide; stdout keeps the full transcript.
    expect(asked).toEqual([`${PLAN}\n${APPLY_PROMPT}`])
    expect(r0.stdout).toBe(`${PLAN}\n${APPLY_PROMPT}yes\n\n${PROGRESS}\n\n${DONE}`)
    expect(yes.lab.hasState).toBe(true)
    const none = world({}, { confirm: async () => undefined })
    const r = await none.run('apply')
    expect(r.stdout).toContain('Apply cancelled.')
    expect(r.exitCode).toBe(1)
    expect(none.lab.hasState).toBe(false)
  })

  it('prints No changes and completes without asking', async () => {
    let asked = false
    const w = world({}, { confirm: async () => ((asked = true), 'no') })
    await w.run('apply', '-auto-approve')
    const r = await w.run('apply')
    expect(r.stdout).toMatch(/\n\nNo changes\. Your infrastructure matches the configuration\.\n[\s\S]*no changes are needed\.\n\nApply complete! Resources: 0 added, 0 changed, 0 destroyed\.$/)
    expect(r.exitCode).toBe(0)
    expect(asked).toBe(false)
  })

  it('stops at a provider fault, keeps what was made, and succeeds on retry', async () => {
    const error = "creating EC2 Subnet: api error InvalidSubnet.Conflict: The CIDR '10.0.1.0/24' conflicts with another subnet"
    const w = world({ faults: [{ at: 'aws_subnet.a', on: 'create', error, times: 1 }] })
    const r = await w.run('apply', '-auto-approve')
    expect(r.stdout).toBe(`${PLAN}\naws_vpc.main: Creating...\naws_vpc.main: Creation complete after 1s [id=vpc-06357f366]\naws_subnet.a: Creating...`)
    expect(r.stderr).toContain(`Error: ${error}`)
    expect(r.stderr).toContain('with aws_subnet.a,')
    expect(r.exitCode).toBe(1)
    expect((await w.run('state', 'list')).stdout).toBe('aws_vpc.main')
    const again = await w.run('apply', '-auto-approve')
    expect(again.stdout).toMatch(/aws_subnet\.a: Creation complete after 1s \[id=subnet-[0-9a-f]+\]\n\nApply complete! Resources: 1 added, 0 changed, 0 destroyed\.$/)
    expect(again.exitCode).toBe(0)
  })

  it('a cancelled apply consumes no fault attempt', async () => {
    const error = 'creating EC2 Subnet: api error Throttling'
    const w = world({ faults: [{ at: 'aws_subnet.a', on: 'create', error, times: 1 }] }, { stdin: 'no\n' })
    expect((await w.run('apply')).stdout).toContain('Apply cancelled.')
    expect(w.lab.attempts.size).toBe(0)
    const hit = await w.run('apply', '-auto-approve')
    expect(hit.stderr).toContain(`Error: ${error}`)
    expect(hit.exitCode).toBe(1)
    expect(w.lab.attempts.get(0)).toBe(1)
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
  })

  it('applies a saved plan with no question, using the saved configuration', async () => {
    const w = world()
    const plan = await w.run('plan', '-out=tfplan')
    expect(plan.stdout).toContain('Saved the plan to: tfplan')
    expect(w.disk[`${DIR}/tfplan`]).toMatch(/^TFPLAN1\np[0-9a-f]{8}\n$/)
    w.disk[`${DIR}/main.tf`] = 'resource "aws_vpc" "main" {\n  cidr_block = "10.9.0.0/16"\n}\n'
    const r = await w.run('apply', 'tfplan')
    expect(r.stdout).toBe(`${PROGRESS}\n\n${DONE}`)
    expect(r.exitCode).toBe(0)
  })

  it('refuses a stale saved plan, a garbage file and a missing one', async () => {
    const w = world()
    await w.run('plan', '-out=tfplan')
    w.disk[`${DIR}/main.tf`] = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
    await w.run('apply', '-auto-approve')
    const stale = await w.run('apply', 'tfplan')
    expect(stale.stderr).toContain('Error: Saved plan is stale')
    expect(stale.stderr).toContain('can no longer be applied because the state was changed')
    expect(stale.exitCode).toBe(1)
    w.disk[`${DIR}/junk`] = 'hello\n'
    const junk = await w.run('apply', 'junk')
    expect(junk.stderr).toContain('Error: Failed to load "junk" as a plan file')
    expect(junk.stderr).toContain('Error: zip: not a valid zip file')
    w.disk[`${DIR}/forged`] = 'TFPLAN1\npdeadbeef\n'
    expect((await w.run('apply', 'forged')).stderr).toContain('Error: zip: not a valid zip file')
    const missing = await w.run('apply', 'nope')
    expect(missing.stderr).toContain('Error: Failed to load "nope" as a plan file')
    expect(missing.stderr).toContain('Error: stat nope: no such file or directory')
    expect(missing.exitCode).toBe(1)
  })

  it('refuses a saved plan from another state lineage', async () => {
    const w = world()
    await w.run('plan', '-out=tfplan')
    w.lab.state = { ...w.lab.state, lineage: '11111111-0000-4000-8000-000000000000' }
    const r = await w.run('apply', 'tfplan')
    expect(r.stderr).toContain('Error: Saved plan is stale')
    expect(r.exitCode).toBe(1)
    expect(w.lab.hasState).toBe(false)
  })

  it('refuses -var and -replace with a saved plan', async () => {
    const w = world()
    await w.run('plan', '-out=tfplan')
    const vars = await w.run('apply', 'tfplan', '-var=x=1')
    expect(vars.stderr).toContain("Error: Can't set variables when applying a saved plan")
    expect(vars.exitCode).toBe(1)
    const replace = await w.run('apply', '-replace=aws_vpc.main', 'tfplan')
    expect(replace.stderr).toContain("Error: Can't set -replace when applying a saved plan")
    expect(replace.exitCode).toBe(1)
    expect(w.lab.hasState).toBe(false)
    expect((await w.run('apply', 'tfplan')).exitCode).toBe(0)
  })

  it('a no-change plan -out writes nothing', async () => {
    const w = world()
    await w.run('apply', '-auto-approve')
    await w.run('plan', '-out=tfplan')
    expect(Object.hasOwn(w.disk, `${DIR}/tfplan`)).toBe(false)
  })

  it('outside the lab directory touches nothing in the lab world', async () => {
    const w = world({}, { stdin: 'yes\n' })
    w.disk['/tmp/main.tf'] = NET
    w.disk['/tmp/.terraform.lock.hcl'] = LOCK_FILE
    const r = await w.run('-chdir=/tmp', 'apply', '-auto-approve')
    expect(r.stdout).toContain(DONE)
    expect(r.ran).toBe('')
    expect(w.lab.hasState).toBe(false)
    expect(w.lab.state.resources).toEqual([])
    expect(w.lab.reality).toEqual({})
    await w.run('-chdir=/tmp', 'plan', '-out=tfplan')
    expect(Object.hasOwn(w.disk, '/tmp/tfplan')).toBe(false)
    expect(w.lab.savedPlans.size).toBe(0)
  })

  it('keeps -target and -refresh-only unavailable and rejects flags apply does not take', async () => {
    for (const flag of ['-target=aws_vpc.main', '-refresh-only']) {
      const r = await world().run('apply', flag)
      expect(r.stderr, flag).toContain('Error: Not available in this lab yet')
      expect(r.exitCode).toBe(1)
    }
    expect((await world().run('apply', '-out=x')).stderr).toContain('flag provided but not defined: -out')
    expect((await world().run('apply', '-input=false', '-no-color', '-lock=false', '-lock-timeout=5s', '-parallelism=2', '-compact-warnings', '-auto-approve')).exitCode).toBe(0)
  })
})

describe('terraform destroy', () => {
  const db = (protect: boolean) => world({ files: [{ path: 'main.tf', content: DB(protect) }], state: [DB_STATE] })

  it('refuses a protected resource, then destroys once unprotected', async () => {
    const w = db(true)
    const serial = w.lab.state.serial
    const r = await w.run('destroy', '-auto-approve')
    expect(r.stderr).toContain('Error: Instance cannot be destroyed')
    expect(r.exitCode).toBe(1)
    expect(w.lab.state.serial).toBe(serial)
    w.disk[`${DIR}/main.tf`] = DB(false)
    const ok = await w.run('destroy', '-auto-approve')
    expect(ok.stdout).toContain('  # aws_db_instance.main will be destroyed\n  - resource')
    expect(ok.stdout).toContain('aws_db_instance.main: Destroying... [id=db-1]')
    expect(ok.stdout).toMatch(/\n\nDestroy complete! Resources: 1 destroyed\.$/)
    expect(ok.exitCode).toBe(0)
    expect(ok.ran).toBe('terraform destroy')
    expect((await w.run('state', 'list')).stdout).toBe('')
  })

  it('asks its own question and cancels', async () => {
    const w = world({ files: [{ path: 'main.tf', content: DB(false) }], state: [DB_STATE] }, { stdin: 'no\n' })
    const r = await w.run('destroy')
    expect(r.stdout).toContain(`Plan: 0 to add, 0 to change, 1 to destroy.\n${DESTROY_PROMPT}no\n\nDestroy cancelled.`)
    expect(r.stdout.endsWith('Destroy cancelled.')).toBe(true)
    expect(r.exitCode).toBe(1)
    expect((await w.run('state', 'list')).stdout).toBe('aws_db_instance.main')
  })

  it('with nothing to destroy completes at once', async () => {
    const r = await world().run('destroy')
    expect(r.stdout).toMatch(/No changes\.[\s\S]*\n\nDestroy complete! Resources: 0 destroyed\.$/)
    expect(r.exitCode).toBe(0)
  })

  it('rejects -replace', async () => {
    const r = await world().run('destroy', '-replace=aws_vpc.main')
    expect(r.stderr).toContain('flag provided but not defined: -replace')
    expect(r.exitCode).toBe(1)
  })
})
