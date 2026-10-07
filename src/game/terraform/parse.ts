// Recursive-descent parser for the HCL subset (blocks, arguments, expressions).
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
    // Pathologically deep input overflowed the stack somewhere in lex/parse.
    if (e instanceof RangeError) return { blocks: [], diagnostics: [{ severity: 'error', summary: NEST, detail: NEST_DETAIL, file, line: 0, col: 0 }] }
    throw e
  }
}

const NEST = 'Unsupported nesting depth'
const NEST_DETAIL = 'The configuration is nested or chained too deeply for this lab.'
const MAX_DEPTH = 100

const show = (t: Tok): string =>
  t.k === 'eof' ? 'the end of the file' : t.k === 'nl' ? 'the end of the line' : t.k === 'id' ? `the identifier "${t.v}"` : t.k === 'p' ? `"${t.v}"` : t.k === 'num' ? 'a number' : 'a string'

type StrTok = Extract<Tok, { k: 'str' }>
type IdTok = Extract<Tok, { k: 'id' }>

const PREC: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 }
const NO_FOR = 'for expressions ([for ...] and {for ...}) are not supported by this lab.'
const NO_SPLAT = 'Splat expressions (.* and [*]) are not supported by this lab.'

class Parser {
  file: string
  toks: Tok[]
  i = 0
  depth = 0 // nesting of unary() calls, to bound recursion
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
    const test = this.bin(1)
    if (!this.isP('?')) return test
    this.i++
    const yes = this.expr()
    this.expectP(':', 'Missing false expression in conditional', 'The conditional operator (...?...:...) requires a false expression, delimited by a colon.')
    return { kind: 'cond', test, yes, no: this.expr() }
  }

  bin(min: number): Expr {
    let left = this.unary()
    let ops = 0 // operators in this chain (the tree is left-deep, and walkers recurse over it)
    for (;;) {
      const t = this.peek()
      if (t.k !== 'p') return left
      const prec = PREC[t.v]
      if (!prec || prec < min) return left
      if (++ops > MAX_DEPTH) this.err(t.pos, NEST, NEST_DETAIL)
      this.i++
      left = { kind: 'bin', op: t.v, left, right: this.bin(prec + 1) }
    }
  }

  unary(): Expr {
    if (++this.depth > MAX_DEPTH) this.err(this.peek().pos, NEST, NEST_DETAIL)
    try {
      if (this.isP('!') || this.isP('-')) {
        const op = (this.next() as Extract<Tok, { k: 'p' }>).v as '!' | '-'
        return { kind: 'un', op, expr: this.unary() }
      }
      return this.postfix()
    } finally {
      this.depth--
    }
  }

  postfix(): Expr {
    let e = this.primary()
    for (;;) {
      if (this.isP('.')) {
        this.i++
        const t = this.next()
        if (t.k === 'id') e = { kind: 'attr', base: e, name: t.v }
        else if (t.k === 'num') e = { kind: 'idx', base: e, index: { kind: 'lit', value: t.v } }
        else if (t.k === 'p' && t.v === '*') this.err(t.pos, 'Unsupported splat expression', NO_SPLAT)
        else this.err(t.pos, 'Invalid attribute name', 'An attribute name is required after a dot.')
      } else if (this.isP('[')) {
        const open = this.next()
        if (this.isP('*')) this.err(open.pos, 'Unsupported splat expression', NO_SPLAT)
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
      if (this.isP(':')) {
        const n = this.toks[this.i + 1]
        if (n.k === 'p' && n.v === ':') this.err(t.pos, 'Unsupported provider function', 'Provider-defined functions (provider::name::function) are not supported by this lab.')
      }
      if (this.isP('(')) return this.call(t)
      return this.ref(t)
    }
    if (t.k === 'p' && t.v === '(') return this.group()
    if (t.k === 'p' && t.v === '[') return this.list()
    if (t.k === 'p' && t.v === '{') return this.obj()
    return this.err(t.pos, 'Invalid expression', `Expected the start of an expression, but found ${show(t)}.`)
  }

  group(): Expr {
    return this.withSkip(true, () => {
      const e = this.expr()
      this.expectP(')', 'Missing closing parenthesis', 'Expected a closing parenthesis to end the parenthesized expression.')
      return e
    })
  }

  call(name: IdTok): Expr {
    this.i++ // the (
    const args = this.withSkip(true, () => {
      const out: Expr[] = []
      while (!this.isP(')')) {
        out.push(this.expr())
        if (this.isP(',')) this.i++
        else if (!this.isP(')')) this.err(this.peek().pos, 'Missing argument separator', 'A comma is required to separate each function argument from the next.')
      }
      this.i++
      return out
    })
    return { kind: 'call', name: name.v, args, pos: name.pos }
  }

  list(): Expr {
    return this.withSkip(true, () => {
      const first = this.peek()
      if (first.k === 'id' && first.v === 'for') this.err(first.pos, 'Unsupported for expression', NO_FOR)
      const items: Expr[] = []
      while (!this.isP(']')) {
        items.push(this.expr())
        if (this.isP(',')) this.i++
        else if (!this.isP(']')) this.err(this.peek().pos, 'Missing item separator', 'Expected a comma to mark the beginning of the next item.')
      }
      this.i++
      return { kind: 'list', items } as Expr
    })
  }

  obj(): Expr {
    return this.withSkip(false, () => {
      const entries: { key: Expr; value: Expr }[] = []
      for (;;) {
        let t = this.nlSkip()
        while (t.k === 'p' && t.v === ',') {
          this.i++
          t = this.nlSkip()
        }
        if (t.k === 'p' && t.v === '}') {
          this.i++
          return { kind: 'obj', entries } as Expr
        }
        if (t.k === 'id' && t.v === 'for' && entries.length === 0) this.err(t.pos, 'Unsupported for expression', NO_FOR)
        let key: Expr
        if (t.k === 'id') {
          this.i++
          key = { kind: 'lit', value: t.v }
        } else if (t.k === 'str') {
          this.i++
          key = this.template(t)
        } else if (t.k === 'p' && t.v === '(') {
          this.i++
          key = this.group()
        } else this.err(t.pos, 'Invalid object key', 'Expected an identifier or string as an object key.')
        if (!(this.isP('=') || this.isP(':'))) this.err(this.peek().pos, 'Missing key/value separator', 'Expected an equals sign ("=") to mark the beginning of the attribute value.')
        this.i++
        entries.push({ key, value: this.expr() })
        const e = this.toks[this.i]
        if (!(e.k === 'nl' || e.k === 'eof' || (e.k === 'p' && (e.v === ',' || e.v === '}')))) {
          this.err(e.pos, 'Missing attribute separator', 'Expected a newline or comma to mark the beginning of the next attribute.')
        }
      }
    })
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
      // Tokens (and nested interpolations) all report at the string's position.
      const toks = lex(this.file, src).map((t): Tok =>
        t.k === 'str' ? { ...t, pos, parts: t.parts.map((x) => (typeof x === 'string' ? x : { ...x, pos })) } : { ...t, pos },
      )
      const p = new Parser(this.file, toks)
      p.depth = this.depth
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
