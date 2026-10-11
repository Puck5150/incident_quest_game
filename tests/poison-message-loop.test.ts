import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'
import { fixComplete, runCommand, type GameEvent } from '../src/game/engine.ts'

const { sc, credit } = load('poison-message-loop')
const take = (...ids: string[]): GameEvent[] => ids.map((id, i) => ({ type: 'TAKE_ACTION', id, at: i }))
describe('poison-message-loop', () => {
  it('the DLX alone, or the reject alone, is not enough', () => {
    expect(fixComplete(sc, take('add-dlx', 'reject-permanent'))).toBe(false)
    expect(fixComplete(sc, take('add-dlx', 'reject-permanent', 'repair-replay'))).toBe(false)
    expect(fixComplete(sc, take('add-dlx', 'reject-permanent', 'repair-replay', 'queue-alerts'))).toBe(true)
    expect(sc.actions.find((a) => a.id === 'add-dlx')?.label).toMatch(/at-least-once.*reject-publish/)
    expect(sc.actions.find((a) => a.id === 'repair-replay')?.label).toMatch(/validate/)
  })
  it('the applied policy shows the at-least-once settings', () => {
    expect(runCommand(sc, 'sudo rabbitmqctl list_policies', new Set(['add-dlx'])).output).toMatch(/at-least-once.*reject-publish|reject-publish.*at-least-once/)
  })
  it('weak routes stay rejected', () => {
    expect(credit('sudo rabbitmqctl set_policy dl "^qq" \'{"delivery-limit":5}\'')?.id).toBe('lower-delivery-limit')
    expect(credit('rabbitmqctl purge_queue qq.order-emails')?.id).toBe('purge-queue')
    expect(credit('kubectl scale deployment/email-worker --replicas=12 -n shop')?.id).toBe('scale-workers')
  })
})
