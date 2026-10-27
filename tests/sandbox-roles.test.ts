// `neutral` is the role for parts the sandbox checks do not judge yet
// (queues, caches, object storage, CDNs).

import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ROLES } from '../src/schema/constants.ts'
import { CanvasChallengeSchema } from '../src/schema/canvas.ts'
import { checkRaw } from '../src/content/item.ts'

it('neutral is a role', () => {
  expect(ROLES).toContain('neutral')
})

it('the canvas schema accepts a palette item with only the neutral role', () => {
  const file = path.resolve(import.meta.dirname, '../content/cloud-design/aws-checkout-canvas.yaml')
  // The first palette item (the load balancer) becomes neutral; the rest of the file is untouched.
  // checkRaw validates shape only, so the reference designs are not run against the engine here.
  const raw = fs.readFileSync(file, 'utf8').replace('roles: [route]', 'roles: [neutral]')
  const errors: string[] = []
  expect(checkRaw(raw, CanvasChallengeSchema, 'aws-checkout-canvas', errors)).toBeTruthy()
  expect(errors).toEqual([])
})
