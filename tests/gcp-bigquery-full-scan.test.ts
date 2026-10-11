import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('gcp-bigquery-full-scan')
describe('gcp-bigquery-full-scan', () => {
  it('requires filter, table guard and a bytes cap', () => {
    expect(sc.solution_paths).toEqual([['filter-dashboard', 'require-filter', 'cap-bytes']])
  })
  it('credits valid spellings only', () => {
    for (const l of ['bq update --require_partition_filter analytics.events', 'bq update --require_partition_filter=true shop-analytics:analytics.events', 'bq update --require_partition_filter shop-analytics.analytics.events'])
      expect(credit(l)?.id).toBe('require-filter')
    for (const l of ['bq update --require_partition_filter=false analytics.events', 'bq update --require_partition_filter analytics.events; bq rm -f analytics.events', 'bq update --require_partition_filter other.events'])
      expect(credit(l)).toBeUndefined()
  })
})
