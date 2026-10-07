import { describe, expect, it } from 'vitest'
import { parseHcl } from '../src/game/terraform/parse.ts'
import { applyMoves, movesOf } from '../src/game/terraform/moves.ts'
import { emptyState, listAddresses, type State } from '../src/game/terraform/state.ts'

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]'
const moves = (hcl: string) => {
  const r = parseHcl('main.tf', hcl)
  if (r.diagnostics.length) throw new Error(r.diagnostics[0].summary)
  return movesOf(r.blocks)
}
const MV = (from: string, to: string) => `moved {\n  from = ${from}\n  to   = ${to}\n}\n`
const stateWith = (...res: { type: string; name: string; keys?: (string | number)[]; mode?: 'managed' | 'data' }[]): State => {
  const s = emptyState()
  for (const r of res) {
    s.resources.push({
      mode: r.mode ?? 'managed',
      type: r.type,
      name: r.name,
      provider: AWS,
      instances: (r.keys ?? [undefined]).map((k) => ({ ...(k === undefined ? {} : { index_key: k }), attributes: { id: `${r.name}-${k ?? 'x'}` } })),
    })
  }
  return s
}
const run = (hcl: string, state: State) => applyMoves(state, moves(hcl).moves)

describe('movesOf', () => {
  it('reads from and to addresses', () => {
    const r = moves(MV('aws_db_instance.orders', 'aws_db_instance.primary') + MV('aws_s3_bucket.b[0]', 'aws_s3_bucket.b["a"]'))
    expect(r.diagnostics).toEqual([])
    expect(r.moves.map((m) => [m.from, m.to])).toEqual([
      [{ type: 'aws_db_instance', name: 'orders' }, { type: 'aws_db_instance', name: 'primary' }],
      [{ type: 'aws_s3_bucket', name: 'b', key: 0 }, { type: 'aws_s3_bucket', name: 'b', key: 'a' }],
    ])
  })

  it('reports missing arguments, bad addresses and a type mismatch', () => {
    expect(moves('moved {\n  from = aws_vpc.a\n}\n').diagnostics[0]).toMatchObject({ summary: 'Missing required argument', detail: 'The argument "to" is required, but no definition was found.' })
    expect(moves(MV('aws_vpc.a.id', 'aws_vpc.b')).diagnostics[0].summary).toBe('Invalid "from" address')
    expect(moves(MV('aws_vpc.a', 'var.x')).diagnostics[0].summary).toBe('Invalid "to" address')
    expect(moves(MV('aws_vpc.a', 'aws_subnet.b')).diagnostics[0]).toMatchObject({ summary: 'Resource type mismatch', file: 'main.tf', line: 1 })
    expect(moves(MV('aws_vpc.a', 'aws_subnet.b')).moves).toEqual([])
  })
})

describe('applyMoves', () => {
  it('renames a resource, keeping instance keys, and reports old addresses', () => {
    const r = run(MV('aws_s3_bucket.old', 'aws_s3_bucket.new'), stateWith({ type: 'aws_s3_bucket', name: 'old', keys: ['a', 'b'] }, { type: 'aws_vpc', name: 'v' }))
    expect(r.diagnostics).toEqual([])
    expect(listAddresses(r.state)).toEqual(['aws_s3_bucket.new["a"]', 'aws_s3_bucket.new["b"]', 'aws_vpc.v'])
    expect(Object.fromEntries(r.moved)).toEqual({ 'aws_s3_bucket.new["a"]': 'aws_s3_bucket.old["a"]', 'aws_s3_bucket.new["b"]': 'aws_s3_bucket.old["b"]' })
  })

  it('re-keys single instances: count index to for_each key, and a lone instance to [0]', () => {
    const r = run(MV('aws_s3_bucket.b[0]', 'aws_s3_bucket.b["a"]') + MV('aws_s3_bucket.b[1]', 'aws_s3_bucket.b["b"]'), stateWith({ type: 'aws_s3_bucket', name: 'b', keys: [0, 1] }))
    expect(listAddresses(r.state)).toEqual(['aws_s3_bucket.b["a"]', 'aws_s3_bucket.b["b"]'])
    const one = run(MV('aws_vpc.v', 'aws_vpc.v[0]'), stateWith({ type: 'aws_vpc', name: 'v' }))
    expect(listAddresses(one.state)).toEqual(['aws_vpc.v[0]'])
    expect(one.moved.get('aws_vpc.v[0]')).toBe('aws_vpc.v')
  })

  it('follows chains, so a to b and b to c ends at c', () => {
    const r = run(MV('aws_vpc.a', 'aws_vpc.b') + MV('aws_vpc.b', 'aws_vpc.c'), stateWith({ type: 'aws_vpc', name: 'a' }))
    expect(listAddresses(r.state)).toEqual(['aws_vpc.c'])
    expect(r.moved.get('aws_vpc.c')).toBe('aws_vpc.a')
  })

  it('does nothing when nothing matches, never touches data sources, and does not mutate the input', () => {
    const s = stateWith({ type: 'aws_vpc', name: 'a' }, { type: 'aws_ami', name: 'a', mode: 'data' })
    const copy = structuredClone(s)
    const r = run(MV('aws_vpc.zzz', 'aws_vpc.b') + MV('aws_ami.a', 'aws_ami.b'), s)
    expect(r.diagnostics).toEqual([])
    expect(r.moved.size).toBe(0)
    expect(listAddresses(r.state)).toEqual(['aws_vpc.a', 'data.aws_ami.a'])
    expect(s).toEqual(copy)
  })

  it('refuses to move onto an occupied address', () => {
    const r = run(MV('aws_vpc.a', 'aws_vpc.b'), stateWith({ type: 'aws_vpc', name: 'a' }, { type: 'aws_vpc', name: 'b' }))
    expect(r.diagnostics[0]).toMatchObject({ severity: 'error', summary: 'Cannot move to existing object' })
    expect(r.diagnostics[0].detail).toContain('aws_vpc.b')
  })

  it('reports a cycle instead of looping', () => {
    const r = run(MV('aws_vpc.a', 'aws_vpc.b') + MV('aws_vpc.b', 'aws_vpc.a'), stateWith({ type: 'aws_vpc', name: 'a' }))
    expect(r.diagnostics.map((d) => d.summary)).toContain('Cycle in move statements')
  })

  it('does not move an instance of a whole-resource move when both addresses are keyed', () => {
    const r = run(MV('aws_s3_bucket.old', 'aws_s3_bucket.new["x"]'), stateWith({ type: 'aws_s3_bucket', name: 'old', keys: ['a'] }))
    expect(listAddresses(r.state)).toEqual(['aws_s3_bucket.old["a"]'])
  })
})
