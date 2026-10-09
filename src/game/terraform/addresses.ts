// Addresses as written in moved / removed / import blocks: a resource instance (module-qualified or not), or a whole module (type and name are '').
import { formatModule, formatResAddr, parseModuleAddr, parseResAddr, formatKey, type ModStep } from './address.ts'
import type { Expr } from './types.ts'

export interface Address {
  module?: ModStep[] // absent = root module
  type: string
  name: string
  key?: string | number
}

export const isModuleAddress = (a: Address): boolean => a.type === ''

// The address as text; a module-only address formats as module.a.module.b.
export const formatAddress = (a: Address): string =>
  isModuleAddress(a) ? formatModule(a.module ?? []) : formatResAddr({ module: a.module ?? [], mode: 'managed', type: a.type, name: a.name, key: a.key })

// A reference / index chain as the dotted text Terraform would print, or undefined if it is anything else.
function exprText(e: Expr): string | undefined {
  if (e.kind === 'ref') return e.path.join('.')
  if (e.kind === 'attr') {
    const b = exprText(e.base)
    return b === undefined ? undefined : `${b}.${e.name}`
  }
  if (e.kind === 'idx' && e.index.kind === 'lit' && (typeof e.index.value === 'string' || typeof e.index.value === 'number')) {
    const b = exprText(e.base)
    return b === undefined ? undefined : `${b}${formatKey(e.index.value)}`
  }
  return undefined
}

// aws_vpc.main, aws_subnet.s[0], module.net.aws_s3_bucket.b["k"], and with `modules` also module.net (a whole module); anything else is not an address.
export function parseAddress(e: Expr, modules = false): Address | undefined {
  const text = exprText(e)
  if (text === undefined) return undefined
  const mod = parseModuleAddr(text)
  if (mod) return modules ? { module: mod, type: '', name: '' } : undefined
  const r = parseResAddr(text)
  if (!r || r.mode !== 'managed') return undefined
  return { ...(r.module.length ? { module: r.module } : {}), type: r.type, name: r.name, ...(r.key === undefined ? {} : { key: r.key }) }
}
