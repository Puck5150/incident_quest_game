import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { IncidentShell } from '../src/game/shell.ts'
import type { Scenario, TerraformBlock } from '../src/schema/scenario.ts'
import { LOCK_FILE, runTerraform, type CliContext } from '../src/game/terraform/cli.ts'
import { labFromScenario } from '../src/game/terraform/lab.ts'
import { listAddresses } from '../src/game/terraform/state.ts'

const LAB = '/home/you/infra'
const call = (name: string) => `module "${name}" {\n  source = "./modules/net"\n  cidr   = "10.0.0.0/16"\n}\n`
const ROOT_FLAT = 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'
const NET = 'variable "cidr" {\n  type = string\n}\n\nresource "aws_vpc" "main" {\n  cidr_block = var.cidr\n}\n'
const MOVED = (from: string, to: string) => `\nmoved {\n  from = ${from}\n  to   = ${to}\n}\n`
const installed = { modules: { installed: ['net', 'network', 'a', 'b'].map((key) => ({ key, source: './modules/net', dir: 'modules/net' })) } }
const VPC_ATTRS = { id: 'vpc-1', cidr_block: '10.0.0.0/16', arn: 'arn:aws:ec2:us-east-1:123456789012:vpc/vpc-1', default_security_group_id: 'sg-1', enable_dns_hostnames: false, enable_dns_support: true }

function world(root: string, tf: Partial<TerraformBlock> = {}) {
  const block = { files: [{ path: 'main.tf', content: root }, { path: 'modules/net/main.tf', content: NET }], ...installed, ...tf } as TerraformBlock
  const lab = labFromScenario(block, LAB, '/home/you')
  const disk: Record<string, string> = {}
  for (const f of lab.files) disk[f.path] = f.content
  if (lab.initialized) disk[`${LAB}/.terraform.lock.hcl`] = LOCK_FILE
  const ctx: CliContext = {
    lab,
    cwd: LAB,
    mainHost: true,
    env: {},
    taken: new Set(),
    listFiles: async (dir) => Object.entries(disk).filter(([p]) => p.slice(0, p.lastIndexOf('/')) === dir).map(([p, text]) => ({ name: p.slice(p.lastIndexOf('/') + 1), text })),
    readFile: async (p) => disk[p],
    write: async (dir, name, text) => void (disk[`${dir}/${name}`] = text),
  }
  const setRoot = (text: string) => void (disk[`${LAB}/main.tf`] = text)
  return { lab, disk, setRoot, run: (...args: string[]) => runTerraform(args, ctx) }
}
// A world whose first apply created `root`'s resources, ready to be refactored.
async function applied(root: string) {
  const w = world(root)
  expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
  return w
}
const heads = (out: string) => out.split('\n').filter((l) => l.startsWith('  # ') && !l.startsWith('  # ('))
// An error box with its frame and line wrapping removed.
const flat = (err: string) => err.replace(/\s*\n│\s*/g, ' ')

