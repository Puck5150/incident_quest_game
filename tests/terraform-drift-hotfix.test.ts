import { describe, expect, it } from 'vitest'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-drift-hotfix')
const { play, detectedAll } = playbook(scenario)

const NONE = { codify: false, 'apply-anyway': false, 'target-instance': false, 'refresh-apply': false }
const FIXED = { ...NONE, codify: true }
const TRAPPED = { ...NONE, 'apply-anyway': true }

const HOTFIX = `  ingress {
    description = "partner hotfix"
    from_port   = 8443
    to_port     = 8443
    protocol    = "tcp"
    cidr_blocks = ["198.51.100.0/24"]
  }
`
const INTERNAL = `  ingress {
    description = "internal clients"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.20.0.0/16"]
  }
`
// The whole lab main.tf with the security group's ingress blocks given.
const MAIN = (ingress: string, sgExtra = '') => `cat > main.tf <<'EOF'
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_security_group" "payments" {
  name        = "payments"
  description = "Payments service"
  vpc_id      = "vpc-0payments"
${sgExtra}
${ingress}}

resource "aws_instance" "payments_worker" {
  ami           = "ami-0abc1234def567890"
  instance_type = "t3.small"

  tags = {
    cost-center = "payments"
  }
}
EOF`
const CODIFIED = MAIN(INTERNAL + HOTFIX)
const RULE443 = { cidr_blocks: ['10.20.0.0/16'], description: 'internal clients', from_port: 443, protocol: 'tcp', to_port: 443 }
const RULE8443 = { cidr_blocks: ['198.51.100.0/24'], description: 'partner hotfix', from_port: 8443, protocol: 'tcp', to_port: 8443 }
const SG = (sh: { doneWhen: (d: never) => Promise<boolean> }, equals: unknown[]) =>
  sh.doneWhen({ reality_has: { type: 'aws_security_group', id: 'sg-0payments', attr: 'ingress', equals } } as never)

