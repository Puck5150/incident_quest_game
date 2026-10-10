import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-module-refactor')
const { play, detectedAll } = playbook(scenario)

const LISTING = ['aws_instance.app', 'aws_instance.db', 'module.network.aws_subnet.a', 'module.network.aws_subnet.b', 'module.network.aws_vpc.main']
const IDS = { vpc: 'vpc-0c5d8a2e6f1b47390', subnets: ['subnet-0e1f7a3c5b9d24680', 'subnet-04b6d8f0a2c9e1357'], app: 'i-0a7c3e5f9b1d28460', db: 'i-0b8d4f6a0c2e39571' }
const MOVED = `cat >> moved.tf <<'EOF'
moved {
  from = aws_vpc.main
  to   = module.network.aws_vpc.main
}

moved {
  from = aws_subnet.a
  to   = module.network.aws_subnet.a
}

moved {
  from = aws_subnet.b
  to   = module.network.aws_subnet.b
}
EOF`
// One-line forms the terminal UI can take (heredocs cannot be typed there; repeated spaces collapse).
const MOVED_PRINTF = ['aws_vpc.main module.network.aws_vpc.main', 'aws_subnet.a module.network.aws_subnet.a', 'aws_subnet.b module.network.aws_subnet.b'].map((p) => {
  const [from, to] = p.split(' ')
  return `printf 'moved {\\n  from = ${from}\\n  to = ${to}\\n}\\n\\n' >> moved.tf`
})
const MV = [
  'terraform state mv aws_vpc.main module.network.aws_vpc.main',
  'terraform state mv aws_subnet.a module.network.aws_subnet.a',
  'terraform state mv aws_subnet.b module.network.aws_subnet.b',
]
const UNPROTECT = "sed -i '/prevent_destroy/d' app.tf"
const NONE = { 'move-into-module': false, 'target-the-module': false, 'revert-and-close': false, 'remove-guard-and-apply': false }
const FIXED = { ...NONE, 'move-into-module': true }
const TRAPPED = { ...NONE, 'remove-guard-and-apply': true }
const TARGETED = { ...NONE, 'target-the-module': true }

