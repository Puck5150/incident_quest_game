import { describe, expect, it } from 'vitest'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { lockFile } from '../src/game/terraform/layout.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import type { TerraformBlock } from '../src/schema/scenario.ts'

const VPC_TF = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const VPC = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1' } }

// An in-memory directory standing in for the simulated disk.
function world(tf: Partial<TerraformBlock> = {}, o: { files?: Record<string, string>; cwd?: string; env?: Record<string, string>; skipLock?: boolean; mainHost?: boolean } = {}) {
  const lab = labFromScenario({ files: [{ path: 'main.tf', content: VPC_TF }], state: [VPC], ...tf } as TerraformBlock, '/home/you/infra', '/home/you')
  const disk: Record<string, string> = {}
  for (const f of lab.files) disk[f.path] = f.content
  if (lab.initialized && !o.skipLock) disk['/home/you/infra/.terraform.lock.hcl'] = LOCK_FILE
  Object.assign(disk, o.files ?? {})
  const ctx: CliContext = {
    lab,
    cwd: o.cwd ?? '/home/you/infra',
    mainHost: o.mainHost ?? true,
    env: o.env ?? {},
    taken: new Set(),
    listFiles: async (dir) => Object.entries(disk).filter(([p]) => p.slice(0, p.lastIndexOf('/')) === dir).map(([p, text]) => ({ name: p.slice(p.lastIndexOf('/') + 1), text })),
    readFile: async (p) => disk[p],
    write: async (dir, name, text) => void (disk[`${dir}/${name}`] = text),
  }
  return { ctx, disk, run: (...args: string[]) => runTerraform(args, ctx) }
}

describe('terraform: basics', () => {
  it('prints the version, with providers once initialised', async () => {
    expect((await world().run('version')).stdout).toBe('Terraform v1.9.8\non linux_amd64\n+ provider registry.terraform.io/hashicorp/aws v5.67.0')
    expect((await world({}, { skipLock: true }).run('-version')).stdout).toBe('Terraform v1.9.8\non linux_amd64')
  })

  it('prints usage with no arguments and for -help, and rejects an unknown command', async () => {
    const usage = (await world().run()).stdout
    expect(usage).toContain('Usage: terraform [global options] <subcommand> [args]')
    expect(usage).toContain('  plan          Show changes required by the current configuration')
    expect((await world().run('-help')).stdout).toBe(usage)
    const bad = await world().run('frobnicate')
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toBe('Terraform has no command named "frobnicate".\n\nTo see all of Terraform\'s top-level commands, run:\n  terraform -help')
  })

  it('answers the commands that need a later milestone honestly', async () => {
    for (const args of [['console'], ['state', 'push', 'x'], ['state', 'replace-provider', 'a', 'b']]) {
      const r = await world().run(...args)
      expect(r.exitCode, args.join(' ')).toBe(1)
      expect(r.stderr).toContain('Error: Not available in this lab yet')
    }
    expect((await world().run('console')).stderr).toContain('"terraform console" is not simulated yet')
  })

  it('honours -chdir', async () => {
    const w = world({}, { cwd: '/home/you' })
    const none = await w.run('plan')
    expect(none.exitCode).toBe(1)
    expect(none.stderr).toContain('Error: No configuration files')
    expect((await w.run('-chdir=infra', 'plan')).stdout).toContain('No changes.')
  })
})

