// The canvas graph engine (PLAN_DESIGN_CANVAS.md §4), as pure functions.
//
// For each stress test: remove what the event kills, let synchronous standbys
// take over, then check that users can still reach what the test needs. Every
// failure comes with a plain-English reason built from the actual graph.

import { USERS, type CanvasChallenge, type CanvasTest, type Design } from '../schema/canvas.ts'

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
    return [{ removed: new Set(d.nodes.filter((n) => n.lane === e.zone_outage).map((n) => n.id)), prefix: '' }]
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
  const traffic = d.edges.filter((e) => e.kind === 'traffic')

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

  const reasons: string[] = []
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
      const connected = traffic.some((e) => r.endpoint.has(e.to) && reachable.has(e.from) && e.from !== USERS)
      if (!connected) reasons.push(`nothing that users can reach is connected to the database (${r.writer}).`)
    }
  }

  if (t.check.capacity !== undefined) {
    const serving = d.nodes.filter((n) => has(n, 'serve') && reachable.has(n.id))
    const cap = serving.reduce((sum, n) => sum + (c.palette.find((p) => p.id === n.type)?.capacity ?? 0), 0)
    if (cap < t.check.capacity) {
      reasons.push(
        cap === 0
          ? `no serving capacity survives; ${t.check.capacity}× is needed.`
          : `only ${cap}× of the ${t.check.capacity}× traffic needed can be served (${serving.map((n) => n.id).join(', ')}).`,
      )
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
