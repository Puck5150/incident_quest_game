// Separate security group rule resources: aws_vpc_security_group_{ingress,egress}_rule and aws_security_group_rule.
import { describe, expect, it } from 'vitest'
import { executeApply, type ApplyContext } from '../src/game/terraform/apply.ts'
import type { Value } from '../src/game/terraform/eval.ts'
import { planConfig } from '../src/game/terraform/plan.ts'
import { evalPredicate, type World } from '../src/game/terraform/predicates.ts'
import { realityKey, type Reality } from '../src/game/terraform/refresh.ts'
import { effectiveRules } from '../src/game/terraform/sgrules.ts'
import { emptyState, findInstance, type State } from '../src/game/terraform/state.ts'
import type { Predicate } from '../src/schema/scenario.ts'

const ctx = (): ApplyContext => ({ faults: [], taken: new Set(), attempts: new Map(), seed: '1' })
const apply = (tf: string, state: State = emptyState(), reality: Reality = {}) => executeApply({ files: [{ name: 'main.tf', text: tf }], state, reality, vars: {} }, ctx())
const ops = (r: { steps: { op: string; address: string; ok: boolean }[] }) => r.steps.map((s) => `${s.ok ? '' : '!'}${s.op} ${s.address}`)
const idOf = (s: State, address: string) => findInstance(s, address)!.instance.attributes.id as string
const world = (tf: string, r: { state: State; reality: Reality }): World => ({
  state: r.state,
  reality: r.reality,
  history: [],
  plan: () => planConfig({ files: [{ name: 'main.tf', text: tf }], state: r.state, reality: r.reality, vars: {} }),
  readFile: async () => undefined,
})

const BASE = `
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}
`
const GROUPS = `
resource "aws_security_group" "web" {
  name   = "web"
  vpc_id = aws_vpc.main.id
}
resource "aws_security_group" "app" {
  name   = "app"
  vpc_id = aws_vpc.main.id
}
`
const RULES = `
resource "aws_vpc_security_group_ingress_rule" "app_from_web" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.web.id
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
}
resource "aws_vpc_security_group_ingress_rule" "web_from_app" {
  security_group_id            = aws_security_group.web.id
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = 8443
  to_port                      = 8443
  ip_protocol                  = "tcp"
}
`
const SPLIT = BASE + GROUPS + RULES

