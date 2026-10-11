import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('load-average-nfs')
const id = (c: string) => actionFor(sc, c)?.id

describe('load-average-nfs', () => {
  it('every route enables the service for boot and adds the alert', () => {
    for (const p of sc.solution_paths) expect(p).toContain('nfs-alert')
    expect(sc.solution_paths).not.toContainEqual(['start-now'])
    expect(sc.solution_paths).not.toContainEqual(['start-now', 'nfs-alert'])
  })
  it('credits enable --now, or enable plus start separately', () => {
    expect(id('ssh files-01 sudo systemctl enable --now nfs-server')).toBe('start-nfs')
    expect(id('ssh files-01 sudo systemctl start nfs-server')).toBe('start-now')
    expect(id('ssh files-01 sudo systemctl enable nfs-server.service')).toBe('enable-boot')
  })
  it.each(['ssh files-01 sudo systemctl enable --now nfs-server; id', 'ssh files-01 sudo systemctl start nfs-server && x', 'ssh files-01 sudo systemctl enable --now nfs-client'])('does not credit %s', (c) =>
    expect(['start-nfs', 'start-now', 'enable-boot']).not.toContain(id(c)),
  )
})

describe('load-average-nfs spellings', () => {
  it('credits enable nfs-server --now and quoted remote commands', () => {
    expect(id('ssh files-01 sudo systemctl enable nfs-server --now')).toBe('start-nfs')
    expect(id("ssh files-01 'sudo systemctl enable --now nfs-server'")).toBe('start-nfs')
    expect(id("ssh files-01 'sudo systemctl start nfs-server; id'")).toBeUndefined()
  })
})
