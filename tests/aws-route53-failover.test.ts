import { describe, expect, it } from 'vitest'
import { loadIncident } from './helpers/terraform-incident.ts'

const sc = loadIncident('aws-route53-failover')
const credit = (cmd: string) => sc.actions.find((a) => a.match_regex !== undefined && new RegExp(a.match_regex).test(cmd))
const A = 'aws ec2 authorize-security-group-ingress --group-id sg-0usw2alb'

describe('aws-route53-failover', () => {
  it.each([
    `${A} --protocol tcp --port 443 --cidr 15.177.0.0/18`,
    `${A} --port 443 --cidr 54.239.98.0/24 --protocol tcp`,
    `sudo ${A} --protocol tcp --port 443 --cidr 15.177.0.0/18`,
    `${A} --ip-permissions IpProtocol=tcp,FromPort=443,ToPort=443,PrefixListIds=[{PrefixListId=pl-0abc123def}]`,
    `${A} --ip-permissions IpProtocol=tcp,ToPort=443,FromPort=443,PrefixListIds=[{PrefixListId=pl-0abc123def}]`,
  ])('credits %s as the health-checker rule', (c) => expect(credit(c)?.id).toBe('allow-health-checkers'))

  it.each([
    [`${A} --protocol tcp --port 443 --cidr 0.0.0.0/0`, 'open-standby-direct', 'wrong'],
    [`${A} --port 443 --cidr 0.0.0.0/0 --protocol tcp`, 'open-standby-direct', 'wrong'],
    [`${A} --protocol -1 --cidr 0.0.0.0/0`, 'open-all-ports', 'destructive'],
    [`${A} --protocol tcp --port 0-65535 --cidr 0.0.0.0/0`, 'open-all-ports', 'destructive'],
    ['aws ec2 revoke-security-group-ingress --group-id sg-0usw2alb --protocol tcp --port 443 --cidr 203.0.113.0/24', 'remove-vpn-rule', 'wrong'],
  ])('flags %s', (c, id, kind) => expect(credit(c)).toMatchObject({ id, kind }))

  it.each([
    `${A} --protocol tcp --port 443 --cidr 10.0.0.0/16`,
    `${A} --protocol tcp --port 443 --cidr 8.0.0.0/8`,
    `${A} --protocol tcp --port 22 --cidr 15.177.0.0/18`,
    `${A} --protocol tcp --port 443 --cidr 203.0.113.0/24`,
  ])('does not credit %s as the checker rule', (c) => expect(credit(c)?.id).not.toBe('allow-health-checkers'))

  it('needs both halves, the alarm and the TTL; the shortcuts never complete it', () => {
    expect(sc.solution_paths).toEqual([['allow-health-checkers', 'restore-standby-ingress', 'alarm-standby-hc', 'lower-ttl']])
    const fixes = sc.actions.filter((a) => a.kind === 'fix').map((a) => a.id)
    expect(fixes.sort()).toEqual(['alarm-standby-hc', 'allow-health-checkers', 'lower-ttl', 'restore-standby-ingress'])
    for (const id of ['open-standby-direct', 'open-all-ports', 'remove-vpn-rule']) expect(sc.actions.find((a) => a.id === id)!.kind).not.toBe('fix')
  })
})
