import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { evaluate, scoreChallenge } from '../src/game/challenge.ts'
import type { Challenge, Picks } from '../src/schema/challenge.ts'

const { challenges, multis } = loadContent(path.resolve(import.meta.dirname, '../content'))
// Slot challenges on the cloud of your choice: every provider's variant gets the same guarantees.
const allSlot: Challenge[] = [
  ...challenges,
  ...multis.flatMap((m) => (m.kind === 'slot' ? (Object.values(m.variants) as Challenge[]) : [])),
]
const c = challenges.find((x) => x.id === 'aws-checkout-az-resilience')!
const failed = (picks: Picks) => evaluate(c, picks).tests.filter((t) => !t.pass).map((t) => t.id)
const run = (picks: Picks) => ({ picks, at: 0 })

const RECOMMENDED = { compute: 'asg-multi-az', database: 'rds-multi-az' }
const WEAK = { compute: 'ec2-single', database: 'rds-single-az' }
const OVERKILL = { compute: 'asg-multi-az', database: 'rds-cross-region' }

describe('evaluate', () => {
  it('the recommended design passes everything within budget', () => {
    const e = evaluate(c, RECOMMENDED)
    expect(e.pass).toBe(true)
    expect(e.cost).toBe(7)
    expect(e.overkill).toEqual([])
  })

  it('each rule type fails the right tier, with authored or default reasons', () => {
    expect(failed(WEAK)).toEqual(['az-outage', 'sale-traffic', 'db-host-failure'])
    const az = evaluate(c, WEAK).tests.find((t) => t.id === 'az-outage')!
    expect(az.reasons).toContain('The only copy of the database was in the failed zone.')
    const traffic = evaluate(c, WEAK).tests.find((t) => t.id === 'sale-traffic')!
    expect(traffic.reasons).toEqual(["One EC2 instance can't absorb 3× traffic."]) // default wording
  })

  it('over-engineered designs can pass but are flagged', () => {
    const e = evaluate(c, OVERKILL)
    expect(e.pass).toBe(true)
    expect(e.overkill).toHaveLength(1)
  })
})

describe('scoreChallenge (difficulty 2, base 200)', () => {
  it('first-run lean pass: base + 20% + 20%', () => {
    expect(scoreChallenge(c, [run(RECOMMENDED)], 0).total).toBe(280)
  })
  it('extra runs cost 10% each', () => {
    expect(scoreChallenge(c, [run(WEAK), run(RECOMMENDED)], 0).total).toBe(200 + 40 - 20)
  })
  it('over-engineering forfeits the lean bonus', () => {
    const s = scoreChallenge(c, [run(OVERKILL)], 0)
    expect(s.total).toBe(240)
    expect(s.lean).toBe(false)
  })
  it('hints use the same tiers as incidents and make it not clean', () => {
    const s = scoreChallenge(c, [run(RECOMMENDED)], 2)
    expect(s.total).toBe(280 - 20 - 50)
    expect(s.clean).toBe(false)
  })
})

// Content-level guarantees for every challenge, not just the placeholder.
describe.each(allSlot.map((x) => [`${x.id} (${x.provider})`, x] as const))('%s', (_id, ch: Challenge) => {
  const all = ch.tiers.reduce<Picks[]>(
    (designs, t) => designs.flatMap((d) => t.options.map((o) => ({ ...d, [t.id]: o.id }))),
    [{}],
  )

  it('every stress test is failed by at least one design (no decorative tests)', () => {
    ch.stress_tests.forEach((t) => {
      expect(all.some((d) => !evaluate(ch, d).tests.find((x) => x.id === t.id)!.pass), t.id).toBe(true)
    })
  })

  it('at least one design fails overall (the challenge is a real choice)', () => {
    expect(all.some((d) => !evaluate(ch, d).pass)).toBe(true)
  })
})
