import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-alb-migration-two-faults')
const s1 = atStage(sc, 0)
const s2 = atStage(sc, 1)
const AU = 'aws ec2 authorize-security-group-ingress --group-id sg-0api --protocol tcp --port 8080'
const RV = 'aws ec2 revoke-security-group-ingress --group-id sg-0api --protocol tcp --port 8080'

describe('aws-alb-migration-two-faults', () => {
  it('credits only the SG-to-SG reference for the new ALB', () => {
    expect(actionFor(s1, `${AU} --source-group sg-0alb2`)?.id).toBe('allow-new-alb')
    for (const c of [`${AU} --cidr 0.0.0.0/0`, `${AU} --cidr 10.0.0.0/8`, `${AU} --source-group sg-0alb2; echo`, `${AU} --source-group sg-0alb`, `${AU} --port 22 --source-group sg-0alb2`]) {
      expect(actionFor(s1, c)?.id).not.toBe('allow-new-alb')
    }
    expect(actionFor(s1, `${AU} --cidr 0.0.0.0/0`)?.kind).toBe('wrong')
  })
  it('stage 2 requires retiring the old rule', () => expect(s2.solution_paths).toEqual([['fix-hc-path', 'retire-old-alb-rule']]))
  it('credits revoking the old ALB rule only', () => {
    expect(actionFor(s2, `${RV} --source-group sg-0alb`)?.id).toBe('retire-old-alb-rule')
    expect(actionFor(s2, `${RV} --source-group sg-0alb2`)).toMatchObject({ id: 'revoke-new-alb-rule', kind: 'destructive' })
    for (const c of [`${RV} --source-group sg-0alb; echo`, `${RV} --source-group sg-0alb && x`, `${RV} --source-group sg-0alb --port 22`]) expect(actionFor(s2, c)?.id).not.toBe('retire-old-alb-rule')
  })
  it('credits only the exact health check path', () => {
    const M = 'aws elbv2 modify-target-group --target-group-arn arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/api-v2/9f3c2b7a1d4e5f60'
    expect(actionFor(s2, `${M} --health-check-path /health`)?.id).toBe('fix-hc-path')
    for (const c of [`${M} --health-check-path /`, `${M} --health-check-path /health; x`, `${M} --health-check-path /health --matcher HttpCode=200-499`]) expect(actionFor(s2, c)?.id).not.toBe('fix-hc-path')
  })
})