describe('terraform init and validate', () => {
  it('initialises, writing the lock file, and is quieter the second time', async () => {
    const w = world({ initialized: false }, { skipLock: true })
    const first = await w.run('init')
    expect(first.exitCode).toBe(0)
    expect(first.stdout).toContain('Initializing the backend...')
    expect(first.stdout).toContain('- Installing hashicorp/aws v5.67.0...')
    expect(first.stdout).toContain('Terraform has created a lock file .terraform.lock.hcl')
    expect(first.stdout).toContain('Terraform has been successfully initialized!')
    expect(w.disk['/home/you/infra/.terraform.lock.hcl']).toContain('provider "registry.terraform.io/hashicorp/aws"')
    const second = await w.run('init')
    expect(second.stdout).toContain('- Reusing previous version of hashicorp/aws from the dependency lock file')
    expect(second.stdout).not.toContain('has created a lock file')
  })

  it('validates a good configuration and reports bad ones', async () => {
    expect((await world().run('validate')).stdout).toBe('Success! The configuration is valid.\n')
    const syntax = await world({ files: [{ path: 'main.tf', content: 'resource "aws_vpc" "main" {\n  cidr_block\n}\n' }] }).run('validate')
    expect(syntax.exitCode).toBe(1)
    expect(syntax.stderr).toContain('Error: Argument or block definition required')
    expect(syntax.stderr).toContain('on main.tf line 2')
    const unknown = await world({ files: [{ path: 'main.tf', content: 'resource "aws_nope" "x" {}\n' }] }).run('validate')
    expect(unknown.stderr).toContain('Error: Invalid resource type')
    const ref = await world({ files: [{ path: 'main.tf', content: 'resource "aws_subnet" "s" {\n  vpc_id = aws_vpc.nope.id\n}\n' }] }).run('validate')
    expect(ref.stderr).toContain('Reference to undeclared resource')
  })

  it('needs initialisation to validate or plan', async () => {
    const w = world({ initialized: false }, { skipLock: true })
    for (const sub of ['validate', 'plan']) {
      const r = await w.run(sub)
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain('Error: Inconsistent dependency lock file')
      expect(r.stderr).toContain('provider registry.terraform.io/hashicorp/aws: required by this configuration but no version is selected')
      expect(r.stderr).toContain('terraform init')
    }
  })
})