describe('terraform-module-refactor on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
  })

  it('(a) the first plan is a partial plan: the old addresses are destroyed, the module ones created, then prevent_destroy fails; nothing is credited yet', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform plan', 'terraform state list')
    const plan = out[1]
    expect(plan.exitCode).toBe(1)
    expect(plan.output).toContain('Terraform planned the following actions, but then encountered a problem:')
    for (const a of ['aws_vpc.main', 'aws_subnet.a', 'aws_subnet.b']) expect(plan.output).toContain(`  # ${a} will be destroyed\n  # (because ${a} is not in configuration)`)
    for (const a of ['aws_vpc.main', 'aws_subnet.a', 'aws_subnet.b']) expect(plan.output).toContain(`  # module.network.${a} will be created`)
    expect(plan.output).toContain('  # aws_instance.app must be replaced')
    expect(plan.output).toContain('-> (known after apply) # forces replacement')
    expect(plan.output).toContain('Plan: 5 to add, 0 to change, 5 to destroy.\n╷\n│ Error: Instance cannot be destroyed')
    expect(plan.output).toContain('Resource aws_instance.db has lifecycle.prevent_destroy set, but the plan')
    expect(plan.hits).toEqual(expect.arrayContaining(['evidence:prevent-destroy-saved-you', 'evidence:vpc-not-in-config']))
    expect(out[2].output.trim().split('\n')).toEqual(['aws_instance.app', 'aws_instance.db', 'aws_subnet.a', 'aws_subnet.b', 'aws_vpc.main'])
    expect(out[2].hits).toContain('evidence:root-addresses')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b) route A: moved blocks (heredoc), plan shows three moves only, apply, then No changes', async () => {
    const { sh, out } = await play('cd ~/infra', MOVED, 'terraform plan', 'echo yes | terraform apply', 'terraform plan', 'terraform state list')
    const plan = out[2].output
    expect(out[2].exitCode).toBe(0)
    for (const a of ['aws_vpc.main', 'aws_subnet.a', 'aws_subnet.b']) expect(plan).toContain(`# ${a} has moved to module.network.${a}`)
    expect(plan).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    expect(out[3].output).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.')
    expect(out[4].output).toContain('No changes.')
    expect(out[5].output.trim().split('\n')).toEqual(LISTING)
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(b1) route A typed as one-line printf commands works the same', async () => {
    const { sh, out } = await play('cd ~/infra', ...MOVED_PRINTF, 'cat moved.tf', 'terraform apply -auto-approve', 'terraform plan')
    expect(out[4].output).toContain('  to = module.network.aws_subnet.a')
    expect(out[5].output).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.')
    expect(out[6].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(b2) moved blocks that are only planned are not the fix', async () => {
    const { sh } = await play('cd ~/infra', MOVED, 'terraform plan')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b3) moving only the VPC is not the fix: the subnets are still planned for destruction', async () => {
    const { sh, out } = await play('cd ~/infra', MOVED_PRINTF[0], 'terraform apply -auto-approve', 'terraform plan')
    expect(out[3].exitCode).toBe(1)
    expect(out[3].output).toContain('# aws_subnet.a will be destroyed')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(c) route B: three terraform state mv commands, then No changes', async () => {
    const { sh, out } = await play('cd ~/infra', ...MV, 'terraform state list', 'terraform plan')
    for (const r of out.slice(1, 4)) {
      expect(r.exitCode).toBe(0)
      expect(r.output).toContain('Successfully moved 1 object(s).')
    }
    expect(out[4].output.trim().split('\n')).toEqual(LISTING)
    expect(out[5].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(d) moving only the subnets with state mv is not the fix', async () => {
    const { sh, out } = await play('cd ~/infra', MV[1], MV[2], 'terraform plan')
    expect(out[3].exitCode).toBe(1)
    expect(out[3].output).toContain('# aws_vpc.main will be destroyed')
    expect(out[3].output).toContain('Error: Instance cannot be destroyed')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(e) trap: removing prevent_destroy and applying destroys the db host, the app and the network; the fix cannot be earned afterwards', async () => {
    const { sh, out } = await play('cd ~/infra', UNPROTECT, 'terraform apply -auto-approve')
    const apply = out[2].output
    expect(out[2].exitCode).toBe(0)
    expect(apply).toContain(`aws_instance.db: Destroying... [id=${IDS.db}]`)
    expect(apply).toContain(`aws_vpc.main: Destroying... [id=${IDS.vpc}]`)
    expect(apply).toContain('Apply complete! Resources: 5 added, 0 changed, 5 destroyed.')
    expect(await sh.doneWhen({ reality_lacks: { type: 'aws_instance', id: IDS.db } })).toBe(true)
    expect(await detectedAll(sh)).toEqual(TRAPPED)
    // Writing the moved blocks and the guard back cannot earn the fix now.
    for (const l of [MOVED, "sed -i 's/^  lifecycle {$/  lifecycle {\\n    prevent_destroy = true/' app.tf", 'terraform apply -auto-approve']) await sh.run(l, atStage(scenario, 0), new Set())
    expect((await sh.run('terraform plan', atStage(scenario, 0), new Set())).output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('(f) -target: planning the module alone avoids the prevent_destroy error and warns; it is not the fix', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform plan -target=module.network')
    expect(out[1].exitCode).toBe(0)
    expect(out[1].output).toContain('Plan: 3 to add, 0 to change, 0 to destroy.')
    expect(out[1].output).toContain('Warning: Resource targeting is in effect')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(g) -target apply of the module builds a second network (wrong action); the original stays, the fix cannot be earned', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform apply -target=module.network -auto-approve', 'terraform state list', 'terraform plan')
    expect(out[1].output).toContain('Apply complete! Resources: 3 added, 0 changed, 0 destroyed.')
    expect(out[1].output).toContain('Warning: Applied changes may be incomplete')
    expect(out[2].output.trim().split('\n')).toContain('aws_vpc.main')
    expect(out[2].output.trim().split('\n')).toContain('module.network.aws_vpc.main')
    expect(out[3].exitCode).toBe(1)
    expect(await detectedAll(sh)).toEqual(TARGETED)
    // Moves cannot reconcile two networks, and the duplicates cannot be removed while the instances depend on them.
    for (const l of [...MOVED_PRINTF, 'terraform apply -auto-approve']) await sh.run(l, atStage(scenario, 0), new Set())
    expect((await sh.run('terraform plan', atStage(scenario, 0), new Set())).exitCode).toBe(1)
    expect(await detectedAll(sh)).toEqual(TARGETED)
    const destroy = await sh.run('terraform destroy -target=module.network -auto-approve', atStage(scenario, 0), new Set())
    expect(destroy.exitCode).toBe(1)
    expect(destroy.output).toContain('Instance cannot be destroyed')
    expect(await detectedAll(sh)).toEqual(TARGETED)
  })

  it('(h) both fix routes keep the same VPC, subnets and instances in AWS; re-applying is a no-op', async () => {
    for (const route of [[MOVED, 'terraform apply -auto-approve'], MV]) {
      const { sh, out } = await play('cd ~/infra', ...route, 'terraform apply -auto-approve', `terraform state show module.network.aws_vpc.main`, 'terraform state show aws_instance.db')
      expect(out.at(-3)!.output).toContain('No changes.')
      expect(out.at(-2)!.output).toContain(`"${IDS.vpc}"`)
      expect(out.at(-1)!.output).toContain(`"${IDS.db}"`)
      for (const id of IDS.subnets) expect(await sh.doneWhen({ reality_has: { type: 'aws_subnet', id } })).toBe(true)
      for (const id of [IDS.app, IDS.db]) expect(await sh.doneWhen({ reality_has: { type: 'aws_instance', id } })).toBe(true)
      expect(await detectedAll(sh)).toEqual(FIXED)
    }
  })

  it('(i) removing prevent_destroy while moving is neither the fix nor the trap until the guard is back', async () => {
    const { sh } = await play('cd ~/infra', MOVED, UNPROTECT, 'terraform apply -auto-approve')
    expect(await detectedAll(sh)).toEqual(NONE)
    await sh.run("sed -i 's/^  lifecycle {$/  lifecycle {\\n    prevent_destroy = true/' app.tf", atStage(scenario, 0), new Set())
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('the scripted git and AWS lookups answer and carry notes', async () => {
    const { out } = await play('cd ~/infra', 'git diff main', 'git log --oneline -3', 'aws ec2 describe-subnets --filters Name=vpc-id,Values=vpc-0c5d8a2e6f1b47390', 'aws ec2 describe-instances')
    expect(out[1].output).toContain('+module "network" {')
    expect(out[2].output).toContain('refactor: move the VPC and subnets into modules/network')
    expect(out[3].output).toContain('"SubnetId": "subnet-0e1f7a3c5b9d24680"')
    expect(out[4].output).toContain('"InstanceId": "i-0b8d4f6a0c2e39571"')
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.match!], c.match).toBeDefined()
  })

  it('(j) every key evidence tag is awarded before the fix', async () => {
    const { out } = await play('cd ~/infra', 'terraform plan', 'terraform state list', 'git diff main', 'aws ec2 describe-subnets')
    const hits = out.flatMap((r) => r.hits)
    const tags = new Set([
      ...hits.filter((h) => h.startsWith('evidence:')).map((h) => h.slice('evidence:'.length)),
      ...scenario.terminal!.commands.filter((c) => c.match && hits.includes(c.match)).map((c) => c.evidence),
    ])
    for (const t of scenario.key_evidence) expect(tags.has(t), t).toBe(true)
  })
})
