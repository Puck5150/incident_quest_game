import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-count-to-for-each')
const { play, detectedAll } = playbook(scenario)

const KEYED = ['aws_instance.db["us-east-1a"]', 'aws_instance.db["us-east-1b"]', 'aws_subnet.private["us-east-1a"]', 'aws_subnet.private["us-east-1b"]', 'aws_vpc.main']
const IDS = { subnet: ['subnet-0a4c1e7f9b2d3a581', 'subnet-0b8d2f6e0c3e4b692'], db: ['i-0d1a5c3e7b9f2a401', 'i-0e2b6d4f8c0a3b512'] }
const MOVED = `cat >> moved.tf <<'EOF'
moved {
  from = aws_subnet.private[0]
  to   = aws_subnet.private["us-east-1a"]
}

moved {
  from = aws_subnet.private[1]
  to   = aws_subnet.private["us-east-1b"]
}

moved {
  from = aws_instance.db[0]
  to   = aws_instance.db["us-east-1a"]
}

moved {
  from = aws_instance.db[1]
  to   = aws_instance.db["us-east-1b"]
}
EOF`
const MV_SUBNETS = [
  `terraform state mv 'aws_subnet.private[0]' 'aws_subnet.private["us-east-1a"]'`,
  `terraform state mv 'aws_subnet.private[1]' 'aws_subnet.private["us-east-1b"]'`,
]
const MV_DBS = [`terraform state mv 'aws_instance.db[0]' 'aws_instance.db["us-east-1a"]'`, `terraform state mv 'aws_instance.db[1]' 'aws_instance.db["us-east-1b"]'`]
const UNPROTECT = "sed -i '/prevent_destroy/d' db.tf"
const NONE = { 'move-addresses': false, 'ignore-and-revert': false, 'remove-prevent-destroy': false }
const FIXED = { ...NONE, 'move-addresses': true }
const TRAPPED = { ...NONE, 'remove-prevent-destroy': true }

