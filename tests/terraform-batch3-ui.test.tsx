// @vitest-environment jsdom
// TF6c incidents (modules, lock file, remote state) played through IncidentScreen:
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


const CLEAN = /No changes\./
const methodical = (s: { lines: { label: string }[] }) => expect(s.lines.map((l) => l.label).join('\n')).toMatch(/Methodical/)

describe('terraform-module-refactor through the UI', () => {
  const ROOT = /Moving the VPC and subnets into the module gave each one a new address/
  const MOVED = ['aws_vpc.main', 'aws_subnet.a', 'aws_subnet.b'].map((a) => `printf 'moved {\\n  from = ${a}\\n  to = module.network.${a}\\n}\\n\\n' >> moved.tf`)
  const INVESTIGATE = ['terraform plan', 'terraform state list', 'git diff main', 'aws ec2 describe-subnets']

  it('ideal path: investigate, name the address change, add moved blocks, apply, close', async () => {
    const g = await mount('terraform-module-refactor')
    await g.run(...INVESTIGATE)
    await waitFor(() => expect(output()).toMatch(/Instance cannot be destroyed/))
    g.declare(ROOT)
    await g.run(...MOVED, 'terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 0 added, 0 changed, 0 destroyed\.[\s\S]*No changes\./))
    methodical(await g.closeClean('move-into-module'))
  })

  it('the confirm dialog on a targeted apply: "no" cancels, "yes" builds the second network (one wrong action, not destructive)', async () => {
    const g = await mount('terraform-module-refactor')
    g.declare(ROOT)
    await g.run('terraform apply -target=module.network')
    const ask = async (value: string) => {
      const dialog = await screen.findByRole('dialog', { name: 'Confirm terraform action' })
      const answer = within(dialog).getByLabelText('Enter a value')
      fireEvent.change(answer, { target: { value } })
      fireEvent.keyDown(answer, { key: 'Enter' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }
    await ask('no')
    await g.settle()
    expect(g.taken()).toEqual([])
    await g.run('terraform apply -target=module.network')
    await ask('yes')
    await waitFor(() => expect(output()).toMatch(/Applied changes may be incomplete[\s\S]*Apply complete! Resources: 3 added|Apply complete! Resources: 3 added[\s\S]*Applied changes may be incomplete/))
    await g.settle()
    expect(g.taken()).toEqual(['target-the-module'])
    expect(g.wrongCount()).toBe(1)
  })

  it('trap: remove prevent_destroy and apply: destructive once, restoring the moves afterwards earns nothing', async () => {
    const g = await mount('terraform-module-refactor')
    g.declare(ROOT)
    await g.run("sed -i '/prevent_destroy/d' app.tf", 'terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 5 added, 0 changed, 5 destroyed\./))
    await g.run(...MOVED, 'terraform apply -auto-approve', 'terraform plan')
    await g.trapped('remove-guard-and-apply')
  })
})

describe('terraform-module-upgrade through the UI', () => {
  const ROOT = /resolved to a newer 2\.x release/
  const PIN = "sed -i 's/~> 2.0/2.0.1/' main.tf"
  const INVESTIGATE = ['terraform plan', 'terraform version', 'git status', 'git log -p -- main.tf', 'cat .terraform/modules/modules.json', 'cat .terraform/modules/db/main.tf']

  it('ideal path: pin the module, init, plan is clean; a remount replays the registry install identically', async () => {
    const g = await mount('terraform-module-upgrade')
    await g.run(...INVESTIGATE)
    await waitFor(() => expect(output()).toMatch(/forces replacement[\s\S]*"Version":"2\.1\.0"/))
    g.declare(ROOT)
    await g.run(PIN, 'terraform init', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(CLEAN))
    await g.settle()
    const before = output()
    await g.remount(/\$ ls/)
    expect(output()).toBe(before)
    await g.run('cat .terraform/modules/modules.json')
    await waitFor(() => expect(output().slice(before.length)).toMatch(/"Version":"2\.0\./))
    methodical(await g.closeClean('pin-the-module'))
  })

  it('trap: remove prevent_destroy from the module and apply: destructive once, pinning afterwards earns nothing', async () => {
    const g = await mount('terraform-module-upgrade')
    g.declare(ROOT)
    await g.run("sed -i '/prevent_destroy/d' .terraform/modules/db/main.tf", 'terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 1 added, 0 changed, 1 destroyed\./))
    await g.run(PIN, 'terraform init', 'terraform plan')
    await g.trapped('unguard-and-apply')
  })
})

describe('terraform-provider-lock-drift through the UI', () => {
  const ROOT = /the dependency lock file still records the old provider version/
  const INVESTIGATE = ['terraform plan', 'terraform version', 'terraform providers', 'terraform validate', 'git diff origin/main', 'git diff --stat origin/main', 'git status', 'git log --oneline', 'cat .terraform.lock.hcl']

  it('ideal path: read the mismatch, init -upgrade, plan clean; a remount replays the lock and cache', async () => {
    const g = await mount('terraform-provider-lock-drift')
    await g.run(...INVESTIGATE)
    await waitFor(() => expect(output()).toMatch(/Inconsistent dependency lock file[\s\S]*version\s*=\s*"5\.31\.0"/))
    g.declare(ROOT)
    await g.run('terraform init -upgrade', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(CLEAN))
    await g.settle()
    const before = output()
    await g.remount(/\$ ls/)
    expect(output()).toBe(before)
    await g.run('terraform plan')
    await waitFor(() => expect(output().slice(before.length)).toMatch(CLEAN))
    methodical(await g.closeClean('refresh-lock'))
  })

  it('wrong path: hand-editing the lock is one wrong action (no destructive), the fix is not credited until the lock is rebuilt', async () => {
    const g = await mount('terraform-provider-lock-drift')
    g.declare(ROOT)
    await g.run("sed -i 's/5.31.0/5.50.0/' .terraform.lock.hcl", 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Required plugins are not installed/))
    await g.settle()
    expect(g.taken()).toEqual(['hand-edit-lock'])
    expect(g.wrongCount()).toBe(1)
    expect(screen.queryByRole('button', { name: 'Close out' })).toBeNull()
    await g.run('rm -f .terraform.lock.hcl', 'terraform init', 'terraform plan')
    await waitFor(() => expect(output().split('No changes.').length).toBeGreaterThan(1))
    await g.closeClean('hand-edit-lock', 'refresh-lock')
    expect(g.wrongCount()).toBe(1)
  })
})

describe('terraform-remote-state-rename through the UI', () => {
  const ROOT = /no longer has an output called private_subnets/
  const FIX = "sed -i 's/private_subnets/private_subnet_ids/' main.tf"
  const INVESTIGATE = ['terraform plan', 'git status', 'git log --oneline', 'cat ../network/outputs.tf', 'git -C ../network log --oneline', 'git -C ../network log -p -- outputs.tf', 'terraform state list', 'terraform state show data.terraform_remote_state.network']

  it('ideal path: read the renamed output, point main.tf at the new name, plan clean, close', async () => {
    const g = await mount('terraform-remote-state-rename')
    await g.run(...INVESTIGATE)
    await waitFor(() => expect(output()).toMatch(/Unsupported attribute/))
    g.declare(ROOT)
    await g.run(FIX, 'terraform plan')
    await waitFor(() => expect(output()).toMatch(CLEAN))
    methodical(await g.closeClean('use-the-new-output'))
  })

  it('trap: point at the public subnets and apply: destructive once (the server is replaced)', async () => {
    const g = await mount('terraform-remote-state-rename')
    g.declare(ROOT)
    await g.run("sed -i 's/private_subnets/public_subnet_ids/' main.tf", 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/forces replacement/))
    await g.run('terraform apply -auto-approve', 'terraform plan')
    await waitFor(() => expect(output()).toMatch(/Apply complete![\s\S]*No changes\./))
    await g.run(FIX, 'terraform plan')
    await g.trapped('point-at-another-output', 'apply-the-replacement')
  })
})

describe('terraform-module-key-removed through the UI', () => {
  const ROOT = /Removing west from var\.regions removes the instance/
  const RESTORE = `sed -i 's/default = \\["east"\\]/default = ["east", "west"]/' variables.tf`
  const INVESTIGATE = ['terraform plan', 'terraform state list', 'git diff main', 'aws rds describe-db-instances']

  it('ideal path: -target warning is shown, restore the key, plan clean, close', async () => {
    const g = await mount('terraform-module-key-removed')
    await g.run(...INVESTIGATE)
    await waitFor(() => expect(output()).toMatch(/Instance cannot be destroyed/))
    await g.run("terraform plan -target='module.stack[\"east\"]'")
    await waitFor(() => expect(output()).toMatch(/Warning: Resource targeting is in effect/))
    g.declare(ROOT)
    await g.run(RESTORE, 'terraform plan')
    await waitFor(() => expect(output()).toMatch(CLEAN))
    methodical(await g.closeClean('restore-the-key'))
  })

  it('ideal path 2: state rm west leaves it running; the git ways to undo the PR have no simulated output', async () => {
    const g = await mount('terraform-module-key-removed')
    g.declare(ROOT)
    for (const c of ['git checkout main -- variables.tf', 'git restore --source=main variables.tf', 'git revert HEAD', 'git reset --hard HEAD~1']) {
      const before = output().length
      await g.run(c)
      await waitFor(() => expect(output().slice(before)).toMatch(/no simulated output/i))
    }
    await g.run(`terraform state rm 'module.stack["west"]'`, 'terraform plan')
    await waitFor(() => expect(output()).toMatch(CLEAN))
    await g.closeClean('stop-managing-west')
  })

  it('trap: remove prevent_destroy and apply: destructive once, restoring the key afterwards earns nothing', async () => {
    const g = await mount('terraform-module-key-removed')
    g.declare(ROOT)
    await g.run("sed -i '/prevent_destroy/d' modules/stack/data/main.tf", 'terraform apply -auto-approve')
    await waitFor(() => expect(output()).toMatch(/Apply complete! Resources: 0 added, 0 changed, 2 destroyed\./))
    await g.run(RESTORE, 'terraform apply -auto-approve', 'terraform plan')
    await g.trapped('remove-guard-and-apply')
  })
})