describe('separate rule resources break the group cycle', () => {
  it('create both groups first, then both rules; neither group depends on a rule', () => {
    const r = apply(SPLIT)
    expect(r.errors).toEqual([])
    expect(ops(r)).toEqual([
      'create aws_vpc.main',
      'create aws_security_group.app',
      'create aws_security_group.web',
      'create aws_vpc_security_group_ingress_rule.app_from_web',
      'create aws_vpc_security_group_ingress_rule.web_from_app',
    ])
    const rule = findInstance(r.state, 'aws_vpc_security_group_ingress_rule.app_from_web')!.instance
    expect(rule.attributes.id).toMatch(/^sgr-0[0-9a-f]{16}$/)
    expect(rule.attributes.security_group_rule_id).toBe(rule.attributes.id)
    expect(rule.attributes.arn).toBe(`arn:aws:ec2:us-east-1:123456789012:security-group-rule/${rule.attributes.id}`)
    expect(rule.attributes.security_group_id).toBe(idOf(r.state, 'aws_security_group.app'))
    expect(rule.attributes.referenced_security_group_id).toBe(idOf(r.state, 'aws_security_group.web'))
    expect(rule.dependencies).toEqual(['aws_security_group.app', 'aws_security_group.web'])
    expect(Object.hasOwn(r.reality, realityKey('aws_vpc_security_group_ingress_rule', rule.attributes.id as string))).toBe(true)
  })

  it('the same references written inline are still a dependency cycle', () => {
    const inline = BASE + `
resource "aws_security_group" "web" {
  name   = "web"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 8443
    to_port         = 8443
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}
resource "aws_security_group" "app" {
  name   = "app"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.web.id]
  }
}
`
    const p = planConfig({ files: [{ name: 'main.tf', text: inline }], state: emptyState(), reality: {}, vars: {} })
    expect(p.diagnostics.map((d) => d.summary)).toEqual(['Cycle: aws_security_group.app, aws_security_group.web'])
    // rules that name each other's group but belong to a group by id are not a cycle either way round
    const rules = planConfig({ files: [{ name: 'main.tf', text: SPLIT }], state: emptyState(), reality: {}, vars: {} })
    expect(rules.diagnostics).toEqual([])
    expect(rules.summary).toEqual({ add: 5, change: 0, destroy: 0 })
  })

  it('effective rules and the sg_rule predicate see the rules by peer group, and see widening', async () => {
    const r = apply(SPLIT)
    const app = idOf(r.state, 'aws_security_group.app')
    const web = idOf(r.state, 'aws_security_group.web')
    expect(effectiveRules(r.reality, app, 'ingress')).toEqual([{ dir: 'ingress', proto: 'tcp', from: 8080, to: 8080, src: { kind: 'sg', v: web } }])
    expect(effectiveRules(r.reality, app, 'egress')).toEqual([])
    const w = world(SPLIT, r)
    const has = (x: object) => evalPredicate({ sg_rule: x } as Predicate, w)
    expect(await has({ group_id: app, direction: 'ingress', port: 8080, source_group_id: web })).toBe(true)
    expect(await has({ group_id: app, direction: 'ingress', port: 8080, source_group_id: app })).toBe(false)
    expect(await has({ group_id: app, direction: 'ingress', port: 8081, source_group_id: web })).toBe(false)
    expect(await has({ group_id: app, direction: 'ingress', port: 8080, cidr: '*' })).toBe(false)
    expect(await has({ group_id: web, direction: 'ingress', port: 8443, source_group_id: app })).toBe(true)
    expect(await has({ group_id: web, direction: 'ingress', port: 8080 })).toBe(false)
    expect(await has({ group_id: app, direction: 'ingress', port: 8080, exact: true, source_group_id: web })).toBe(true)
    expect(await has({ group_id: app, direction: 'ingress', port: 8080, protocol: 'udp', source_group_id: web })).toBe(false)
    expect(await evalPredicate({ plan_clean: true }, w)).toBe(true)
  })

  it('swapping the peer for a CIDR is an in-place update that the predicate reports as a cidr rule', async () => {
    const first = apply(SPLIT)
    const widened = SPLIT.replace('referenced_security_group_id = aws_security_group.web.id', 'cidr_ipv4                    = "10.0.0.0/16"')
    const plan = planConfig({ files: [{ name: 'main.tf', text: widened }], state: first.state, reality: first.reality, vars: {} })
    expect(plan.items.filter((i) => i.action !== 'noop').map((i) => `${i.action} ${i.address}`)).toEqual(['update aws_vpc_security_group_ingress_rule.app_from_web'])
    const second = executeApply({ files: [{ name: 'main.tf', text: widened }], state: first.state, reality: first.reality, vars: {} }, ctx())
    expect(second.errors).toEqual([])
    const app = idOf(second.state, 'aws_security_group.app')
    const w = world(widened, second)
    expect(await evalPredicate({ sg_rule: { group_id: app, direction: 'ingress', port: 8080, cidr: '*' } }, w)).toBe(true)
    expect(await evalPredicate({ sg_rule: { group_id: app, direction: 'ingress', port: 8080, cidr: '10.0.0.0/16' } }, w)).toBe(true)
    expect(await evalPredicate({ sg_rule: { group_id: app, direction: 'ingress', port: 8080, cidr: '10.0.1.0/24' } }, w)).toBe(false)
    expect(await evalPredicate({ sg_rule: { group_id: app, direction: 'ingress', port: 8080, source_group_id: idOf(second.state, 'aws_security_group.web') } }, w)).toBe(false)
  })

  it('moving a rule to another group replaces it; removing the rule deletes it from the cloud', () => {
    const first = apply(SPLIT)
    const moved = SPLIT.replace(/security_group_id            = aws_security_group\.app\.id/, 'security_group_id            = aws_security_group.web.id')
    const plan = planConfig({ files: [{ name: 'main.tf', text: moved }], state: first.state, reality: first.reality, vars: {} })
    expect(plan.items.find((i) => i.address === 'aws_vpc_security_group_ingress_rule.app_from_web')!.action).toBe('replace')
    expect(plan.items.find((i) => i.address === 'aws_vpc_security_group_ingress_rule.app_from_web')!.changes.find((c) => c.name === 'security_group_id')!.forcesReplacement).toBe(true)
    const gone = SPLIT.replace(/resource "aws_vpc_security_group_ingress_rule" "web_from_app"[\s\S]*$/, '')
    const second = executeApply({ files: [{ name: 'main.tf', text: gone }], state: first.state, reality: first.reality, vars: {} }, ctx())
    expect(second.errors).toEqual([])
    expect(ops(second)).toEqual(['delete aws_vpc_security_group_ingress_rule.web_from_app'])
    expect(effectiveRules(second.reality, idOf(second.state, 'aws_security_group.web'), 'ingress')).toEqual([])
  })
})

