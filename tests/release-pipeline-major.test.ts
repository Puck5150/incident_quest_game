import { describe, expect, it } from 'vitest'
import { load } from './helpers/azure-credit.ts'

const { sc, credit } = load('release-pipeline-major')
const BIN = 'acmectl-darwin-arm64.tar.gz acmectl-windows-amd64.zip'

describe('release-pipeline-major', () => {
  it('stage 1 needs the tag dispatch plus a durable trigger fix; stage 3 both uploads', () => {
    expect(sc.solution_paths).toEqual([['dispatch-tag', 'app-token'], ['dispatch-tag', 'workflow-call']])
    expect(sc.stages?.at(-1)?.solution_paths).toEqual([['upload-binaries', 'upload-sums'], ['upload-darwin', 'upload-windows', 'upload-sums']])
  })
  it.each([
    'gh workflow run publish.yml --ref v2.4.0 -f tag=v2.4.0',
    'gh workflow run publish.yml -f tag=v2.4.0 --ref v2.4.0',
    'gh workflow run publish.yml --ref=v2.4.0 --field=tag=v2.4.0',
    'gh workflow run publish.yml -r v2.4.0 -f "tag=v2.4.0"',
    'gh workflow run publish.yml --ref refs/tags/v2.4.0 -f tag=v2.4.0',
  ])('credits the dispatch on the tag ref: %s', (c) => expect(credit(c)?.id).toBe('dispatch-tag'))
  it.each(['gh workflow run publish.yml -f tag=v2.4.0', 'gh workflow run publish.yml --field=tag=v2.4.0'])('a dispatch on main is wrong: %s', (c) =>
    expect(credit(c)).toMatchObject({ id: 'dispatch-main', kind: 'wrong' }))
  it.each([
    'gh workflow run publish.yml --ref main -f tag=v2.4.0',
    'gh workflow run publish.yml --ref v2.4.0 -f tag=v2.4.0; id',
    'gh workflow run publish.yml --ref v2.4.0 --ref main -f tag=v2.4.0',
    'gh workflow run publish.yml --ref v2.4.0 -f tag=v2.4.0 $(id)',
    'gh workflow run publish.yml --ref v2.4.0 -f tag=v2.4.0 -f tag=v2.3.0',
  ])('does not credit %s', (c) => expect(credit(c)?.id).not.toBe('dispatch-tag'))

  it.each([`gh release upload v2.4.0 ${BIN}`, 'gh release upload v2.4.0 acmectl-windows-amd64.zip acmectl-darwin-arm64.tar.gz', `gh release upload v2.4.0 dist/acmectl-darwin-arm64.tar.gz ./dist/acmectl-windows-amd64.zip`])(
    'credits the new binaries without --clobber: %s',
    (c) => expect(credit(c)?.id).toBe('upload-binaries'),
  )
  it.each([
    ['gh release upload v2.4.0 acmectl-darwin-arm64.tar.gz', 'upload-darwin'],
    ["gh release upload v2.4.0 'acmectl-windows-amd64.zip' -R acme/acmectl", 'upload-windows'],
    ['gh release upload --repo=acme/acmectl v2.4.0 "acmectl-darwin-arm64.tar.gz" "acmectl-windows-amd64.zip"', 'upload-binaries'],
    ['gh release upload v2.4.0 SHA256SUMS --clobber --repo acme/acmectl', 'upload-sums'],
  ])('credits per-file, quoted and --repo spellings: %s', (c, id) => expect(credit(c)?.id).toBe(id))
  it.each(['gh release upload v2.4.0 SHA256SUMS --clobber', 'gh release upload v2.4.0 --clobber dist/SHA256SUMS'])('credits SHA256SUMS alone: %s', (c) =>
    expect(credit(c)?.id).toBe('upload-sums'))
  it.each([
    'gh release upload v2.4.0 acmectl-linux-amd64.tar.gz --clobber',
    `gh release upload v2.4.0 acmectl-linux-amd64.tar.gz ${BIN} SHA256SUMS --clobber`,
    `gh release upload v2.4.0 --clobber acmectl-linux-amd64.tar.gz SHA256SUMS`,
  ])('replacing the Linux binary is destructive: %s', (c) => expect(credit(c)).toMatchObject({ id: 'clobber-linux', kind: 'destructive' }))
  it.each([`gh release upload v2.4.0 ${BIN} SHA256SUMS --clobber`, `gh release upload v2.4.0 --clobber ${BIN} SHA256SUMS`])('one big --clobber upload is wrong: %s', (c) =>
    expect(credit(c)).toMatchObject({ id: 'clobber-binaries', kind: 'wrong' }))
  it.each([
    'gh release upload v2.4.0 SHA256SUMS',
    'gh release upload v2.4.0 SHA256SUMS --clobber; id',
    `gh release upload v2.4.0 ${BIN} acmectl-linux-amd64.tar.gz`,
    'gh release upload v2.4.0 acmectl-darwin-arm64.tar.gz',
    `gh release upload v2.4.0 ${BIN} && echo`,
  ])('does not credit %s', (c) => expect(['upload-binaries', 'upload-sums']).not.toContain(credit(c)?.id))
})
