// The canvas graph engine (PLAN_DESIGN_CANVAS.md §4), as pure functions.
//
// For each stress test: remove what the event kills, let synchronous standbys
// take over, then check that users can still reach what the test needs. Every
// failure comes with a plain-English reason built from the actual graph.

import { USERS } from '../schema/constants.ts'
import type { CanvasChallenge, CanvasTest, Design } from '../schema/canvas.ts'

export type CanvasTestResult = {
  id: string
  label: string
  pass: boolean
  reasons: string[]
  down: string[] // components lost in the scenario that failed (for highlighting)
}

export type CanvasEvaluation = {
  tests: CanvasTestResult[]
  cost: number
  withinBudget: boolean
  overkill: string[]
  pass: boolean
}

type Node = Design['nodes'][number]
const fmt = (x: number) => String(Number(x.toFixed(2)))

export function evaluateCanvas(c: CanvasChallenge, design: Design): CanvasEvaluation {
  const palette = new Map(c.palette.map((p) => [p.id, p]))
  const has = (n: Node, role: string) => palette.get(n.type)?.roles.includes(role as never) ?? false

  const tests = c.stress_tests.map((t): CanvasTestResult => {
    // Try every scenario the event implies; the test fails on the first bad one.
    for (const { removed, prefix } of scenarios(c, design, t)) {
      const reasons = check(c, design, removed, t, has)
      if (reasons.length) {
        return { id: t.id, label: t.label, pass: false, reasons: reasons.map((r) => prefix + r), down: [...removed] }
      }
    }
    return { id: t.id, label: t.label, pass: true, reasons: [], down: [] }
  })

  const cost = design.nodes.reduce((sum, n) => sum + (palette.get(n.type)?.cost ?? 0), 0)
  const types = [...new Set(design.nodes.map((n) => n.type))]
  const overkill = types.flatMap((t) => {
    const p = palette.get(t)
    return p?.overkill ? [`${p.label}: ${p.overkill}`] : []
  })
  return { tests, cost, withinBudget: cost <= c.budget, overkill, pass: tests.every((t) => t.pass) && cost <= c.budget }
}

// Which sets of components go down for a test's event.
function scenarios(c: CanvasChallenge, d: Design, t: CanvasTest): { removed: Set<string>; prefix: string }[] {
  const e = t.event
  const scopeOf = (n: Node) => c.palette.find((p) => p.id === n.type)?.scope
  if ('zone_outage' in e) {
    const lose = (zone: string) => new Set(d.nodes.filter((n) => n.lane === zone).map((n) => n.id))
    // A zone no stress test names is still a zone that can fail: a design that
    // hides everything in one (say, a second Region's lane) must not slip past.
    // Every zone_outage test therefore also fails each occupied, unnamed zone.
    const named = new Set(c.stress_tests.flatMap((x) => ('zone_outage' in x.event ? [x.event.zone_outage] : [])))
    const zoneList = c.layout.regions.flatMap((r) => r.zones)
    const extra = zoneList.map((z) => z.id).filter((z) => !named.has(z) && d.nodes.some((n) => n.lane === z))
    return [
      { removed: lose(e.zone_outage), prefix: '' },
      ...extra.map((z) => ({ removed: lose(z), prefix: `A zone you used but no test names (${zoneList.find((x) => x.id === z)!.label}) fails: ` })),
    ]
  }
  if ('region_outage' in e) {
    const region = c.layout.regions.find((r) => r.id === e.region_outage)!
    const zones = new Set(region.zones.map((z) => z.id))
    return [
      {
        removed: new Set(
          d.nodes.filter((n) => zones.has(n.lane) || (scopeOf(n) === 'regional' && n.lane === region.id)).map((n) => n.id),
        ),
        prefix: '',
      },
    ]
  }
  if ('single_failure' in e) {
    const candidates = d.nodes.filter((n) => n.type === e.single_failure)
    if (!candidates.length) return [{ removed: new Set(), prefix: '' }]
    return candidates.map((n) => ({ removed: new Set([n.id]), prefix: `If ${n.id} fails: ` }))
  }
  return [{ removed: new Set(), prefix: '' }]
}