describe('groups and the rules that name them', () => {
  it('a group another group has a rule for cannot be deleted; its own rules do not hold it', () => {
    const first = apply(SPLIT)
    // delete both rules and both groups: rules go first, then the groups
    const destroy = executeApply({ files: [{ name: 'main.tf', text: BASE }], state: first.state, reality: first.reality, vars: {} }, ctx())
    expect(destroy.errors).toEqual([])
    expect(ops(destroy).slice(0, 2).sort()).toEqual(['delete aws_vpc_security_group_ingress_rule.app_from_web', 'delete aws_vpc_security_group_ingress_rule.web_from_app'])
    // only web goes, app keeps a rule that names web: AWS refuses
    const onlyWebGone = BASE + `
resource "aws_security_group" "app" {
  name   = "app"
  vpc_id = aws_vpc.main.id
}
resource "aws_vpc_security_group_ingress_rule" "app_from_web" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = "${idOf(first.state, 'aws_security_group.web')}"
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
}
`
    const refused = executeApply({ files: [{ name: 'main.tf', text: onlyWebGone }], state: first.state, reality: first.reality, vars: {} }, ctx())
    expect(refused.errors.some((e) => e.summary.includes('DependencyViolation'))).toBe(true)
    expect(Object.hasOwn(refused.reality, realityKey('aws_security_group', idOf(first.state, 'aws_security_group.web')))).toBe(true)
  })

  it('a rule for a group that already has the identical rule inline is refused as a duplicate', () => {
    const inline = BASE + `
resource "aws_security_group" "web" {
  name   = "web"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`
    const first = apply(inline)
    expect(first.errors).toEqual([])
    const rule = `
resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.web.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}
`
    // inline blocks dropped, the rule added: the group is not touched (its rules are computed), so AWS still has the inline rule
    const dropped = BASE + `
resource "aws_security_group" "web" {
  name   = "web"
  vpc_id = aws_vpc.main.id
}
` + rule
    const second = executeApply({ files: [{ name: 'main.tf', text: dropped }], state: first.state, reality: first.reality, vars: {} }, ctx())
    expect(ops(second)).toEqual(['!create aws_vpc_security_group_ingress_rule.https'])
    expect(second.errors[0].summary).toContain('InvalidPermission.Duplicate')
    expect(second.errors[0].summary).toContain('peer: 0.0.0.0/0, TCP, from port: 443, to port: 443, ALLOW')
    expect(second.errors[0].summary).toContain('creating VPC Security Group Ingress Rule')
    // clearing the inline rules in the same apply orders the group update before the rule
    const cleared = BASE + `
resource "aws_security_group" "web" {
  name    = "web"
  vpc_id  = aws_vpc.main.id
  ingress = []
}
` + rule
    const third = executeApply({ files: [{ name: 'main.tf', text: cleared }], state: first.state, reality: first.reality, vars: {} }, ctx())
    expect(third.errors).toEqual([])
    expect(ops(third)).toEqual(['update aws_security_group.web', 'create aws_vpc_security_group_ingress_rule.https'])
    expect(effectiveRules(third.reality, idOf(third.state, 'aws_security_group.web'), 'ingress')).toHaveLength(1)
  })

  it('inline rules and a separate rule for the same group is a conflict: warned, and never plan-clean', async () => {
    const mixed = BASE + `
resource "aws_security_group" "web" {
  name   = "web"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.web.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
`
    const first = apply(mixed)
    expect(first.errors).toEqual([])
    const p = planConfig({ files: [{ name: 'main.tf', text: mixed }], state: first.state, reality: first.reality, vars: {} })
    expect(p.diagnostics).toEqual([])
    expect(p.warnings.map((w) => w.summary)).toEqual(['Security group rules are managed twice'])
    expect(p.warnings[0].detail).toContain('aws_security_group.web')
    expect(p.warnings[0].detail).toContain('aws_vpc_security_group_egress_rule.all')
    expect(await evalPredicate({ plan_clean: true }, world(mixed, first))).toBe(false)
    // another group's rules do not conflict, nor does a group with no inline rules
    const fine = planConfig({ files: [{ name: 'main.tf', text: SPLIT }], state: emptyState(), reality: {}, vars: {} })
    expect(fine.warnings).toEqual([])
    // an explicit empty list is still inline management
    const empty = SPLIT.replace('name   = "web"', 'name   = "web"\n  egress = []')
    expect(planConfig({ files: [{ name: 'main.tf', text: empty }], state: emptyState(), reality: {}, vars: {} }).warnings).toHaveLength(1)
  })
})