describe('terraform-count-to-for-each on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
  })

  it('(a) the first plan fails on prevent_destroy for both db hosts; state list shows the old indexes', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform plan', 'terraform state list')
    const plan = out[1]
    expect(plan.exitCode).toBe(1)
    expect(plan.output.match(/Error: Instance cannot be destroyed/g)).toHaveLength(2)
    expect(plan.output).toContain('Resource aws_instance.db[0] has lifecycle.prevent_destroy set, but the plan')
    expect(plan.output).toContain('Resource aws_instance.db[1] has lifecycle.prevent_destroy set')
    // Simulator gap (CONTENT_TODO): real Terraform 1.9 also prints the partial plan
    // ("Terraform planned the following actions, but then encountered a problem:"); the simulator prints only the errors.
    expect(plan.output).not.toContain('will be destroyed')
    expect(plan.hits).toContain('evidence:prevent-destroy-saved-you')
    expect(out[2].output.trim().split('\n')).toEqual(['aws_instance.db[0]', 'aws_instance.db[1]', 'aws_subnet.private[0]', 'aws_subnet.private[1]', 'aws_vpc.main'])
    expect(out[2].hits).toContain('evidence:address-changed')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('a plan without prevent_destroy shows each old index destroyed "because resource does not use count"', async () => {
    const { sh, out } = await play('cd ~/infra', UNPROTECT, 'terraform plan')
    const plan = out[2].output
    expect(out[2].exitCode).toBe(0)
    for (const a of ['aws_subnet.private[0]', 'aws_subnet.private[1]', 'aws_instance.db[0]', 'aws_instance.db[1]']) expect(plan).toContain(`  # ${a} will be destroyed\n  # (because resource does not use count)`)
    for (const a of ['aws_subnet.private["us-east-1a"]', 'aws_subnet.private["us-east-1b"]', 'aws_instance.db["us-east-1a"]', 'aws_instance.db["us-east-1b"]']) expect(plan).toContain(`  # ${a} will be created`)
    expect(plan).toContain('Plan: 4 to add, 0 to change, 4 to destroy.')
    expect(out[2].hits).toContain('evidence:plan-destroys-subnets')
    // planning is harmless: nothing is applied
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b) route A: moved blocks, plan shows four moves and nothing else, apply with yes, then No changes', async () => {
    const { sh, out } = await play('cd ~/infra', MOVED, 'terraform plan', 'echo yes | terraform apply', 'terraform plan', 'terraform state list')
    const plan = out[2].output
    expect(out[2].exitCode).toBe(0)
    expect(plan).toContain('# aws_subnet.private[0] has moved to aws_subnet.private["us-east-1a"]')
    expect(plan).toContain('# aws_subnet.private[1] has moved to aws_subnet.private["us-east-1b"]')
    expect(plan).toContain('# aws_instance.db[0] has moved to aws_instance.db["us-east-1a"]')
    expect(plan).toContain('# aws_instance.db[1] has moved to aws_instance.db["us-east-1b"]')
    expect(plan).toContain('Plan: 0 to add, 0 to change, 0 to destroy.')
    expect(out[3].exitCode).toBe(0)
    expect(out[3].output).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.')
    expect(out[4].output).toContain('No changes.')
    expect(out[5].output.trim().split('\n')).toEqual(KEYED)
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(b2) moved blocks without an apply are not the fix: state is still indexed', async () => {
    const { sh } = await play('cd ~/infra', MOVED, 'terraform plan')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(c) route B: four terraform state mv commands, then No changes', async () => {
    const { sh, out } = await play('cd ~/infra', ...MV_SUBNETS, ...MV_DBS, 'terraform state list', 'terraform plan')
    for (const r of out.slice(1, 5)) {
      expect(r.exitCode).toBe(0)
      expect(r.output).toContain('Successfully moved 1 object(s).')
    }
    expect(out[1].output).toContain('Move "aws_subnet.private[0]" to "aws_subnet.private["us-east-1a"]"')
    expect(out[5].output.trim().split('\n')).toEqual(KEYED)
    expect(out[6].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(d) moving only the subnets is not the fix: the db hosts are still at the old indexes', async () => {
    const { sh, out } = await play('cd ~/infra', ...MV_SUBNETS, 'terraform plan')
    expect(out[3].exitCode).toBe(1)
    expect(out[3].output).toContain('Resource aws_instance.db[0] has lifecycle.prevent_destroy set')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(e) trap: removing prevent_destroy and applying terminates both db hosts; moved blocks afterwards cannot earn the fix', async () => {
    const { sh, out } = await play('cd ~/infra', UNPROTECT, 'terraform apply -auto-approve')
    const apply = out[2].output
    expect(out[2].exitCode).toBe(0)
    expect(apply).toContain('aws_instance.db[0]: Destroying... [id=i-0d1a5c3e7b9f2a401]')
    expect(apply).toContain('aws_instance.db[1]: Destroying... [id=i-0e2b6d4f8c0a3b512]')
    expect(apply).toContain('aws_subnet.private[0]: Destroying... [id=subnet-0a4c1e7f9b2d3a581]')
    expect(apply).toContain('Apply complete! Resources: 4 added, 0 changed, 4 destroyed.')
    expect(await sh.doneWhen({ reality_lacks: { type: 'aws_instance', id: IDS.db[0] } })).toBe(true)
    expect(await detectedAll(sh)).toEqual(TRAPPED)
    // Putting everything back as the fix would have it cannot earn the fix now.
    for (const l of [MOVED, 'terraform apply -auto-approve']) await sh.run(l, atStage(scenario, 0), new Set())
    const after = await sh.run('terraform plan', atStage(scenario, 0), new Set())
    expect(after.output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('(f) both fix routes keep the same subnets and db hosts in AWS', async () => {
    for (const route of [[MOVED, 'terraform apply -auto-approve'], [...MV_SUBNETS, ...MV_DBS]]) {
      const { sh, out } = await play('cd ~/infra', ...route, `terraform state show 'aws_subnet.private["us-east-1a"]'`, `terraform state show 'aws_instance.db["us-east-1b"]'`)
      expect(out.at(-2)!.output).toContain(`id                      = "${IDS.subnet[0]}"`)
      expect(out.at(-1)!.output).toContain(`id                = "${IDS.db[1]}"`)
      for (const id of IDS.subnet) expect(await sh.doneWhen({ reality_has: { type: 'aws_subnet', id } })).toBe(true)
      for (const id of IDS.db) expect(await sh.doneWhen({ reality_has: { type: 'aws_instance', id } })).toBe(true)
      expect(await detectedAll(sh)).toEqual(FIXED)
    }
  })

  it('the scripted AWS and git lookups answer and carry notes', async () => {
    const { out } = await play(
      'cd ~/infra',
      'aws ec2 describe-subnets --filters Name=vpc-id,Values=vpc-0f3e2a9c41b7d5e60',
      'aws ec2 describe-instances --filters Name=tag:Name,Values=orders-db-*',
      'git diff main -- network.tf db.tf',
      'git log --oneline -3',
    )
    expect(out[1].output).toContain('"SubnetId": "subnet-0a4c1e7f9b2d3a581"')
    expect(out[2].output).toContain('"InstanceId": "i-0e2b6d4f8c0a3b512"')
    expect(out[3].output).toContain('+  for_each          = toset(var.azs)')
    expect(out[4].output).toContain('refactor: key private subnets and db hosts by AZ')
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.match!], c.match).toBeDefined()
  })

  it('(g) every key evidence tag is awarded on the ideal path', async () => {
    const { out } = await play(
      'cd ~/infra',
      'terraform plan',
      'terraform state list',
      'git diff main -- network.tf db.tf',
      'aws ec2 describe-subnets --filters Name=vpc-id,Values=vpc-0f3e2a9c41b7d5e60',
      MOVED,
      'terraform plan',
      'echo yes | terraform apply',
      'terraform plan',
    )
    const hits = out.flatMap((r) => r.hits)
    const tags = new Set([
      ...hits.filter((h) => h.startsWith('evidence:')).map((h) => h.slice('evidence:'.length)),
      ...scenario.terminal!.commands.filter((c) => c.match && hits.includes(c.match)).map((c) => c.evidence),
    ])
    for (const t of scenario.key_evidence) expect(tags.has(t), t).toBe(true)
  })
})
