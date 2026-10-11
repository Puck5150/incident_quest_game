import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { IncidentShell } from '../src/game/shell.ts'
import { TerraformSchema, type Scenario } from '../src/schema/scenario.ts'

// A lab with state_file: the fixture builder from terraform-shell-state.test.ts, with a
// VPC and a database (its password is a sensitive attribute) in state.
const base = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@') && !s.stages)!
const VPC_TF = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const DB_TF = 'resource "aws_db_instance" "main" {\n  identifier     = "orders"\n  engine         = "postgres"\n  instance_class = "db.t3.micro"\n  username       = "app"\n  password       = "hunter22"\n}\n'
const S3 = 'terraform {\n  backend "s3" {\n    bucket = "acme-tfstate"\n    key    = "prod/terraform.tfstate"\n    region = "us-east-1"\n  }\n}\n'
const S3_OTHER = S3.replace('prod/', 'live/')
const VPC = { type: 'aws_vpc', name: 'main', attrs: { id: 'vpc-1', arn: 'arn:vpc-1', cidr_block: '10.0.0.0/16', enable_dns_support: true, enable_dns_hostnames: false, default_security_group_id: 'sg-1', tags_all: {} } }
const DB = {
  type: 'aws_db_instance',
  name: 'main',
  attrs: { id: 'db-1', arn: 'arn:db-1', identifier: 'orders', engine: 'postgres', engine_version: '16.3', instance_class: 'db.t3.micro', allocated_storage: 20, storage_encrypted: false, kms_key_id: '', db_name: '', username: 'app', password: 'hunter22', multi_az: false, skip_final_snapshot: false, endpoint: 'orders.x:5432', tags: {}, tags_all: {} },
}
const scenario = (over: Record<string, unknown> = { state_file: true }): Scenario =>
  ({
    ...structuredClone(base),
    terminal: { ...structuredClone(base.terminal!), prompt: 'you@laptop:~/infra$', commands: [] },
    terraform: { dir: '~/infra', files: [{ path: 'main.tf', content: VPC_TF + DB_TF }], state: [VPC, DB], ...over },
  }) as Scenario
const session = () => {
  const s = scenario()
  const sh = new IncidentShell(s)
  const run = (line: string) => sh.run(line, s, new Set())
  return { run, out: async (line: string) => (await run(line)).output }
}
const pull = async (o: (l: string) => Promise<string>) => (await o('terraform state pull')).trimEnd()
const serialOf = (text: string) => (JSON.parse(text) as { serial: number }).serial

describe('terraform.tfstate on the disk of a state_file lab', () => {
  it('is mounted and equals state pull; a lab without the flag has no such file', async () => {
    const { out } = session()
    expect((await out('cat terraform.tfstate')).trimEnd()).toBe(await pull(out))
    expect(await out('grep password terraform.tfstate')).toContain('"password": "hunter22"')

    const plain = scenario({})
    const sh = new IncidentShell(plain)
    const r = await sh.run('cat terraform.tfstate', plain, new Set())
    expect(r.output).not.toContain('"serial"')
    expect((await sh.run('ls', plain, new Set())).output).not.toContain('terraform.tfstate')
  })

  it('follows every state-writing command; the backup holds the state before it', async () => {
    const { out } = session()
    const first = await pull(out)
    expect(await out('ls')).not.toContain('terraform.tfstate.backup')
    await out('terraform state rm aws_vpc.main')
    const second = await pull(out)
    expect(serialOf(second)).toBe(serialOf(first) + 1)
    expect((await out('cat terraform.tfstate')).trimEnd()).toBe(second)
    expect((await out('cat terraform.tfstate.backup')).trimEnd()).toBe(first)

    await out('terraform apply -auto-approve')
    const third = await pull(out)
    expect(serialOf(third)).toBeGreaterThan(serialOf(second))
    expect((await out('cat terraform.tfstate')).trimEnd()).toBe(third)
    expect((await out('cat terraform.tfstate.backup')).trimEnd()).toBe(second)

    // A command that writes nothing leaves both alone.
    await out('terraform plan')
    expect((await out('cat terraform.tfstate.backup')).trimEnd()).toBe(second)
  })

  it('is a view: an edit by the player is overwritten and never read back', async () => {
    const { out } = session()
    const before = await pull(out)
    await out('echo "{}" > terraform.tfstate')
    expect(await pull(out)).toBe(before)
    expect((await out('cat terraform.tfstate')).trimEnd()).toBe(before)
  })
})

