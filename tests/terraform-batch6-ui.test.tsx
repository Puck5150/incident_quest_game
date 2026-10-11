// @vitest-environment jsdom
// TF7b migrated scripted incidents (batch 6) played through IncidentScreen: the ideal path and the trap path of
// each, typed as one-line commands. Same helpers as terraform-batch5-ui.test.tsx.

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

describe('terraform-drift-hotfix through the UI', () => {
  const ROOT = /Last night's console change isn't in the code/
  const SED = `sed -i 's|vpc_id.*|&\\n  ingress {\\n    description = "partner hotfix"\\n    from_port = 8443\\n    to_port = 8443\\n    protocol = "tcp"\\n    cidr_blocks = ["198.51.100.16/28"]\\n  }|' main.tf`
  const SED_WIDE = SED.replace('198.51.100.16/28', '198.51.100.0/24')

  it('ideal path: plan, refresh-only plan, codify the rule, plan, apply; a remount replays the same transcript', async () => {
    const g = await mount('terraform-drift-hotfix')
    await g.run('terraform plan', 'terraform plan -refresh-only')
    await waitFor(() => expect(output()).toMatch(/Note: Objects have changed outside of Terraform/))
    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }))
    fireEvent.click(screen.getByRole('button', { name: '#incidents (last night)' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    fireEvent.click(screen.getByRole('button', { name: 'Partner onboarding ticket SEC-4417 (excerpt)' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }))
    g.declare(ROOT)
    await g.run(SED, 'terraform plan', 'terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 0 added, 2 changed, 0 destroyed\./))
    await g.settle()
    expect(g.taken()).toEqual(['codify'])
    const before = output()
    await g.remount(/\$ ls/)
    expect(output()).toBe(before)
    methodical(await g.closeClean('codify'))
  })

  it('weak route: copying the console /24 into the code is one wrong action and cannot be closed out', async () => {
    const g = await mount('terraform-drift-hotfix')
    g.declare(ROOT)
    await g.run(SED_WIDE, 'terraform plan', 'terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 0 added, 1 changed, 0 destroyed\./))
    await g.settle()
    expect(g.taken()).toEqual(['codify-wide'])
    expect(g.wrongCount()).toBe(1)
    expect(screen.queryByRole('button', { name: 'Close out' })).toBeNull()
  })

  it('trap: applying the plan as it is removes the hotfix rule: destructive once', async () => {
    const g = await mount('terraform-drift-hotfix')
    g.declare(ROOT)
    await g.run('terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 0 added, 2 changed, 0 destroyed\./))
    await g.trapped('apply-anyway')
    // recovery: the verified narrow rule, applied, is still the fix; the destructive mark stays
    await g.run(SED, 'terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 0 added, 1 changed, 0 destroyed\./))
    await g.settle()
    expect(g.taken()).toEqual(['apply-anyway', 'codify'])
    expect(g.wrongCount()).toBe(0)
  })
})