describe('terraform plan', () => {
  it('prints refresh lines, then no changes', async () => {
    const r = await world().run('plan')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe(
      ['aws_vpc.main: Refreshing state... [id=vpc-1]', '', 'No changes. Your infrastructure matches the configuration.', '', 'Terraform has compared your real infrastructure against your configuration', 'and found no differences, so no changes are needed.'].join('\n'),
    )
  })

  it('plans the edit the player made, with the -out note when not saving', async () => {
    const w = world({}, { files: { '/home/you/infra/main.tf': 'resource "aws_vpc" "main" {\n  cidr_block = "10.1.0.0/16"\n}\n' } })
    const r = await w.run('plan')
    expect(r.stdout).toContain('# aws_vpc.main must be replaced')
    expect(r.stdout).toContain('~ cidr_block                = "10.0.0.0/16" -> "10.1.0.0/16" # forces replacement')
    expect(r.stdout).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
    expect(r.stdout.endsWith('Note: You didn\'t use the -out option to save this plan, so Terraform can\'t\nguarantee to take exactly these actions if you run "terraform apply" now.')).toBe(true)
    expect(r.stdout).toContain('─'.repeat(77))
    const saved = await w.run('plan', '-out=tfplan')
    expect(saved.stdout).toContain('Saved the plan to: tfplan')
    expect(saved.stdout).not.toContain("You didn't use the -out option")
    expect((await w.run('plan', '-detailed-exitcode')).exitCode).toBe(2)
  })

  it('prints configuration errors to stderr with exit 1 and no refresh lines', async () => {
    const r = await world({}, { files: { '/home/you/infra/main.tf': 'resource "aws_vpc" "main" {\n  cidr_block\n}\n' } }).run('plan')
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('Error: Argument or block definition required')
  })

  it('applies variables in Terraform precedence', async () => {
    const tf = 'variable "cidr" {\n  default = "10.0.0.0/16"\n}\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}\n'
    const w = (extra: Record<string, string>, tfv: Partial<TerraformBlock> = {}, env: Record<string, string> = {}) =>
      world({ files: [{ path: 'main.tf', content: tf }], ...tfv }, { files: extra, env })
    const out = async (r: Promise<{ stdout: string }>) => (await r).stdout
    const dir = '/home/you/infra'
    // The plan prints `cidr_block = "old" -> "new"`, so the winning value is the one after the arrow.
    expect(await out(w({}).run('plan'))).not.toContain('->')
    expect(await out(w({}, { vars: { cidr: '10.2.0.0/16' } }).run('plan'))).toContain('-> "10.2.0.0/16"')
    expect(await out(w({}, { vars: { cidr: '10.2.0.0/16' } }, { TF_VAR_cidr: '10.3.0.0/16' }).run('plan'))).toContain('-> "10.3.0.0/16"')
    expect(await out(w({ [`${dir}/terraform.tfvars`]: 'cidr = "10.4.0.0/16"\n' }, {}, { TF_VAR_cidr: '10.3.0.0/16' }).run('plan'))).toContain('-> "10.4.0.0/16"')
    expect(await out(w({ [`${dir}/terraform.tfvars`]: 'cidr = "10.4.0.0/16"\n', [`${dir}/z.auto.tfvars`]: 'cidr = "10.5.0.0/16"\n' }).run('plan'))).toContain('-> "10.5.0.0/16"')
    expect(await out(w({ [`${dir}/prod.tfvars`]: 'cidr = "10.6.0.0/16"\n', [`${dir}/z.auto.tfvars`]: 'cidr = "10.5.0.0/16"\n' }).run('plan', '-var-file=prod.tfvars'))).toContain('-> "10.6.0.0/16"')
    expect(await out(w({ [`${dir}/prod.tfvars`]: 'cidr = "10.6.0.0/16"\n' }).run('plan', '-var-file=prod.tfvars', '-var', 'cidr=10.7.0.0/16'))).toContain('-> "10.7.0.0/16"')
    expect(await out(w({}).run('plan', '-var=cidr=10.8.0.0/16'))).toContain('-> "10.8.0.0/16"')
  })

  it('reports a bad tfvars file, a missing var file and an unsupported option', async () => {
    const dir = '/home/you/infra'
    const bad = await world({}, { files: { [`${dir}/terraform.tfvars`]: 'cidr = \n' } }).run('plan')
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toContain('terraform.tfvars')
    const missing = await world().run('plan', '-var-file=nope.tfvars')
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('nope.tfvars')
    for (const flag of ['-refresh-only', '-destroy']) {
      const r = await world().run('plan', flag)
      expect(r.exitCode, flag).toBe(1)
      expect(r.stderr).toContain('Not available in this lab yet')
    }
  })

  it('passes -replace and -refresh=false through to the planner', async () => {
    const r = await world().run('plan', '-replace=aws_vpc.main')
    expect(r.stdout).toContain('# aws_vpc.main will be replaced, as requested')
    expect((await world().run('plan', '-refresh=false')).stdout).not.toContain('Refreshing state')
  })

  it('with no configuration is an error with no plan, exit 1', async () => {
    const r = await world({}, { cwd: '/home/you' }).run('plan')
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('Error: No configuration files')
    // The box wraps its detail at 76 columns, so compare with the box margins folded away.
    expect(r.stderr.replace(/\n│ /g, ' ')).toContain(
      'Plan requires configuration to be present. Planning without a configuration would mark everything for destruction, which is normally not what is desired. If you would like to destroy everything, run plan with the -destroy option. Otherwise, create a Terraform configuration file (.tf file) and try again.',
    )
    const chdir = await world().run('-chdir=../../../etc', 'plan')
    expect(chdir.exitCode).toBe(1)
    expect(chdir.stderr).toContain('Error: No configuration files')
  })

  it('uses no lab state outside the lab directory or off the main host', async () => {
    const other = '/home/you/other'
    const w = world({ outputs: { id: { value: 'vpc-1' } } }, { files: { [`${other}/main.tf`]: VPC_TF, [`${other}/.terraform.lock.hcl`]: LOCK_FILE } })
    const plan = await w.run('-chdir=../other', 'plan')
    expect(plan.stdout).toContain('Plan: 1 to add, 0 to change, 0 to destroy.')
    expect(plan.stdout).not.toContain('Refreshing state')
    expect((await w.run('-chdir=../other', 'state', 'list')).stderr).toContain('No state file was found!')
    expect((await w.run('-chdir=../other', 'show')).stdout).toBe('No state.')
    expect((await w.run('-chdir=../other', 'output')).stdout).toContain('Warning: No outputs found')
    const ssh = world({ outputs: { id: { value: 'vpc-1' } } }, { mainHost: false })
    expect((await ssh.run('state', 'list')).stderr).toContain('No state file was found!')
    expect((await ssh.run('show')).stdout).toBe('No state.')
    expect((await ssh.run('output')).stdout).toContain('No outputs found')
    expect((await ssh.run('plan')).stdout).toContain('Plan: 1 to add')
  })

  it('rejects a -replace value that is not a resource instance address', async () => {
    const r = await world().run('plan', '-replace=bogus')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Error: Invalid force-replace address "bogus"')
    expect(r.stderr).toContain('The force-replace address "bogus" is not a valid resource instance address.')
  })

  it('shows drift only when the plan uses it, and reads data sources', async () => {
    const tf = 'data "aws_ami" "x" {}\nresource "aws_instance" "i" {\n  ami = data.aws_ami.x.id\n  instance_type = "t3.micro"\n}\n'
    const r = await world({ files: [{ path: 'main.tf', content: tf }], state: [{ mode: 'data', type: 'aws_ami', name: 'x', attrs: { id: 'ami-1' } }] }).run('plan')
    expect(r.stdout).toContain('data.aws_ami.x: Reading...')
    expect(r.stdout).toContain('data.aws_ami.x: Read complete after 0s [id=ami-1]')
    expect(r.stdout).toContain('# aws_instance.i will be created')
  })
})

