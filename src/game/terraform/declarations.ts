// `removed` and `import` blocks: statements about state rather than resources.
import { formatAddress, isModuleAddress, parseAddress, type Address } from './addresses.ts'
import type { Block, Diagnostic, Expr, Pos } from './types.ts'

const diag = (file: string, pos: Pos, summary: string, detail: string): Diagnostic => ({ severity: 'error', summary, detail, file, line: pos.line, col: pos.col })
const missing = (b: Block, name: string) => diag(b.file, b.pos, 'Missing required argument', `The argument "${name}" is required, but no definition was found.`)

// Arguments and labels a statement block does not take.
export function shapeErrors(b: Block, allowed: string[]): Diagnostic[] {
  const out: Diagnostic[] = []
  if (b.labels.length) out.push(diag(b.file, b.pos, 'Extraneous label', `No labels are expected for ${b.type} blocks.`))
  for (const a of b.attrs) if (!allowed.includes(a.name)) out.push(diag(b.file, a.pos, 'Unsupported argument', `An argument named "${a.name}" is not expected here.`))
  return out
}

export interface Removal {
  from: Address
  destroy: boolean
  file: string
  pos: Pos
}

export function removedOf(blocks: Block[]): { removals: Removal[]; diagnostics: Diagnostic[] } {
  const removals: Removal[] = []
  const diagnostics: Diagnostic[] = []
  for (const b of blocks) {
    if (b.type !== 'removed') continue
    diagnostics.push(...shapeErrors(b, ['from']))
    const fromAttr = b.attrs.find((a) => a.name === 'from')
    if (!fromAttr) {
      diagnostics.push(missing(b, 'from'))
      continue
    }
    const from = parseAddress(fromAttr.value)
    if (!from || from.key !== undefined || isModuleAddress(from)) {
      diagnostics.push(diag(b.file, fromAttr.pos, 'Invalid "from" address', 'Removed block addresses must be resource addresses such as aws_instance.web or module.net.aws_instance.web.'))
      continue
    }
    let destroy = true
    let bad = false
    for (const a of b.blocks.find((x) => x.type === 'lifecycle')?.attrs ?? []) {
      if (a.name !== 'destroy') {
        diagnostics.push(diag(b.file, a.pos, 'Unsupported argument', `An argument named "${a.name}" is not expected here.`))
        bad = true
      } else if (a.value.kind !== 'lit') {
        diagnostics.push(diag(b.file, a.pos, 'Variables not allowed', 'Variables may not be used here.'))
        bad = true
      } else if (typeof a.value.value !== 'boolean') {
        diagnostics.push(diag(b.file, a.pos, 'Unsuitable value type', 'Unsuitable value: a bool is required.'))
        bad = true
      } else destroy = a.value.value
    }
    if (!bad) removals.push({ from, destroy, file: b.file, pos: b.pos })
  }
  return { removals, diagnostics }
}

export interface ImportDecl {
  to: Address
  id: Expr
  idPos: Pos
  file: string
  pos: Pos
}

export function importsOf(blocks: Block[]): { imports: ImportDecl[]; diagnostics: Diagnostic[] } {
  const imports: ImportDecl[] = []
  const diagnostics: Diagnostic[] = []
  for (const b of blocks) {
    if (b.type !== 'import') continue
    diagnostics.push(...shapeErrors(b, ['to', 'id']))
    const toAttr = b.attrs.find((a) => a.name === 'to')
    const idAttr = b.attrs.find((a) => a.name === 'id')
    if (!toAttr) diagnostics.push(missing(b, 'to'))
    if (!idAttr) diagnostics.push(missing(b, 'id'))
    if (!toAttr || !idAttr) continue
    const to = parseAddress(toAttr.value)
    if (!to || isModuleAddress(to)) {
      diagnostics.push(diag(b.file, toAttr.pos, 'Invalid "to" address', 'Import block addresses must be resource instance addresses such as aws_instance.web or aws_instance.web[0].'))
      continue
    }
    const key = formatAddress(to)
    if (imports.some((x) => formatAddress(x.to) === key)) {
      diagnostics.push(diag(b.file, b.pos, `Duplicate import configuration for "${key}"`, `An import block for ${key} was already declared. A resource instance can have only one import block.`))
      continue
    }
    imports.push({ to, id: idAttr.value, idPos: idAttr.pos, file: b.file, pos: b.pos })
  }
  return { imports, diagnostics }
}
