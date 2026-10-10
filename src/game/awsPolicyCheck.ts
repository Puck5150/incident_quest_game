// Judges a typed `aws iam put-role-policy` line by PARSING its --policy-document, so a fix is
// credited only for the least-privilege grant and a lookalike (extra actions, extra statements,
// a second command, a wildcard in any case) cannot hide behind a loose regex.
export interface IamPolicySpec {
  role: string
  profile: string
  reserved_policy: string // an existing policy whose name must not be reused (put-role-policy replaces it)
  allowed_actions: string[] // the union of Allow actions must stay inside this set (case-insensitive)
  required_actions: string[]
  resource: string // every statement's Resource is exactly this ARN
}
// ok: the least-privilege grant. wildcard / overwrite: flagged wrong routes. null: not a verdict (other command, or not credited).
export type IamVerdict = 'ok' | 'wildcard' | 'overwrite'

// Split like a POSIX shell for the simple cases: '…' literal, "…" with \" and \\ escapes, bare words.
// Returns undefined for an unterminated quote.
function words(line: string): string[] | undefined {
  const out: string[] = []
  let cur = ''
  let has = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'" || c === '"') {
      const end = c === "'" ? line.indexOf("'", i + 1) : closing(line, i + 1)
      if (end < 0) return undefined
      const body = line.slice(i + 1, end)
      cur += c === '"' ? body.replace(/\\(["\\$`])/g, '$1') : body
      has = true
      i = end
    } else if (/\s/.test(c)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (has) out.push(cur)
  return out
}
function closing(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === '"') return i
  }
  return -1
}

const strings = (v: unknown): string[] | undefined => (typeof v === 'string' ? [v] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined)

export function iamPolicyVerdict(input: string, spec: IamPolicySpec): IamVerdict | null {
  const line = input.trim().replace(/\s+/g, ' ')
  const w = words(line)
  if (!w) return null
  let at = 0
  let profile: string | undefined
  while (/^[A-Za-z_]\w*=/.test(w[at] ?? '')) {
    const [k, ...v] = w[at].split('=')
    if (k !== 'AWS_PROFILE') return null
    profile = v.join('=')
    at++
  }
  if (w[at] !== 'aws') return null
  const rest = w.slice(at + 1)
  const opts = new Map<string, string>()
  const pos: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(rest[i])
    if (!m) pos.push(rest[i])
    else if (m[2] !== undefined) opts.set(m[1], m[2])
    else opts.set(m[1], rest[++i] ?? '')
  }
  if (opts.has('profile')) profile = opts.get('profile')
  if (profile !== spec.profile || pos.slice(0, 2).join(' ') !== 'iam put-role-policy' || opts.get('role-name') !== spec.role) return null
  const doc = opts.get('policy-document') ?? ''
  const name = opts.get('policy-name') ?? ''
  // The weak routes are judged first, on the raw text, case-insensitively.
  if (name.toLowerCase() === spec.reserved_policy.toLowerCase()) return 'overwrite'
  if (/"[^"]*\*[^"]*"/.test(doc)) return 'wildcard'
  // Anything else on the line (a second command, substitution) is never credited.
  if (/[;&|`<>]|\$\(/.test(line.replace(doc, '')) || /[`]|\$\(/.test(doc) || pos.length > 2 || rest.some((x) => x === 'aws') || w.slice(0, at).length > 1) return null
  if (!name || !doc.startsWith('{')) return null
  let j: unknown
  try {
    j = JSON.parse(doc)
  } catch {
    return null
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return null
  const stmts = (j as { Statement?: unknown }).Statement
  const list = Array.isArray(stmts) ? stmts : stmts === undefined ? [] : [stmts]
  if (!list.length) return null
  const allowed = new Set(spec.allowed_actions.map((a) => a.toLowerCase()))
  const seen = new Set<string>()
  for (const s of list) {
    if (typeof s !== 'object' || s === null) return null
    const st = s as Record<string, unknown>
    if (Object.keys(st).some((k) => !['Sid', 'Effect', 'Action', 'Resource', 'Condition'].includes(k))) return null // also rejects NotAction, NotResource, Principal
    const actions = strings(st.Action)
    const res = strings(st.Resource)
    if (st.Effect !== 'Allow' || !actions?.length || res?.length !== 1 || res[0] !== spec.resource) return null
    for (const a of actions) {
      if (!allowed.has(a.toLowerCase())) return null
      seen.add(a.toLowerCase())
    }
  }
  return spec.required_actions.every((a) => seen.has(a.toLowerCase())) ? 'ok' : null
}
