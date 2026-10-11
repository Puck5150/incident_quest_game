import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc } = load('azure-files-port-445')
describe('azure-files-port-445', () => {
  it('opening 445 is a wrong action and never a route; public access must be disabled', () => {
    expect(sc.actions.find((a) => a.id === 'open-445-azure')!.kind).toBe('wrong')
    expect(sc.solution_paths).toEqual([['vpn-private-endpoint', 'disable-public-access']])
  })
  it('the 443 check after disabling public access fails if the private endpoint is not in yet, and works if it is', () => {
    const cmds = sc.terminal!.commands.filter((c) => c.match === 'Test-NetConnection -ComputerName stacmefiles.file.core.windows.net -Port 443')
    expect(cmds[0].when_actions).toEqual(['vpn-private-endpoint', 'disable-public-access'])
    expect(cmds[0].output).toContain('10.40.2.5')
    expect(cmds[1].when_actions).toEqual(['disable-public-access'])
    expect(cmds[1].output).toContain('Azure VMs')
    expect(sc.actions.find((a) => a.id === 'disable-public-access')!.feedback).toContain('after the private endpoint')
  })
})