describe('moved: root to module', () => {
  it('without moved the refactor is a destroy and a create', async () => {
    const w = await applied(ROOT_FLAT)
    w.setRoot(call('net'))
    const p = await w.run('plan')
    expect(heads(p.stdout)).toEqual(['  # aws_vpc.main will be destroyed', '  # module.net.aws_vpc.main will be created'])
    expect(p.stdout).toContain('Plan: 1 to add, 0 to change, 1 to destroy.')
  })

  it('a moved block makes it a clean move, applied without a destroy', async () => {
    const w = await applied(ROOT_FLAT)
    w.setRoot(call('net') + MOVED('aws_vpc.main', 'module.net.aws_vpc.main'))
    const p = await w.run('plan')
    expect(p.exitCode).toBe(0)
    expect(heads(p.stdout)).toEqual(['  # aws_vpc.main has moved to module.net.aws_vpc.main'])
    expect(p.stdout).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    const a = await w.run('apply', '-auto-approve')
    expect(a.exitCode).toBe(0)
    expect(a.stdout).not.toContain('Destroying')
    expect(a.stdout).not.toContain('Creating')
    expect(listAddresses(w.lab.state)).toEqual(['module.net.aws_vpc.main'])
    expect(w.lab.state.resources[0].module).toBe('module.net')
    const again = await w.run('plan', '-detailed-exitcode')
    expect(again.exitCode).toBe(0)
    expect(again.stdout).toContain('No changes.')
  })

  it('keeps the object (same id) through the move', async () => {
    const w = await applied(ROOT_FLAT)
    const id = w.lab.state.resources[0].instances[0].attributes.id
    w.setRoot(call('net') + MOVED('aws_vpc.main', 'module.net.aws_vpc.main'))
    await w.run('apply', '-auto-approve')
    expect(w.lab.state.resources[0].instances[0].attributes.id).toBe(id)
  })

  it('state mv reaches the same end state as the moved block', async () => {
    const viaBlock = await applied(ROOT_FLAT)
    viaBlock.setRoot(call('net') + MOVED('aws_vpc.main', 'module.net.aws_vpc.main'))
    await viaBlock.run('apply', '-auto-approve')
    const viaMv = await applied(ROOT_FLAT)
    viaMv.setRoot(call('net'))
    const mv = await viaMv.run('state', 'mv', 'aws_vpc.main', 'module.net.aws_vpc.main')
    expect(mv.exitCode).toBe(0)
    expect(mv.stdout).toContain('Move "aws_vpc.main" to "module.net.aws_vpc.main"')
    const strip = (w: typeof viaMv) => w.lab.state.resources.map((r) => ({ ...r, instances: r.instances.map((i) => ({ ...i })) }))
    expect(strip(viaMv)).toEqual(strip(viaBlock))
    const p = await viaMv.run('plan', '-detailed-exitcode')
    expect(p.exitCode).toBe(0)
    expect(p.stdout).toContain('No changes.')
  })
})

describe('moved: other directions', () => {
  it('module to root', async () => {
    const w = await applied(call('net'))
    w.setRoot(ROOT_FLAT + MOVED('module.net.aws_vpc.main', 'aws_vpc.main'))
    const p = await w.run('plan')
    expect(heads(p.stdout)).toEqual(['  # module.net.aws_vpc.main has moved to aws_vpc.main'])
    expect(p.stdout).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    expect((await w.run('apply', '-auto-approve')).stdout).not.toContain('Destroying')
    expect(listAddresses(w.lab.state)).toEqual(['aws_vpc.main'])
    expect(w.lab.state.resources[0].module).toBeUndefined()
  })

  it('module to another module (resource-level move)', async () => {
    const w = await applied(call('a'))
    w.setRoot(call('b') + MOVED('module.a.aws_vpc.main', 'module.b.aws_vpc.main'))
    const p = await w.run('plan')
    expect(heads(p.stdout)).toEqual(['  # module.a.aws_vpc.main has moved to module.b.aws_vpc.main'])
    await w.run('apply', '-auto-approve')
    expect(listAddresses(w.lab.state)).toEqual(['module.b.aws_vpc.main'])
    expect((await w.run('plan', '-detailed-exitcode')).exitCode).toBe(0)
  })

  it('a module rename moves every resource under it', async () => {
    const w = await applied(call('net'))
    w.setRoot(call('network'))
    const bad = await w.run('plan')
    expect(heads(bad.stdout)).toEqual(['  # module.net.aws_vpc.main will be destroyed', '  # module.network.aws_vpc.main will be created'])
    expect(bad.stdout).toContain('(because module.net is not in configuration)')
    w.setRoot(call('network') + MOVED('module.net', 'module.network'))
    const p = await w.run('plan')
    expect(heads(p.stdout)).toEqual(['  # module.net.aws_vpc.main has moved to module.network.aws_vpc.main'])
    expect(p.stdout).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    await w.run('apply', '-auto-approve')
    expect(listAddresses(w.lab.state)).toEqual(['module.network.aws_vpc.main'])
    expect(w.lab.state.resources[0].module).toBe('module.network')
    expect((await w.run('plan', '-detailed-exitcode')).exitCode).toBe(0)
  })

  it('chains a module rename with a resource move inside it', async () => {
    const w = await applied(call('net'))
    const net2 = NET.replace('"main"', '"core"')
    w.disk[`${LAB}/modules/net/main.tf`] = net2
    w.setRoot(call('network') + MOVED('module.net', 'module.network') + MOVED('module.network.aws_vpc.main', 'module.network.aws_vpc.core'))
    const p = await w.run('plan')
    expect(heads(p.stdout)).toEqual(['  # module.net.aws_vpc.main has moved to module.network.aws_vpc.core'])
    await w.run('apply', '-auto-approve')
    expect(listAddresses(w.lab.state)).toEqual(['module.network.aws_vpc.core'])
  })
})

