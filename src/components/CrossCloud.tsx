import { PROVIDER_NAMES, type Provider } from '../schema/multi.ts'
import Card from './Card.tsx'

export type CrossCloud = {
  current: Provider
  providers: Provider[]
  rows: { id: string; tier?: string; names: Partial<Record<Provider, string>>; differences: string }[]
  sources: Partial<Record<Provider, { title: string; url: string }[]>>
}

// "Same design on other clouds": each part of the design next to its
// equivalents, with the authored note on what isn't equivalent.
export default function CrossCloudCard({ data }: { data: CrossCloud }) {
  const { current, providers, rows, sources } = data
  return (
    <Card title="Same design on other clouds">
      {/* Phones: one block per part, so the differences notes stay readable. */}
      <ul className="space-y-4 sm:hidden">
        {rows.map((r) => (
          <li key={r.id} className="border-b border-line pb-3 text-sm last:border-0">
            {r.tier && <p className="text-muted">{r.tier}</p>}
            <dl className="mt-1 space-y-0.5">
              {providers.map((p) => (
                <div key={p} className="flex gap-2">
                  <dt className={`w-24 shrink-0 ${p === current ? 'text-accent' : 'text-muted'}`}>{PROVIDER_NAMES[p]}</dt>
                  <dd className={p === current ? 'font-medium' : ''}>{r.names[p]}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-1.5 text-xs text-muted">
              <span className="font-medium">Differences: </span>
              {r.differences}
            </p>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-muted">
              {rows.some((r) => r.tier) && <th className="py-1.5 pr-3 font-normal">Tier</th>}
              {providers.map((p) => (
                <th key={p} className={`py-1.5 pr-3 font-normal ${p === current ? 'text-accent' : ''}`}>
                  {PROVIDER_NAMES[p]}
                  {p === current && (
                    <>
                      {' '}
                      <span className="text-xs">(you)</span>
                    </>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <FragmentRows key={r.id} row={r} providers={providers} current={current} withTier={rows.some((x) => x.tier)} />
            ))}
          </tbody>
        </table>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted">Docs for each cloud</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {providers.map((p) => (
            <div key={p}>
              <h3 className="font-medium">{PROVIDER_NAMES[p]}</h3>
              <ul className="mt-1 space-y-1">
                {(sources[p] ?? []).map((s) => (
                  <li key={s.url}>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${s.title} (opens in a new tab)`}
                      className="text-accent underline underline-offset-2"
                    >
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </details>
    </Card>
  )
}

function FragmentRows({
  row,
  providers,
  current,
  withTier,
}: {
  row: CrossCloud['rows'][number]
  providers: Provider[]
  current: Provider
  withTier: boolean
}) {
  return (
    <>
      <tr>
        {withTier && <td className="pt-2 pr-3 text-muted">{row.tier}</td>}
        {providers.map((p) => (
          <td key={p} className={`pt-2 pr-3 ${p === current ? 'font-medium' : ''}`}>
            {row.names[p]}
          </td>
        ))}
      </tr>
      <tr className="border-b border-line">
        <td colSpan={providers.length + (withTier ? 1 : 0)} className="pb-2 text-xs text-muted">
          <span className="font-medium">Differences: </span>
          {row.differences}
        </td>
      </tr>
    </>
  )
}