// Returns reasons the check fails in this scenario (empty = pass).
function check(
  c: CanvasChallenge,
  d: Design,
  removed: Set<string>,
  t: CanvasTest,
  has: (n: Node, role: string) => boolean,
): string[] {
  const alive = (id: string) => id === USERS || !removed.has(id)
  const byId = new Map(d.nodes.map((n) => [n.id, n]))
  const type = (id: string) => c.palette.find((p) => p.id === byId.get(id)?.type)
  const needsEntry = c.palette.some((p) => p.roles.includes('route'))
  const reasons: string[] = []

  // Users may only talk to an entry point: never straight to a database, and
  // (when the palette offers a load balancer) never straight to a web server
  // unless that service has its own managed front end (`public`).
  const toDb: string[] = []
  const direct: string[] = []
  const traffic = d.edges.filter((e) => {
    if (e.kind !== 'traffic') return false
    if (e.from !== USERS) return true
    const n = byId.get(e.to)
    if (!n) return true
    if (has(n, 'write-store')) return void toDb.push(n.id), false
    if (needsEntry && !has(n, 'route') && !type(n.id)?.public) return void direct.push(n.id), false
    return true
  })
  if (toDb.length)
    reasons.push(`users connect straight to the database (${toDb.join(', ')}); keep it private and reach it only through the web tier.`)
  if (direct.length)
    reasons.push(`users connect straight to ${direct.join(', ')}; put a load balancer or other entry point in front.`)
  // The design is wrong before any failure: skip the downstream reachability noise.
  if (reasons.length) return reasons

  // Everything users can reach along traffic links, through surviving components.
  const reachable = new Set<string>([USERS])
  for (let grew = true; grew; ) {
    grew = false
    for (const e of traffic) {
      if (reachable.has(e.from) && alive(e.to) && !reachable.has(e.to)) {
        reachable.add(e.to)
        grew = true
      }
    }
  }

  const lost = (role: string) => d.nodes.filter((n) => has(n, role) && removed.has(n.id)).map((n) => n.id)

  if (t.check.reach.includes('serve')) {
    const servers = d.nodes.filter((n) => has(n, 'serve'))
    if (!servers.length) reasons.push('nothing in the design serves pages.')
    else if (!servers.some((n) => reachable.has(n.id))) {
      const gone = lost('serve')
      reasons.push(
        gone.length === servers.length
          ? `every web server was lost (${gone.join(', ')}).`
          : 'no surviving web server is connected to users.',
      )
    }
  }

  if (t.check.reach.includes('write-store')) {
    const r = writer(d, removed, has)
    if ('problem' in r) reasons.push(r.problem)
    else {
      // Apps connect to the database's endpoint. On failover it points at the
      // standby, so a traffic link to any member of the group reaches the writer.
      // Only a web server counts as the application; a load balancer linked to the database doesn't.
      const connected = traffic.some(
        (e) => r.endpoint.has(e.to) && reachable.has(e.from) && byId.has(e.from) && has(byId.get(e.from)!, 'serve'),
      )
      if (!connected) reasons.push(`nothing that users can reach is connected to the database (${r.writer}).`)
    }
  }

  // The servers that count: reachable, and able to reach whichever database
  // currently accepts writes (every reachable server, when the design has no database).
  const serversThatCount = () => {
    const stores = d.nodes.filter((n) => has(n, 'write-store')).map((n) => n.id)
    const w = writer(d, removed, has)
    const endpoint = 'problem' in w ? new Set(stores) : w.endpoint
    const reached = d.nodes.filter((n) => has(n, 'serve') && reachable.has(n.id))
    const serving = stores.length
      ? reached.filter((n) => traffic.some((e) => e.from === n.id && endpoint.has(e.to)))
      : reached
    return { w, reached, serving }
  }

  if (t.check.capacity !== undefined) {
    // A server only adds capacity if it can actually write to the database.
    const { reached, serving } = serversThatCount()
    const unlinked = reached.filter((n) => !serving.includes(n)).map((n) => n.id)
    const cap = serving.reduce((sum, n) => sum + (c.palette.find((p) => p.id === n.type)?.capacity ?? 0), 0)
    if (cap < t.check.capacity) {
      reasons.push(
        cap === 0
          ? `no serving capacity survives; ${t.check.capacity}× is needed.`
          : `only ${cap}× of the ${t.check.capacity}× traffic needed can be served (${serving.map((n) => n.id).join(', ')}).`,
      )
      if (unlinked.length) reasons.push(`${unlinked.join(', ')} can't reach the database, so they don't count as serving capacity.`)
    }
  }

  // Opt-in (check.read_load): the database's read load. The serving servers share the reads
  // equally; one linked to a surviving cache sends only the misses to the database. Skipped
  // when nothing serves or nothing can accept writes: the reasons above already failed that.
  const rl = t.check.read_load
  if (rl) {
    const { w, serving } = serversThatCount()
    if (!('problem' in w) && serving.length) {
      const caches = d.nodes.filter((n) => has(n, 'cache'))
      const live = new Set(caches.filter((n) => !removed.has(n.id)).map((n) => n.id))
      const open = serving.filter((n) => !traffic.some((e) => e.from === n.id && live.has(e.to)))
      const share = rl.traffic / serving.length
      const load = share * open.length + share * (serving.length - open.length) * (1 - rl.hit)
      if (load - rl.db_capacity > 1e-9) {
        const lost = caches.filter((n) => removed.has(n.id)).map((n) => n.id)
        const why = !caches.length
          ? 'there is no cache in the design'
          : lost.length === caches.length
            ? `${lost.join(', ')} ${lost.length > 1 ? 'were' : 'was'} lost`
            : `${open.map((n) => n.id).join(', ')} ${open.length > 1 ? 'are' : 'is'} not linked to a surviving cache`
        reasons.push(`${w.writer} would see ${fmt(load)}× normal reads but can take ${rl.db_capacity}× (${why}).`)
      }
    }
  }
  return reasons
}

