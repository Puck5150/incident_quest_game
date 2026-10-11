// Judges a typed `aws iam put-role-policy` line by PARSING it, so a fix is credited only for the
// least-privilege grant and a lookalike cannot hide behind a loose regex. Hard-wired to that one
// command and to service-prefixed IAM action names ("rds:CreateDBInstance").
// Evasion rules: every token outside the policy document must be plain (no shell expansion of any
// kind), the document may not repeat a key, and names are compared in ASCII lowercase.
export interface IamPolicySpec {
  role: string
  profile: string
  reserved_policy: string // an existing policy whose name must not be reused (put-role-policy replaces it)
  allowed_actions: string[] // the union of Allow actions must stay inside this set (ASCII case-insensitive)
  required_actions: string[]
  resource: string // every statement's Resource is exactly this ARN
}
// ok: the least-privilege grant. wildcard / overwrite: flagged wrong routes. null: not a verdict (another command, or not credited).
export type IamVerdict = 'ok' | 'wildcard' | 'overwrite'

export const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))

interface Word {
  text: string
  plain: boolean // false if any part could be expanded or rewritten by a real shell
  dqEscape: boolean // had a backslash inside double quotes (fine only in the policy document)
}

// Split like a POSIX shell for the simple cases: '…' literal, "…" with \" and \\ escapes, bare words.
// Unquoted text outside [A-Za-z0-9_.:/=@+,-] and "$ ` in double quotes mark the word as not plain.
// Returns undefined for an unterminated quote.
function words(line: string): Word[] | undefined {
  const out: Word[] = []
  let w: Word | undefined
  const add = (t: string, plain: boolean, dqEscape = false) => {
    w ??= { text: '', plain: true, dqEscape: false }
    w.text += t
    w.plain &&= plain
    w.dqEscape ||= dqEscape
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'" || c === '"') {
      const end = c === "'" ? line.indexOf("'", i + 1) : closing(line, i + 1)
      if (end < 0) return undefined
      const body = line.slice(i + 1, end)
      if (c === "'") add(body, true)
      else add(body.replace(/\\(["\\$`])/g, '$1'), !/[$`]/.test(body.replace(/\\[$`]/g, '')), body.includes('\\'))
      i = end
    } else if (/\s/.test(c)) {
      if (w) out.push(w)
      w = undefined
    } else add(c, /[A-Za-z0-9_.:/=@+,-]/.test(c))
  }
  if (w) out.push(w)
  return out
}
function closing(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === '"') return i
  }
  return -1
}

// True if any object in the raw JSON text repeats a key (JSON.parse would silently keep the last).
function hasDuplicateKeys(raw: string): boolean {
  const stack: (Set<string> | null)[] = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '{') stack.push(new Set())
    else if (c === '[') stack.push(null)
    else if (c === '}' || c === ']') stack.pop()
    else if (c === '"') {
      let j = i + 1
      while (j < raw.length && raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1
      const lit = raw.slice(i, j + 1)
      i = j
      const top = stack[stack.length - 1]
      if (top && /^\s*:/.test(raw.slice(j + 1))) {
        const key = JSON.parse(lit) as string
        if (top.has(key)) return true
        top.add(key)
      }
    }
  }
  return false
}

// Principal exactly "*", or its real spellings {"AWS":"*"} / {"AWS":["*"]}.
const isStarPrincipal = (p: unknown) =>
  p === '*' || (typeof p === 'object' && p !== null && !Array.isArray(p) && Object.keys(p).length === 1 && (p as Record<string, unknown>).AWS !== undefined && strings((p as Record<string, unknown>).AWS)?.length === 1 && strings((p as Record<string, unknown>).AWS)![0] === '*')

const strings = (v: unknown): string[] | undefined => (typeof v === 'string' ? [v] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined)

