import { describe, expect, it } from 'vitest'
import { iamPolicyVerdict, type IamPolicySpec } from '../src/game/awsPolicyCheck.ts'

const ARN = 'arn:aws:rds:us-east-1:1:db:x'
const spec: IamPolicySpec = { role: 'r', profile: 'p', reserved_policy: 'main', allowed_actions: ['rds:CreateDBInstance', 'rds:AddTagsToResource'], required_actions: ['rds:CreateDBInstance'], resource: ARN }
const cmd = (doc: string, name = 'new') => `aws iam put-role-policy --profile p --role-name r --policy-name ${name} --policy-document ${doc}`
const st = (a: string, r = `"${ARN}"`, e = 'Allow') => `{"Effect":"${e}","Action":${a},"Resource":${r}}`
const doc = (...s: string[]) => `'{"Statement":[${s.join(',')}]}'`
const v = (line: string) => iamPolicyVerdict(line, spec)

describe('iamPolicyVerdict', () => {
  it('credits only the exact least-privilege grant', () => {
    expect(v(cmd(doc(st('["rds:CreateDBInstance"]'))))).toBe('ok')
    expect(v(cmd(doc(st('"rds:createdbinstance"'))))).toBe('ok')
    expect(v(cmd(doc(st('["rds:CreateDBInstance","rds:AddTagsToResource"]', `["${ARN}"]`))))).toBe('ok')
    expect(v(cmd(doc(st('"rds:CreateDBInstance"'), st('"rds:AddTagsToResource"'))))).toBe('ok')
    expect(v(cmd(`"{\\"Statement\\":${`[${st('"rds:CreateDBInstance"').replace(/"/g, '\\"')}]`}}"`))).toBe('ok')
    expect(v(cmd(`'{"Statement":{"Sid":"a","Effect":"Allow","Action":"rds:CreateDBInstance","Resource":"${ARN}","Condition":{"Bool":{"aws:SecureTransport":"true"}}}}'`))).toBe('ok')
  })
  it('rejects extra actions, statements, resources and Not* keys', () => {
    for (const d of [
      doc(st('["rds:CreateDBInstance","rds:DeleteDBInstance"]')),
      doc(st('"rds:CreateDBInstance"'), st('"iam:PassRole"')),
      doc(st('"rds:CreateDBInstance"'), st('"rds:CreateDBInstance"', '"arn:aws:rds:us-east-1:1:db:y"')),
      doc(st('"rds:CreateDBInstance"', `["${ARN}","${ARN}x"]`)),
      doc(st('"rds:AddTagsToResource"')),
      doc(st('"rds:CreateDBInstance"', `"${ARN}"`, 'Deny')),
      `'{"Statement":[{"Effect":"Allow","NotAction":"x","Resource":"${ARN}"}]}'`,
      `'{"Statement":[]}'`,
      `'not json'`,
      'file://p.json',
    ])
      expect(v(cmd(d)), d).toBeNull()
  })
  it('flags wildcards in any case and a reused policy name before anything else', () => {
    for (const a of ['"*"', '"RDS:*"', '["rds:CreateDBInstance","rds:Delete*"]', '"iam:*"']) expect(v(cmd(doc(st(a)))), a).toBe('wildcard')
    expect(v(cmd(doc(st('"rds:CreateDBInstance"', '"*"'))))).toBe('wildcard')
    expect(v(cmd(doc(st('"rds:*"')) + ' && echo x'))).toBe('wildcard')
    expect(v(cmd(doc(st('"rds:CreateDBInstance"')), 'MAIN'))).toBe('overwrite')
    expect(v(cmd(doc(st('"rds:*"')), 'main'))).toBe('overwrite')
  })
  it('never credits a compound line, another command, or the wrong caller', () => {
    const ok = cmd(doc(st('"rds:CreateDBInstance"')))
    for (const x of [' && ls', '; ls', ' | cat', ' || true', ' $(id)', ' `id`', ' > out', ' aws sts get-caller-identity']) expect(v(ok + x), x).toBeNull()
    expect(v(ok.replace('--profile p', ''))).toBeNull()
    expect(v(ok.replace('--role-name r', '--role-name q'))).toBeNull()
    expect(v(`AWS_PROFILE=p ${ok.replace('--profile p ', '')}`)).toBe('ok')
    expect(v('ls')).toBeNull()
    expect(v("aws iam put-role-policy --role-name r --policy-document '{")).toBeNull()
  })
})
