import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('duplicate-ip-cache-major')
const NFT = 'ssh cache-02-mgmt sudo nft add rule inet filter input ip saddr 10.20.6.0/24 tcp dport 6379 accept'

describe('duplicate-ip-cache-major', () => {
  it('requires persisting every runtime change, Redis auth and a real decommission', () => {
    expect(atStage(sc, 0).solution_paths).toEqual([['isolate-old', 'persist-isolation']])
    expect(atStage(sc, 1).solution_paths).toEqual([['allow-subnet', 'persist-nft']])
    expect(atStage(sc, 2).solution_paths).toEqual([['copy-carts', 'redis-auth', 'decommission-old']])
  })
  it('credits the exact one-subnet one-port rule only', () => {
    const st = atStage(sc, 1)
    expect(actionFor(st, NFT)?.id).toBe('allow-subnet')
    for (const c of [NFT.replace('10.20.6.0/24', '0.0.0.0/0'), NFT.replace('10.20.6.0/24', '10.20.0.0/16'), NFT.replace('6379', '22'), `${NFT}; id`]) expect(actionFor(st, c)?.id).not.toBe('allow-subnet')
  })
  it('credits only the exact migrate script', () => {
    const st = atStage(sc, 2)
    expect(actionFor(st, './migrate-carts.sh 10.99.0.11 10.99.0.12')?.id).toBe('copy-carts')
    expect(actionFor(st, './migrate-carts.sh 10.99.0.11 10.99.0.12 replace')?.id).not.toBe('copy-carts')
  })
  it('keeps shortcuts non-fixes', () => {
    expect(atStage(sc, 0).actions.find((a) => a.id === 'power-off-old')?.kind).toBe('destructive')
    expect(atStage(sc, 1).actions.find((a) => a.id === 'policy-accept')?.kind).toBe('destructive')
  })
})

describe('duplicate-ip-cache-major spellings', () => {
  it('credits dev eth0, quoted remote commands and the set syntax', () => {
    expect(actionFor(atStage(sc, 0), 'ssh cache-01-mgmt sudo ip link set dev eth0 down')?.id).toBe('isolate-old')
    expect(actionFor(atStage(sc, 0), "ssh cache-01-mgmt 'sudo ip link set eth0 down'")?.id).toBe('isolate-old')
    expect(actionFor(atStage(sc, 1), NFT.replace('dport 6379', 'dport { 6379 }'))?.id).toBe('allow-subnet')
    expect(actionFor(atStage(sc, 1), NFT.replace('dport 6379', 'dport { 6379, 22 }'))?.id).not.toBe('allow-subnet')
    expect(actionFor(atStage(sc, 0), "ssh cache-01-mgmt 'sudo ip link set eth0 down; id'")?.id).not.toBe('isolate-old')
  })
})