describe('moved with prevent_destroy', () => {
  it('a move into a module whose resource has prevent_destroy plans clean and applies', async () => {
    const w = await applied(ROOT_FLAT)
    w.disk[`${LAB}/modules/net/main.tf`] = NET.replace('cidr_block = var.cidr', 'cidr_block = var.cidr\n  lifecycle {\n    prevent_destroy = true\n  }')
    w.setRoot(call('net') + MOVED('aws_vpc.main', 'module.net.aws_vpc.main'))
    const p = await w.run('plan')
    expect(p.exitCode).toBe(0)
    expect(p.stdout).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    expect((await w.run('apply', '-auto-approve')).exitCode).toBe(0)
  })
})

describe('moved: diagnostics with module addresses', () => {
  it('Moved object still exists for a resource and for a module', async () => {
    const w = await applied(call('net'))
    w.setRoot(call('net') + ROOT_FLAT + MOVED('aws_vpc.main', 'module.net.aws_vpc.main'))
    const r = await w.run('plan')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('Moved object still exists')
    expect(flat(r.stderr)).toContain('This statement declares that aws_vpc.main was moved to module.net.aws_vpc.main, but aws_vpc.main is still declared in the configuration.')
    w.setRoot(call('net') + call('network') + MOVED('module.net', 'module.network'))
    const m = await w.run('plan')
    expect(flat(m.stderr)).toContain('Moved object still exists')
    expect(flat(m.stderr)).toContain('module.net was moved to module.network, but module.net is still declared')
  })

  it('rejects mixed kinds, a module moved into itself, ambiguous and cyclic moves', async () => {
    const w = world(call('net'))
    w.setRoot(call('net') + MOVED('module.net', 'aws_vpc.main'))
    expect(flat((await w.run('plan')).stderr)).toContain('The "from" and "to" addresses must either both refer to resources or both refer to modules.')
    w.setRoot(call('net') + MOVED('module.net', 'module.net.module.sub'))
    expect(flat((await w.run('plan')).stderr)).toContain('a module cannot be moved into itself')
    w.setRoot(call('net') + MOVED('aws_vpc.a', 'module.net.aws_vpc.c') + MOVED('aws_vpc.b', 'module.net.aws_vpc.c'))
    expect(flat((await w.run('plan')).stderr)).toContain('Each move statement must have a distinct destination: module.net.aws_vpc.c is the destination of more than one move statement.')
    const seeded = world(call('net') + MOVED('module.net.aws_vpc.a', 'aws_vpc.a') + MOVED('aws_vpc.a', 'module.net.aws_vpc.a'), { state: [{ type: 'aws_vpc', name: 'a', module: 'module.net', attrs: VPC_ATTRS }] })
    expect(flat((await seeded.run('plan')).stderr)).toContain('Cycle in move statements')
  })

  it('a type mismatch across modules is still a type mismatch', async () => {
    const w = world(call('net'))
    w.setRoot(call('net') + MOVED('aws_vpc.main', 'module.net.aws_subnet.main'))
    expect(flat((await w.run('plan')).stderr)).toContain('Resource type mismatch')
  })

  it('moved blocks inside a child module are ignored', async () => {
    const w = await applied(ROOT_FLAT)
    w.setRoot(call('net'))
    w.disk[`${LAB}/modules/net/main.tf`] = NET + MOVED('aws_vpc.main', 'aws_vpc.other')
    const p = await w.run('plan')
    expect(heads(p.stdout)).toEqual(['  # aws_vpc.main will be destroyed', '  # module.net.aws_vpc.main will be created'])
  })
})

