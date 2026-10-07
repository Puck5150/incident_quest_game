// Shared shapes for the Terraform simulator's HCL front end (see
// docs/superpowers/specs/2026-10-07-terraform-simulator-design.md).

export interface Pos {
  line: number
  col: number
}

// A string is literal text, or an interpolation still to be parsed.
export type TmplPart = string | { src: string; pos: Pos }

export type Tok =
  | { k: 'id'; v: string; pos: Pos }
  | { k: 'num'; v: number; pos: Pos }
  | { k: 'str'; parts: TmplPart[]; pos: Pos }
  | { k: 'p'; v: string; pos: Pos }
  | { k: 'nl'; pos: Pos }
  | { k: 'eof'; pos: Pos }

export type Expr =
  | { kind: 'lit'; value: string | number | boolean | null }
  | { kind: 'tmpl'; parts: (string | Expr)[] }
  // A reference such as aws_vpc.main.id: path is the leading dotted names
  // (here [aws_vpc, main, id]); anything after an index becomes attr/idx nodes.
  | { kind: 'ref'; path: string[]; pos: Pos }
  | { kind: 'attr'; base: Expr; name: string }
  | { kind: 'idx'; base: Expr; index: Expr }
  | { kind: 'call'; name: string; args: Expr[]; pos: Pos }
  | { kind: 'list'; items: Expr[] }
  | { kind: 'obj'; entries: { key: Expr; value: Expr }[] }
  | { kind: 'cond'; test: Expr; yes: Expr; no: Expr }
  | { kind: 'bin'; op: string; left: Expr; right: Expr }
  | { kind: 'un'; op: '!' | '-'; expr: Expr }

export interface Attr {
  name: string
  value: Expr
  pos: Pos
}

export interface Block {
  type: string
  labels: string[]
  attrs: Attr[]
  blocks: Block[]
  pos: Pos
  file: string
}

export interface Diagnostic {
  severity: 'error'
  summary: string
  detail: string
  file: string // '' for diagnostics with no source location (e.g. a cycle)
  line: number
  col: number
  context?: string // e.g. resource "aws_vpc" "main"
}

export class HclError extends Error {
  diag: Diagnostic
  constructor(diag: Diagnostic) {
    super(diag.summary)
    this.diag = diag
  }
}

export function fail(file: string, pos: Pos, summary: string, detail: string, context?: string): never {
  throw new HclError({ severity: 'error', summary, detail, file, line: pos.line, col: pos.col, context })
}
