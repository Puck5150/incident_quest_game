import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'
import { runCommand } from '../src/game/engine.ts'

const sc = loadIncident('breaking-api-field')
describe('breaking-api-field', () => {
  it('requires the compatible release and contract tests', () => {
    expect(sc.solution_paths).toEqual([['restore-field', 'contract-tests']])
    expect(sc.actions.find((a) => a.id === 'rollback-v5')?.kind).toBe('wrong')
    expect(sc.actions.find((a) => a.id === 'force-update')?.kind).toBe('wrong')
  })
  it('the response serves both fields only after the restore', () => {
    const cmd = "curl -s https://api.example.com/catalog/products/p-1182 | jq '{price, price_money}'"
    expect(runCommand(sc, cmd, new Set(['restore-field'])).output).toMatch(/"price": 24\.99/)
    expect(runCommand(sc, cmd, new Set()).output).toMatch(/"price": null/)
  })
  it('hint and ideal path mention the contract tests', () => {
    expect(sc.hints.answer).toMatch(/contract tests/)
    expect(sc.debrief.ideal_path.join(' ')).toMatch(/contract tests/)
  })
})