describe('terraform state, show and output', () => {
  const tf = (extra: Partial<TerraformBlock> = {}) => world({ state: [VPC, { type: 'aws_s3_bucket', name: 'b', key: 'a', attrs: { id: 'b-a', bucket: 'b-a' } }], ...extra })

  it('lists, filters and shows state', async () => {
    expect((await tf().run('state', 'list')).stdout).toBe('aws_s3_bucket.b["a"]\naws_vpc.main')
    expect((await tf().run('state', 'list', 'aws_vpc.main')).stdout).toBe('aws_vpc.main')
    expect((await tf().run('state', 'list', 'aws_s3_bucket.b')).stdout).toBe('aws_s3_bucket.b["a"]')
    const show = await tf().run('state', 'show', 'aws_vpc.main')
    expect(show.stdout).toContain('# aws_vpc.main:\nresource "aws_vpc" "main" {')
    expect(show.stdout).toContain('    cidr_block                = "10.0.0.0/16"')
    expect((await tf().run('state', 'show', 'aws_s3_bucket.b["a"]')).stdout).toContain('# aws_s3_bucket.b["a"]:')
    const missing = await tf().run('state', 'show', 'aws_vpc.nope')
    expect(missing.exitCode).toBe(1)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toBe(
      'No instance found for the given address!\n\nThis command requires that the address references one specific instance.\nTo view the available instances, use "terraform state list". Please modify \nthe address to reference a specific instance.',
    )
  })

  it('state list reports a missing address as a boxed error and a type-only address as unparseable', async () => {
    const detail = (what: string, addr: string) =>
      `The current state contains no ${what} ${addr}. If you've just added this resource to the configuration, you must run "terraform apply" first to create the resource's entry in the state.`
    const none = await tf().run('state', 'list', 'aws_vpc.nope')
    expect(none.exitCode).toBe(1)
    expect(none.stderr).toContain('Error: Unknown resource\n')
    expect(none.stderr.replace(/\n│ /g, ' ')).toContain(detail('resource', 'aws_vpc.nope'))
    const inst = await tf().run('state', 'list', 'aws_s3_bucket.b["z"]')
    expect(inst.exitCode).toBe(1)
    expect(inst.stderr).toContain('Error: Unknown resource instance')
    expect(inst.stderr.replace(/\n│ /g, ' ')).toContain(
      'The current state contains no resource instance aws_s3_bucket.b["z"]. If you\'ve just added its resource to the configuration or have changed the count or for_each arguments, you must run "terraform apply" first to update the resource\'s entry in the state.',
    )
    const typeOnly = await tf().run('state', 'list', 'aws_vpc')
    expect(typeOnly.exitCode).toBe(1)
    expect(typeOnly.stderr).toContain('Error: Invalid address')
    expect(typeOnly.stderr.replace(/\n│ /g, ' ')).toContain('Resource specification must include a resource type and name.')
    const mod = await tf().run('state', 'list', 'module.m.aws_vpc.a')
    expect(mod.stderr).toContain('Error: Unknown resource\n')
  })

  it('state show: a type-only address is a plain parse error, a missing instance a plain not-found', async () => {
    const typeOnly = await tf().run('state', 'show', 'aws_vpc')
    expect(typeOnly.exitCode).toBe(1)
    expect(typeOnly.stderr).toBe(
      'Error parsing instance address: aws_vpc\n\nThis command requires that the address references one specific instance.\nTo view the available instances, use "terraform state list". Please modify \nthe address to reference a specific instance.',
    )
    const gone = await tf().run('state', 'show', 'aws_vpc.nope')
    expect(gone.exitCode).toBe(1)
    expect(gone.stderr).toContain('No instance found for the given address!')
  })

  it('pulls state as JSON, shows it, and has the default workspace', async () => {
    const pull = JSON.parse((await tf().run('state', 'pull')).stdout)
    expect(pull).toMatchObject({ version: 4, serial: 12, terraform_version: '1.9.8' })
    expect((await tf().run('show')).stdout).toContain('# aws_vpc.main:')
    expect((await tf().run('workspace', 'show')).stdout).toBe('default')
    expect((await tf().run('workspace', 'list')).stdout).toBe('* default\n')
  })

  it('says so when there is no state file at all', async () => {
    const w = world({ state: undefined })
    const r = await w.run('state', 'list')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('No state file was found!')
  })

  it('prints outputs', async () => {
    const w = world({ outputs: { id: { value: 'vpc-1' }, pw: { value: 'x', sensitive: true } } })
    expect((await w.run('output')).stdout).toBe('id = "vpc-1"\npw = <sensitive>')
    expect((await w.run('output', '-raw', 'id')).stdout).toBe('vpc-1')
    expect((await w.run('output', 'nope')).exitCode).toBe(1)
  })

  it('prints output flags and warnings the way Terraform does', async () => {
    const w = world({ outputs: { tags: { value: { Name: 'x', LongerKey: 'y' } }, id: { value: 'vpc-1' } } })
    expect((await w.run('output', 'tags')).stdout).toBe('{\n  "LongerKey" = "y"\n  "Name" = "x"\n}')
    expect((await w.run('output', '-json', 'tags')).stdout).toBe('{"LongerKey":"y","Name":"x"}')
    expect(JSON.parse((await w.run('output', '-json')).stdout).id).toEqual({ sensitive: false, type: 'string', value: 'vpc-1' })
    expect((await w.run('output', '-raw')).stderr).toContain('Error: Raw output format is only supported for single outputs')
    expect((await w.run('output', '-raw', 'tags')).stderr).toContain('Error: Unsupported value for raw output')
    const empty = await world({ outputs: {} }).run('output', 'x')
    expect(empty.exitCode).toBe(0)
    expect(empty.stdout).toContain('Warning: No outputs found')
    const nul = await world({ outputs: { n: { value: null } } }).run('output', '-raw', 'n')
    expect(nul.exitCode).toBe(1)
    expect(nul.stderr).toContain('Error: Unsupported value for raw output')
    expect(nul.stderr.replace(/\n│ /g, ' ')).toContain('The value for output value "n" is null, so -raw mode cannot print it.')
    expect((await world({ outputs: { id: { value: 'v' } } }).run('output', '-raw', 'id')).raw).toBe(true)
    const none = await world({ outputs: {} }).run('output')
    expect(none.exitCode).toBe(0)
    expect(none.stderr).toBe('')
    expect(none.stdout).toContain('Warning: No outputs found')
  })
})

