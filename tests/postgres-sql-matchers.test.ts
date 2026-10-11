import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'
import { actionFor } from '../src/game/engine.ts'

describe('postgres-missing-index', () => {
  const { credit } = load('postgres-missing-index')
  it.each([
    'CREATE INDEX CONCURRENTLY orders_customer_email_idx ON orders (customer_email);',
    'CREATE INDEX CONCURRENTLY ON orders(customer_email)',
    'create index concurrently if not exists idx_orders_email on public.orders using btree (customer_email);',
    'CREATE INDEX CONCURRENTLY idx_x ON orders ( customer_email );',
    'CREATE INDEX CONCURRENTLY idx_x ON shop.orders USING BTREE (customer_email) ;',
  ])('credits %s', (c) => expect(credit(c)?.id).toBe('index-concurrently'))
  it.each([
    'CREATE INDEX orders_customer_email_idx ON orders (customer_email);',
    'create index on public.orders (customer_email)',
  ])('plain build is wrong: %s', (c) => expect(credit(c)).toMatchObject({ id: 'index-plain', kind: 'wrong' }))
  it.each([
    'CREATE INDEX CONCURRENTLY ON orders (customer_email, total);',
    'CREATE INDEX CONCURRENTLY ON orders (total);',
    'CREATE INDEX CONCURRENTLY ON orders (customer_email); DROP TABLE orders;',
    'CREATE INDEX CONCURRENTLY ON customers (customer_email);',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS ON orders (customer_email);',
  ])('does not credit %s', (c) => expect(credit(c)?.id).not.toBe('index-concurrently'))
})

describe('pgbouncer-transaction-pooling-major unique index', () => {
  const { credit, sc } = load('pgbouncer-transaction-pooling-major')
  it('needs the refund step and the index', () => expect(sc.stages!.at(-1)!.solution_paths).toEqual([['void-and-refund', 'unique-index']]))
  const W = `WHERE status <> 'void'`
  it.each([
    `CREATE UNIQUE INDEX CONCURRENTLY ON invoices (customer_id, period) ${W};`,
    `psql -d billing -c "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS inv_uq ON public.invoices (customer_id,period) ${W}"`,
    `create unique index concurrently on invoices (customer_id, period) where status != 'void'`,
    `psql -d billing -Atc "CREATE UNIQUE INDEX CONCURRENTLY Inv_UQ ON invoices (customer_id, period) WHERE (status <> 'void')"`,
  ])('credits %s', (c) => expect(credit(c)?.id).toBe('unique-index'))
  it.each([
    `CREATE UNIQUE INDEX ON invoices (customer_id, period) ${W};`,
    `CREATE UNIQUE INDEX ON invoices (customer_id, period);`,
    `CREATE UNIQUE INDEX CONCURRENTLY ON invoices (customer_id, period);`,
  ])('is wrong: %s', (c) => expect(credit(c)).toMatchObject({ id: 'unique-now', kind: 'wrong' }))
  it.each([
    `CREATE UNIQUE INDEX CONCURRENTLY ON invoices (customer_id) ${W};`,
    `CREATE UNIQUE INDEX CONCURRENTLY ON invoices (customer_id, period) ${W}; DELETE FROM invoices;`,
    `CREATE UNIQUE INDEX CONCURRENTLY ON invoices (customer_id, period) ${W}"`,
    `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ON invoices (customer_id, period) ${W}`,
    `CREATE UNIQUE INDEX CONCURRENTLY ON invoices (customer_id, period) WHERE (status <> 'void';`,
  ])('does not credit %s', (c) => expect(credit(c)?.id).not.toBe('unique-index'))
})

describe('required solution paths', () => {
  it.each([
    ['postgres-listen-localhost', [['listen', 'hba', 'tls']]],
    ['postgres-pitr-accidental-delete', [['restore-side', 'copy-back', 'lockdown-restore', 'least-priv-cleanup']]],
    ['postgres-replica-read-after-write', [['read-your-writes', 'lag-alert']]],
    ['oidc-environment-subject', [['trust-environment', 'restrict-environment']]],
    ['github-token-permissions', [['job-permissions', 'org-default-read']]],
    ['fork-pr-secrets', [['skip-for-forks', 'permissions-block', 'reviewed-run']]],
  ])('%s', (id, paths) => expect(load(id).sc.solution_paths).toEqual(paths))
})

// Behavioural: the weak or partial routes do not finish the scenario on their own.
describe('weak routes do not complete', () => {
  const done = (id: string, taken: string[]) => {
    const { sc } = load(id)
    return sc.solution_paths.some((p) => p.every((a) => taken.includes(a)))
  }
  it.each([
    ['postgres-too-many-clients', ['smaller-pool']],
    ['postgres-too-many-clients', ['pooler']],
    ['postgres-lock-queue', ['cancel-migration', 'migration-lock-timeout', 'analyst-timeout', 'analyst-replica']],
    ['oidc-environment-subject', ['trust-environment']],
    ['fork-pr-secrets', ['skip-for-forks']],
    ['github-token-permissions', ['job-permissions']],
    ['postgres-listen-localhost', ['listen', 'hba']],
    ['postgres-pitr-accidental-delete', ['restore-side', 'copy-back']],
    ['postgres-replica-read-after-write', ['read-your-writes']],
  ])('%s with only %j is not done', (id, taken) => expect(done(id, taken)).toBe(false))
  it('a typed one-second analyst timeout is not the fix', () => {
    const { sc } = load('postgres-lock-queue')
    expect(actionFor(sc, "ALTER ROLE analyst2 SET idle_in_transaction_session_timeout = '1s';")?.id).toBe('analyst-timeout-short')
  })
})
