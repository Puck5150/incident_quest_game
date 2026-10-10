// @vitest-environment jsdom
// TF7a destroy incidents (non-empty bucket, dependency violation, deleted out of band,
// orphans after state rm) played through IncidentScreen:
// the ideal path and the trap path of each, typed as one-line commands.

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
  const wrongCount = () => score(scenario, box.saved!.log).mistakes.wrongActions
  return { run, declare, click, taken, settle, remount, closeClean, trapped, wrongCount, box }
}



const methodical = (s: { lines: { label: string }[] }) => expect(s.lines.map((l) => l.label).join('\n')).toMatch(/Methodical/)
const D = 'terraform destroy -auto-approve'

describe('terraform-destroy-nonempty-bucket through the UI', () => {
  const ROOT = /still holds objects and its force_destroy setting/
  const INVESTIGATE = [D, 'terraform state show aws_s3_bucket.logs', 'aws s3 ls s3://acme-reports-logs --recursive', 'aws sts get-caller-identity']

  it('ideal path: investigate, empty the bucket (flag before the path), destroy, close; a remount replays the release', async () => {
    const g = await mount('terraform-destroy-nonempty-bucket')
    await g.run(...INVESTIGATE)
    await waitFor(() => expect(output()).toMatch(/BucketNotEmpty/))
    g.declare(ROOT)
    await g.run('aws s3 rm --recursive s3://acme-reports-logs', 'aws s3 ls s3://acme-reports-logs --recursive --human-readable', D)
    await waitFor(() => expect(output()).toMatch(/Destroy complete! Resources: 1 destroyed\./))
    await g.settle()
    const before = output()
    await g.remount(/\$ ls/)
    expect(output()).toBe(before)
    methodical(await g.closeClean('empty-bucket', 'destroy-after-emptying'))
  })

  it('trap: state rm the bucket, then destroy: destructive once, emptying afterwards earns nothing more', async () => {
    const g = await mount('terraform-destroy-nonempty-bucket')
    g.declare(ROOT)
    await g.run('terraform state rm aws_s3_bucket.logs', D)
    await waitFor(() => expect(output()).toMatch(/Destroy complete! Resources: 2 destroyed\./))
    await g.trapped('state-rm-bucket')
  })
})

describe('terraform-destroy-dependency-violation through the UI', () => {
  const ROOT = /Something Terraform never created still lives in the subnet/
  const DESC = 'aws ec2 describe-network-interfaces --filters Name=subnet-id,Values=subnet-0e92c4a7b1d38f560 --output json'
  const DEL = 'aws ec2 delete-network-interface --network-interface-id eni-0c4a8e2f6b1d97305'

  it('ideal path: read the error, find whose interface it is, delete it, destroy, close', async () => {
    const g = await mount('terraform-destroy-dependency-violation')
    await g.run(D, 'terraform state list', DESC, 'aws sts get-caller-identity')
    await waitFor(() => expect(output()).toMatch(/DependencyViolation[\s\S]*Interface for the shared ingest endpoint/))
    g.declare(ROOT)
    await g.run(DEL, DESC, D)
    await waitFor(() => expect(output()).toMatch(/Destroy complete! Resources: 2 destroyed\./))
    await g.settle()
    const before = output()
    await g.remount(/\$ ls/)
    expect(output()).toBe(before)
    methodical(await g.closeClean('release-eni', 'destroy-after-release'))
  })

  it('trap: state rm of the subnet and VPC, then destroy: destructive once', async () => {
    const g = await mount('terraform-destroy-dependency-violation')
    g.declare(ROOT)
    await g.run('terraform state rm aws_subnet.app aws_vpc.main', D)
    await waitFor(() => expect(output()).toMatch(/Destroy complete! Resources: 2 destroyed\./))
    await g.trapped('state-rm-network')
  })
})