const VAR_TF = (type: string, use: string) => `variable "v" {\n  ${type}\n}\nresource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  enable_dns_support = ${use}\n}\n`
const varWorld = (type: string, use: string, o: Parameters<typeof world>[1] = {}) => world({ files: [{ path: 'main.tf', content: VAR_TF(type, use) }] }, o)

describe('terraform variables', () => {
  it('converts -var strings to the declared bool and number types, and leaves untyped ones as strings', async () => {
    // state has enable_dns_support = true; `var.v == false` is a bool only when the string was converted.
    const eq = (type: string) => varWorld(type, 'var.v == false').run('plan', '-var', 'v=false')
    expect((await eq('type = bool')).stdout).toContain('No changes.')
    expect((await eq('')).stdout).toContain('true -> false')
    const n = (type: string) =>
      world({ files: [{ path: 'main.tf', content: `variable "n" {\n  ${type}\n}\nresource "aws_vpc" "main" {\n  cidr_block = var.n == 2 ? "10.2.0.0/16" : "10.9.0.0/16"\n}\n` }] }).run('plan', '-var', 'n=2')
    expect((await n('type = number')).stdout).toContain('"10.0.0.0/16" -> "10.2.0.0/16"')
    expect((await n('')).stdout).toContain('"10.0.0.0/16" -> "10.9.0.0/16"')
  })

  it('reports a value that cannot be converted, naming the variable and where it is declared', async () => {
    for (const [type, val] of [['number', 'abc'], ['bool', 'yes']]) {
      const r = await varWorld(`type = ${type}`, 'true').run('plan', '-var', `v=${val}`)
      expect(r.exitCode).toBe(1)
      expect(r.stdout).toBe('')
      expect(r.stderr).toContain('Error: Invalid value for input variable')
      expect(r.stderr.replace(/\n│ /g, ' ')).toContain(`Unsuitable value for var.v set using -var="v=${val}": a ${type} is required.`)
    }
  })

  it('words the conversion error by origin, and accepts 1 and 0 for bool', async () => {
    const err = (r: { stderr: string }) => r.stderr.replace(/\n│ /g, ' ')
    const env = await varWorld('type = number', 'true', { env: { TF_VAR_v: 'abc' } }).run('plan')
    expect(err(env)).toContain('Unsuitable value for var.v set using the TF_VAR_v environment variable: a number is required.')
    const file = await varWorld('type = number', 'true', { files: { '/home/you/infra/terraform.tfvars': 'v = "abc"\n' } }).run('plan')
    expect(err(file)).toContain('The given value is not suitable for var.v declared at main.tf:1: a number is required.')
    const str = await varWorld('type = string', 'true', { files: { '/home/you/infra/terraform.tfvars': 'v = [1]\n' } }).run('plan')
    expect(err(str)).toContain('declared at main.tf:1: a string is required.')
    const cap = await varWorld('type = bool', 'true').run('plan', '-var', 'v=True')
    expect(err(cap)).toContain('a bool is required; to convert from string, use lowercase "true".')
    expect(err(await varWorld('type = bool', 'true').run('plan', '-var', 'v=False'))).toContain('use lowercase "false".')
    const eq = (v: string) => varWorld('type = bool', 'var.v == false').run('plan', '-var', `v=${v}`)
    expect((await eq('0')).stdout).toContain('No changes.')
    expect((await eq('1')).stdout).toContain('true -> false')
  })

  it('parses collection-typed values from -var and TF_VAR_ as expressions', async () => {
    const tf = (type: string, expr: string) => ({ files: [{ path: 'main.tf', content: `variable "v" {\n  type = ${type}\n}\noutput "o" {\n  value = ${expr}\n}\n` }] })
    const out = async (type: string, expr: string, val: string, how: 'var' | 'env') => {
      const w = how === 'var' ? world(tf(type, expr)) : world(tf(type, expr), { env: { TF_VAR_v: val } })
      const r = how === 'var' ? await w.run('plan', '-var', `v=${val}`) : await w.run('plan')
      return r.stdout
    }
    for (const how of ['var', 'env'] as const) {
      expect(await out('list(string)', 'length(var.v)', '["a","b"]', how)).toContain('o = 2')
      expect(await out('list(string)', 'toset(var.v)', '["a","b","a"]', how)).toMatch(/o = \[\s+\+ "a",\s+\+ "b",\s+\]/)
      expect(await out('map(string)', 'var.v.k', '{ k = "x" }', how)).toContain('o = "x"')
      expect(await out('object({ a = number })', 'var.v.a', '{ a = 3 }', how)).toContain('o = 3')
    }
    const bad = await world(tf('list(string)', 'var.v')).run('plan', '-var', 'v=[')
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toContain('Error: Invalid value for input variable')
    expect(bad.stderr.replace(/\n│ /g, ' ')).toContain('Unsuitable value for var.v set using -var="v=["')
  })

  it('null passes conversion; a non-nullable variable drops it so the default applies or the variable is unset', async () => {
    const f = { '/home/you/infra/terraform.tfvars': 'v = null\n' }
    const use = 'var.v == null ? false : var.v'
    const nullable = await varWorld('type = bool\n  default = true', use, { files: f }).run('plan')
    expect(nullable.stdout).toContain('true -> false')
    const dropped = await varWorld('type = bool\n  default = true\n  nullable = false', use, { files: f }).run('plan')
    expect(dropped.stdout).toContain('No changes.')
    const unset = await varWorld('type = bool\n  nullable = false', 'var.v', { files: f }).run('plan')
    expect(unset.stderr).toContain('No value for required variable')
  })

  it('verifies and matches evidence only for runs in the lab directory on the main host', async () => {
    const ev = { evidence: [{ evidence: 'listed', command: 'plan' as const, contains: 'No changes' }] }
    const here = await world(ev).run('plan')
    expect(here.ran).toBe('terraform plan')
    expect(here.evidence).toEqual(['evidence:listed'])
    const tmp = world(ev, { cwd: '/tmp', files: { '/tmp/main.tf': VPC_TF } })
    const away = await tmp.run('plan')
    expect(away.ran).toBe('')
    expect(away.evidence).toEqual([])
    expect((await world(ev, { mainHost: false }).run('plan')).ran).toBe('')
    for (const a of [['version'], ['workspace', 'show'], ['state', 'pull'], ['plan', '-help'], ['state', 'list', '-help']]) expect((await world().run(...a)).ran).toBe('')
    expect((await world().run('state', 'list')).ran).toBe('terraform state list')
  })

  it('errors for an undeclared -var, warns on stdout for an undeclared tfvars value, ignores TF_VAR_', async () => {
    const dir = '/home/you/infra'
    const cli = await world().run('plan', '-var', 'foo=1')
    expect(cli.exitCode).toBe(1)
    expect(cli.stderr).toContain('Error: Value for undeclared variable')
    expect(cli.stderr.replace(/\n│ /g, ' ')).toContain(
      'A variable named "foo" was assigned on the command line, but the root module does not declare a variable of that name. To use this value, add a "variable" block to the configuration.',
    )
    const file = await world({}, { files: { [`${dir}/terraform.tfvars`]: 'foo = 1\n' } }).run('plan')
    expect(file.exitCode).toBe(0)
    expect(file.stderr).toBe('')
    expect(file.stdout.startsWith('╷\n│ Warning: Value for undeclared variable')).toBe(true)
    expect(file.stdout.replace(/\n│ /g, ' ')).toContain(
      'The root module does not declare a variable named "foo" but a value was found in file "terraform.tfvars". If you meant to use this value, add a "variable" block to the configuration.  To silence these warnings, use TF_VAR_... environment variables to provide certain "global" settings to all configurations in your organization. To reduce the verbosity of these warnings, use the -compact-warnings option.',
    )
    expect(file.stdout).toContain('No changes.')
    const env = await world({ vars: { lab: 'x' } }, { env: { TF_VAR_foo: '1' } }).run('plan')
    expect(env.stdout.startsWith('aws_vpc.main: Refreshing state')).toBe(true)
  })

  it('caps undeclared-file warnings at two and summarises the rest', async () => {
    const r = await world({}, { files: { '/home/you/infra/terraform.tfvars': 'a = 1\nb = 2\nc = 3\nd = 4\n' } }).run('plan')
    expect(r.stdout.match(/Warning: Value for undeclared variable/g)).toHaveLength(2)
    expect(r.stdout).toContain('Warning: Values for undeclared variables')
    expect(r.stdout.replace(/\n│ /g, ' ')).toContain('In addition to the other similar warnings shown, 2 other variable(s) defined without being declared.')
  })
})