// Who accepts writes after failures. The primary is the database nothing
// replicates *into*. A synchronous standby takes over automatically; an
// asynchronous replica doesn't (it needs manual promotion and may be missing
// recent writes).
function writer(
  d: Design,
  removed: Set<string>,
  has: (n: Node, role: string) => boolean,
): { writer: string; endpoint: Set<string> } | { problem: string } {
  const stores = d.nodes.filter((n) => has(n, 'write-store'))
  if (!stores.length) return { problem: 'there is no database for orders.' }
  const repl = d.edges.filter((e) => e.kind !== 'traffic')
  const primaries = stores.filter((s) => !repl.some((e) => e.to === s.id))
  if (primaries.length !== 1) {
    return {
      problem: `${primaries.length} separate databases with no replication between them: orders would be split across ${primaries
        .map((p) => p.id)
        .join(' and ')}.`,
    }
  }
  const primary = primaries[0].id
  const sync = repl.filter((e) => e.from === primary && e.kind === 'sync').map((e) => e.to)
  const async = repl.filter((e) => e.from === primary && e.kind === 'async').map((e) => e.to)
  const endpoint = new Set([primary, ...sync])

  if (!removed.has(primary)) return { writer: primary, endpoint }
  const standby = sync.find((s) => !removed.has(s))
  if (standby) return { writer: standby, endpoint }

  const survivingAsync = async.filter((a) => !removed.has(a))
  if (survivingAsync.length)
    return {
      problem: `${primary} was lost, and ${survivingAsync[0]} is an async replica: it needs manual promotion and could be missing recent writes.`,
    }
  if (sync.length) return { problem: `${primary} and its standby (${sync.join(', ')}) were both lost.` }
  return { problem: `${primary} was lost and has no standby, so nothing can accept writes.` }
}
