// Resource addresses as written in moved / removed / import blocks.
import type { Expr } from './types.ts'

export interface Address {
  type: string
  name: string
  key?: string | number
}

const NOT_RESOURCES = new Set(['var', 'local', 'module', 'data', 'each', 'count', 'path', 'terraform', 'self'])

// aws_vpc.main, aws_subnet.s[0], aws_s3_bucket.b["k"]; anything else is not an address.
export function parseAddress(e: Expr): Address | undefined {
  const isResource = (p: string[]) => p.length === 2 && !NOT_RESOURCES.has(p[0])
  if (e.kind === 'ref') return isResource(e.path) ? { type: e.path[0], name: e.path[1] } : undefined
  if (e.kind === 'idx' && e.base.kind === 'ref' && isResource(e.base.path) && e.index.kind === 'lit' && (typeof e.index.value === 'string' || typeof e.index.value === 'number')) {
    return { type: e.base.path[0], name: e.base.path[1], key: e.index.value }
  }
  return undefined
}