describe('terraform init, lock file and empty directories', () => {
  it('validate and init in an empty directory are quiet and succeed', async () => {
    const empty = () => world({}, { cwd: '/home/you' })
    const v = await empty().run('validate')
    expect(v).toMatchObject({ stdout: 'Success! The configuration is valid.\n', stderr: '', exitCode: 0 })
    const w = empty()
    const i = await w.run('init')
    expect(i).toMatchObject({
      stdout: '\nTerraform initialized in an empty directory!\n\nThe directory has no Terraform configuration files. You may begin working\nwith Terraform immediately by creating Terraform configuration files.\n',
      stderr: '',
      exitCode: 0,
    })
    expect(Object.keys(w.disk).filter((p) => p.startsWith('/home/you/') && p.includes('.terraform.lock'))).toEqual(['/home/you/infra/.terraform.lock.hcl'])
  })

  it('init initialises despite semantic errors but fails on syntax errors', async () => {
    const sem = world({ initialized: false, files: [{ path: 'main.tf', content: 'resource "aws_vpc" "main" {\n  cidr_block = var.nope\n}\n' }] }, { skipLock: true })
    const r = await sem.run('init')
    expect(r.exitCode).toBe(0)
    expect(sem.disk['/home/you/infra/.terraform.lock.hcl']).toContain('provider "registry.terraform.io/hashicorp/aws"')
    for (const sub of ['validate', 'plan']) expect((await sem.run(sub)).stderr).toContain('Reference to undeclared input variable')
    const syn = world({ initialized: false, files: [{ path: 'main.tf', content: 'resource "aws_vpc" "main" {\n  cidr_block\n}\n' }] }, { skipLock: true })
    const bad = await syn.run('init')
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toContain('Error: Argument or block definition required')
    expect(syn.disk['/home/you/infra/.terraform.lock.hcl']).toBeUndefined()
  })

  it('compares providers with the lock file: validate and plan fail, init adds only the missing ones, version lists the locked ones', async () => {
    const lockPath = '/home/you/infra/.terraform.lock.hcl'
    const random = world({}, { files: { [lockPath]: lockFile(['registry.terraform.io/hashicorp/random']) } })
    for (const sub of ['validate', 'plan']) {
      const r = await random.run(sub)
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toContain('Error: Inconsistent dependency lock file')
      expect(r.stderr).toContain('provider registry.terraform.io/hashicorp/aws: required by this configuration but no version is selected')
    }
    const two = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\nresource "azurerm_resource_group" "rg" {\n  name = "rg"\n  location = "eastus"\n}\n'
    const w = world({ files: [{ path: 'main.tf', content: two }] })
    const plan = await w.run('plan')
    expect(plan.exitCode).toBe(1)
    expect(plan.stderr).toContain('provider registry.terraform.io/hashicorp/azurerm: required by this configuration but no version is selected')
    expect(plan.stderr).not.toContain('provider registry.terraform.io/hashicorp/aws:')
    expect((await w.run('version')).stdout).toBe('Terraform v1.9.8\non linux_amd64\n+ provider registry.terraform.io/hashicorp/aws v5.67.0')
    const init = await w.run('init')
    expect(init.exitCode).toBe(0)
    expect(init.stdout).toContain('- Reusing previous version of hashicorp/aws from the dependency lock file')
    expect(init.stdout).toContain('- Installing hashicorp/azurerm v5.67.0...')
    expect(init.stdout).not.toContain('- Installing hashicorp/aws')
    expect(w.disk[lockPath]).toContain('provider "registry.terraform.io/hashicorp/aws"')
    expect(w.disk[lockPath]).toContain('provider "registry.terraform.io/hashicorp/azurerm"')
    expect((await w.run('plan')).stderr).not.toContain('Inconsistent dependency lock file')
    expect((await w.run('version')).stdout).toContain('+ provider registry.terraform.io/hashicorp/azurerm v5.67.0')
  })
})

