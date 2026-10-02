// Checks every `url` in the shipped content (sources, per-provider sources,
// fact links) still resolves. Run with `npm run check-links`; CI runs it
// weekly and on PRs that touch content.

import dns from 'node:dns'
import path from 'node:path'
import { loadContent } from '../vite-plugin-content.ts'

// An honest bot user agent: rabbitmq.com rejects curl's and freedesktop.org
// rejects a faked browser one, but both accept this.
const UA = 'incident-quest-link-check/1.0 (+https://github.com/Puck5150/incident_quest_game)'
// Some networks have broken IPv6 routes to some hosts (gnu.org); IPv4 first avoids false failures.
dns.setDefaultResultOrder('ipv4first')

const urls = new Map<string, Set<string>>() // url -> items that cite it
const walk = (x: unknown, item: string) => {
  if (Array.isArray(x)) x.forEach((v) => walk(v, item))
  else if (x && typeof x === 'object')
    for (const [k, v] of Object.entries(x)) {
      if (k === 'url' && typeof v === 'string') urls.set(v, (urls.get(v) ?? new Set()).add(item))
      else walk(v, item)
    }
}
const c = loadContent(path.resolve(import.meta.dirname, '../content'))
for (const x of [...c.scenarios, ...c.challenges, ...c.canvases, ...c.multis]) walk(x, x.id)
for (const e of c.library) walk(e, `commands:${e.id}`) // the command breakdown library's docs links

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A link is broken only when the site says the page is gone (404, 410, other
// 4xx). Timeouts, 401/403, 429 and 5xx mean "couldn't tell from here": some
// docs sites block or throttle cloud runners' IP ranges. Those are warnings.
type Result = { broken?: string; unverified?: string }
const INCONCLUSIVE = new Set([401, 403, 429])

async function check(url: string): Promise<Result> {
  for (let attempt = 1; ; attempt++) {
    let retryAfter = 0
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      if (res.ok) return {}
      const inconclusive = INCONCLUSIVE.has(res.status) || res.status >= 500
      if (!inconclusive) return { broken: `HTTP ${res.status}` }
      if (attempt >= 4) return { unverified: `HTTP ${res.status}` }
      retryAfter = Number(res.headers.get('retry-after')) || 0
    } catch (e) {
      // fetch() hides the network error (DNS, reset, timeout) in `cause`.
      const err = e as Error & { cause?: { code?: string; message?: string } }
      if (attempt >= 4) return { unverified: err.cause?.code ?? err.cause?.message ?? err.message }
    }
    await sleep(Math.min(retryAfter * 1000 || 5000 * attempt, 60_000))
  }
}

// ponytail: fixed concurrency of 8, no per-host throttling; add it if a site starts rate-limiting.
const queue = [...urls.keys()]
const broken: string[] = []
const unverified: string[] = []
const line = (why: string, url: string) => `${why}  ${url}\n    cited by: ${[...urls.get(url)!].join(', ')}`
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const r = await check(url)
      if (r.broken) broken.push(line(r.broken, url))
      if (r.unverified) unverified.push(line(r.unverified, url))
    }
  }),
)

console.log(`Checked ${urls.size} links.`)
if (unverified.length) {
  console.warn(`\n${unverified.length} couldn't be verified from here (blocked, throttled or down; not failing):\n\n${unverified.sort().join('\n')}`)
  // Shows as a warning annotation on the GitHub Actions run.
  if (process.env.GITHUB_ACTIONS) console.log(`::warning::${unverified.length} source links couldn't be verified from the runner; see the log`)
}
if (broken.length) {
  console.error(`\n${broken.length} broken:\n\n${broken.sort().join('\n')}`)
  process.exit(1)
}