describe('import with module addresses', () => {
  const B = 'resource "aws_s3_bucket" "b" {\n  bucket = "legacy"\n}\n'
  const world2 = (root: string, extra: Record<string, string> = {}) => {
    const w = world(root, { state: [], cloud: { add: [{ type: 'aws_s3_bucket', attrs: { id: 'legacy', bucket: 'legacy', arn: 'arn:aws:s3:::legacy' } }] } } as Partial<TerraformBlock>)
    w.disk[`${LAB}/modules/net/main.tf`] = NET + B
    Object.assign(w.disk, extra)
    return w
  }

  it('an import block into a module resource plans and applies the import', async () => {
    const w = world2(call('net') + 'import {\n  to = module.net.aws_s3_bucket.b\n  id = "legacy"\n}\n')
    const p = await w.run('plan')
    expect(p.stderr).toBe('')
    expect(heads(p.stdout)).toContain('  # module.net.aws_s3_bucket.b will be imported')
    await w.run('apply', '-auto-approve')
    expect(listAddresses(w.lab.state)).toContain('module.net.aws_s3_bucket.b')
  })

  it('an import block for a module resource that is not declared is an error', async () => {
    const w = world2(call('net') + 'import {\n  to = module.net.aws_s3_bucket.zzz\n  id = "legacy"\n}\n')
    const p = await w.run('plan')
    expect(p.exitCode).toBe(1)
    expect(p.stderr).toContain('Configuration for import target does not exist')
    expect(p.stderr).toContain('module.net.aws_s3_bucket.zzz')
  })

  it('an import block inside a child module is rejected', async () => {
    const w = world2(call('net'))
    w.disk[`${LAB}/modules/net/main.tf`] = NET + B + 'import {\n  to = aws_s3_bucket.b\n  id = "legacy"\n}\n'
    const p = await w.run('plan')
    expect(p.exitCode).toBe(1)
    expect(p.stderr).toContain('Invalid import configuration')
    expect(flat(p.stderr)).toContain('An import block was detected in "module.net". Import blocks are only allowed in the root module.')
  })

  it('terraform import module.net.aws_s3_bucket.b legacy', async () => {
    const w = world2(call('net'))
    const r = await w.run('import', 'module.net.aws_s3_bucket.b', 'legacy')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Import successful!')
    expect(listAddresses(w.lab.state)).toEqual(['module.net.aws_s3_bucket.b'])
    expect(w.lab.state.resources[0].module).toBe('module.net')
  })

  it('terraform import of an undeclared module resource names the module', async () => {
    const w = world2(call('net'))
    const r = await w.run('import', 'module.net.aws_s3_bucket.nope', 'legacy')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('module.net.aws_s3_bucket.nope')
    expect(flat(r.stderr)).toContain('please create its configuration in module.net. For example:')
    const none = await w.run('import', 'module.ghost.aws_s3_bucket.b', 'legacy')
    expect(flat(none.stderr)).toContain('please create its configuration in module.ghost. For example:')
  })

  it('terraform import of a root resource still works and a keyed module instance is undeclared', async () => {
    const w = world2(call('net') + B)
    expect((await w.run('import', 'aws_s3_bucket.b', 'legacy')).exitCode).toBe(0)
    const keyed = await w.run('import', 'module.net["a"].aws_s3_bucket.b', 'legacy')
    expect(keyed.exitCode).toBe(1)
  })
})