describe('changing the backend of a state_file lab', () => {
  const withBackend = async (block = S3) => {
    const w = session()
    await w.out(`cat > backend.tf <<'EOF'\n${block}EOF`)
    return w
  }
  const INIT_REQUIRED = 'Backend initialization required, please run "terraform init"'

  it('a new backend block stops every command that opens the backend until init', async () => {
    const { out } = await withBackend()
    for (const c of ['plan', 'apply', 'state list', 'output', 'show', 'refresh', 'workspace list']) {
      const o = await out(`terraform ${c}`)
      expect(o, c).toContain(INIT_REQUIRED)
      expect(o, c).toContain('Initial configuration of the requested backend "s3"')
    }
    expect(await out('terraform validate')).not.toContain(INIT_REQUIRED)
  })

  it('init -migrate-state copies the state, empties the local file and keeps the backup', async () => {
    const { out, run } = session()
    const before = await pull(out)
    await out(`cat > backend.tf <<'EOF'\n${S3}EOF`)
    const r = await run('echo yes | terraform init -migrate-state')
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('Do you want to copy existing state to the new backend?')
    expect(r.output).toContain('Successfully configured the backend "s3"! Terraform will automatically\nuse this backend unless the backend configuration changes.')
    expect(r.output).toContain('Terraform has been successfully initialized!')
    expect(await pull(out)).toBe(before) // same serial and lineage
    expect(await out('cat terraform.tfstate')).toBe('')
    expect((await out('cat terraform.tfstate.backup')).trimEnd()).toBe(before)
    expect(await out('grep -c . terraform.tfstate')).toContain('0')
    expect(await out('terraform plan')).toContain('No changes.')
    // Later writes do not bring the file back.
    await out('terraform state rm aws_vpc.main')
    expect(await out('cat terraform.tfstate')).toBe('')
    expect((await out('cat terraform.tfstate.backup')).trimEnd()).toBe(before)
  })

  it('plain init asks the same question; no answer cancels; -force-copy skips it', async () => {
    const { out, run } = await withBackend()
    const none = await run('terraform init')
    expect(none.exitCode).toBe(1)
    expect(none.output).toContain("Can't ask approval for state migration")
    const forced = await run('terraform init -force-copy')
    expect(forced.exitCode).toBe(0)
    expect(forced.output).not.toContain('Do you want to copy')
    expect(await out('cat terraform.tfstate')).toBe('')
    expect(await out('terraform plan')).toContain('No changes.')
  })

  it('answering no starts with an empty state (the local state is cleared either way)', async () => {
    const { out, run } = await withBackend()
    const r = await run('echo no | terraform init -migrate-state')
    expect(r.exitCode).toBe(0)
    expect(await out('terraform plan')).toContain('Plan: 2 to add')
    expect(await out('cat terraform.tfstate')).toBe('')
    expect(await out('cat terraform.tfstate.backup')).toContain('"hunter22"')
  })

  it('a changed backend block asks for -migrate-state or -reconfigure; -reconfigure starts empty', async () => {
    const { out, run } = await withBackend()
    await run('echo yes | terraform init -migrate-state')
    await out(`cat > backend.tf <<'EOF'\n${S3_OTHER}EOF`)
    const p = await run('terraform plan')
    expect(p.output).toContain('Backend initialization required: please run "terraform init"')
    expect(p.output).toContain('Reason: Backend configuration block has changed')
    const i = await run('terraform init')
    expect(i.exitCode).toBe(1)
    expect(i.output).toContain('Error: Backend configuration changed')
    const flat = i.output.replace(/\n│ ?/g, ' ') // the box wraps long lines
    expect(flat).toContain('use "terraform init -migrate-state".')
    expect(flat).toContain('use "terraform init -reconfigure".')
    expect((await run('terraform init -migrate-state -reconfigure')).output).toContain('mutually-exclusive')

    const local = await out('cat terraform.tfstate.backup')
    const r = await run('terraform init -reconfigure')
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('Successfully configured the backend "s3"!')
    expect(await out('terraform plan')).toContain('Plan: 2 to add')
    expect(await out('cat terraform.tfstate')).toBe('')
    expect(await out('cat terraform.tfstate.backup')).toBe(local)
  })

  it('a changed block with -migrate-state carries the state over', async () => {
    const { out, run } = await withBackend()
    await run('echo yes | terraform init -migrate-state')
    const before = await pull(out)
    await out(`cat > backend.tf <<'EOF'\n${S3_OTHER}EOF`)
    const r = await run('echo yes | terraform init -migrate-state')
    expect(r.output).toContain('Backend configuration changed!')
    expect(r.output).toContain('Successfully configured the backend "s3"!')
    expect(await pull(out)).toBe(before)
    expect(await out('terraform plan')).toContain('No changes.')
  })

  it('removing the backend block is also a change; -migrate-state brings the state back to the file', async () => {
    const { out, run } = await withBackend()
    await run('echo yes | terraform init -migrate-state')
    const before = await pull(out)
    await out('rm -f backend.tf')
    const p = await run('terraform plan')
    expect(p.output).toContain(INIT_REQUIRED)
    expect(p.output).toContain('Unsetting the previously set backend "s3"')
    expect((await run('terraform init')).output).toContain('Error: Backend configuration changed')
    const r = await run('echo yes | terraform init -migrate-state')
    expect(r.output).toContain("Terraform has detected you're unconfiguring your previously set \"s3\" backend.")
    expect(r.output).toContain('Successfully unset the backend "s3". Terraform will now operate locally.')
    expect((await out('cat terraform.tfstate')).trimEnd()).toBe(before)
    expect(await out('terraform plan')).toContain('No changes.')
  })

  it('init without a backend change is as before, with or without the flag', async () => {
    for (const over of [{ state_file: true }, {}]) {
      const s = scenario(over)
      const sh = new IncidentShell(s)
      const a = await sh.run('terraform init', s, new Set())
      const b = await sh.run('terraform init -migrate-state', s, new Set())
      expect(a.exitCode).toBe(0)
      expect(b.output).toBe(a.output)
      expect(a.output).toContain('Initializing the backend...\n\nInitializing provider plugins...')
    }
  })

  it('a lab without state_file ignores backend blocks entirely', async () => {
    const s = scenario({})
    const sh = new IncidentShell(s)
    await sh.run(`cat > backend.tf <<'EOF'\n${S3}EOF`, s, new Set())
    expect((await sh.run('terraform plan', s, new Set())).output).not.toContain(INIT_REQUIRED)
  })
})

describe('state_file in the schema', () => {
  const parse = (v: unknown) => TerraformSchema.safeParse({ files: [{ path: 'main.tf', content: VPC_TF }], state_file: v })
  it('is a boolean', () => {
    expect(parse(true).success).toBe(true)
    expect(parse('yes').success).toBe(false)
  })
})
