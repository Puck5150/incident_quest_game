// @vitest-environment jsdom
// TF4 incidents played through IncidentScreen: the simulated terminal takes
// the fix (or the trap) from the world, once, and the incident closes and scores.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GameEvent, Session } from '../src/game/engine.ts'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

// Same helpers as tests/incident.test.tsx.
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
const output = () => screen.getByRole('log', { name: 'Terminal output' }).textContent

async function mount(id: string) {
  const { default: IncidentScreen } = await import('../src/screens/IncidentScreen.tsx')
  const { fixComplete } = await import('../src/game/engine.ts')
  const { score } = await import('../src/game/scoring.ts')
  const item = await (await import('virtual:content')).loadItem(id)
  if (item.kind !== 'incident') throw new Error('expected an incident')
  const scenario = item.scenario
  const box: { saved?: Session; resolved?: GameEvent[] } = {}
  render(<IncidentScreen scenario={scenario} onResolved={(log) => (box.resolved = log)} onChange={(s) => (box.saved = s)} />)
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
  const taken = () => box.saved!.log.flatMap((e) => (e.type === 'TAKE_ACTION' ? [e.id] : []))
  // Ideal path: the fix is taken once, Close out resolves, no destructive deduction.
  const closeClean = async (fix: string) => {
    await settle()
    expect(taken()).toEqual([fix])
    expect(fixComplete(scenario, box.saved!.log)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close out' }))
    expect(box.resolved).toBeDefined()
    expect(box.resolved!.at(-1)).toMatchObject({ type: 'CLOSE_INCIDENT' })
    expect(score(scenario, box.resolved!).mistakes.destructive).toBe(0)
  }
  // Trap path: the destructive action is taken once, and the fix stays out of reach.
  const trapped = async (trap: string) => {
    await settle()
    expect(taken()).toEqual([trap])
    expect(fixComplete(scenario, box.saved!.log)).toBe(false)
    expect(screen.queryByRole('button', { name: 'Close out' })).toBeNull()
    expect(score(scenario, box.saved!.log).mistakes.destructive).toBe(1)
  }
  return { run, declare, closeClean, trapped, settle }
}

describe('terraform-state-lost through the UI', () => {
  const ROOT = /state file went with Priya's laptop/
  const IMPORTS = [
    'terraform import aws_s3_bucket.app_logs acme-app-logs',
    'terraform import aws_cloudwatch_log_group.api /acme/api',
    'terraform import aws_iam_role.task acme-task-role',
    'terraform import aws_cloudwatch_log_group.worker /acme/worker',
  ]

  it('ideal path: investigate, name the lost state, import all four, close', async () => {
    const g = await mount('terraform-state-lost')
    await g.run('terraform init', 'terraform state list', 'terraform plan', 'aws s3api head-bucket --bucket acme-app-logs', 'aws sts get-caller-identity')
    await waitFor(() => expect(output()).toMatch(/Plan: 4 to add[\s\S]*"Account": "123456789012"/))
    g.declare(ROOT)
    await g.run(...IMPORTS, 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/No changes\./))
    await g.closeClean('import-resources')
  })

  it('trap: import the bucket, destroy, then rebuild and import the rest: destructive once, never the fix', async () => {
    const g = await mount('terraform-state-lost')
    g.declare(ROOT)
    await g.run(IMPORTS[0], 'terraform destroy -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Destroy complete! Resources: 1 destroyed\./))
    await g.run('terraform apply -auto-approve', ...IMPORTS.slice(1), 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/No changes\./))
    await g.trapped('delete-and-recreate')
  })
})

describe('terraform-count-to-for-each through the UI', () => {
  const ROOT = /changed every address from an index to a key/
  const MVS = [
    `terraform state mv 'aws_subnet.private[0]' 'aws_subnet.private["us-east-1a"]'`,
    `terraform state mv 'aws_subnet.private[1]' 'aws_subnet.private["us-east-1b"]'`,
    `terraform state mv 'aws_instance.db[0]' 'aws_instance.db["us-east-1a"]'`,
    `terraform state mv 'aws_instance.db[1]' 'aws_instance.db["us-east-1b"]'`,
  ]

  it('ideal path: investigate, name the address change, four state mv, close', async () => {
    const g = await mount('terraform-count-to-for-each')
    await g.run('terraform init', 'terraform plan', 'terraform state list', 'git diff main -- network.tf db.tf')
    await waitFor(() => expect(output()).toMatch(/Instance cannot be destroyed[\s\S]*aws_subnet\.private\[1\]/))
    g.declare(ROOT)
    await g.run(...MVS, 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/No changes\./))
    await g.closeClean('move-addresses')
  })

  it('trap: drop prevent_destroy and apply -auto-approve: destructive once, putting the guard back earns nothing', async () => {
    const g = await mount('terraform-count-to-for-each')
    g.declare(ROOT)
    await g.run("sed -i '/prevent_destroy/d' db.tf", 'terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 4 added, 0 changed, 4 destroyed\./))
    await g.run("sed -i 's/lifecycle {/lifecycle {\\n prevent_destroy = true/' db.tf", 'grep -c prevent_destroy db.tf', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/grep -c prevent_destroy db\.tf\s*1[\s\S]*No changes\./))
    await g.trapped('remove-prevent-destroy')
  })
})

describe('terraform-forgotten-taint through the UI', () => {
  const ROOT = /marked tainted in state from an earlier taint/

  it('ideal path: investigate, name the leftover taint, untaint, close', async () => {
    const g = await mount('terraform-forgotten-taint')
    await g.run('terraform init', 'terraform plan', 'terraform state show aws_instance.web', 'history | grep taint')
    await waitFor(() => expect(output()).toMatch(/is tainted, so must be replaced[\s\S]*\(tainted\)[\s\S]*terraform taint aws_instance\.web/))
    g.declare(ROOT)
    await g.run('terraform untaint aws_instance.web', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/will be updated in-place[\s\S]*Plan: 0 to add, 1 to change, 0 to destroy\./))
    await g.closeClean('untaint')
  })

  it('trap: apply -auto-approve before untainting: destructive once, untaint afterwards earns nothing', async () => {
    const g = await mount('terraform-forgotten-taint')
    g.declare(ROOT)
    await g.run('terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 1 added, 0 changed, 1 destroyed\./))
    await g.run('terraform untaint aws_instance.web', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/not currently tainted[\s\S]*No changes\./))
    await g.trapped('apply-the-pr')
  })
})
