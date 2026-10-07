// Recursive-descent parser for the HCL subset (blocks, arguments, expressions).
// Expressions beyond references and strings arrive in the next task.
import { lex } from './lex.ts'
import { fail, HclError, type Attr, type Block, type Diagnostic, type Expr, type Pos, type Tok } from './types.ts'

export interface ParseResult {
  blocks: Block[]
  diagnostics: Diagnostic[]
}

export function parseHcl(file: string, text: string): ParseResult {
  try {
    return { blocks: new Parser(file, lex(file, text)).topLevel(), diagnostics: [] }
  } catch (e) {
    if (e instanceof HclError) return { blocks: [], diagnostics: [e.diag] }
    throw e
  }
}

const show = (t: Tok): string =>
  t.k === 'eof' ? 'the end of the file' : t.k === 'nl' ? 'the end of the line' : t.k === 'id' ? `the identifier "${t.v}"` : t.k === 'p' ? `"${t.v}"` : t.k === 'num' ? 'a number' : 'a string'

type StrTok = Extract<Tok, { k: 'str' }>
type IdTok = Extract<Tok, { k: 'id' }>

class Parser {
  file: string
  toks: Tok[]
  i = 0
  skip = 0 // >0 inside ( ) and [ ]: newlines don't end an expression
  ctx: string | undefined // e.g. resource "aws_vpc" "main", for diagnostics

  constructor(file: string, toks: Tok[]) {
    this.file = file
    this.toks = toks
  }

  peek(): Tok {
    if (this.skip) while (this.toks[this.i].k === 'nl') this.i++
    return this.toks[this.i]
  }
  next(): Tok {
    const t = this.peek()
    if (t.k !== 'eof') this.i++
    return t
  }
  isP(v: string): boolean {
    const t = this.peek()
    return t.k === 'p' && t.v === v
  }
  nlSkip(): Tok {
    while (this.toks[this.i].k === 'nl') this.i++
    return this.toks[this.i]
  }
  err(pos: Pos, summary: string, detail: string): never {
    return fail(this.file, pos, summary, detail, this.ctx)
  }
  expectP(v: string, summary: string, detail: string): void {
    if (!this.isP(v)) this.err(this.peek().pos, summary, detail)
    this.i++
  }
  withSkip<T>(on: boolean, fn: () => T): T {
    const saved = this.skip
    this.skip = on ? 1 : 0
    try {
      return fn()
    } finally {
      this.skip = saved
    }
  }

  topLevel(): Block[] {
    return this.body(false, undefined, true).blocks
  }

  // Items until the closing brace (or end of file at top level).
  body(closing: boolean, open: Pos | undefined, top: boolean): { attrs: Attr[]; blocks: Block[] } {
    const attrs: Attr[] = []
    const blocks: Block[] = []
    for (;;) {
      const t = this.nlSkip()
      if (t.k === 'eof') {
        if (closing) {
          this.err(open!, 'Unclosed configuration block', 'There is no closing brace for this block before the end of the file. This may be caused by incorrect brace nesting elsewhere in this file.')
        }
        return { attrs, blocks }
      }
      if (t.k === 'p' && t.v === '}' && closing) {
        this.i++
        return { attrs, blocks }
      }
      if (t.k !== 'id') this.err(t.pos, 'Argument or block definition required', 'An argument or block definition is required here.')
      this.i++
      if (this.isP('=')) {
        if (top) this.err(t.pos, 'Unsupported argument', `An argument named "${t.v}" is not expected here.`)
        this.i++
        const value = this.expr()
        const prev = attrs.find((a) => a.name === t.v)
        if (prev) {
          this.err(t.pos, 'Attribute redefined', `The argument "${t.v}" was already set at ${this.file}:${prev.pos.line},${prev.pos.col}. Each argument may be set only once.`)
        }
        attrs.push({ name: t.v, value, pos: t.pos })
        this.endOfItem('argument')
        continue
      }
      const labels: string[] = []
      for (;;) {
        const l = this.peek()
        if (l.k === 'id') {
          labels.push(l.v)
          this.i++
        } else if (l.k === 'str') {
          if (!l.parts.every((p) => typeof p === 'string')) this.err(l.pos, 'Invalid block label', 'Block labels must be plain strings, without interpolation.')
          labels.push(l.parts.join(''))
          this.i++
        } else break
      }
      const brace = this.peek()
      if (!(brace.k === 'p' && brace.v === '{')) {
        this.err(brace.pos, 'Argument or block definition required', 'An argument or block definition is required here. To set an argument, use the equals sign "=" to introduce the argument value.')
      }
      this.i++
      const saved = this.ctx
      if (top) this.ctx = [t.v, ...labels.map((x) => `"${x}"`)].join(' ')
      const inner = this.body(true, brace.pos, false)
      this.ctx = saved
      blocks.push({ type: t.v, labels, attrs: inner.attrs, blocks: inner.blocks, pos: t.pos, file: this.file })
      this.endOfItem('block')
    }
  }

