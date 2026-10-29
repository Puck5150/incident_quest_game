// The design sandbox, as pure functions: turning a sandbox file into a
// challenge the canvas engine understands, building the menu of failure checks
// from what the design actually contains, and validating a design against a
// cloud's palette and lanes (used on import and when a saved design is opened).
//
// No scoring: a check shows what survives and why.

import { USERS } from '../schema/constants.ts'
import type { CanvasTest, Design } from '../schema/canvas.ts'
import type { SandboxChallenge, SandboxFile } from '../schema/sandbox.ts'
import type { CanvasChallenge } from '../schema/canvas.ts'
import { evaluateCanvas, type CanvasTestResult } from './canvas.ts'
import { connect, lanes } from './canvasEdit.ts'

export const SANDBOX_MAX_NODES = 40
export const SPIKE = 3 // the traffic-spike check: this many times normal traffic
export const READ_HIT = 0.9 // scenario number: the share of reads a live, linked cache answers
export const DB_READS = 1 // scenario number: the most reads the database can take, in multiples of normal
export const EDGE_SHARE = 0.5 // scenario number: the share of requests that are cacheable GETs
export const EDGE_HIT = 0.9 // scenario number: the share of those a live, caching edge answers

// Returns an error message when the file can't extend the base.
export function resolveSandbox(f: SandboxFile, base: CanvasChallenge): SandboxChallenge | string {
  if (base.provider !== f.provider) return `extends "${base.id}", which is a ${base.provider} challenge, not ${f.provider}`
  const taken = new Set(base.palette.map((p) => p.id))
  const clash = f.palette.find((p, i) => taken.has(p.id) || f.palette.findIndex((q) => q.id === p.id) !== i)
  if (clash) return `palette id "${clash.id}" is already in ${base.id}'s palette or repeated`
  const overlays = f.overlays ?? []
  for (const [i, o] of overlays.entries()) {
    const p = base.palette.find((x) => x.id === o.id)
    if (!p) return `overlay "${o.id}" is not in ${base.id}'s palette`
    if (overlays.findIndex((q) => q.id === o.id) !== i) return `overlay "${o.id}" appears more than once`
    if (p.caching) return `${o.id} already has a caching setting`
    if (!p.roles.includes('route')) return `${o.id} isn't a route part, so it can't have a caching setting`
  }
  const basePalette = base.palette.map((p) => {
    const o = overlays.find((x) => x.id === p.id)
    return o ? { ...p, caching: o.caching } : p
  })
  return {
    type: 'challenge',
    mode: 'canvas',
    id: f.id,
    track: base.track,
    difficulty: 1,
    title: f.title,
    provider: f.provider,
    par_minutes: 1,
    brief: 'A free-form sandbox: build anything, then run the checks.',
    requirements: ['No requirements: the checks show what survives and why.'],
    budget: 1_000_000,
    layout: f.layout,
    palette: [...basePalette, ...f.palette],
    link_facts: base.link_facts,
    stress_tests: [],
    reference_designs: [],
    counter_examples: [],
    hints: base.hints,
    analogy: base.analogy,
    debrief: base.debrief,
    sources: [...base.sources, ...f.sources],
    max_nodes: SANDBOX_MAX_NODES,
  }
}

const rolesOf = (c: SandboxChallenge, type: string) => c.palette.find((p) => p.id === type)?.roles ?? []
const hasRole = (c: SandboxChallenge, d: Design, role: string) => d.nodes.some((n) => rolesOf(c, n.type).includes(role as never))

// Reads are judged only when the design has a cache, a web server and a database.
// Without all three a cache is inert: treated as a neutral part is, so such a
// design gets exactly the checks and results it always has.
// The edge rule applies when the design has a part with a caching setting and a web server to relieve.
export const edgeJudged = (c: SandboxChallenge, d: Design) =>
  d.nodes.some((n) => c.palette.find((p) => p.id === n.type)?.caching) && hasRole(c, d, 'serve')

export const readsJudged = (c: SandboxChallenge, d: Design) => hasRole(c, d, 'cache') && hasRole(c, d, 'serve') && hasRole(c, d, 'write-store')

const isNeutral = (c: SandboxChallenge, type: string, reads: boolean) => {
  const roles = rolesOf(c, type)
  return roles.length > 0 && roles.every((r) => r === 'neutral' || (r === 'cache' && !reads))
}

