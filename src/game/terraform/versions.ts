// Versions and version constraints, following hashicorp/go-version v1.6.0 (what Terraform v1.9.8 uses for
// module and provider constraints). Pure; shared by registry modules and provider requirements.

export interface Version {
  major: number
  minor: number
  patch: number
  pre?: string
}

// 1 to 3 numeric segments, an optional prerelease and ignored build metadata (a leading "v" is accepted).
const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z~-]+(?:\.[0-9A-Za-z~-]+)*))?(?:\+[0-9A-Za-z~-]+(?:\.[0-9A-Za-z~-]+)*)?$/

interface Parsed extends Version {
  si: number // how many numeric segments were written (~> depends on it)
}

function parse(s: string): Parsed | undefined {
  const m = VERSION_RE.exec(s)
  if (!m) return undefined
  const nums = [m[1], m[2], m[3]]
  const si = nums.filter((n) => n !== undefined).length
  const [major, minor, patch] = nums.map((n) => (n === undefined ? 0 : Number(n)))
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined
  return { major, minor, patch, si, ...(m[4] === undefined ? {} : { pre: m[4] }) }
}

export function parseVersion(s: string): Version | undefined {
  const p = parse(s.trim())
  if (!p) return undefined
  const { si: _si, ...v } = p
  return v
}

export const formatVersion = (v: Version) => `${v.major}.${v.minor}.${v.patch}${v.pre === undefined ? '' : `-${v.pre}`}`

// Prerelease identifiers compare like semver: numeric < alphanumeric, numerics numerically, a shorter prefix is lower.
function comparePre(a: string, b: string): number {
  const x = a.split('.')
  const y = b.split('.')
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    const nx = /^\d+$/.test(x[i])
    const ny = /^\d+$/.test(y[i])
    if (nx && ny) return Number(x[i]) < Number(y[i]) ? -1 : 1
    if (nx !== ny) return nx ? -1 : 1
    return x[i] < y[i] ? -1 : 1
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1
}

export function compareVersions(a: Version, b: Version): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  if (a.pre === b.pre) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  return comparePre(a.pre, b.pre)
}

const OPS = ['>=', '<=', '!=', '~>', '=', '>', '<', ''] as const
type Op = (typeof OPS)[number]
interface Clause {
  op: Op
  v: Parsed
}
export const INVALID_CONSTRAINT = 'This string does not use correct version constraint syntax.'

function parseConstraint(constraint: string): Clause[] | undefined {
  const out: Clause[] = []
  for (const part of constraint.split(',')) {
    const t = part.trim()
    const op = OPS.find((o) => t.startsWith(o)) as Op
    const v = parse(t.slice(op.length).trim())
    if (!v) return undefined
    out.push({ op, v })
  }
  return out
}

// go-version prereleaseCheck: a prerelease only matches a constraint that names a prerelease of the same x.y.z.
const preOk = (v: Version, c: Version) => (v.pre !== undefined && c.pre !== undefined ? v.major === c.major && v.minor === c.minor && v.patch === c.patch : v.pre === undefined || c.pre !== undefined)

function check(v: Version, { op, v: c }: Clause): boolean {
  const cmp = compareVersions(v, c)
  switch (op) {
    case '':
    case '=':
      return cmp === 0
    case '!=':
      return cmp !== 0
    case '>':
      return preOk(v, c) && cmp > 0
    case '<':
      return preOk(v, c) && cmp < 0
    case '>=':
      return preOk(v, c) && cmp >= 0
    case '<=':
      return preOk(v, c) && cmp <= 0
    case '~>': {
      // go-version quirk, kept: the segments before the last written one must match and the last must be >=, so
      // "~> 5" has no upper bound ("~> 5.40" means >= 5.40, < 6.0 and "~> 5.40.1" means >= 5.40.1, < 5.41).
      if (!preOk(v, c) || (c.pre !== undefined && v.pre === undefined) || cmp < 0) return false
      const vs = [v.major, v.minor, v.patch]
      const cs = [c.major, c.minor, c.patch]
      for (let i = 0; i < c.si - 1; i++) if (vs[i] !== cs[i]) return false
      return cs[2] <= vs[2]
    }
  }
}

// Whether v meets every comma-separated clause. A prerelease version never matches unless a clause names a prerelease
// (this is also Terraform's module installer rule). An unparsable constraint gives ok:false and the error detail.
export function satisfies(v: Version, constraint: string): { ok: boolean; error?: string } {
  const cs = parseConstraint(constraint)
  if (!cs) return { ok: false, error: INVALID_CONSTRAINT }
  if (v.pre !== undefined && !cs.some((c) => c.v.pre !== undefined)) return { ok: false }
  return { ok: cs.every((c) => check(v, c)) }
}

export const isValidConstraint = (constraint: string) => parseConstraint(constraint) !== undefined

// The highest of `versions` (strings; unparsable ones are ignored) that meets the constraint, as written.
export function newestSatisfying(versions: string[], constraint: string): string | undefined {
  let best: { s: string; v: Version } | undefined
  for (const s of versions) {
    const v = parseVersion(s)
    if (!v || !satisfies(v, constraint).ok) continue
    if (!best || compareVersions(v, best.v) > 0) best = { s, v }
  }
  return best?.s
}
