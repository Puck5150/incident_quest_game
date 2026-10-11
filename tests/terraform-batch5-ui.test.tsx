// @vitest-environment jsdom
// TF7b migrated scripted incidents played through IncidentScreen: the ideal path and the trap path of
// each, typed as one-line commands. Shared by the TF7b migration tasks.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

describe('terraform-count-index-shift through the UI', () => {
  const ROOT = /With count, each queue is identified by its position/
  const SED = "sed -i -e 's/count = length(var.queue_names)/for_each = toset(var.queue_names)/' -e 's/var.queue_names\\[count.index\\]/each.key/' queues.tf"
  const MOVED = `printf 'moved {\\n  from = aws_sqs_queue.queue[0]\\n  to = aws_sqs_queue.queue["orders"]\\n}\\nmoved {\\n  from = aws_sqs_queue.queue[2]\\n  to = aws_sqs_queue.queue["refunds"]\\n}\\nmoved {\\n  from = aws_sqs_queue.queue[3]\\n  to = aws_sqs_queue.queue["shipping"]\\n}\\n' > moved.tf`

  it('ideal path: read the plan, state and file, switch to for_each with moved blocks, apply; a remount replays the same transcript', async () => {
    const g = await mount('terraform-count-index-shift')
    await g.run('terraform plan', 'terraform state list', 'cat queues.tf', 'aws sqs get-queue-attributes --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/returns --attribute-names ApproximateNumberOfMessages')
    await waitFor(() => expect(output()).toMatch(/Plan: 2 to add, 0 to change, 3 to destroy\./))
    g.declare(ROOT)
    await g.run(SED, MOVED, 'terraform plan', 'terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 0 added, 0 changed, 1 destroyed\./))
    await g.settle()
    expect(g.taken()).toEqual(['for-each-moved'])
    const before = output()
    await g.remount(/\$ ls/)
    expect(output()).toBe(before)
    methodical(await g.closeClean('for-each-moved'))
  })

  it('trap: applying the shifted plan recreates the live queues: destructive once, fixing afterwards earns nothing', async () => {
    const g = await mount('terraform-count-index-shift')
    g.declare(ROOT)
    await g.run('terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 2 added, 0 changed, 3 destroyed\./))
    await g.trapped('apply-anyway')
    await g.run(SED, MOVED, 'terraform apply -auto-approve')
    await g.settle()
    expect(g.taken()).toEqual(['apply-anyway'])
  })
})

describe('wrong-workspace-major through the UI', () => {
  const ROOT = /Yesterday at 16:40 staging\.tfvars was applied/

  it('ideal path: prod.tfvars applied in prod is detected, then the guard; stage 2 starts', async () => {
    const g = await mount('wrong-workspace-major')
    await g.run('terraform workspace show', 'terraform plan -var-file=prod.tfvars')
    await waitFor(() => expect(output()).toMatch(/Plan: 0 to add, 1 to change, 0 to destroy\./))
    g.declare(ROOT)
    await g.run('terraform apply -auto-approve -var-file=prod.tfvars')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 0 added, 1 changed, 0 destroyed\./))
    await g.settle()
    expect(g.taken()).toEqual(['prod-apply'])
    g.click(/Open a PR that makes the plan fail/)
    expect(g.taken()).toEqual(['prod-apply', 'workspace-guard'])
    g.click(/Close out/)
    await waitFor(() => expect(screen.getByText('Stage 2 of 3')).toBeTruthy())
  })

  it('trap: state rm in prod is destructive once, and the prod apply afterwards earns nothing', async () => {
    const g = await mount('wrong-workspace-major')
    g.declare(ROOT)
    await g.run('terraform state rm aws_db_instance.orders', 'terraform apply -auto-approve -var-file=prod.tfvars')
    await g.trapped('state-rm')
  })

  it('wrong: selecting staging and applying staging.tfvars changes only staging', async () => {
    const g = await mount('wrong-workspace-major')
    g.declare(ROOT)
    await g.run('terraform workspace select staging', 'terraform apply -auto-approve -var-file=staging.tfvars')
    await g.settle()
    expect(g.taken()).toEqual(['select-staging'])
    expect(g.wrongCount()).toBe(1)
  })
})

// Every migrated incident's key_evidence is reachable through the UI before any action is taken
// (so the Methodical bonus is earnable). Steps are typed commands or [tab, artifact name] clicks.
describe('TF7b key_evidence is obtainable before the fix', () => {
  type Step = string | [tab: string, name: string]
  const CASES: Record<string, Step[]> = {
    'terraform-count-index-shift': ['terraform plan', 'terraform state list', 'cat queues.tf', 'aws sqs get-queue-attributes --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/returns --attribute-names ApproximateNumberOfMessages'],
    'terraform-drift-hotfix': ['terraform plan', 'terraform plan -refresh-only', ['Logs', '#incidents (last night)'], ['Files', 'Partner onboarding ticket SEC-4417 (excerpt)']],
    'terraform-import-existing': ['terraform state show aws_s3_bucket.analytics_raw', 'terraform plan', 'aws s3api head-bucket --bucket acme-analytics-raw', ['Logs', 'CI: terraform apply (PR #77)']],
    'terraform-moved-block': ['terraform state list', 'git diff main', ['Pipeline', 'terraform plan']],
    'terraform-ignore-changes-autoscaling': ['terraform plan', 'aws application-autoscaling describe-scalable-targets --service-namespace ecs --resource-ids service/prod/checkout --query ScalableTargets[0].[MinCapacity,MaxCapacity]'],
    'terraform-state-in-git': ['terraform state pull', 'git ls-files | grep tfstate', ['Files', 'main.tf and db.tf (no backend block)']],
    'wrong-workspace-major': ['terraform workspace show', 'aws rds describe-db-instances --db-instance-identifier orders-prod --query "DBInstances[0].[DBInstanceClass,PendingModifiedValues,PreferredMaintenanceWindow]"', "grep -E 'instance_class|apply_immediately' staging.tfvars prod.tfvars", ['Logs', 'ops-01: shell history (user dana, 10-01)']],
  }
  for (const [id, steps] of Object.entries(CASES)) {
    it(id, async () => {
      const g = await mount(id)
      for (const s of steps) {
        if (typeof s === 'string') await g.run(s)
        else {
          fireEvent.click(screen.getByRole('tab', { name: s[0] }))
          fireEvent.click(screen.getByRole('button', { name: s[0] === 'Pipeline' ? /terraform plan/ : s[1] }))
          fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }))
        }
      }
      await g.settle()
      const { evidenceSeen } = await import('../src/game/engine.ts')
      const item = await (await import('virtual:content')).loadItem(id)
      if (item.kind !== 'incident') throw new Error('expected an incident')
      expect(g.taken()).toEqual([])
      const seen = evidenceSeen(item.scenario, g.box.saved!.log)
      for (const t of item.scenario.key_evidence) expect(seen.has(t), t).toBe(true)
    })
  }
})
