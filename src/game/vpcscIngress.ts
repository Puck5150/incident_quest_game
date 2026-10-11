// Judges an ingress-policy file for a VPC Service Controls perimeter by PARSING it
// (a regex over YAML cannot tell a narrow rule from a lookalike). The file passes only if it is
// one YAML document holding exactly the `keep` policies unchanged plus the one `narrow` rule,
// every policy having exactly one identity, source, operation, method and target, and no other
// key anywhere. Aliases are refused, duplicate keys are a parse error, and the text is capped,
// so the cost stays linear in a small input.
import { parseAllDocuments } from 'yaml'

export interface IngressRule {
  identity: string
  source: string
  service: string
  method: string
  target: string
}
export interface IngressSpec {
  narrow: IngressRule
  keep?: IngressRule[] // policies already on the perimeter, which `--set-ingress-policies` would otherwise drop
}

export const MAX_INGRESS_FILE = 8000

const canon = (r: IngressRule) =>
  JSON.stringify({
    from: { identities: [r.identity], sources: [r.source] },
    to: { service: r.service, methods: [r.method], resources: [r.target] },
  })

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const only = (v: unknown, keys: string[]): v is Record<string, unknown> => isObj(v) && Object.keys(v).sort().join() === [...keys].sort().join()
const one = (v: unknown): unknown => (Array.isArray(v) && v.length === 1 ? v[0] : undefined)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

// One policy in the file, in the same canonical form as canon(), or undefined if it has any other shape.
function policy(p: unknown): string | undefined {
  if (!only(p, ['ingressFrom', 'ingressTo'])) return undefined
  const { ingressFrom: f, ingressTo: t } = p
  if (!only(f, ['identities', 'sources']) || !only(t, ['operations', 'resources'])) return undefined
  const src = one(f.sources)
  const op = one(t.operations)
  if (!only(src, ['resource']) || !only(op, ['serviceName', 'methodSelectors'])) return undefined
  const sel = one(op.methodSelectors)
  if (!only(sel, ['method'])) return undefined
  const [identity, source, service, method, target] = [str(one(f.identities)), str(src.resource), str(op.serviceName), str(sel.method), str(one(t.resources))]
  if ([identity, source, service, method, target].some((x) => x === undefined)) return undefined
  return canon({ identity: identity!, source: source!, service: service!, method: method!, target: target! })
}

export function ingressPolicyOk(raw: string, spec: IngressSpec): boolean {
  const text = raw.replace(/^\uFEFF/, '') // a UTF-8 byte-order mark is not part of the document
  if (text.length > MAX_INGRESS_FILE) return false
  try {
    const docs = parseAllDocuments(text)
    if (docs.length !== 1 || docs[0].errors.length > 0) return false
    const js: unknown = docs[0].toJS({ maxAliasCount: 0 })
    if (!Array.isArray(js)) return false
    const got = js.map(policy)
    if (got.some((g) => g === undefined)) return false
    const want = [...(spec.keep ?? []), spec.narrow].map(canon).sort()
    return got.length === want.length && (got as string[]).sort().every((g, i) => g === want[i])
  } catch {
    return false
  }
}