describe('terraform-drift-hotfix on the simulator', () => {
  it('is backed by the simulator, with only a benign git command scripted', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.map((c) => c.match ?? c.example)).toEqual(['git log --oneline -3'])
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.match ?? c.example!]).toBeDefined()
  })

  it('keeps the old action ids, kinds, solution path and evidence tags', () => {
    expect(scenario.actions.map((a) => [a.id, a.kind])).toEqual([
      ['codify', 'fix'],
      ['apply-anyway', 'destructive'],
      ['target-instance', 'wrong'],
      ['refresh-apply', 'wrong'],
    ])
    expect(scenario.solution_paths).toEqual([['codify']])
    expect(scenario.key_evidence).toEqual(['plan-removes-rule', 'drift', 'hotfix-note'])
    expect(scenario.logs!.map((l) => l.evidence)).toEqual(['hotfix-note'])
  })

  it('(a) the real plan: instance tags and the security group losing the hotfix rule; evidence plan-removes-rule', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform plan')
    const plan = out[1].output
    expect(plan).toContain('# aws_instance.payments_worker will be updated in-place')
    expect(plan).toContain('+ "cost-center" = "payments"')
    expect(plan).toContain('# aws_security_group.payments will be updated in-place')
    expect(plan).toContain('- "198.51.100.0/24",')
    expect(plan).toContain('- description = "partner hotfix"')
    expect(plan).toContain('(1 unchanged element hidden)')
    expect(plan).toContain('Plan: 0 to add, 2 to change, 0 to destroy.')
    expect(out[1].hits).toContain('evidence:plan-removes-rule')
    expect(out[1].hits).not.toContain('evidence:drift')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b) plan -refresh-only shows the security group changed outside Terraform; evidence drift; state is not touched', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform plan -refresh-only', 'terraform state show aws_security_group.payments')
    expect(out[1].exitCode).toBe(0)
    expect(out[1].output).toContain('Note: Objects have changed outside of Terraform')
    expect(out[1].output).toContain('# aws_security_group.payments has changed')
    expect(out[1].output).toContain('+ description = "partner hotfix"')
    expect(out[1].output).toContain('This is a refresh-only plan, so Terraform will not take any actions to undo')
    expect(out[1].output).not.toContain('Plan:')
    expect(out[1].hits).toContain('evidence:drift')
    expect(out[2].output).not.toContain('8443')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(c) every key evidence tag is obtainable before any fix (the note is the scripted log)', async () => {
    const { out } = await play('cd ~/infra', 'terraform plan', 'terraform plan -refresh-only')
    const tags = new Set(out.flatMap((r) => r.hits).filter((h) => h.startsWith('evidence:')).map((h) => h.slice(9)))
    expect(tags.has('plan-removes-rule') && tags.has('drift')).toBe(true)
  })

  it('(d) ideal: codify the rule in main.tf; the plan shows only the tag; apply updates only the instance and keeps the rule', async () => {
    const { sh, out } = await play('cd ~/infra', CODIFIED, 'terraform plan')
    expect(out[2].output).toContain('Plan: 0 to add, 1 to change, 0 to destroy.')
    expect(out[2].output).toContain('# aws_instance.payments_worker will be updated in-place')
    expect(out[2].output).not.toContain('aws_security_group.payments will be')
    expect(await detectedAll(sh)).toEqual(FIXED)
    const apply = await sh.run('terraform apply -auto-approve', scenario as never, new Set())
    expect(apply.output).toContain('Apply complete! Resources: 0 added, 1 changed, 0 destroyed.')
    expect(apply.output).not.toContain('aws_security_group.payments: Modifying')
    expect(await detectedAll(sh)).toEqual(FIXED)
    expect(await SG(sh, [RULE443, RULE8443])).toBe(true)
    expect((await sh.run('terraform plan', scenario as never, new Set())).output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(e) spelling variants of the codified rule are accepted when the plan leaves the group alone', async () => {
    const reordered = `  ingress {
    cidr_blocks = ["198.51.100.0/24"]
    protocol    = "tcp"
    to_port     = 8443
    from_port   = 8443
    description = "partner hotfix"
  }
`
    const cases = [MAIN(HOTFIX + INTERNAL), MAIN(INTERNAL + reordered), MAIN(INTERNAL + HOTFIX.replace('["198.51.100.0/24"]', '[ "198.51.100.0/24" ]'))]
    for (const c of cases) {
      const { sh, out } = await play('cd ~/infra', c, 'terraform plan')
      expect(out[2].output).toContain('Plan: 0 to add, 1 to change, 0 to destroy.')
      expect(await detectedAll(sh)).toEqual(FIXED)
    }
    // the same edit made with sed on the checked-out file
    const sed = `sed -i 's|^  vpc_id      = "vpc-0payments"|&\\n  ingress {\\n    description = "partner hotfix"\\n    from_port = 8443\\n    to_port = 8443\\n    protocol = "tcp"\\n    cidr_blocks = ["198.51.100.0/24"]\\n  }|' main.tf`
    const { sh } = await play('cd ~/infra', sed, 'terraform plan')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(f) a rule that does not match reality (other description or port) leaves the group changing: not the fix', async () => {
    for (const bad of [HOTFIX.replace('partner hotfix', 'partner'), HOTFIX.replace(/8443/g, '9443')]) {
      const { sh, out } = await play('cd ~/infra', MAIN(INTERNAL + bad), 'terraform plan')
      expect(out[2].output).toContain('# aws_security_group.payments will be updated in-place')
      expect(await detectedAll(sh)).toEqual(NONE)
    }
  })

  it('(g) the CIDR only in a comment, or ignore_changes on ingress, is a clean plan but not the codified fix', async () => {
    const comment = await play('cd ~/infra', MAIN(INTERNAL, '  # TODO 198.51.100.0/24 on 8443\n'), 'terraform plan')
    expect(comment.out[2].output).toContain('aws_security_group.payments will be updated')
    expect(await detectedAll(comment.sh)).toEqual(NONE)
    const ignore = await play('cd ~/infra', MAIN(INTERNAL + '\n  lifecycle {\n    ignore_changes = [ingress]\n  }\n'), 'terraform plan')
    expect(ignore.out[2].output).toContain('Plan: 0 to add, 1 to change, 0 to destroy.')
    expect(await detectedAll(ignore.sh)).toEqual(NONE)
  })

  it('(h) trap: apply as-is removes the rule from reality; codifying afterwards never earns the fix', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform apply -auto-approve')
    expect(out[1].output).toContain('Apply complete! Resources: 0 added, 2 changed, 0 destroyed.')
    expect(await SG(sh, [RULE443])).toBe(true)
    expect(await detectedAll(sh)).toEqual(TRAPPED)
    await sh.run(CODIFIED, scenario as never, new Set())
    const plan = await sh.run('terraform plan', scenario as never, new Set())
    expect(plan.output).toContain('aws_security_group.payments will be updated in-place')
    await sh.run('terraform apply -auto-approve', scenario as never, new Set())
    expect(await SG(sh, [RULE443, RULE8443])).toBe(true)
    expect((await sh.run('terraform plan', scenario as never, new Set())).output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('(i) trap spelling: answering yes to a plain apply is the same damage', async () => {
    const { sh } = await play('cd ~/infra', 'echo yes | terraform apply')
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('(j) wrong: -target on the instance leaves the group alone, the rule stays in reality and the next plan still removes it', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform apply -target=aws_instance.payments_worker -auto-approve', 'terraform plan')
    expect(out[1].output).toContain('Apply complete! Resources: 0 added, 1 changed, 0 destroyed.')
    expect(out[1].output).not.toContain('aws_security_group.payments: Modifying')
    expect(await SG(sh, [RULE443, RULE8443])).toBe(true)
    expect(out[2].output).toContain('Plan: 0 to add, 1 to change, 0 to destroy.')
    expect(out[2].output).toContain('# aws_security_group.payments will be updated in-place')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(k) wrong: apply -refresh-only records the rule in state but the plan still removes it', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform apply -refresh-only -auto-approve', 'terraform state show aws_security_group.payments', 'terraform plan')
    expect(out[1].exitCode).toBe(0)
    expect(out[1].output).toContain('# aws_security_group.payments has changed')
    expect(out[1].output).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.')
    expect(out[2].output).toContain('8443')
    expect(out[3].output).toContain('# aws_security_group.payments will be updated in-place')
    expect(out[3].output).toContain('- description = "partner hotfix"')
    expect(await SG(sh, [RULE443, RULE8443])).toBe(true)
    expect(await detectedAll(sh)).toEqual(NONE)
    // refreshed first, then codified: still the fix, and a second refresh finds nothing
    await sh.run(CODIFIED, scenario as never, new Set())
    expect(await detectedAll(sh)).toEqual(FIXED)
    expect((await sh.run('terraform plan -refresh-only', scenario as never, new Set())).output).toContain('No changes. Your infrastructure still matches the configuration.')
  })

  it('(l) refresh-only apply asks first and an unanswered prompt changes nothing', async () => {
    const { sh, out } = await play('cd ~/infra', 'echo no | terraform apply -refresh-only', 'echo yes | terraform apply -refresh-only', 'terraform state show aws_security_group.payments')
    expect(out[1].exitCode).toBe(1)
    expect(out[1].output).toContain('Would you like to update the Terraform state to reflect these detected changes?')
    expect(out[1].output).toContain('Apply cancelled.')
    expect(out[2].exitCode).toBe(0)
    expect(out[3].output).toContain('8443')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(m) refresh-only flag conflicts are errors', async () => {
    const { out } = await play('cd ~/infra', 'terraform plan -refresh-only -refresh=false', 'terraform plan -refresh-only -replace=aws_instance.payments_worker')
    expect(out[1].exitCode).toBe(1)
    expect(out[1].output + out[1].output).toContain('Incompatible refresh-only and refresh options')
    expect(out[2].output).toContain('Incompatible refresh-only and replace options')
  })

  it('(n) stuck: a broken main.tf plans nothing and credits nothing, and fixing the syntax goes on as before', async () => {
    const { sh, out } = await play('cd ~/infra', 'echo "resource {" >> main.tf', 'terraform plan')
    expect(out[2].exitCode).toBe(1)
    expect(await detectedAll(sh)).toEqual(NONE)
  })
})

describe('codify spelled with variables and locals', () => {
  const CIDR_RULE = (cidr: string) => HOTFIX.replace('"198.51.100.0/24"', cidr)
  const cases: [string, string[]][] = [
    ['var default', ['cat > vars.tf <<\'EOF\'\nvariable "partner" {\n  default = "198.51.100.0/24"\n}\nEOF', MAIN(INTERNAL + CIDR_RULE('var.partner'))]],
    ['local', ['cat > locals.tf <<\'EOF\'\nlocals {\n  partner = "198.51.100.0/24"\n}\nEOF', MAIN(INTERNAL + CIDR_RULE('local.partner'))]],
    ['variables.tf', ['cat > variables.tf <<\'EOF\'\nvariable "partner_cidr" {\n  default = "198.51.100.0/24"\n}\nEOF', MAIN(INTERNAL + CIDR_RULE('var.partner_cidr'))]],
  ]
  for (const [name, lines] of cases)
    it(`${name} is credited`, async () => {
      const { sh, out } = await play('cd ~/infra', ...lines, 'terraform plan')
      expect(out.at(-1)!.output).toContain('Plan: 0 to add, 1 to change, 0 to destroy.')
      expect(await detectedAll(sh)).toEqual(FIXED)
    })
  it('state rm of the group (a plan that would create it) is not credited', async () => {
    const { sh } = await play('cd ~/infra', "terraform state rm aws_security_group.payments", 'terraform plan')
    expect(await detectedAll(sh)).toEqual(NONE)
  })
})

describe('set-valued attributes compare without order', () => {
  it('ingress rules in another order are the same set, and a different set is not', async () => {
    const { equalSet } = await import('../src/game/terraform/eval.ts')
    const a = { p: 1 }
    const b = { p: 2 }
    expect(equalSet([a, b], [b, a])).toBe(true)
    expect(equalSet([a, a], [a, b])).toBe(false)
    expect(equalSet([a], [a, b])).toBe(false)
    expect(equalSet('x', 'x')).toBe(true)
  })
})
