import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('poison-message-loop')
describe('poison-message-loop', () => {
  it('needs at-least-once DLX, permanent rejects, repair+validation and alerts', () => {
    expect(sc.solution_paths).toEqual([['add-dlx', 'reject-permanent', 'repair-replay', 'queue-alerts']])
    expect(sc.actions.find((a) => a.id === 'add-dlx')?.label).toMatch(/at-least-once.*reject-publish/)
    expect(sc.actions.find((a) => a.id === 'repair-replay')?.label).toMatch(/validate/)
  })
  it('weak routes stay rejected', () => {
    expect(credit('sudo rabbitmqctl set_policy dl "^qq" \'{"delivery-limit":5}\'')?.id).toBe('lower-delivery-limit')
    expect(credit('rabbitmqctl purge_queue qq.order-emails')?.id).toBe('purge-queue')
    expect(credit('kubectl scale deployment/email-worker --replicas=12 -n shop')?.id).toBe('scale-workers')
  })
})
