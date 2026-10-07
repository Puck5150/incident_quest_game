import { describe, expect, it } from 'vitest'
import { parseAddress } from '../src/game/terraform/addresses.ts'
import { parseHcl } from '../src/game/terraform/parse.ts'

const addr = (src: string) => {
  const r = parseHcl('main.tf', `locals {\n  v = ${src}\n}`)
  if (r.diagnostics.length) throw new Error(r.diagnostics[0].summary)
  return parseAddress(r.blocks[0].attrs[0].value)
}

describe('parseAddress', () => {
  it('reads a resource, a counted instance and a keyed instance', () => {
    expect(addr('aws_vpc.main')).toEqual({ type: 'aws_vpc', name: 'main' })
    expect(addr('aws_subnet.s[0]')).toEqual({ type: 'aws_subnet', name: 's', key: 0 })
    expect(addr('aws_s3_bucket.b["logs"]')).toEqual({ type: 'aws_s3_bucket', name: 'b', key: 'logs' })
  })

  it('rejects everything else', () => {
    for (const s of ['aws_vpc', 'aws_vpc.main.id', 'var.x', 'local.x', 'module.m', 'data.aws_ami.x', 'each.key', 'count.index', '"aws_vpc.main"', '1', 'aws_vpc.main[var.k]', 'aws_vpc.main[0][1]', 'aws_vpc.main[true]']) {
      expect(addr(s), s).toBeUndefined()
    }
  })
})