describe('removed with module addresses', () => {
  it('forgets a module resource without destroying it', async () => {
    const w = await applied(call('net'))
    w.disk[`${LAB}/modules/net/main.tf`] = 'variable "cidr" {\n  type = string\n}\n'
    w.setRoot(call('net') + 'removed {\n  from = module.net.aws_vpc.main\n  lifecycle {\n    destroy = false\n  }\n}\n')
    const p = await w.run('plan')
    expect(p.stdout).toContain('# module.net.aws_vpc.main will no longer be managed by Terraform, but will not be destroyed')
    await w.run('apply', '-auto-approve')
    expect(listAddresses(w.lab.state)).toEqual([])
  })

  it('still-declared module resource is an error; removed from a whole module is rejected', async () => {
    const w = await applied(call('net'))
    w.setRoot(call('net') + 'removed {\n  from = module.net.aws_vpc.main\n  lifecycle {\n    destroy = false\n  }\n}\n')
    expect(flat((await w.run('plan')).stderr)).toContain('This statement declares that module.net.aws_vpc.main was removed')
    w.setRoot(call('net') + 'removed {\n  from = module.net\n  lifecycle {\n    destroy = false\n  }\n}\n')
    expect(flat((await w.run('plan')).stderr)).toContain('Invalid "from" address')
  })
})

describe('the refactor incident through the shell', () => {
  const base = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios.find((s) => s.terminal && s.terminal.prompt.includes('@') && !s.stages && !s.terraform)!
  const scenario = (): Scenario =>
    ({
      ...structuredClone(base),
      terminal: { ...structuredClone(base.terminal!), prompt: 'you@laptop:~/infra$', commands: [] },
      terraform: {
        dir: '~/infra',
        files: [{ path: 'main.tf', content: call('net') }, { path: 'modules/net/main.tf', content: NET }],
        state: [{ type: 'aws_vpc', name: 'main', attrs: VPC_ATTRS }],
        ...installed,
      },
    }) as Scenario
  const SAVED = { state_has: 'module.net.aws_vpc.main' }
  const run = (sh: IncidentShell, s: Scenario, cmd: string) => sh.run(cmd, s, new Set())

  it('plan shows destroy and create; a moved block fixes it; apply persists; done_when holds', async () => {
    const s = scenario()
    const sh = new IncidentShell(s)
    await run(sh, s, 'ls') // files are mounted by the first command
    const bad = await run(sh, s, 'terraform plan')
    expect(bad.output).toContain('# aws_vpc.main will be destroyed')
    expect(bad.output).toContain('# module.net.aws_vpc.main will be created')
    expect(await sh.doneWhen(SAVED)).toBe(false)
    await run(sh, s, `printf '\\nmoved {\\n  from = aws_vpc.main\\n  to   = module.net.aws_vpc.main\\n}\\n' >> main.tf`)
    const p = await run(sh, s, 'terraform plan')
    expect(p.output).toContain('# aws_vpc.main has moved to module.net.aws_vpc.main')
    expect(p.output).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    const a = await run(sh, s, 'terraform apply -auto-approve')
    expect(a.output).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.')
    expect(await sh.doneWhen(SAVED)).toBe(true)
    expect(await sh.doneWhen({ plan_clean: true })).toBe(true)
    expect(await sh.doneWhen({ applied: { op: 'delete', address: 'aws_vpc.main' } })).toBe(false)
    expect(await sh.doneWhen({ state_lacks: 'aws_vpc.main' })).toBe(true)
  })

  it('the state mv route ends the same way', async () => {
    const s = scenario()
    const sh = new IncidentShell(s)
    await run(sh, s, 'ls')
    const mv = await run(sh, s, 'terraform state mv aws_vpc.main module.net.aws_vpc.main')
    expect(mv.output).toContain('Successfully moved 1 object(s).')
    expect(await sh.doneWhen(SAVED)).toBe(true)
    expect(await sh.doneWhen({ plan_clean: true })).toBe(true)
    expect(await sh.doneWhen({ applied: { op: 'delete', address: 'aws_vpc.main' } })).toBe(false)
  })
})