describe('sg_rule exact', () => {
  it('a wide rule covers a port but is not exact for it', async () => {
    const tf = SPLIT.replace('from_port                    = 8080\n  to_port                      = 8080', 'from_port                    = 8000\n  to_port                      = 9000')
    const r = apply(tf)
    const app = idOf(r.state, 'aws_security_group.app')
    const w = world(tf, r)
    expect(await evalPredicate({ sg_rule: { group_id: app, direction: 'ingress', port: 8080 } }, w)).toBe(true)
    expect(await evalPredicate({ sg_rule: { group_id: app, direction: 'ingress', port: 8080, exact: true } }, w)).toBe(false)
    expect(await evalPredicate({ sg_rule: { group_id: app, direction: 'ingress', port: 22 } }, w)).toBe(false)
  })
})

describe('aws_security_group_rule', () => {
  it('models type, source_security_group_id and self; most arguments force a new rule', () => {
    const tf =
      BASE +
      GROUPS +
      `
resource "aws_security_group_rule" "app_from_web" {
  type                     = "ingress"
  security_group_id        = aws_security_group.app.id
  source_security_group_id = aws_security_group.web.id
  from_port                = 8080
  to_port                  = 8080
  protocol                 = "tcp"
}
resource "aws_security_group_rule" "web_self" {
  type              = "ingress"
  security_group_id = aws_security_group.web.id
  self              = true
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  description       = "members talk"
}
`
    const r = apply(tf)
    expect(r.errors).toEqual([])
    const app = idOf(r.state, 'aws_security_group.app')
    const web = idOf(r.state, 'aws_security_group.web')
    expect(idOf(r.state, 'aws_security_group_rule.app_from_web')).toMatch(/^sgrule-\d{10}$/)
    expect(effectiveRules(r.reality, app, 'ingress')).toEqual([{ dir: 'ingress', proto: 'tcp', from: 8080, to: 8080, src: { kind: 'sg', v: web } }])
    expect(effectiveRules(r.reality, web, 'ingress')).toEqual([{ dir: 'ingress', proto: '-1', from: 0, to: 65535, src: { kind: 'sg', v: web } }])
    // description updates in place; the port forces a replacement
    const desc = planConfig({ files: [{ name: 'main.tf', text: tf.replace('"members talk"', '"nodes"') }], state: r.state, reality: r.reality, vars: {} })
    expect(desc.items.find((i) => i.address === 'aws_security_group_rule.web_self')!.action).toBe('update')
    const port = planConfig({ files: [{ name: 'main.tf', text: tf.replace('8080', '8081').replace('8080', '8081') }], state: r.state, reality: r.reality, vars: {} })
    expect(port.items.find((i) => i.address === 'aws_security_group_rule.app_from_web')!.action).toBe('replace')
  })
})

describe('the value helper', () => {
  it('ignores objects of other groups and rules of other types', () => {
    const reality: Reality = { 'aws_vpc:vpc-1': { id: 'vpc-1' } as Record<string, Value> }
    expect(effectiveRules(reality, 'sg-x', 'ingress')).toEqual([])
  })
})