  endOfItem(kind: 'argument' | 'block'): void {
    const t = this.toks[this.i]
    if (t.k === 'nl' || t.k === 'eof' || (t.k === 'p' && t.v === '}')) return
    this.err(t.pos, `Missing newline after ${kind}`, `${kind === 'argument' ? 'An argument' : 'A block'} definition must end with a newline.`)
  }

  // --- expressions ---

  expr(): Expr {
    return this.postfix()
  }

  postfix(): Expr {
    let e = this.primary()
    for (;;) {
      if (this.isP('.')) {
        this.i++
        const t = this.next()
        if (t.k === 'id') e = { kind: 'attr', base: e, name: t.v }
        else if (t.k === 'num') e = { kind: 'idx', base: e, index: { kind: 'lit', value: t.v } }
        else this.err(t.pos, 'Invalid attribute name', 'An attribute name is required after a dot.')
      } else if (this.isP('[')) {
        this.i++
        const base = e
        e = this.withSkip(true, () => {
          const index = this.expr()
          this.expectP(']', 'Missing close bracket on index', 'The index operator must end with a closing bracket ("]").')
          return { kind: 'idx', base, index } as Expr
        })
      } else return e
    }
  }

  primary(): Expr {
    const t = this.next()
    if (t.k === 'num') return { kind: 'lit', value: t.v }
    if (t.k === 'str') return this.template(t)
    if (t.k === 'id') {
      if (t.v === 'true') return { kind: 'lit', value: true }
      if (t.v === 'false') return { kind: 'lit', value: false }
      if (t.v === 'null') return { kind: 'lit', value: null }
      return this.ref(t)
    }
    return this.err(t.pos, 'Invalid expression', `Expected the start of an expression, but found ${show(t)}.`)
  }

  ref(t: IdTok): Expr {
    const path = [t.v]
    while (this.isP('.') && this.toks[this.i + 1].k === 'id') {
      path.push((this.toks[this.i + 1] as IdTok).v)
      this.i += 2
    }
    return { kind: 'ref', path, pos: t.pos }
  }

  template(t: StrTok): Expr {
    if (t.parts.every((p) => typeof p === 'string')) return { kind: 'lit', value: t.parts.join('') }
    const parts = t.parts.map((p) => (typeof p === 'string' ? p : this.sub(p.src, p.pos)))
    // "${x}" on its own is just x
    if (parts.length === 1 && typeof parts[0] !== 'string') return parts[0]
    return { kind: 'tmpl', parts }
  }

  // Parse the inside of a ${ } sequence. Errors are reported at the string.
  sub(src: string, pos: Pos): Expr {
    try {
      const p = new Parser(this.file, lex(this.file, src))
      p.skip = 1
      p.ctx = this.ctx
      const e = p.expr()
      const t = p.peek()
      if (t.k !== 'eof') p.err(t.pos, 'Extra characters after interpolation expression', 'Expected a closing brace to end the interpolation expression, but found extra characters.')
      return e
    } catch (e) {
      if (e instanceof HclError) throw new HclError({ ...e.diag, line: pos.line, col: pos.col })
      throw e
    }
  }
}