export function iamPolicyVerdict(input: string, spec: IamPolicySpec): IamVerdict | null {
  const line = input.trim().replace(/\s+/g, ' ')
  const ws = words(line)
  if (!ws) return null
  let at = 0
  let profile: string | undefined
  while (/^[A-Za-z_]\w*=/.test(ws[at]?.text ?? '')) {
    const [k, ...v] = ws[at].text.split('=')
    if (k !== 'AWS_PROFILE' || !ws[at].plain) return null
    profile = v.join('=')
    at++
  }
  if (ws[at]?.text !== 'aws') return null
  const rest = ws.slice(at + 1)
  const opts = new Map<string, string>()
  const pos: string[] = []
  let loose = false // a word a shell could expand or rewrite, or a stray escape outside the policy document
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i]
    const m = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(f.text)
    if (!m) {
      pos.push(f.text)
      loose ||= !f.plain || f.dqEscape
      continue
    }
    const val = m[2] !== undefined ? f : rest[++i]
    opts.set(m[1], m[2] ?? val?.text ?? '')
    loose ||= !f.plain || !(val?.plain ?? true) || (m[1] !== 'policy-document' && !!val?.dqEscape)
  }
  if (opts.has('profile')) profile = opts.get('profile')
  if (profile !== spec.profile || pos.slice(0, 2).join(' ') !== 'iam put-role-policy' || opts.get('role-name') !== spec.role) return null
  const doc = opts.get('policy-document') ?? ''
  const name = opts.get('policy-name') ?? ''
  // The weak routes are judged first, on the raw text, in ASCII lowercase.
  if (asciiLower(name) === asciiLower(spec.reserved_policy)) return loose ? null : 'overwrite'
  if (doc.includes('*')) return 'wildcard' // linear: a '*' outside a string is invalid JSON anyway
  if (loose || !name) return null
  // Anything else on the line (a second command, substitution, redirection) is never credited.
  if (/[;&|`<>]|\$\(/.test(line.replace(doc, '')) || /[`]|\$\(/.test(doc) || pos.length > 2 || rest.some((x) => x.text === 'aws') || ws.slice(0, at).length > 1) return null
  if (!doc.startsWith('{') || hasDuplicateKeys(doc)) return null
  let j: unknown
  try {
    j = JSON.parse(doc)
  } catch {
    return null
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return null
  const top = j as Record<string, unknown>
  if (Object.keys(top).some((k) => !['Version', 'Statement', 'Id'].includes(k)) || (top.Version !== undefined && top.Version !== '2012-10-17')) return null
  const stmts = top.Statement
  const list = Array.isArray(stmts) ? stmts : stmts === undefined ? [] : [stmts]
  if (!list.length) return null
  const allowed = new Set(spec.allowed_actions.map(asciiLower))
  const seen = new Set<string>()
  for (const s of list) {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return null
    const st = s as Record<string, unknown>
    if (Object.keys(st).some((k) => !['Sid', 'Effect', 'Action', 'Resource', 'Condition'].includes(k))) return null // also rejects NotAction, NotResource, Principal
    const actions = strings(st.Action)
    const res = strings(st.Resource)
    if (st.Effect !== 'Allow' || !actions?.length || res?.length !== 1 || res[0] !== spec.resource) return null
    for (const a of actions) {
      if (!allowed.has(asciiLower(a))) return null
      seen.add(asciiLower(a))
    }
  }
  return spec.required_actions.every((a) => seen.has(asciiLower(a))) ? 'ok' : null
}

// ---- VPC endpoint policy (`aws ec2 modify-vpc-endpoint --policy-document '<json>'`) -------------
// Same tokenizer and evasion rules as above. ok: every statement is Effect Allow, Principal exactly "*"
// (endpoint policies require one), Action inside allowed_actions (and required_actions all present),
// every Resource an S3 ARN of a bucket named <bucket_prefix>… (a trailing "*" in the bucket name is the
// prefix wildcard; objects only as "/*"). broad: a parseable document that is anything else (a Deny,
// a "*" action or resource, another bucket, extra keys). null: not this command, a file:// document
// (cannot be read here), a malformed document, or any shell trick.
export interface EndpointPolicySpec {
  endpoint_id: string
  allowed_actions: string[]
  required_actions: string[]
  bucket_prefix: string // e.g. "acme-media-"
}
export type EndpointVerdict = 'ok' | 'broad'

export function endpointPolicyVerdict(input: string, spec: EndpointPolicySpec): EndpointVerdict | null {
  const line = input.trim().replace(/\s+/g, ' ')
  const ws = words(line)
  if (ws?.[0]?.text !== 'aws') return null
  const rest = ws.slice(1)
  const opts = new Map<string, string>()
  const pos: string[] = []
  let loose = false
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i]
    const m = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(f.text)
    if (!m) {
      pos.push(f.text)
      loose ||= !f.plain || f.dqEscape
      continue
    }
    const val = m[2] !== undefined ? f : rest[++i]
    if (opts.has(m[1])) return null // a repeated flag
    opts.set(m[1], m[2] ?? val?.text ?? '')
    loose ||= !f.plain || !(val?.plain ?? true) || (m[1] !== 'policy-document' && !!val?.dqEscape)
  }
  if (pos.join(' ') !== 'ec2 modify-vpc-endpoint' || opts.get('vpc-endpoint-id') !== spec.endpoint_id) return null
  if ([...opts.keys()].some((k) => !['vpc-endpoint-id', 'policy-document', 'region'].includes(k)) || (opts.has('region') && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(opts.get('region')!))) return null
  const doc = opts.get('policy-document') ?? ''
  if (loose || /[`]|\$\(/.test(doc) || /[;&|`<>]|\$\(/.test(line.replace(doc, '')) || rest.some((x) => x.text === 'aws')) return null
  if (!doc.startsWith('{') || hasDuplicateKeys(doc)) return null
  let j: unknown
  try {
    j = JSON.parse(doc)
  } catch {
    return null
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return null
  const top = j as Record<string, unknown>
  if (Object.keys(top).some((k) => !['Version', 'Statement', 'Id'].includes(k)) || (top.Version !== undefined && top.Version !== '2012-10-17' && top.Version !== '2008-10-17')) return 'broad'
  const stmts = top.Statement
  const list = Array.isArray(stmts) ? stmts : stmts === undefined ? [] : [stmts]
  if (!list.length) return 'broad'
  const allowed = new Set(spec.allowed_actions.map(asciiLower))
  const bucket = new RegExp(`^arn:aws:s3:::${spec.bucket_prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\*|[a-z0-9][a-z0-9.-]*[a-z0-9])(/\\*)?$`)
  const seen = new Set<string>()
  for (const s of list) {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return 'broad'
    const st = s as Record<string, unknown>
    if (Object.keys(st).some((k) => !['Sid', 'Effect', 'Principal', 'Action', 'Resource', 'Condition'].includes(k))) return 'broad' // NotAction, NotResource, NotPrincipal
    const actions = strings(st.Action)
    const res = strings(st.Resource)
    if (st.Effect !== 'Allow' || !isStarPrincipal(st.Principal) || !actions?.length || !res?.length || !res.every((r) => bucket.test(r))) return 'broad'
    for (const a of actions) {
      if (!allowed.has(asciiLower(a))) return 'broad'
      seen.add(asciiLower(a))
    }
  }
  return spec.required_actions.every((a) => seen.has(asciiLower(a))) ? 'ok' : 'broad'
}