describe('terraform aliases and help', () => {
  it('treats -v as version', async () => {
    expect((await world().run('-v')).stdout).toBe((await world().run('version')).stdout)
  })

  it('prints brief usage for a subcommand with -help or --help', async () => {
    const plan = await world().run('plan', '-help')
    expect(plan.exitCode).toBe(0)
    expect(plan.stdout).toBe(
      'Usage: terraform [global options] plan [options]\n\nGenerates a speculative execution plan, showing what actions Terraform would take to apply the current configuration. This command will not actually perform the planned actions.',
    )
    for (const sub of ['init', 'validate', 'show', 'state', 'output', 'workspace', 'version']) {
      const r = await world().run(sub, '--help')
      expect(r.exitCode, sub).toBe(0)
      expect(r.stdout.startsWith(`Usage: terraform [global options] ${sub} [options]\n\n`), sub).toBe(true)
    }
  })
})

describe('terraform: evidence', () => {
  it('awards evidence when the output contains the text', async () => {
    const w = world(
      { evidence: [{ evidence: 'plan-forces', command: 'plan', contains: 'forces replacement' }, { evidence: 'listed', command: 'state list', contains: 'aws_vpc.main' }] },
      { files: { '/home/you/infra/main.tf': 'resource "aws_vpc" "main" {\n  cidr_block = "10.1.0.0/16"\n}\n' } },
    )
    expect((await w.run('plan')).evidence).toEqual(['evidence:plan-forces'])
    expect((await w.run('state', 'list')).evidence).toEqual(['evidence:listed'])
    expect((await w.run('version')).evidence).toEqual([])
  })
})
