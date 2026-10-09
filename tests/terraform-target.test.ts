import { describe, expect, it } from 'vitest'
import { LOCK_FILE, runTerraform, worldPlan, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import type { TerraformBlock } from '../src/schema/scenario.ts'

const DIR = '/home/you/infra'
const ROOT = `resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

resource "aws_s3_bucket" "b" {
  for_each = toset(["x", "y"])
  bucket   = "logs-\${each.key}"
}

resource "aws_s3_bucket" "c" {
  count  = 2
  bucket = "cnt-\${count.index}"
}

output "vpc" {
  value = aws_vpc.main.id
}

output "bucket" {
  value = aws_s3_bucket.c[0].id
}
`

function world(files: Record<string, string> = { 'main.tf': ROOT }, o: { stdin?: string; confirm?: CliContext['confirm']; tf?: Partial<TerraformBlock>; manifest?: { key: string; source: string; dir: string }[] } = {}) {
  const block = { files: Object.entries(files).map(([path, content]) => ({ path, content })), ...(o.manifest ? { modules: { installed: o.manifest } } : {}), ...o.tf } as TerraformBlock
  const lab = labFromScenario(block, DIR, '/home/you')
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
const heads = (stdout: string) => stdout.split('\n').filter((l) => l.startsWith('  # ') && !l.startsWith('  # ('))
const refreshed = (stdout: string) => stdout.split('\n').filter((l) => l.includes(': Refreshing state...')).map((l) => l.split(':')[0])
const stateList = async (w: ReturnType<typeof world>) => (await w.run('state', 'list')).stdout.split('\n').filter(Boolean)
const applied = async (files?: Record<string, string>, o: Parameters<typeof world>[1] = {}) => {
  const w = world(files, o)
  expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
  return w
}

const PLAN_WARNING = `╷
│ Warning: Resource targeting is in effect
│ 
│ You are creating a plan with the -target option, which means that the result
│ of this plan may not represent all of the changes requested by the current
│ configuration.
│ 
│ The -target option is not for routine use, and is provided only for
│ exceptional situations such as recovering from errors or mistakes, or when
│ Terraform specifically suggests to use it as part of an error message.
╵`
const APPLY_WARNING = `╷
│ Warning: Applied changes may be incomplete
│ 
│ The plan was created with the -target option in effect, so some changes
│ requested in the configuration may have been ignored and the output values
│ may not be fully updated. Run the following command to verify that no other
│ changes are pending:
│     terraform plan
│ 
│ Note that the -target option is not suitable for routine use, and is
│ provided only for exceptional situations such as recovering from errors or
│ mistakes, or when Terraform specifically suggests to use it as part of an
│ error message.
╵`

describe('-target on plan', () => {
  it('plans the target and what it depends on, nothing else, with the warning after the plan', async () => {
    const w = world()
    const r = await w.run('plan', '-target=aws_subnet.a')
    expect(r.exitCode).toBe(0)
    expect(heads(r.stdout)).toEqual(['  # aws_subnet.a will be created', '  # aws_vpc.main will be created'])
    expect(r.stdout).toContain('Plan: 2 to add, 0 to change, 0 to destroy.\n\nChanges to Outputs:\n  + vpc = (known after apply)\n\n' + PLAN_WARNING + '\n\n')
    expect(r.stdout).not.toContain('bucket')
    expect(r.stdout.endsWith("Note: You didn't use the -out option to save this plan, so Terraform can't\nguarantee to take exactly these actions if you run \"terraform apply\" now.")).toBe(true)
  })

  it('a target with no dependencies plans alone; every spelling of the flag works', async () => {
    for (const args of [['-target=aws_vpc.main'], ['-target', 'aws_vpc.main'], ['--target=aws_vpc.main'], ['--target', 'aws_vpc.main']]) {
      const r = await world().run('plan', ...args)
      expect(heads(r.stdout), args.join(' ')).toEqual(['  # aws_vpc.main will be created'])
    }
  })

  it('refreshes only the targets and what they depend on', async () => {
    const w = await applied()
    expect(refreshed((await w.run('plan')).stdout)).toEqual(['aws_s3_bucket.b["x"]', 'aws_s3_bucket.b["y"]', 'aws_s3_bucket.c[0]', 'aws_s3_bucket.c[1]', 'aws_subnet.a', 'aws_vpc.main'])
    const r = await w.run('plan', '-target=aws_subnet.a')
    expect(refreshed(r.stdout)).toEqual(['aws_subnet.a', 'aws_vpc.main'])
    expect(r.stdout).toContain('No changes. Your infrastructure matches the configuration.')
    expect(r.stdout).toContain('Warning: Resource targeting is in effect')
  })

  it('objects outside the targets report no drift and are not refreshed', async () => {
    const w = await applied()
    const id = w.lab.state.resources.find((x) => x.name === 'c')!.instances[0].attributes.id as string
    w.lab.reality[`aws_s3_bucket:${id}`] = { ...w.lab.reality[`aws_s3_bucket:${id}`], bucket: 'changed' }
    expect((await w.run('plan')).stdout).toContain('has changed')
    const r = await w.run('plan', '-target=aws_vpc.main')
    expect(r.stdout).not.toContain('has changed')
    expect(r.stdout).not.toContain('aws_s3_bucket.c')
    await w.run('apply', '-auto-approve', '-target=aws_vpc.main')
    const c = w.lab.state.resources.find((x) => x.name === 'c')!.instances[0].attributes
    expect(c.bucket).toBe('cnt-0') // the recorded state of an untargeted object is not refreshed
  })

  it('instance targets on for_each and count resources', async () => {
    const w = world()
    expect(heads((await w.run('plan', '-target=aws_s3_bucket.b["x"]')).stdout)).toEqual(['  # aws_s3_bucket.b["x"] will be created'])
    expect(heads((await w.run('plan', '-target=aws_s3_bucket.c[1]')).stdout)).toEqual(['  # aws_s3_bucket.c[1] will be created'])
    expect(heads((await w.run('plan', '-target=aws_s3_bucket.c')).stdout)).toEqual(['  # aws_s3_bucket.c[0] will be created', '  # aws_s3_bucket.c[1] will be created'])
    const r = await w.run('plan', '-target=aws_s3_bucket.b["x"]')
    expect(r.stdout).toContain('Plan: 1 to add, 0 to change, 0 to destroy.\n\n' + PLAN_WARNING)
  })

  it('several targets add up', async () => {
    const r = await world().run('plan', '-target=aws_vpc.main', '-target', 'aws_s3_bucket.c[0]', '--target=aws_s3_bucket.b["y"]')
    expect(heads(r.stdout)).toEqual(['  # aws_s3_bucket.b["y"] will be created', '  # aws_s3_bucket.c[0] will be created', '  # aws_vpc.main will be created'])
    // the output depending only on a targeted resource is planned too
    expect(r.stdout).toContain('Changes to Outputs:\n  + bucket = (known after apply)\n  + vpc    = (known after apply)\n')
  })

  it('a root output is planned only when every resource it depends on is targeted', async () => {
    const r = await world().run('plan', '-target=aws_s3_bucket.b["x"]')
    expect(r.stdout).not.toContain('Changes to Outputs')
    const both = await world().run('plan', '-target=aws_s3_bucket.c')
    expect(both.stdout).toContain('+ bucket = (known after apply)')
  })

  it('the error for an invalid address names it and exits 1', async () => {
    const w = world()
    for (const bad of ['foo', 'module.', 'aws_vpc', '']) {
      const r = await w.run('plan', `-target=${bad}`)
      expect(r.exitCode, bad).toBe(1)
      expect(r.stdout, bad).toBe('')
      expect(r.stderr, bad).toBe(`╷\n│ Error: Invalid target ${JSON.stringify(bad)}\n│ \n│ Resource specification must include a resource type and name.\n╵`)
    }
    for (const cmd of ['apply', 'destroy']) expect((await w.run(cmd, '-target=foo')).stderr).toContain('Error: Invalid target "foo"')
    const missing = await w.run('plan', '-target')
    expect(missing.stderr).toContain('flag needs an argument: -target')
  })

  it('an address that matches nothing plans nothing; __proto__ is only a name', async () => {
    const w = world()
    for (const t of ['aws_vpc.nope', '__proto__.x', 'aws_s3_bucket.b["__proto__"]', 'module.__proto__', 'constructor.toString']) {
      const r = await w.run('plan', `-target=${t}`)
      expect(r.exitCode, t).toBe(0)
      expect(r.stdout, t).toContain('No changes. Your infrastructure matches the configuration.')
      expect(r.stdout, t).toContain('Warning: Resource targeting is in effect')
    }
    const key = world({ 'main.tf': 'resource "aws_s3_bucket" "b" {\n  for_each = toset(["__proto__", "x"])\n  bucket   = "l-${each.key}"\n}\n' })
    expect(heads((await key.run('plan', '-target=aws_s3_bucket.b["__proto__"]')).stdout)).toEqual(['  # aws_s3_bucket.b["__proto__"] will be created'])
  })

  it('untargeted output is unchanged', async () => {
    const r = await world().run('plan')
    expect(r.stdout).not.toContain('targeting')
    expect(r.stdout).toContain('Plan: 6 to add, 0 to change, 0 to destroy.\n\nChanges to Outputs:\n  + bucket = (known after apply)\n  + vpc    = (known after apply)\n\n─')
  })

  it('refresh and state commands still refuse -target', async () => {
    const w = world()
    expect((await w.run('refresh', '-target=aws_vpc.main')).exitCode).toBe(1)
    expect((await w.run('state', 'list', '-target=aws_vpc.main')).exitCode).toBe(1)
  })
})

describe('-target on apply', () => {
  it('prints the plan warning before the prompt and the applied warning before the summary', async () => {
    const w = world(undefined, { stdin: 'yes\n' })
    const r = await w.run('apply', '-target=aws_subnet.a')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(`${PLAN_WARNING}\n\nDo you want to perform these actions?\n  Terraform will perform the actions described above.\n  Only 'yes' will be accepted to approve.\n\n  Enter a value: yes\n\n`)
    expect(r.stdout).toMatch(/aws_subnet\.a: Creation complete after 1s \[id=subnet-[0-9a-f]+\]\n\n╷\n│ Warning: Applied changes may be incomplete/)
    expect(r.stdout).toContain(`${APPLY_WARNING}\n\nApply complete! Resources: 2 added, 0 changed, 0 destroyed.\n\nOutputs:\n\nvpc = "vpc-`)
    expect(await stateList(w)).toEqual(['aws_subnet.a', 'aws_vpc.main'])
    // only the outputs inside the targets are written
    expect(Object.keys(w.lab.state.outputs)).toEqual(['vpc'])
  })

  it('asks through the confirm hook with the warning shown; no cancels and changes nothing', async () => {
    const asked: string[] = []
    const w = world(undefined, { confirm: async (p) => (asked.push(p), 'no') })
    const r = await w.run('apply', '-target=aws_vpc.main')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain(PLAN_WARNING)
    expect(asked[0].endsWith('Enter a value: ')).toBe(true)
    expect(r.stdout).toContain('Apply cancelled.')
    expect(r.exitCode).toBe(1)
    expect(await stateList(w)).toEqual([])
  })

  it('-auto-approve skips the question; the warnings still print', async () => {
    const r = await world().run('apply', '-auto-approve', '-target=aws_vpc.main')
    expect(r.stdout).not.toContain('Enter a value')
    expect(r.stdout).toContain(PLAN_WARNING)
    expect(r.stdout).toContain(APPLY_WARNING)
  })

  it('an apply with nothing to do still ends with the applied warning', async () => {
    const w = await applied()
    const r = await w.run('apply', '-target=aws_vpc.main')
    expect(r.stdout).toContain(`${PLAN_WARNING}\n\n${APPLY_WARNING}\n\nApply complete! Resources: 0 added, 0 changed, 0 destroyed.`)
  })

  it('leaves the rest pending: a plain plan afterwards shows it', async () => {
    const w = world()
    await w.run('apply', '-auto-approve', '-target=aws_vpc.main')
    const r = await w.run('plan')
    expect(heads(r.stdout)).toEqual(['  # aws_s3_bucket.b["x"] will be created', '  # aws_s3_bucket.b["y"] will be created', '  # aws_s3_bucket.c[0] will be created', '  # aws_s3_bucket.c[1] will be created', '  # aws_subnet.a will be created'])
    expect(r.stdout).not.toContain('targeting')
  })

  it('records history like any apply and leaves done_when plans unclean', async () => {
    const w = world()
    await w.run('apply', '-auto-approve', '-target=aws_subnet.a')
    expect(w.lab.history).toEqual(['create aws_vpc.main', 'create aws_subnet.a'])
    const plan = await worldPlan(w.ctx)
    expect(plan!.items.filter((i) => i.action !== 'noop').map((i) => i.address)).toEqual(['aws_s3_bucket.b["x"]', 'aws_s3_bucket.b["y"]', 'aws_s3_bucket.c[0]', 'aws_s3_bucket.c[1]'])
  })

  it('plan -out saves the targets; apply of the file applies the same subset and warns at the end only', async () => {
    const w = world()
    const p = await w.run('plan', '-target=aws_subnet.a', '-out=tfplan')
    expect(p.stdout).toContain(`${PLAN_WARNING}\n\n─`)
    expect(p.stdout).toContain('Saved the plan to: tfplan')
    const r = await w.run('apply', 'tfplan')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).not.toContain('Resource targeting is in effect')
    expect(r.stdout).toContain(`${APPLY_WARNING}\n\nApply complete! Resources: 2 added, 0 changed, 0 destroyed.`)
    expect(await stateList(w)).toEqual(['aws_subnet.a', 'aws_vpc.main'])
  })

  it('a saved plan without targets is unchanged', async () => {
    const w = world()
    await w.run('plan', '-out=tfplan')
    const r = await w.run('apply', 'tfplan')
    expect(r.stdout).not.toContain('Warning')
    expect(await stateList(w)).toHaveLength(6)
  })
})

describe('-target on destroy', () => {
  it('destroys the targets and what depends on them, keeps everything else', async () => {
    const w = await applied()
    const r = await w.run('destroy', '-target=aws_vpc.main', '-auto-approve')
    expect(r.exitCode).toBe(0)
    expect(refreshed(r.stdout)).toEqual(['aws_subnet.a', 'aws_vpc.main'])
    expect(heads(r.stdout)).toEqual(['  # aws_subnet.a will be destroyed', '  # aws_vpc.main will be destroyed'])
    expect(r.stdout).toContain('Plan: 0 to add, 0 to change, 2 to destroy.\n\nChanges to Outputs:\n  - vpc = "vpc-0ba6e49a7" -> null\n\n' + PLAN_WARNING)
    expect(r.stdout).toContain(`${APPLY_WARNING}\n\nDestroy complete! Resources: 2 destroyed.`)
    expect(await stateList(w)).toEqual(['aws_s3_bucket.b["x"]', 'aws_s3_bucket.b["y"]', 'aws_s3_bucket.c[0]', 'aws_s3_bucket.c[1]'])
    expect(Object.keys(w.lab.state.outputs)).toEqual(['bucket'])
  })

  it('a dependent target does not take what it depends on', async () => {
    const w = await applied()
    await w.run('destroy', '-target=aws_subnet.a', '-auto-approve')
    expect(await stateList(w)).toContain('aws_vpc.main')
    expect(await stateList(w)).not.toContain('aws_subnet.a')
  })

  it('instance targets and the destroy prompt', async () => {
    const w = await applied()
    const w2 = world(undefined, { stdin: 'yes\n' })
    w2.lab.state = w.lab.state
    w2.lab.reality = w.lab.reality
    w2.lab.hasState = true
    const r = await w2.run('destroy', '-target=aws_s3_bucket.b["x"]')
    expect(heads(r.stdout)).toEqual(['  # aws_s3_bucket.b["x"] will be destroyed'])
    expect(r.stdout).toContain(`${PLAN_WARNING}\n\nDo you really want to destroy all resources?`)
    expect(await stateList(w2)).toHaveLength(5)
  })
})

const DB = (protect: boolean) =>
  `resource "aws_db_instance" "main" {\n  identifier     = "orders"\n  engine         = "postgres"\n  instance_class = "db.t3.micro"\n  username       = "app"\n  password       = "hunter22"\n${protect ? '\n  lifecycle {\n    prevent_destroy = true\n  }\n' : ''}}\n\nresource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n`
const DB_STATE = {
  type: 'aws_db_instance',
  name: 'main',
  attrs: { id: 'db-1', arn: 'arn:db-1', identifier: 'orders', engine: 'postgres', engine_version: '16.3', instance_class: 'db.t3.micro', allocated_storage: 20, storage_encrypted: false, kms_key_id: '', db_name: '', username: 'app', password: 'hunter22', multi_az: false, skip_final_snapshot: false, endpoint: 'orders.x:5432', tags: {}, tags_all: {} },
}

describe('-target and prevent_destroy', () => {
  it('targeting another resource avoids the error; targeting the protected one still raises it', async () => {
    const w = world({ 'main.tf': DB(true) }, { tf: { state: [DB_STATE] } })
    const blocked = await w.run('plan', '-replace=aws_db_instance.main')
    expect(blocked.stderr).toContain('Error: Instance cannot be destroyed')
    const around = await w.run('plan', '-replace=aws_db_instance.main', '-target=aws_vpc.main')
    expect(around.exitCode).toBe(0)
    expect(around.stderr).toBe('')
    expect(heads(around.stdout)).toEqual(['  # aws_vpc.main will be created'])
    const hit = await w.run('plan', '-replace=aws_db_instance.main', '-target=aws_db_instance.main')
    expect(hit.exitCode).toBe(1)
    expect(hit.stdout).toContain('Terraform planned the following actions, but then encountered a problem:\n\n  # aws_db_instance.main will be replaced, as requested\n')
    expect(hit.stdout).toContain(PLAN_WARNING)
    expect(hit.stderr).toContain('│ Error: Instance cannot be destroyed')
  })

  it('apply with the protected resource outside the targets goes ahead', async () => {
    const w = world({ 'main.tf': DB(true) }, { tf: { state: [DB_STATE] }, stdin: 'yes\n' })
    const r = await w.run('apply', '-replace=aws_db_instance.main', '-target=aws_vpc.main')
    expect(r.exitCode).toBe(0)
    expect(await stateList(w)).toEqual(['aws_db_instance.main', 'aws_vpc.main'])
  })

  it('destroy: the protected resource outside the targets is left alone', async () => {
    const w = world({ 'main.tf': DB(true) }, { tf: { state: [DB_STATE] } })
    await w.run('apply', '-auto-approve', '-target=aws_vpc.main')
    const r = await w.run('destroy', '-target=aws_vpc.main', '-auto-approve')
    expect(r.exitCode).toBe(0)
    expect(await stateList(w)).toEqual(['aws_db_instance.main'])
    const blocked = await w.run('destroy', '-target=aws_db_instance.main', '-auto-approve')
    expect(blocked.exitCode).toBe(1)
    expect(blocked.stderr).toContain('Error: Instance cannot be destroyed')
  })
})

const MOD_ROOT = `module "net" {
  source   = "./modules/net"
  for_each = toset(["a", "b"])
  cidr     = each.key == "a" ? "10.0.0.0/16" : "10.1.0.0/16"
}

module "solo" {
  source = "./modules/net"
  cidr   = "10.9.0.0/16"
}

resource "aws_subnet" "s" {
  vpc_id     = module.solo.vpc_id
  cidr_block = "10.9.1.0/24"
}

resource "aws_s3_bucket" "other" {
  bucket = "other"
}
`
const NET = 'variable "cidr" {\n  type = string\n}\n\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}\n\nresource "aws_subnet" "in" {\n  vpc_id     = aws_vpc.main.id\n  cidr_block = cidr_subnet(var.cidr)\n}\n\noutput "vpc_id" {\n  value = aws_vpc.main.id\n}\n'
const NET_FIXED = NET.replace('cidr_subnet(var.cidr)', '"10.0.1.0/24"')
const MANIFEST = [
  { key: 'net', source: './modules/net', dir: 'modules/net' },
  { key: 'solo', source: './modules/net', dir: 'modules/net' },
]
const modWorld = (o: Parameters<typeof world>[1] = {}) => world({ 'main.tf': MOD_ROOT, 'modules/net/main.tf': NET_FIXED }, { manifest: MANIFEST, ...o })

describe('-target with modules', () => {
  it('a module target covers every instance and every resource under it', async () => {
    const r = await modWorld().run('plan', '-target=module.net')
    expect(heads(r.stdout)).toEqual(['  # module.net["a"].aws_subnet.in will be created', '  # module.net["a"].aws_vpc.main will be created', '  # module.net["b"].aws_subnet.in will be created', '  # module.net["b"].aws_vpc.main will be created'])
    expect(r.stdout).toContain(PLAN_WARNING)
  })

  it('a keyed module target covers that instance only', async () => {
    const r = await modWorld().run('plan', '-target=module.net["a"]')
    expect(heads(r.stdout)).toEqual(['  # module.net["a"].aws_subnet.in will be created', '  # module.net["a"].aws_vpc.main will be created'])
  })

  it('a resource inside a module instance, and a resource inside every instance', async () => {
    const w = modWorld()
    // A dependency is not filtered to the targeted instance: Terraform only narrows nodes that are targeted directly.
    expect(heads((await w.run('plan', '-target=module.net["b"].aws_subnet.in')).stdout)).toEqual(['  # module.net["a"].aws_vpc.main will be created', '  # module.net["b"].aws_subnet.in will be created', '  # module.net["b"].aws_vpc.main will be created'])
    expect(heads((await w.run('plan', '-target=module.net["b"].aws_vpc.main')).stdout)).toEqual(['  # module.net["b"].aws_vpc.main will be created'])
    expect(heads((await w.run('plan', '-target=module.net.aws_vpc.main')).stdout)).toEqual(['  # module.net["a"].aws_vpc.main will be created', '  # module.net["b"].aws_vpc.main will be created'])
  })

  it('a root resource pulls in the module it reads from', async () => {
    const r = await modWorld().run('plan', '-target=aws_subnet.s')
    expect(heads(r.stdout)).toEqual(['  # aws_subnet.s will be created', '  # module.solo.aws_vpc.main will be created'])
  })

  it('module targets with apply and destroy; the rest of the modules stay', async () => {
    const w = modWorld()
    await w.run('apply', '-auto-approve', '-target=module.net["a"]')
    expect(await stateList(w)).toEqual(['module.net["a"].aws_subnet.in', 'module.net["a"].aws_vpc.main'])
    await w.run('apply', '-auto-approve')
    expect(await stateList(w)).toHaveLength(8)
    const r = await w.run('destroy', '-target=module.solo.aws_vpc.main', '-auto-approve')
    expect(refreshed(r.stdout)).toEqual(['aws_subnet.s', 'module.solo.aws_subnet.in', 'module.solo.aws_vpc.main'])
    expect(await stateList(w)).toEqual(['aws_s3_bucket.other', 'module.net["a"].aws_subnet.in', 'module.net["a"].aws_vpc.main', 'module.net["b"].aws_subnet.in', 'module.net["b"].aws_vpc.main'])
  })

  it('nested modules: the outer module covers the inner, the inner can be targeted alone', async () => {
    const files = {
      'main.tf': 'module "net" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\n\nresource "aws_s3_bucket" "other" {\n  bucket = "other"\n}\n',
      'modules/net/main.tf': 'variable "cidr" {\n  type = string\n}\n\nmodule "inner" {\n  source = "./inner"\n  cidr   = var.cidr\n}\n\nresource "aws_subnet" "own" {\n  vpc_id     = module.inner.vpc_id\n  cidr_block = "10.0.1.0/24"\n}\n\noutput "vpc_id" {\n  value = module.inner.vpc_id\n}\n',
      'modules/net/inner/main.tf': 'variable "cidr" {\n  type = string\n}\n\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}\n\noutput "vpc_id" {\n  value = aws_vpc.main.id\n}\n',
    }
    const manifest = [
      { key: 'net', source: './modules/net', dir: 'modules/net' },
      { key: 'net.inner', source: './inner', dir: 'modules/net/inner' },
    ]
    const w = world(files, { manifest })
    expect(heads((await w.run('plan', '-target=module.net')).stdout)).toEqual(['  # module.net.aws_subnet.own will be created', '  # module.net.module.inner.aws_vpc.main will be created'])
    expect(heads((await w.run('plan', '-target=module.net.module.inner')).stdout)).toEqual(['  # module.net.module.inner.aws_vpc.main will be created'])
    expect(heads((await w.run('plan', '-target=module.net.aws_subnet.own')).stdout)).toEqual(['  # module.net.aws_subnet.own will be created', '  # module.net.module.inner.aws_vpc.main will be created'])
    expect(heads((await w.run('plan', '-target=module.net.module.inner.aws_vpc.main')).stdout)).toEqual(['  # module.net.module.inner.aws_vpc.main will be created'])
  })
})
