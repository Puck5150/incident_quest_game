import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('jwt-clock-skew')
describe('jwt-clock-skew', () => {
  it('requires the fleet check and a clock alert too', () => {
    expect(sc.solution_paths).toEqual([['fix-ntp', 'check-fleet', 'clock-alert']])
  })
  it('credits chrony or chronyd, sudo, either flag order', () => {
    for (const l of ['ssh wishlist-01 systemctl enable --now chrony', 'ssh wishlist-01 sudo systemctl enable --now chronyd.service', 'ssh wishlist-01 sudo systemctl --now enable chrony'])
      expect(credit(l)?.id).toBe('fix-ntp')
    for (const l of ['ssh wishlist-01 systemctl start chrony', 'ssh wishlist-02 systemctl enable --now chrony', 'ssh wishlist-01 systemctl enable --now chrony; true'])
      expect(credit(l)).toBeUndefined()
  })
})

describe('jwt-clock-skew: behaviour', () => {
  it('chrony on wishlist-01 alone does not complete it', async () => {
    const { fixComplete } = await import('../src/game/engine.ts')
    const take = (...ids: string[]) => ids.map((id, i) => ({ type: 'TAKE_ACTION' as const, id, at: i }))
    expect(fixComplete(sc, take('fix-ntp'))).toBe(false)
    expect(fixComplete(sc, take('fix-ntp', 'check-fleet', 'clock-alert'))).toBe(true)
  })
})
