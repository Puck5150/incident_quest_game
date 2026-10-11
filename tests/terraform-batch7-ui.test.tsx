// @vitest-environment jsdom
// TF7b migrated scripted incidents (batch 7) played through IncidentScreen: the ideal path and the trap path of
// each, typed as one-line commands. Same helpers as terraform-batch6-ui.test.tsx.

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

describe('terraform-ignore-changes-autoscaling through the UI', () => {
  const ROOT = /Terraform and Application Auto Scaling both set desired_count/
  const SED = `sed -i 's|desired_count.*|&\\n  lifecycle {\\n    ignore_changes = [desired_count]\\n  }|' ecs.tf`

  it('ideal path: plan, autoscaler lookup, ignore_changes, plan, apply; a remount replays the same transcript', async () => {
    const g = await mount('terraform-ignore-changes-autoscaling')
    await g.run('terraform plan', 'aws application-autoscaling describe-scalable-targets --service-namespace ecs --resource-ids service/prod/checkout --query ScalableTargets[0].[MinCapacity,MaxCapacity]')
    await waitFor(() => expect(output()).toMatch(/desired_count\s+= 12 -> 2/))
    g.declare(ROOT)
    await g.run(SED, 'terraform plan', 'terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 0 added, 0 changed, 0 destroyed\./))
    await g.settle()
    expect(g.taken()).toEqual(['ignore-desired'])
    const before = output()
    await g.remount(/\$ ls/)
    expect(output()).toBe(before)
    methodical(await g.closeClean('ignore-desired'))
  })

  it('trap: applying first resets the service to 2: wrong once, ignore_changes afterwards earns nothing', async () => {
    const g = await mount('terraform-ignore-changes-autoscaling')
    g.declare(ROOT)
    await g.run('terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 0 added, 1 changed, 0 destroyed\./))
    await g.run(SED, 'terraform plan')
    await g.settle()
    expect(g.taken()).toEqual(['apply-at-night'])
    expect(g.wrongCount()).toBe(1)
    expect(screen.queryByRole('button', { name: 'Close out' })).toBeNull()
  })
})

describe('terraform-import-existing through the UI', () => {
  const ROOT = /Terraform doesn't know the bucket exists/
  const BLOCK = `printf 'import {\\n  to = aws_s3_bucket.analytics_raw\\n  id = "acme-analytics-raw"\\n}\\n' > import.tf`
  const PD = `sed -i 's/bucket = "acme-analytics-raw"/&\\n  lifecycle {\\n    prevent_destroy = true\\n  }/' main.tf`

  it('ideal path: state show, plan, import block, plan, apply, prevent_destroy, plan', async () => {
    const g = await mount('terraform-import-existing')
    await g.run('terraform state show aws_s3_bucket.analytics_raw', 'terraform plan', 'aws s3api head-bucket --bucket acme-analytics-raw')
    g.declare(ROOT)
    await g.run(BLOCK, 'terraform plan', 'terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Plan: 1 to import, 0 to add, 0 to change, 0 to destroy\./))
    await g.run(PD, 'terraform plan')
    await g.settle()
    expect(g.taken()).toEqual(['import-block'])
    await g.closeClean('import-block')
  })

  it('import without prevent_destroy is not the fix: nothing taken, no Close out', async () => {
    const g = await mount('terraform-import-existing')
    g.declare(ROOT)
    await g.run('terraform import aws_s3_bucket.analytics_raw acme-analytics-raw', 'terraform plan')
    await g.settle()
    expect(g.taken()).toEqual([])
    expect(screen.queryByRole('button', { name: 'Close out' })).toBeNull()
  })

  it('sticky: fix taken, then lifting prevent_destroy, force_destroy and destroying still counts delete-recreate as a destructive mistake', async () => {
    const g = await mount('terraform-import-existing')
    g.declare(ROOT)
    await g.run(PD, 'terraform import aws_s3_bucket.analytics_raw acme-analytics-raw')
    await g.settle()
    expect(g.taken()).toEqual(['import-block'])
    await g.run("sed -i '/prevent_destroy/d' main.tf", "sed -i 's/bucket = \"acme-analytics-raw\"/&\\n  force_destroy = true/' main.tf", 'terraform apply -auto-approve', 'terraform destroy -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Destroy complete!/))
    await g.settle()
    expect(g.taken()).toEqual(['import-block', 'delete-recreate'])
    const { score } = await import('../src/game/scoring.ts')
    const { loadItem } = await import('virtual:content')
    const item = await loadItem('terraform-import-existing')
    if (item.kind !== 'incident') throw new Error('expected an incident')
    expect(score(item.scenario, g.box.saved!.log).mistakes.destructive).toBe(1)
  })
})

describe('terraform-moved-block through the UI', () => {
  const ROOT = /The resource's address changed/
  const MOVED = `printf 'moved {\\n  from = aws_db_instance.orders\\n  to   = module.database.aws_db_instance.orders\\n}\\n' >> main.tf`

  it('ideal path: plan, state list, moved block, plan, apply keeps the database', async () => {
    const g = await mount('terraform-moved-block')
    await g.run('terraform plan', 'terraform state list', 'git diff main')
    await waitFor(() => expect(output()).toMatch(/Plan: 1 to add, 0 to change, 1 to destroy\./))
    g.declare(ROOT)
    await g.run(MOVED, 'terraform plan', 'terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/has moved to module\.database\.aws_db_instance\.orders/))
    await g.closeClean('moved-block')
  })

  it('terraform state mv is wrong, not the fix: no credit, no Close out, not destructive', async () => {
    const g = await mount('terraform-moved-block')
    g.declare(ROOT)
    await g.run('terraform state mv aws_db_instance.orders module.database.aws_db_instance.orders', 'terraform plan')
    await g.settle()
    expect(g.taken()).toEqual(['state-mv'])
    expect(g.wrongCount()).toBe(1)
    expect(screen.queryByRole('button', { name: 'Close out' })).toBeNull()
    const { score } = await import('../src/game/scoring.ts')
    const item = await (await import('virtual:content')).loadItem('terraform-moved-block')
    if (item.kind !== 'incident') throw new Error('expected an incident')
    expect(score(item.scenario, g.box.saved!.log).mistakes.destructive).toBe(0)
  })

  it('trap: applying the untouched PR destroys the database: destructive once, the moved block afterwards earns nothing', async () => {
    const g = await mount('terraform-moved-block')
    g.declare(ROOT)
    await g.run('terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 1 added, 0 changed, 1 destroyed\./))
    await g.run(MOVED, 'terraform plan')
    await g.trapped('merge-with-snapshot')
  })
})
