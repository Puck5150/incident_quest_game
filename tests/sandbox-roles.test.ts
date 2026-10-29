// `neutral` is the role for parts the sandbox checks do not judge yet
// (queues, object storage). Caches have `cache`, and entry points
// (CloudFront, Traffic Manager, a global load balancer) have `route`.

import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ROLES } from '../src/schema/constants.ts'
import { CanvasChallengeSchema } from '../src/schema/canvas.ts'
import { checkRaw } from '../src/content/item.ts'
import { SandboxSchema } from '../src/schema/sandbox.ts'

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

// The first palette part of the AWS sandbox (the queue) is rewritten with other role lists.
// checkRaw validates shape only, so nothing here runs the engine.
const sandboxWithRoles = (roles: string) => {
  const file = path.resolve(import.meta.dirname, '../content/sandbox/aws-sandbox.yaml')
  const raw = fs.readFileSync(file, 'utf8').replace('roles: [neutral]', `roles: ${roles}`)
  const errors: string[] = []
  const ok = checkRaw(raw, SandboxSchema, 'aws-sandbox', errors)
  return { ok, errors }
}

it('a sandbox file accepts an extra part with only the cache role', () => {
  const { ok, errors } = sandboxWithRoles('[cache]')
  expect(errors).toEqual([])
  expect(ok).toBeTruthy()
})

it('a sandbox file accepts an extra part with only the route role', () => {
  const { ok, errors } = sandboxWithRoles('[route]')
  expect(errors).toEqual([])
  expect(ok).toBeTruthy()
})

it.each([['[cache, neutral]'], ['[route, neutral]'], ['[serve]'], ['[write-store]'], ['[]']])('a sandbox file refuses an extra part with roles %s, naming the allowed roles', (roles) => {
  const { ok, errors } = sandboxWithRoles(roles)
  expect(ok).toBeUndefined()
  expect(errors.join(' ')).toMatch(/neutral, cache or route/)
})

it('a sandbox file accepts an overlay that adds a caching setting to an inherited part, and refuses unknown keys in it', () => {
  const file = path.resolve(import.meta.dirname, '../content/sandbox/aws-sandbox.yaml')
  const raw = fs.readFileSync(file, 'utf8')
  const overlay = (extra: string) => `${raw}\noverlays:\n  - id: alb\n    caching: { label: Caching, default: false, facts: ["A fact."] }${extra}\n`
  const errors: string[] = []
  expect(checkRaw(overlay(''), SandboxSchema, 'aws-sandbox', errors)).toBeTruthy()
  expect(errors).toEqual([])
  expect(checkRaw(overlay('\n    extra: 1'), SandboxSchema, 'aws-sandbox', [])).toBeUndefined()
})
