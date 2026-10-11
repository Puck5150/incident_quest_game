import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'
import { fixComplete, runCommand, type GameEvent } from '../src/game/engine.ts'

const sc = loadIncident('cascading-failure')
const take = (...ids: string[]): GameEvent[] => ids.map((id, i) => ({ type: 'TAKE_ACTION', id, at: i }))
const post = "curl -s -o /dev/null -w '%{http_code} %{time_total}\\n' -X POST https://shop.example.com/api/checkout"

describe('cascading-failure', () => {
  it('needs index, bounded client, bulkhead and migration guard; a rollback is not a fix', () => {
    expect(fixComplete(sc, take('restore-index', 'add-timeout'))).toBe(false)
    expect(fixComplete(sc, take('rollback-inventory', 'add-timeout', 'bulkhead', 'migration-guard'))).toBe(false)
    expect(fixComplete(sc, take('restore-index', 'add-timeout', 'bulkhead', 'migration-guard'))).toBe(true)
  })
  it('only the index restores checkout; a rollback leaves it slow', () => {
    expect(runCommand(sc, post, new Set(['restore-index'])).output).toMatch(/^200/)
    expect(runCommand(sc, post, new Set(['rollback-inventory'])).output).toMatch(/^504/)
    expect(sc.actions.find((a) => a.id === 'restore-index')?.label).toMatch(/CONCURRENTLY/)
  })
})
