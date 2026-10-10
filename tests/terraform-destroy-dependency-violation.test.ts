import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-destroy-dependency-violation')
const { play, detectedAll } = playbook(scenario)

const NONE = { 'release-eni': false, 'destroy-after-release': false, 'state-rm-network': false, 'target-the-vpc': false, 'add-depends-on': false, 'grant-more-permissions': false }
const D = 'terraform destroy -auto-approve'
const DESC = 'aws ec2 describe-network-interfaces --filters Name=subnet-id,Values=subnet-0e92c4a7b1d38f560'
const DEL = 'aws ec2 delete-network-interface --network-interface-id eni-0c4a8e2f6b1d97305'

// Typed-command actions are taken by the engine, not the shell: mimic it.
const withTaken = async (lines: (string | { take: string })[]) => {
  const { sh } = await play('cd ~/app-infra')
  const taken = new Set<string>()
  const out = []
  for (const l of lines) {
    if (typeof l !== 'string') {
      taken.add(l.take)
      await sh.update(scenario, taken)
      continue
    }
    out.push(await sh.run(l, atStage(scenario, 0), taken))
  }
  return { sh, out, taken }
}

describe('terraform-destroy-dependency-violation', () => {
  it('destroy stops at the subnet with the exact error; instance and group are gone', async () => {
    const { sh, out } = await play('cd ~/app-infra', D, 'terraform state list')
    expect(out[1].exitCode).toBe(1)
    expect(out[1].output).toContain("api error DependencyViolation: The subnet 'subnet-0e92c4a7b1d38f560' has dependencies and cannot be deleted.")
    expect(out[1].output).toContain('aws_instance.app: Destruction complete')
    expect(out[1].output).toContain('aws_security_group.app: Destruction complete')
    expect(out[1].hits).toContain('evidence:subnet-dependency-violation')
    expect(out[2].output.trim().split('\n').sort()).toEqual(['aws_subnet.app', 'aws_vpc.main'])
    expect(out[2].hits).toContain('evidence:eni-not-in-state')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('evidence is obtainable before any change, in several spellings', async () => {
    const { out } = await play('cd ~/app-infra', DESC, "aws ec2 describe-network-interfaces --filters 'Name=subnet-id,Values=subnet-0e92c4a7b1d38f560'", 'aws ec2 describe-network-interfaces --network-interface-ids eni-0c4a8e2f6b1d97305', 'aws ec2 describe-network-interfaces --region us-east-1 --filters Name=subnet-id,Values=subnet-0e92c4a7b1d38f560', 'aws sts get-caller-identity', `${DESC} --output json`)
    for (const i of [1, 2, 3, 4, 6]) {
      expect(out[i].output, `${i}`).toContain('Interface for the shared ingest endpoint')
      expect(out[i].output).toContain('"Status": "available"')
    }
    expect(out[5].output).toContain('PlatformAdmin')
  })

  it('ideal route: release the interface, destroy once, second destroy is a no-op', async () => {
    const { sh, out } = await withTaken([D, DESC, { take: 'release-eni' }, DESC, D, D, 'terraform state list'])
    expect(out[0].exitCode).toBe(1)
    expect(out[1].output).toContain('eni-0c4a8e2f6b1d97305')
    expect(out[2].output).toContain('"NetworkInterfaces": []')
    expect(out[3].exitCode).toBe(0)
    expect(out[3].output).toContain('Destroy complete! Resources: 2 destroyed.')
    expect(out[4].exitCode).toBe(0)
    expect(out[4].output).toContain('Destroy complete! Resources: 0 destroyed.')
    expect(out[5].output.trim()).toBe('')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'destroy-after-release': true })
  })

  it('releasing alone is not the whole fix', async () => {
    const { sh } = await withTaken([{ take: 'release-eni' }, 'terraform plan'])
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('the release command regex accepts spellings and refuses others', () => {
    const rx = new RegExp(scenario.actions.find((a) => a.id === 'release-eni')!.match_regex!)
    for (const ok of [DEL, `${DEL} --region us-east-1`, 'aws ec2 delete-network-interface --region us-east-1 --network-interface-id eni-0c4a8e2f6b1d97305']) expect(rx.test(ok), ok).toBe(true)
    for (const no of ['aws ec2 delete-network-interface --network-interface-id eni-other', 'aws ec2 delete-subnet --subnet-id subnet-0e92c4a7b1d38f560', 'aws ec2 delete-network-interface', `${DEL} --dry-run`]) expect(rx.test(no), no).toBe(false)
  })

  it('-target on the vpc is a dead end with the same error, nothing extra destroyed', async () => {
    const { sh, out } = await play('cd ~/app-infra', 'terraform destroy -target=aws_vpc.main -auto-approve', 'terraform state list')
    expect(out[1].exitCode).toBe(1)
    expect(out[1].output).toContain("DependencyViolation: The subnet 'subnet-0e92c4a7b1d38f560'")
    expect(out[2].output.trim().split('\n').sort()).toEqual(['aws_subnet.app', 'aws_vpc.main'])
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('a depends_on edit changes nothing, and a refresh finds nothing', async () => {
    const { sh, out } = await play('cd ~/app-infra', "sed -i 's/subnet_id              = aws_subnet.app.id/subnet_id              = aws_subnet.app.id\\n  depends_on = [aws_vpc.main]/' main.tf", D, 'terraform refresh')
    expect(out[2].exitCode).toBe(1)
    expect(out[2].output).toContain('DependencyViolation: The subnet')
    expect(out[3].exitCode).toBe(0)
    expect(out[3].output).not.toContain('Error')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('trap: state rm of the subnet and vpc orphans them, and it stays on the score', async () => {
    const { sh, out } = await play('cd ~/app-infra', 'terraform state rm aws_subnet.app aws_vpc.main', D)
    expect(out[2].exitCode).toBe(0)
    expect(out[2].output).toContain('Destroy complete! Resources: 2 destroyed.')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'state-rm-network': true })
  })

  it('state rm of the subnet alone leaves the vpc destroy failing', async () => {
    const { sh, out } = await play('cd ~/app-infra', 'terraform state rm aws_subnet.app', D)
    expect(out[2].exitCode).toBe(1)
    expect(out[2].output).toContain('DependencyViolation')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'state-rm-network': true })
  })

  it('wrong hypotheses: honest output', async () => {
    const { out } = await play('cd ~/app-infra', D)
    expect(out[1].output).not.toContain('UnauthorizedOperation')
    expect(out[1].output).not.toContain('state lock')
  })
})
