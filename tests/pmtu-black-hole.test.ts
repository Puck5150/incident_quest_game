import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('pmtu-black-hole')

describe('pmtu-black-hole', () => {
  it('only allowing ICMP type 3 code 4 completes it; the MSS clamp alone does not', () => {
    expect(sc.solution_paths.every((p) => p.includes('allow-frag-needed'))).toBe(true)
    expect(sc.solution_paths).not.toContainEqual(['mss-clamp'])
  })
  it('keeps broad shortcuts wrong or destructive', () => {
    expect(sc.actions.find((a) => a.id === 'allow-all-icmp')?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'bypass-vpn')?.kind).toBe('destructive')
  })
})
