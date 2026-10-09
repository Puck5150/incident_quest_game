// @vitest-environment jsdom
// TF5 incidents played through IncidentScreen: the simulated terminal takes
// the fix (or the trap) from the world, once; typed and button actions flip
// the apply faults through the real session, also after a remount.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GameEvent, Session } from '../src/game/engine.ts'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

// Same helpers as tests/incident.test.tsx. Typed input is one line, and runs of
// spaces collapse (engine normalize), so commands below use single spaces.
const press = (cmd: string) => {
  const input = screen.getByLabelText('Terminal command')
  fireEvent.change(input, { target: { value: cmd } })
  fireEvent.keyDown(input, { key: 'Enter' })
}
const idle = () => waitFor(() => expect(screen.getByRole('log', { name: 'Terminal output' }).getAttribute('aria-busy')).toBe('false'))
const type = async (cmd: string) => {
  await idle()
  press(cmd)
}
const output = () => screen.getByRole('log', { name: 'Terminal output' }).textContent ?? ''
const count = (re: RegExp) => output().match(new RegExp(re.source, 'g'))?.length ?? 0

async function mount(id: string) {
  const { default: IncidentScreen } = await import('../src/screens/IncidentScreen.tsx')
  const { fixComplete } = await import('../src/game/engine.ts')
  const { score } = await import('../src/game/scoring.ts')
  const item = await (await import('virtual:content')).loadItem(id)
  if (item.kind !== 'incident') throw new Error('expected an incident')
  const scenario = item.scenario
  const box: { saved?: Session; resolved?: GameEvent[] } = {}
  const props = { scenario, onResolved: (log: GameEvent[]) => (box.resolved = log), onChange: (s: Session) => (box.saved = s) }
  let view = render(<IncidentScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Accept mission' }))
  const run = async (...cmds: string[]) => {
    for (const c of cmds) await type(c)
  }
  // A later command, and the world checks queued behind it, finish.
  const settle = async () => {
    await type('ls')
    await waitFor(() => expect(box.saved!.log.at(-1)).toMatchObject({ type: 'RUN_COMMAND', input: 'ls' }))
    await idle()
  }
  const declare = (text: RegExp) => {
    fireEvent.click(screen.getByLabelText(text))
    fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
    expect(box.saved!.phase).toBe('acting')
  }
  const click = (label: RegExp) => fireEvent.click(screen.getByRole('button', { name: label }))
  const taken = () => box.saved!.log.flatMap((e) => (e.type === 'TAKE_ACTION' ? [e.id] : []))
  // Unmount and mount again from the saved session; waits until the shell
  // commands have replayed (the transcript ends with `last`).
  const remount = async (last: RegExp) => {
    view.unmount()
    view = render(<IncidentScreen {...props} initial={box.saved} />)
    await waitFor(() => expect(output()).toMatch(last))
    await idle()
  }
  // Ideal path: each fix taken once, Close out resolves, no destructive deduction.
  const closeClean = async (...fixes: string[]) => {
    await settle()
    expect(taken()).toEqual(fixes)
    expect(fixComplete(scenario, box.saved!.log)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close out' }))
    expect(box.resolved).toBeDefined()
    expect(box.resolved!.at(-1)).toMatchObject({ type: 'CLOSE_INCIDENT' })
    const s = score(scenario, box.resolved!)
    expect(s.mistakes.destructive).toBe(0)
    return s
  }
  // Trap path: the actions taken, in order, include the destructive one once; the fix is out of reach.
  const trapped = async (...expected: string[]) => {
    await settle()
    expect(taken()).toEqual(expected)
    expect(fixComplete(scenario, box.saved!.log)).toBe(false)
    expect(screen.queryByRole('button', { name: 'Close out' })).toBeNull()
    expect(score(scenario, box.saved!.log).mistakes.destructive).toBe(1)
  }
  return { run, declare, click, taken, settle, remount, closeClean, trapped, box }
}

const NOT_YET = /Not run: that changes the system\. Declare a root cause first/g

describe('terraform-partial-apply-iam through the UI', () => {
  const ROOT = /isn't allowed rds:CreateDBInstance/
  const GRANT = 'aws iam put-role-policy --profile platform-admin --role-name orders-ci-deploy --policy-name orders-rds --policy-document file://orders-rds.json'
  const GRANT_BUTTON = /^Add rds:CreateDBInstance to the orders-ci-deploy role's policy/
  const DENIED = /not authorized to perform: rds:CreateDBInstance/g
  const ADDED = /Apply complete! Resources: 1 added, 0 changed, 0 destroyed\./

  it('typed grant: held until the root cause is named, then the next apply creates only the database; a remount rebuilds the same transcript', async () => {
    const g = await mount('terraform-partial-apply-iam')
    await g.run('cat ci-apply.log', 'terraform state list', 'terraform plan', 'aws sts get-caller-identity', 'terraform apply -auto-approve')
    await waitFor(() => expect(count(DENIED)).toBe(2)) // the log, then the reproduced apply
    // typed before naming the cause: not taken, the fault stays
    await g.run(GRANT, 'terraform apply -auto-approve')
    await waitFor(() => expect(count(DENIED)).toBe(3))
    expect(count(NOT_YET)).toBe(1)
    expect(g.taken()).toEqual([])
    g.declare(ROOT)
    await g.run(GRANT, 'terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 1 added, 0 changed, 0 destroyed\.[\s\S]*No changes\./))
    expect(count(DENIED)).toBe(3)
    await g.settle()
    expect(g.taken()).toEqual(['grant-rds-permission', 'finish-apply'])
    const before = output()

    // replay passes each command the actions taken before it: the failed applies fail again, the last succeeds
    await g.remount(/\$ ls/)
    expect(output()).toBe(before)
    expect(g.taken()).toEqual(['grant-rds-permission', 'finish-apply'])
    await g.run('terraform plan')
    await waitFor(() => expect(output().slice(before.length)).toMatch(/No changes\./))
    const s = await g.closeClean('grant-rds-permission', 'finish-apply')
    expect(s.lines.map((l) => l.label).join('\n')).toMatch(/Methodical/)
  })

  it('button grant after a remount: the fault still holds until the button, then the next apply succeeds', async () => {
    const g = await mount('terraform-partial-apply-iam')
    await g.run('terraform apply -auto-approve')
    await waitFor(() => expect(count(DENIED)).toBe(1))
    await g.remount(DENIED)
    await g.run('terraform apply -auto-approve')
    await waitFor(() => expect(count(DENIED)).toBe(2))
    g.declare(ROOT)
    g.click(GRANT_BUTTON)
    await waitFor(() => expect(g.taken()).toEqual(['grant-rds-permission']))
    await g.run('terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 1 added[\s\S]*No changes\./))
    await g.settle()
    const before = output()
    await g.remount(/\$ ls/)
    expect(output()).toBe(before)
    expect(count(ADDED)).toBe(1)
    await g.closeClean('grant-rds-permission', 'finish-apply')
  })

  it('trap: destroy the partial network: destructive once, granting and rebuilding earns nothing', async () => {
    const g = await mount('terraform-partial-apply-iam')
    g.declare(ROOT)
    await g.run('terraform apply -auto-approve', 'terraform destroy -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Destroy complete! Resources: 4 destroyed\./))
    g.click(GRANT_BUTTON)
    await g.run('terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 5 added[\s\S]*No changes\./))
    await g.trapped('destroy-and-retry', 'grant-rds-permission') // the rebuild's finish-apply never came
  })
})

describe('terraform-vcpu-limit through the UI', () => {
  const ROOT = /vCPU quota for running On-Demand standard instances/
  const REQUEST = 'aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 128'
  const REQUEST_BUTTON = /^Request a Service Quotas increase/
  const LIMIT = /api error VcpuLimitExceeded/g
  const INVESTIGATE = [
    'terraform init',
    'terraform apply -auto-approve',
    'terraform state list',
    'terraform plan',
    'aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A',
    'aws ec2 describe-instance-types --instance-types c5.24xlarge --query "InstanceTypes[].VCpuInfo.DefaultVCpus"',
  ]

  it('ideal path, right-size: c5.12xlarge fits and the apply only adds loadgen', async () => {
    const g = await mount('terraform-vcpu-limit')
    await g.run(...INVESTIGATE)
    await waitFor(() => expect(output()).toMatch(/VcpuLimitExceeded[\s\S]*Plan: 1 to add, 0 to change, 0 to destroy\./))
    g.declare(ROOT)
    await g.run("sed -i 's/c5\\.24xlarge/c5.12xlarge/' compute.tf", 'terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 1 added, 0 changed, 0 destroyed\.[\s\S]*No changes\./))
    const s = await g.closeClean('right-size')
    expect(s.lines.map((l) => l.label).join('\n')).toMatch(/Methodical/)
  })

  it('typed quota request: held until the root cause is named, then c5.24xlarge launches; a remount keeps the gating', async () => {
    const g = await mount('terraform-vcpu-limit')
    await g.run(...INVESTIGATE)
    await waitFor(() => expect(count(LIMIT)).toBe(1))
    await g.run(REQUEST, 'terraform apply -auto-approve')
    await waitFor(() => expect(count(LIMIT)).toBe(2))
    expect(count(NOT_YET)).toBe(1)
    expect(g.taken()).toEqual([])
    // a remount here replays both failures, and the next apply still fails
    await g.remount(/terraform apply -auto-approve[\s\S]*VcpuLimitExceeded[\s\S]*VcpuLimitExceeded/)
    expect(count(LIMIT)).toBe(2)
    await g.run('terraform apply -auto-approve')
    await waitFor(() => expect(count(LIMIT)).toBe(3))
    g.declare(ROOT)
    await g.run(REQUEST, 'terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 1 added, 0 changed, 0 destroyed\.[\s\S]*No changes\./))
    expect(count(LIMIT)).toBe(3)
    await g.settle()
    const before = output()
    await g.remount(/\$ ls/)
    expect(output()).toBe(before)
    await g.closeClean('request-quota-increase', 'finish-apply')
  })

  it('button quota request: the next apply launches c5.24xlarge', async () => {
    const g = await mount('terraform-vcpu-limit')
    g.declare(ROOT)
    await g.run('terraform init', 'terraform apply -auto-approve')
    await waitFor(() => expect(count(LIMIT)).toBe(1))
    g.click(REQUEST_BUTTON)
    await waitFor(() => expect(g.taken()).toEqual(['request-quota-increase']))
    await g.run('terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 1 added[\s\S]*No changes\./))
    await g.closeClean('request-quota-increase', 'finish-apply')
  })

  it('trap: destroy the half-built environment: destructive once, re-sizing and rebuilding earns nothing', async () => {
    const g = await mount('terraform-vcpu-limit')
    g.declare(ROOT)
    await g.run('terraform init', 'terraform apply -auto-approve', 'terraform destroy -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Destroy complete! Resources: 3 destroyed\./))
    await g.run("sed -i 's/c5\\.24xlarge/c5.12xlarge/' compute.tf", 'terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 4 added[\s\S]*No changes\./))
    await g.trapped('destroy-everything')
  })
})

describe('terraform-cancelled-ci-lock through the UI', () => {
  const ROOT = /cancelled partway through and exited without releasing the state lock/
  const LOCK_ID = '4c2e8f17-9a3b-d605-7e1c-b28f5a0d93e4'
  const LOCKED = /Error acquiring the state lock/g
  const UNLOCKED = /Terraform state has been successfully unlocked!/
  const confirm = async (value: string) => {
    const dialog = await screen.findByRole('dialog', { name: 'Confirm terraform action' })
    expect(dialog.textContent).toMatch(/Do you really want to force-unlock\?[\s\S]*Enter a value:/)
    const answer = within(dialog).getByLabelText('Enter a value')
    fireEvent.change(answer, { target: { value } })
    fireEvent.keyDown(answer, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  }

  it('ideal path: key evidence while locked (methodical), force-unlock answered yes in the dialog, plan, apply', async () => {
    const g = await mount('terraform-cancelled-ci-lock')
    await g.run('terraform plan', 'terraform state list', 'cat ci-pipeline.log', 'gh run list')
    await waitFor(() => expect(output()).toMatch(/Who:\s+ci@runner-17[\s\S]*aws_vpc\.ledger[\s\S]*Two interrupts received[\s\S]*11823046571/))
    await g.settle()
    const { evidenceSeen } = await import('../src/game/engine.ts')
    const item = await (await import('virtual:content')).loadItem('terraform-cancelled-ci-lock')
    if (item.kind !== 'incident') throw new Error('expected an incident')
    expect([...evidenceSeen(item.scenario, g.box.saved!.log)]).toEqual(expect.arrayContaining(item.scenario.key_evidence))
    g.declare(ROOT)
    // a "no" leaves the lock; a "yes" removes it
    await g.run(`terraform force-unlock ${LOCK_ID}`)
    await confirm('no')
    await waitFor(() => expect(output()).toMatch(/force-unlock cancelled\./))
    await g.run('terraform plan')
    await waitFor(() => expect(count(LOCKED)).toBe(2))
    await g.run(`terraform force-unlock ${LOCK_ID}`)
    await confirm('yes')
    await waitFor(() => expect(output()).toMatch(UNLOCKED))
    await g.run('terraform plan', 'terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Plan: 1 to add, 0 to change, 0 to destroy\.[\s\S]*Apply complete! Resources: 1 added, 0 changed, 0 destroyed\.[\s\S]*No changes\./))
    expect(g.box.saved!.log.filter((e) => e.type === 'ANSWERED').map((e) => (e as { value: string }).value)).toEqual(['no', 'yes'])
    const s = await g.closeClean('unlock-and-finish')
    expect(s.methodical).toBe(true)
    expect(s.lines.map((l) => l.label).join('\n')).toMatch(/Methodical/)
  })

  it('ideal path, piped: echo yes | terraform force-unlock unlocks without a dialog', async () => {
    const g = await mount('terraform-cancelled-ci-lock')
    g.declare(ROOT)
    await g.run(`echo yes | terraform force-unlock ${LOCK_ID}`)
    await waitFor(() => expect(output()).toMatch(UNLOCKED))
    expect(screen.queryByRole('dialog')).toBeNull()
    await g.run('terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 1 added[\s\S]*No changes\./))
    await g.closeClean('unlock-and-finish')
  })

  it('trap: apply -lock=false while the lock is held: destructive once, unlocking and applying afterwards earns nothing', async () => {
    const g = await mount('terraform-cancelled-ci-lock')
    g.declare(ROOT)
    await g.run('terraform apply -auto-approve -lock=false', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 1 added[\s\S]*Error acquiring the state lock/))
    await g.run(`echo yes | terraform force-unlock ${LOCK_ID}`, 'terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/successfully unlocked![\s\S]*No changes\./))
    await g.trapped('apply-without-lock')
  })
})

describe('terraform-sg-cycle through the UI', () => {
  const ROOT = /web's new rule refer to app's group id/
  const WEB_BY_CIDR = "sed -i 's/security_groups = \\[aws_security_group\\.app\\.id\\]/cidr_blocks = [aws_subnet.app.cidr_block]/' security.tf"
  const TO_WORLD = "sed -i 's/security_groups = \\[aws_security_group\\.app\\.id\\]/cidr_blocks = [\"0.0.0.0\\/0\"]/' security.tf"

  it('ideal path: investigate, name the cycle, sed web\'s 8443 rule to the app subnet CIDR, apply in place, close', async () => {
    const g = await mount('terraform-sg-cycle')
    await g.run('terraform plan', 'terraform validate', 'git diff main', 'terraform state list')
    await waitFor(() => expect(output()).toMatch(/Error: Cycle: aws_security_group\.app, aws_security_group\.web[\s\S]*aws_vpc\.checkout/))
    g.declare(ROOT)
    await g.run(WEB_BY_CIDR, 'terraform plan', 'terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Plan: 0 to add, 2 to change, 0 to destroy\.[\s\S]*Apply complete! Resources: 0 added, 2 changed, 0 destroyed\.[\s\S]*No changes\./))
    const s = await g.closeClean('break-the-cycle')
    expect(s.lines.map((l) => l.label).join('\n')).toMatch(/Methodical/)
  })

  it('trap, terminal: open 8443 to 0.0.0.0/0 and apply: destructive once, no fix while it is open', async () => {
    const g = await mount('terraform-sg-cycle')
    g.declare(ROOT)
    await g.run(TO_WORLD, 'terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 0 added, 2 changed[\s\S]*No changes\./))
    await g.trapped('open-callbacks-to-internet')
  })

  it('trap, button: recreating the groups is taken once and counts as one destructive mistake', async () => {
    const { score } = await import('../src/game/scoring.ts')
    const item = await (await import('virtual:content')).loadItem('terraform-sg-cycle')
    if (item.kind !== 'incident') throw new Error('expected an incident')
    const g = await mount('terraform-sg-cycle')
    g.declare(ROOT)
    g.click(/^Start the groups fresh/)
    await waitFor(() => expect(g.taken()).toEqual(['recreate-groups']))
    await g.settle()
    expect(g.taken()).toEqual(['recreate-groups'])
    expect(screen.queryByRole('button', { name: 'Close out' })).toBeNull()
    expect(score(item.scenario, g.box.saved!.log).mistakes.destructive).toBe(1)
  })
})
