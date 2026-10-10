import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-permissions-boundary')
const D = 'aws iam detach-role-policy --role-name orders-api-task-role --policy-arn arn:aws:iam::aws:policy/AdministratorAccess'

describe('aws-permissions-boundary', () => {
  it('requires removing AdministratorAccess in the solution path', () => {
    expect(sc.solution_paths).toEqual([['boundary-allows', 'redeploy', 'remove-admin']])
  })
  it.each([D, `  ${D}  `])('credits %s', (c) => expect(actionFor(sc, c)?.id).toBe('remove-admin'))
  it.each([
    `${D}; aws iam attach-role-policy --role-name x --policy-arn arn:aws:iam::aws:policy/AdministratorAccess`,
    `${D} && echo`,
    `${D} --role-name other-role`,
    `${D}x`,
    D.replace('orders-api-task-role', 'payments-task-role'),
    D.replace('AdministratorAccess', 'ReadOnlyAccess'),
    D.replace('detach', 'attach'),
    `${D} | cat`,
  ])('does not credit %s', (c) => expect(actionFor(sc, c)?.id).not.toBe('remove-admin'))
  it('flags the wide boundary grant as wrong and the boundary deletion as wrong', () => {
    expect(sc.actions.find((a) => a.id === 'boundary-star')?.kind).toBe('wrong')
    expect(actionFor(sc, 'aws iam delete-role-permissions-boundary --role-name orders-api-task-role')?.kind).toBe('wrong')
  })
})