// The checks on offer for this design. Only roles the design contains are
// required, so a design with no database isn't failed for lacking one; a design
// with nothing the engine judges (no web server, no database) gets no checks,
// because every one would pass without meaning anything.
export function sandboxChecks(c: SandboxChallenge, d: Design): CanvasTest[] {
  const has = (role: 'serve' | 'write-store') => hasRole(c, d, role)
  const reach = (['serve', 'write-store'] as const).filter(has)
  if (!reach.length) return []
  const reads = readsJudged(c, d)
  const check = { reach, ...(reads && { read_load: { traffic: SPIKE, hit: READ_HIT, db_capacity: DB_READS } }) }
  const note = reads ? `, reads at ${SPIKE}×` : ''
  const occupied = (lane: string) => d.nodes.some((n) => n.lane === lane && !isNeutral(c, n.type, reads)) // neutral parts don't make a zone worth testing
  const label = (type: string) => c.palette.find((p) => p.id === type)?.label ?? type
  const judged = [...new Set(d.nodes.filter((n) => !isNeutral(c, n.type, reads) && rolesOf(c, n.type).length > 0).map((n) => n.type))]

  const tests: CanvasTest[] = [
    ...c.layout.regions.flatMap((r) => r.zones).filter((z) => occupied(z.id)).map((z): CanvasTest => ({ id: `zone-${z.id}`, label: `Lose ${z.label}${note}`, event: { zone_outage: z.id }, check })),
    ...c.layout.regions
      .filter((r) => occupied(r.id) || r.zones.some((z) => occupied(z.id)))
      .map((r): CanvasTest => ({ id: `region-${r.id}`, label: `Lose region ${r.label}${note}`, event: { region_outage: r.id }, check })),
    ...judged.map((t): CanvasTest => ({ id: `one-${t}`, label: `Lose any one ${label(t)}${note}`, event: { single_failure: t }, check })),
  ]
  if (has('serve'))
    tests.push({ id: 'spike', label: `Traffic spike: ${SPIKE}× normal`, event: { none: true }, check: { ...check, capacity: SPIKE, ...(edgeJudged(c, d) && { edge_load: { share: EDGE_SHARE, hit: EDGE_HIT } }) } })
  return tests
}

// The engine knows nothing of neutral parts, so judge a copy with every neutral
// part contracted away: each traffic path from users or a judged part through
// one or more neutral parts to a judged part becomes a direct link, and every
// other link touching a neutral part is dropped. A queue, CDN or bucket
// therefore behaves exactly as if the link ran straight through it (or, hanging
// off a server, as if it weren't there). A cache does too only while it is inert
// (no web server or no database); otherwise readsJudged applies the read checks.
function withoutNeutral(c: SandboxChallenge, d: Design): Design {
  const reads = readsJudged(c, d)
  const neutral = new Set(d.nodes.filter((n) => isNeutral(c, n.type, reads)).map((n) => n.id))
  const edges = d.edges.filter((e) => !neutral.has(e.from) && !neutral.has(e.to))
  const seen = new Set(edges.map((e) => `${e.from}>${e.to}>${e.kind}`))
  for (const start of [USERS, ...d.nodes.filter((n) => !neutral.has(n.id)).map((n) => n.id)]) {
    const visited = new Set<string>()
    const stack = [start]
    while (stack.length) {
      const from = stack.pop()!
      for (const e of d.edges) {
        if (e.kind !== 'traffic' || e.from !== from) continue
        if (neutral.has(e.to)) {
          if (!visited.has(e.to)) {
            visited.add(e.to)
            stack.push(e.to)
          }
        } else if (from !== start && e.to !== start && !seen.has(`${start}>${e.to}>traffic`)) {
          seen.add(`${start}>${e.to}>traffic`)
          edges.push({ from: start, to: e.to, kind: 'traffic' })
        }
      }
    }
  }
  return { nodes: d.nodes.filter((n) => !neutral.has(n.id)), edges }
}

// Runs one check. The engine fails every occupied zone that no zone test names
// (so a design can't hide in an unlisted zone); passing the whole generated
// menu names every occupied zone, so a single zone check reports only its zone.
export function runCheck(c: SandboxChallenge, d: Design, testId: string): CanvasTestResult | undefined {
  const judged = withoutNeutral(c, d)
  return evaluateCanvas({ ...c, stress_tests: sandboxChecks(c, d) }, judged).tests.find((t) => t.id === testId)
}

// The first reason this design couldn't have been built in this cloud's editor, or undefined.
export function validateDesign(c: SandboxChallenge, d: Design): string | undefined {
  if (d.nodes.length > c.max_nodes) return `A design can have at most ${c.max_nodes} components.`
  const palette = new Map(c.palette.map((p) => [p.id, p]))
  const laneScope = new Map(lanes(c).map((l) => [l.id, l.scope]))
  const ids = new Set<string>()
  for (const n of d.nodes) {
    if (!n.id) return "A component id can't be empty."
    if (n.id === USERS) return `"${USERS}" is reserved and can't be a component id.`
    if (ids.has(n.id)) return `Duplicate component id "${n.id}".`
    ids.add(n.id)
    const p = palette.get(n.type)
    if (!p) return `"${n.id}" is a ${n.type}, which isn't in this cloud's palette.`
    if (laneScope.get(n.lane) !== p.scope) return `${n.id} (${p.label}) can't go in lane "${n.lane}".`
  }
  // Replay the links through the editor's own rules, so import can't admit a design the editor refuses.
  let built: Design = { nodes: d.nodes, edges: [] }
  for (const e of d.edges) {
    if (e.from !== USERS && !ids.has(e.from)) return `A link starts at "${e.from}", which isn't in the design.`
    if (!ids.has(e.to)) return `A link ends at "${e.to}", which isn't in the design.`
    const next = connect(c, built, e.from, e.to, e.kind)
    if (typeof next === 'string') return next
    built = next
  }
}