describe('terraform-deleted-out-of-band through the UI', () => {
  const ROOT = /deleted outside Terraform, so state is stale/
  const RM_WORKER = "sed -i '/^resource \"aws_instance\" \"worker\"/,/^}/d' main.tf"
  const INVESTIGATE = ['terraform plan', 'terraform state list', 'aws sqs get-queue-url --queue-name app-jobs', 'aws ec2 describe-instances --instance-ids i-0d6a3f8b2c71e9450', 'cat NOTES.md', 'aws sts get-caller-identity', 'terraform destroy -target=aws_sqs_queue.jobs -target=aws_instance.worker -auto-approve']

  it('ideal path: plan and state list first, confirm in AWS, drop the worker block, apply, close', async () => {
    const g = await mount('terraform-deleted-out-of-band')
    await g.run(...INVESTIGATE)
    await waitFor(() => expect(output()).toMatch(/has been deleted[\s\S]*aws_instance\.worker[\s\S]*InvalidInstanceID\.NotFound/))
    g.declare(ROOT)
    await g.run(RM_WORKER, 'terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 1 added[\s\S]*No changes\./))
    await g.settle()
    const before = output()
    await g.remount(/\$ ls/)
    expect(output()).toBe(before)
    methodical(await g.closeClean('remove-instance-block', 'apply-reconcile'))
  })

  it('trap: delete both blocks so the plan goes quiet: destructive once', async () => {
    const g = await mount('terraform-deleted-out-of-band')
    g.declare(ROOT)
    await g.run(RM_WORKER, "sed -i '/^resource \"aws_sqs_queue\" \"jobs\"/,/^}/d' main.tf", 'terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/No changes\./))
    await g.trapped('remove-instance-block', 'remove-both-blocks')
  })
})

describe('terraform-orphans-after-state-rm through the UI', () => {
  const ROOT = /dropped from Terraform's state but still run in AWS/
  const LOCK_ID = '7e3b9d41-5c2a-8f06-b1d7-a94e2c60f385'
  const IMPORTS = ['terraform import aws_instance.worker i-0c7f3a9d1e5b24680', 'terraform import aws_db_instance.reports reports-db']
  const INVESTIGATE = ['terraform plan', 'cat marta-destroy.txt', 'terraform state list', 'aws ec2 describe-instances', 'aws rds describe-db-instances', 'aws sts get-caller-identity']

  it('ideal path: the force-unlock dialog, import both, destroy, close; a remount replays the lot', async () => {
    const g = await mount('terraform-orphans-after-state-rm')
    await g.run(...INVESTIGATE)
    await waitFor(() => expect(output()).toMatch(/Error acquiring the state lock/))
    g.declare(ROOT)
    await g.run(`terraform force-unlock ${LOCK_ID}`)
    const dialog = await screen.findByRole('dialog', { name: 'Confirm terraform action' })
    const answer = within(dialog).getByLabelText('Enter a value')
    fireEvent.change(answer, { target: { value: 'yes' } })
    fireEvent.keyDown(answer, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(output()).toMatch(/successfully unlocked/))
    await g.run(...IMPORTS, D)
    await waitFor(() => expect(output()).toMatch(/Destroy complete! Resources: 5 destroyed\./))
    await g.settle()
    const before = output()
    await g.remount(/\$ ls/)
    expect(output()).toBe(before)
    methodical(await g.closeClean('unlock-and-import', 'destroy-environment'))
  })

  it('late naming: unlock, import and destroy before naming the cause, then declare: both fixes are still earned', async () => {
    const g = await mount('terraform-orphans-after-state-rm')
    await g.run(...INVESTIGATE, `echo yes | terraform force-unlock ${LOCK_ID}`, ...IMPORTS, D)
    await waitFor(() => expect(output()).toMatch(/Destroy complete! Resources: 5 destroyed\./))
    await g.settle()
    g.declare(ROOT)
    methodical(await g.closeClean('unlock-and-import', 'destroy-environment'))
  })

  it('trap: apply after unlocking duplicates the worker: destructive once, no close-out', async () => {
    const g = await mount('terraform-orphans-after-state-rm')
    g.declare(ROOT)
    await g.run(`echo yes | terraform force-unlock ${LOCK_ID}`, 'terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/DBInstanceAlreadyExists/))
    await g.trapped('apply-recreate')
  })
})
