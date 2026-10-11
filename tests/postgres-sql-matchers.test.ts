import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

describe('postgres-missing-index', () => {
  const { credit } = load('postgres-missing-index')
  it.each([
    'CREATE INDEX CONCURRENTLY orders_customer_email_idx ON orders (customer_email);',
    'CREATE INDEX CONCURRENTLY ON orders(customer_email)',
    'create index concurrently if not exists idx_orders_email on public.orders using btree (customer_email);',
    'CREATE INDEX CONCURRENTLY idx_x ON orders ( customer_email );',
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
  ])('credits %s', (c) => expect(credit(c)?.id).toBe('unique-index'))
  it.each([
    `CREATE UNIQUE INDEX ON invoices (customer_id, period) ${W};`,
    `CREATE UNIQUE INDEX ON invoices (customer_id, period);`,
    `CREATE UNIQUE INDEX CONCURRENTLY ON invoices (customer_id, period);`,
  ])('is wrong: %s', (c) => expect(credit(c)).toMatchObject({ id: 'unique-now', kind: 'wrong' }))
  it.each([`CREATE UNIQUE INDEX CONCURRENTLY ON invoices (customer_id) ${W};`, `CREATE UNIQUE INDEX CONCURRENTLY ON invoices (customer_id, period) ${W}; DELETE FROM invoices;`])(
    'does not credit %s',
    (c) => expect(credit(c)?.id).not.toBe('unique-index'),
  )
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
