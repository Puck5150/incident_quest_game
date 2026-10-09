import { describe, expect, it } from 'vitest'
import { formatManifest, loadModuleTree, parseManifest, resolveLocal, sourceKind } from '../src/game/terraform/modules.ts'

const ROOT = [{ name: 'main.tf', text: 'module "net" {\n  source = "./modules/net"\n}\n' }]
const NET = [{ name: 'main.tf', text: 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n' }, { name: 'notes.txt', text: 'x' }]
const reader = (dirs: Record<string, { name: string; text: string }[]>) => async (dir: string) => (Object.hasOwn(dirs, dir) ? dirs[dir] : [])
const NET_MANIFEST = [{ key: 'net', source: './modules/net', dir: 'modules/net' }]

describe('module loader', () => {
  it('a root-only configuration is just its files', async () => {
    const files = [{ name: 'main.tf', text: 'resource "aws_vpc" "main" {\n}\n' }]
    const m = await loadModuleTree(files, reader({}), undefined, false)
    expect(m.tree.root.files).toEqual(files)
    expect(m.calls).toEqual([])
    expect([m.tree.children.size, m.install, m.syntax]).toEqual([0, [], []])
  })

  it('loads a local module with lab-relative file names', async () => {
    const m = await loadModuleTree(ROOT, reader({ 'modules/net': NET }), NET_MANIFEST, false)
    expect(m.install).toEqual([])
    expect(m.tree.children.get('net')?.files).toEqual({ dir: 'modules/net', files: [{ name: 'modules/net/main.tf', text: NET[0].text }] })
    expect(m.tree.children.get('net')?.call).toMatchObject({ name: 'net', source: './modules/net', moduleDir: '', file: 'main.tf', pos: { line: 1 } })
  })

  it('reports not installed, source changed and an unreadable cache directory', async () => {
    const dirs = reader({ 'modules/net': NET })
    const none = await loadModuleTree(ROOT, dirs, undefined, false)
    expect(none.install).toMatchObject([{ summary: 'Module not installed', detail: 'This module is not yet installed. Run "terraform init" to install all modules required by this configuration.', file: 'main.tf', line: 1, context: 'module "net"' }])
    const changed = await loadModuleTree(ROOT, dirs, [{ key: 'net', source: './modules/old', dir: 'modules/old' }], false)
    expect(changed.install).toMatchObject([{ summary: 'Module source has changed', detail: 'The source address was changed since this module was installed. Run "terraform init" to install all modules required by this configuration.' }])
    const gone = await loadModuleTree(ROOT, reader({}), NET_MANIFEST, false)
    expect(gone.install).toMatchObject([{ summary: 'Module not installed', detail: "This module's local cache directory modules/net could not be read. Run \"terraform init\" to install all modules required by this configuration." }])
  })

  it('install mode reads the source directory and reports a missing one', async () => {
    const ok = await loadModuleTree(ROOT, reader({ 'modules/net': NET }), undefined, true)
    expect(ok.entries).toEqual(NET_MANIFEST)
    const gone = await loadModuleTree(ROOT, reader({}), undefined, true)
    expect(gone.install.map((d) => [d.summary, d.detail])).toEqual([
      ['Unreadable module directory', 'Unable to evaluate directory symlink: lstat modules/net: no such file or directory'],
      ['Unreadable module directory', 'The directory  could not be read for module "net" at main.tf:1.'],
    ])
    expect(gone.entries).toEqual([])
  })

  it('child syntax errors carry the lab-relative path', async () => {
    const bad = [{ name: 'main.tf', text: 'resource "aws_vpc" "main" {\n  cidr_block = \n' }]
    const m = await loadModuleTree(ROOT, reader({ 'modules/net': bad }), NET_MANIFEST, false)
    expect(m.syntax.length).toBe(1)
    expect(m.syntax[0].file).toBe('modules/net/main.tf')
  })

  it('a root syntax error stops module checks', async () => {
    const m = await loadModuleTree([{ name: 'main.tf', text: 'module "net" {' }], reader({}), undefined, false)
    expect([m.rootBad, m.install]).toEqual([true, []])
  })

  it('git and escaping sources are unsupported (registry sources are TF6b: see terraform-modules-registry)', async () => {
    const call = (src: string) => [{ name: 'main.tf', text: `module "x" {\n  source = "${src}"\n}\n` }]
    for (const src of ['git::https://example.com/x.git', '../x']) {
      const m = await loadModuleTree(call(src), reader({}), undefined, true)
      expect(m.install.map((d) => d.summary), src).toEqual(['Unsupported module source'])
    }
    expect(sourceKind('registry.terraform.io/acme/network/aws')).toBe('registry')
    expect(sourceKind('github.com/acme/x')).toBe('git')
    expect(sourceKind('https://x.example/a.zip')).toBe('other')
  })

  it('a missing or non-literal source is a diagnostic; __proto__ is a fine module name', async () => {
    const m = await loadModuleTree([{ name: 'main.tf', text: 'module "a" {\n}\nmodule "b" {\n  source = var.s\n}\nmodule "__proto__" {\n  source = "./p"\n}\n' }], reader({ p: NET }), undefined, true)
    expect(m.install.map((d) => d.summary)).toEqual(['Missing required argument', 'Invalid module source'])
    expect(m.entries).toEqual([{ key: '__proto__', source: './p', dir: 'p' }])
    expect(m.tree.children.get('__proto__')?.files.dir).toBe('p')
  })

  it('resolves sources against the calling directory', () => {
    expect(resolveLocal('', './modules/net')).toBe('modules/net')
    expect(resolveLocal('', './modules/../modules/net')).toBe('modules/net')
    expect(resolveLocal('modules/net', '../db')).toBe('modules/db')
    expect(resolveLocal('', '../x')).toBeUndefined()
    expect(resolveLocal('', './')).toBe('.')
  })

  it('formats and parses the manifest, root record first', () => {
    const text = formatManifest(NET_MANIFEST)
    expect(text).toBe('{"Modules":[{"Key":"","Source":"","Dir":"."},{"Key":"net","Source":"./modules/net","Dir":"modules/net"}]}')
    expect(parseManifest(text)).toEqual([{ key: '', source: '', dir: '.' }, ...NET_MANIFEST])
    expect(parseManifest(undefined)).toBeUndefined()
    expect(parseManifest('not json')).toBeUndefined()
    expect(parseManifest('{"Modules":[1,{"Key":"a"}]}')).toEqual([])
    expect(parseManifest('{"Modules":[{"Key":"n","Source":"s","Version":"1.0.0","Dir":"d"}]}')).toEqual([{ key: 'n', source: 's', dir: 'd', version: '1.0.0' }])
  })
})
