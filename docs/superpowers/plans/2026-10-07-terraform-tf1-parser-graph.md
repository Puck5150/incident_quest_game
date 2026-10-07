# Terraform TF1: HCL parser and resource graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse a subset of HCL into an AST with real-looking Terraform diagnostics, and build a dependency graph (references, topological order, cycle detection) from it. No UI, nothing wired into the shell yet.

**Architecture:** Four small files in `src/game/terraform/`: `types.ts` (AST, diagnostics), `lex.ts` (tokens, strings, heredocs), `parse.ts` (recursive-descent parser), `diag.ts` (Terraform-style error box), `graph.ts` (nodes, deps, order, cycles). The parser throws an `HclError` internally and `parseHcl` returns it as a diagnostic, so callers never see exceptions. TF2 (engine) consumes `Block`, `Expr` and `Graph`.

**Tech Stack:** TypeScript (strict), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-terraform-simulator-design.md` (sections "Architecture", "Errors and honesty", build step TF1).

## Global Constraints

- TypeScript is strict with `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`: no enums, no constructor parameter properties, use `import type` for types, and import with the `.ts` extension (`from './types.ts'`).
- No new npm dependencies.
- Tests live in `tests/*.test.ts`, run with `npm test` (vitest). `tests/` `.ts` files are not type-checked by `tsc`; `src/` is.
- Unsupported syntax gives `Error: Unsupported ...` (summary starts with `Unsupported`), never a crash or invented behavior.
- Diagnostic text follows real Terraform wording where known. Wording that is not verified against the docs is logged in `CONTENT_TODO.md` (Task 6).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

Inputs the spec implies but no obvious task would test, most likely first:

1. Windows line endings (`\r\n`) and a leading BOM must parse the same as plain `\n` files (Task 1 and Task 2 tests).
2. An empty file, or one with only comments, parses to zero blocks with no diagnostic (Task 2 test).
3. `lifecycle { ignore_changes = [tags] }` holds attribute names, not references; they must not become dependencies or "undeclared resource" errors (Task 5 test).
4. `each.*`, `count.*`, `self.*`, and `provider = aws.west` / `providers = { aws = aws.west }` must not be reported as undeclared resources (Task 5 test).
5. A resource that depends on itself reports `Cycle:` and terminates, rather than hanging or silently ordering (Task 5 test).

Also pinned: `$${` is a literal `${` (Task 1), and `<<-EOT` heredocs strip common indentation (Task 1).

---

### Task 1: Types and lexer

**Files:**
- Create: `src/game/terraform/types.ts`
- Create: `src/game/terraform/lex.ts`
- Test: `tests/terraform-hcl.test.ts`

**Interfaces:**
- Produces (`types.ts`): `Pos`, `TmplPart`, `Tok`, `Expr`, `Attr`, `Block`, `Diagnostic`, `HclError`, `fail(file, pos, summary, detail, context?): never`.
- Produces (`lex.ts`): `lex(file: string, source: string): Tok[]` (always ends with an `eof` token), `template(raw, escapes, pos, file): TmplPart[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-hcl.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { lex } from '../src/game/terraform/lex.ts'
import { HclError } from '../src/game/terraform/types.ts'

const kinds = (t: string) =>
  lex('main.tf', t).map((x) => (x.k === 'p' ? x.v : x.k === 'id' ? `id:${x.v}` : x.k))

const lexError = (t: string) => {
  try {
    lex('main.tf', t)
  } catch (e) {
    if (e instanceof HclError) return e.diag
    throw e
  }
  throw new Error('expected a lex error')
}

describe('lex', () => {
  it('tokenises identifiers, punctuation, numbers and newlines', () => {
    expect(kinds('a = 1\nb-c = foo.bar')).toEqual(['id:a', '=', 'num', 'nl', 'id:b-c', '=', 'id:foo', '.', 'id:bar', 'eof'])
  })

  it('reads two-character operators as one token', () => {
    expect(kinds('a == b && c != d || e >= f')).toEqual(['id:a', '==', 'id:b', '&&', 'id:c', '!=', 'id:d', '||', 'id:e', '>=', 'id:f', 'eof'])
  })

  it('skips all three comment styles', () => {
    expect(kinds('# x\n// y\n/* z */ a')).toEqual(['nl', 'nl', 'id:a', 'eof'])
  })

  it('ignores a BOM and carriage returns', () => {
    expect(kinds('﻿a = 1\r\n')).toEqual(['id:a', '=', 'num', 'nl', 'eof'])
  })

  it('tracks line and column', () => {
    const toks = lex('main.tf', 'a = 1\n  b')
    expect(toks[4]).toMatchObject({ k: 'id', v: 'b', pos: { line: 2, col: 3 } })
  })

  it('decodes escapes and splits interpolations out of strings', () => {
    const [, , s] = lex('main.tf', 'a = "x\\n${var.y}z"')
    expect(s).toMatchObject({ k: 'str', parts: ['x\n', { src: 'var.y' }, 'z'] })
  })

  it('treats $${ as a literal ${', () => {
    const [, , s] = lex('main.tf', 'a = "$${x}"')
    expect(s).toMatchObject({ k: 'str', parts: ['${x}'] })
  })

  it('finds the end of an interpolation that contains quotes and braces', () => {
    const [, , s] = lex('main.tf', 'a = "${lookup({ k = "v" }, "k")}"')
    expect(s).toMatchObject({ k: 'str', parts: [{ src: 'lookup({ k = "v" }, "k")' }] })
  })

  it('reads a <<- heredoc, strips the common indent, and keeps interpolations', () => {
    const toks = lex('main.tf', 'a = <<-EOT\n    hi ${x}\n      there\n  EOT\n')
    expect(toks[2]).toMatchObject({ k: 'str', parts: ['hi ', { src: 'x' }, '\n  there\n'] })
    expect(toks[3]).toMatchObject({ k: 'nl' })
  })

  it('rejects an unterminated string', () => {
    expect(lexError('a = "oops\n')).toMatchObject({ summary: 'Unterminated template string', line: 1 })
  })

  it('rejects an unterminated comment, heredoc and interpolation', () => {
    expect(lexError('/* never closed').summary).toBe('Unterminated comment')
    expect(lexError('a = <<EOT\nbody\n').summary).toBe('Unterminated heredoc')
    expect(lexError('a = "${x"').summary).toBe('Unterminated template interpolation')
  })

  it('rejects template directives and stray characters', () => {
    expect(lexError('a = "%{ if x }y%{ endif }"').summary).toBe('Unsupported template directive')
    expect(lexError('a = @').summary).toBe('Invalid character')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-hcl.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/lex.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/types.ts`:

```ts
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
```

Create `src/game/terraform/lex.ts`:

```ts
// Tokeniser for the HCL subset. Strings are split into literal text and
// interpolation sources here; the parser parses the sources.
import { fail, type Pos, type TmplPart, type Tok } from './types.ts'

type Bad = (summary: string, detail: string) => never

// text[j] is just after "${"; returns the index of the matching "}".
function scanInterp(text: string, j: number, bad: Bad): number {
  let depth = 1
  while (j < text.length) {
    const c = text[j]
    if (c === '"') {
      j = skipString(text, j, bad)
      continue
    }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return j
    j++
  }
  return bad('Unterminated template interpolation', 'The interpolation sequence has no closing brace.')
}

// text[i] is the opening quote; returns the index just after the closing one.
function skipString(text: string, i: number, bad: Bad): number {
  let j = i + 1
  while (j < text.length && text[j] !== '\n') {
    const c = text[j]
    if (c === '"') return j + 1
    if (c === '\\') j += 2
    else if (c === '$' && text[j + 1] === '$' && text[j + 2] === '{') j += 3
    else if (c === '$' && text[j + 1] === '{') j = scanInterp(text, j + 2, bad) + 1
    else j++
  }
  return bad('Unterminated template string', 'No closing quote was found for this string.')
}

const ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }

// Split string content into literal text and ${...} sources. `escapes` is true
// for quoted strings, false for heredocs (which have no backslash escapes).
export function template(raw: string, escapes: boolean, pos: Pos, file: string): TmplPart[] {
  const bad: Bad = (s, d) => fail(file, pos, s, d)
  const parts: TmplPart[] = []
  let cur = ''
  let j = 0
  while (j < raw.length) {
    const c = raw[j]
    if (c === '$' && raw[j + 1] === '$' && raw[j + 2] === '{') {
      cur += '${'
      j += 3
    } else if (c === '$' && raw[j + 1] === '{') {
      const end = scanInterp(raw, j + 2, bad)
      if (cur) parts.push(cur)
      cur = ''
      parts.push({ src: raw.slice(j + 2, end), pos })
      j = end + 1
    } else if (c === '%' && raw[j + 1] === '{') {
      bad('Unsupported template directive', 'Template directives (%{ ... }) are not supported by this lab.')
    } else if (escapes && c === '\\') {
      const e = raw[j + 1]
      const hex = raw.slice(j + 2, j + 6)
      if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(hex)) {
        cur += String.fromCharCode(parseInt(hex, 16))
        j += 6
      } else if (e in ESC) {
        cur += ESC[e]
        j += 2
      } else {
        bad('Invalid escape sequence', `The symbol "\\${e ?? ''}" is not a valid escape sequence selector.`)
      }
    } else {
      cur += c
      j++
    }
  }
  if (cur) parts.push(cur)
  return parts
}

const NUM = /\d+(\.\d+)?([eE][+-]?\d+)?/y
const ID = /[A-Za-z_][\w-]*/y
const HEREDOC = /<<(-?)([A-Za-z_]\w*)\r?\n/y
const PUNCT2 = ['==', '!=', '<=', '>=', '&&', '||', '=>']
const PUNCT1 = '{}[]()=,.?:!+-*/%<>'

export function lex(file: string, source: string): Tok[] {
  const text = source.replace(/^﻿/, '')
  const n = text.length
  const starts = [0]
  for (let k = 0; k < n; k++) if (text[k] === '\n') starts.push(k + 1)
  const posAt = (i: number): Pos => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= i) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, col: i - starts[lo] + 1 }
  }

  const toks: Tok[] = []
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '#' || (c === '/' && text[i + 1] === '/')) {
      while (i < n && text[i] !== '\n') i++
      continue
    }
    const pos = posAt(i)
    if (c === '\n') {
      toks.push({ k: 'nl', pos })
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2)
      if (e < 0) fail(file, pos, 'Unterminated comment', 'No closing "*/" was found for this comment.')
      i = e + 2
      continue
    }
    if (c === '"') {
      const end = skipString(text, i, (s, d) => fail(file, pos, s, d))
      toks.push({ k: 'str', parts: template(text.slice(i + 1, end - 1), true, pos, file), pos })
      i = end
      continue
    }
    if (c === '<' && text[i + 1] === '<') {
      HEREDOC.lastIndex = i
      const m = HEREDOC.exec(text)
      if (m) {
        const marker = m[2]
        const lines: string[] = []
        let j = i + m[0].length
        for (;;) {
          if (j >= n) fail(file, pos, 'Unterminated heredoc', `The heredoc "${marker}" has no closing marker line.`)
          let e = text.indexOf('\n', j)
          const last = e < 0
          if (last) e = n
          const ln = text.slice(j, e).replace(/\r$/, '')
          if (ln.trim() === marker) {
            j = e
            break
          }
          if (last) fail(file, pos, 'Unterminated heredoc', `The heredoc "${marker}" has no closing marker line.`)
          lines.push(ln)
          j = e + 1
        }
        let body = lines
        if (m[1] === '-') {
          const indents = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length)
          const cut = indents.length ? Math.min(...indents) : 0
          body = lines.map((l) => l.slice(cut))
        }
        const raw = body.length ? body.join('\n') + '\n' : ''
        toks.push({ k: 'str', parts: template(raw, false, pos, file), pos })
        i = j
        continue
      }
    }
    if (c >= '0' && c <= '9') {
      NUM.lastIndex = i
      const m = NUM.exec(text)!
      toks.push({ k: 'num', v: Number(m[0]), pos })
      i += m[0].length
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      ID.lastIndex = i
      const m = ID.exec(text)!
      toks.push({ k: 'id', v: m[0], pos })
      i += m[0].length
      continue
    }
    const two = text.slice(i, i + 2)
    if (PUNCT2.includes(two)) {
      toks.push({ k: 'p', v: two, pos })
      i += 2
      continue
    }
    if (PUNCT1.includes(c)) {
      toks.push({ k: 'p', v: c, pos })
      i++
      continue
    }
    fail(file, pos, 'Invalid character', 'This character is not used within the language.')
  }
  toks.push({ k: 'eof', pos: posAt(n) })
  return toks
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-hcl.test.ts`
Expected: PASS (12 tests). If the heredoc or nested-quote test fails, fix the scanner, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/types.ts src/game/terraform/lex.ts tests/terraform-hcl.test.ts
git commit -m "feat: HCL lexer for the Terraform simulator (TF1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Parser: blocks, arguments, references, strings

**Files:**
- Create: `src/game/terraform/parse.ts`
- Test: `tests/terraform-parse.test.ts`

**Interfaces:**
- Consumes: `lex`, `Tok`, `Expr`, `Attr`, `Block`, `Diagnostic`, `HclError`, `fail`, `Pos` from Task 1.
- Produces: `parseHcl(file: string, text: string): ParseResult` where `ParseResult = { blocks: Block[]; diagnostics: Diagnostic[] }`. On a syntax error `blocks` is `[]` and `diagnostics` holds one entry.

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseHcl } from '../src/game/terraform/parse.ts'

const parse = (text: string) => parseHcl('main.tf', text)

// Parse one expression by putting it in a locals block.
export const ex = (src: string) => {
  const r = parse(`locals {\n  v = ${src}\n}`)
  if (r.diagnostics.length) throw new Error(r.diagnostics[0].summary)
  return r.blocks[0].attrs[0].value
}

describe('parse: structure', () => {
  it('parses labelled blocks, arguments and nested blocks', () => {
    const r = parse(`resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = var.tags
  lifecycle {
    prevent_destroy = true
  }
}
`)
    expect(r.diagnostics).toEqual([])
    const b = r.blocks[0]
    expect(b).toMatchObject({ type: 'resource', labels: ['aws_vpc', 'main'], file: 'main.tf', pos: { line: 1, col: 1 } })
    expect(b.attrs.map((a) => a.name)).toEqual(['cidr_block', 'tags'])
    expect(b.attrs[0].value).toEqual({ kind: 'lit', value: '10.0.0.0/16' })
    expect(b.attrs[1].value).toMatchObject({ kind: 'ref', path: ['var', 'tags'] })
    expect(b.blocks[0]).toMatchObject({ type: 'lifecycle', attrs: [{ name: 'prevent_destroy', value: { kind: 'lit', value: true } }] })
  })

  it('accepts one-line blocks and bare-word labels', () => {
    const r = parse('terraform { required_version = ">= 1.9" }\nvariable region {}\n')
    expect(r.diagnostics).toEqual([])
    expect(r.blocks[0].attrs[0].name).toBe('required_version')
    expect(r.blocks[1]).toMatchObject({ type: 'variable', labels: ['region'] })
  })

  it('treats empty and comment-only files as no blocks', () => {
    expect(parse('')).toEqual({ blocks: [], diagnostics: [] })
    expect(parse('# nothing here\n/* or here */\n')).toEqual({ blocks: [], diagnostics: [] })
  })

  it('parses files with CRLF line endings', () => {
    const r = parse('locals {\r\n  a = 1\r\n}\r\n')
    expect(r.diagnostics).toEqual([])
    expect(r.blocks[0].attrs[0].name).toBe('a')
  })
})

describe('parse: strings and references', () => {
  it('keeps plain strings as literals and templates as parts', () => {
    expect(ex('"plain"')).toEqual({ kind: 'lit', value: 'plain' })
    expect(ex('"x-${var.y}"')).toMatchObject({ kind: 'tmpl', parts: ['x-', { kind: 'ref', path: ['var', 'y'] }] })
  })

  it('unwraps a string that is only one interpolation', () => {
    expect(ex('"${var.y}"')).toMatchObject({ kind: 'ref', path: ['var', 'y'] })
  })

  it('reads dotted references, indexes and later attributes', () => {
    expect(ex('aws_subnet.s[0].id')).toMatchObject({
      kind: 'attr',
      name: 'id',
      base: { kind: 'idx', index: { kind: 'lit', value: 0 }, base: { kind: 'ref', path: ['aws_subnet', 's'] } },
    })
  })

  it('reads true, false and null as literals', () => {
    expect([ex('true'), ex('false'), ex('null')]).toEqual([
      { kind: 'lit', value: true },
      { kind: 'lit', value: false },
      { kind: 'lit', value: null },
    ])
  })
})

describe('parse: errors', () => {
  it('reports a bare name with no = as a missing argument, with context', () => {
    const d = parse('resource "a" "b" {\n  cidr_block\n}\n').diagnostics[0]
    expect(d).toMatchObject({ summary: 'Argument or block definition required', file: 'main.tf', line: 2, context: 'resource "a" "b"' })
    expect(d.detail).toContain('use the equals sign "="')
  })

  it('reports an unclosed block at the opening brace', () => {
    expect(parse('resource "a" "b" {\n  x = 1\n').diagnostics[0]).toMatchObject({ summary: 'Unclosed configuration block', line: 1 })
  })

  it('reports a redefined argument', () => {
    const d = parse('locals {\n  a = 1\n  a = 2\n}\n').diagnostics[0]
    expect(d).toMatchObject({ summary: 'Attribute redefined', line: 3 })
    expect(d.detail).toContain('main.tf:2,3')
  })

  it('reports a top-level argument', () => {
    expect(parse('region = "x"\n').diagnostics[0]).toMatchObject({ summary: 'Unsupported argument', detail: 'An argument named "region" is not expected here.' })
  })

  it('reports two arguments on one line', () => {
    expect(parse('locals {\n  a = 1 b = 2\n}\n').diagnostics[0]).toMatchObject({ summary: 'Missing newline after argument', line: 2 })
  })

  it('returns lexer errors as diagnostics too', () => {
    expect(parse('a = "oops\n').diagnostics[0].summary).toBe('Unterminated template string')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-parse.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/parse.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/parse.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-parse.test.ts tests/terraform-hcl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/parse.ts tests/terraform-parse.test.ts
git commit -m "feat: HCL block and reference parser (TF1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Parser: operators, calls, lists, objects, conditionals

**Files:**
- Modify: `src/game/terraform/parse.ts` (replace `expr`, `postfix`'s dot handling, `primary`; add `cond`, `bin`, `unary`, `call`, `list`, `obj`, `group`)
- Modify: `tests/terraform-parse.test.ts` (append)

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: the same `parseHcl`; `Expr` now also contains `bin`, `un`, `cond`, `call`, `list`, `obj` nodes. `for` expressions, splats (`[*]`, `.*`) give `Unsupported ...` diagnostics.

- [ ] **Step 1: Write the failing test**

Append to `tests/terraform-parse.test.ts`:

```ts
describe('parse: operators and collections', () => {
  it('respects precedence and left associativity', () => {
    expect(ex('1 + 2 * 3')).toMatchObject({ kind: 'bin', op: '+', left: { value: 1 }, right: { kind: 'bin', op: '*', left: { value: 2 }, right: { value: 3 } } })
    expect(ex('1 - 2 - 3')).toMatchObject({ op: '-', left: { kind: 'bin', op: '-' }, right: { value: 3 } })
  })

  it('parses logic, comparison and negation', () => {
    expect(ex('a == b && !c')).toMatchObject({ kind: 'bin', op: '&&', left: { kind: 'bin', op: '==' }, right: { kind: 'un', op: '!' } })
  })

  it('parses conditionals', () => {
    expect(ex('x ? 1 : 2')).toMatchObject({ kind: 'cond', test: { kind: 'ref', path: ['x'] }, yes: { value: 1 }, no: { value: 2 } })
  })

  it('parses function calls, including across lines', () => {
    expect(ex('lookup(m, "k", 0)')).toMatchObject({ kind: 'call', name: 'lookup', args: [{ kind: 'ref' }, { value: 'k' }, { value: 0 }] })
    expect(ex('merge(\n  a,\n  b,\n)')).toMatchObject({ kind: 'call', name: 'merge', args: [{ kind: 'ref' }, { kind: 'ref' }] })
  })

  it('parses lists with a trailing comma over several lines', () => {
    expect(ex('[1, 2,\n  3,\n]')).toMatchObject({ kind: 'list', items: [{ value: 1 }, { value: 2 }, { value: 3 }] })
  })

  it('parses objects separated by newlines or commas, with bare, quoted and (computed) keys', () => {
    expect(ex('{\n  a = 1\n  "b-c" : 2, d = 3\n  (var.k) = 4\n}')).toMatchObject({
      kind: 'obj',
      entries: [
        { key: { value: 'a' }, value: { value: 1 } },
        { key: { value: 'b-c' }, value: { value: 2 } },
        { key: { value: 'd' }, value: { value: 3 } },
        { key: { kind: 'ref', path: ['var', 'k'] }, value: { value: 4 } },
      ],
    })
  })

  it('lets parentheses span lines', () => {
    expect(ex('(1 +\n 2)')).toMatchObject({ kind: 'bin', op: '+' })
  })

  it('parses a call result that is indexed or accessed', () => {
    expect(ex('toset(var.a)[0]')).toMatchObject({ kind: 'idx', base: { kind: 'call', name: 'toset' } })
  })

  it('says for expressions and splats are unsupported', () => {
    const d = (src: string) => parse(`locals {\n  v = ${src}\n}`).diagnostics[0]
    expect(d('[for x in y : x]').summary).toBe('Unsupported for expression')
    expect(d('{ for k, v in m : k => v }').summary).toBe('Unsupported for expression')
    expect(d('a.b[*].c').summary).toBe('Unsupported splat expression')
    expect(d('a.b.*.c').summary).toBe('Unsupported splat expression')
  })

  it('reports an unfinished expression', () => {
    expect(parse('locals {\n  v = 1 +\n}').diagnostics[0].summary).toBe('Invalid expression')
    expect(parse('locals {\n  v = [1 2]\n}').diagnostics[0].summary).toBe('Missing item separator')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-parse.test.ts`
Expected: FAIL on the new tests (e.g. operators parse as an `Invalid expression` / `Missing newline`).

- [ ] **Step 3: Write the implementation**

In `src/game/terraform/parse.ts`, add this constant above `class Parser`:

```ts
const PREC: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 }
const NO_FOR = 'for expressions ([for ...] and {for ...}) are not supported by this lab.'
const NO_SPLAT = 'Splat expressions (.* and [*]) are not supported by this lab.'
```

Replace the `// --- expressions ---` section's `expr()`, `postfix()` and `primary()` with the following, and add the new methods (keep `ref`, `template`, `sub` as they are):

```ts
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
    for (;;) {
      const t = this.peek()
      if (t.k !== 'p') return left
      const prec = PREC[t.v]
      if (!prec || prec < min) return left
      this.i++
      left = { kind: 'bin', op: t.v, left, right: this.bin(prec + 1) }
    }
  }

  unary(): Expr {
    if (this.isP('!') || this.isP('-')) {
      const op = (this.next() as Extract<Tok, { k: 'p' }>).v as '!' | '-'
      return { kind: 'un', op, expr: this.unary() }
    }
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-parse.test.ts tests/terraform-hcl.test.ts && npx tsc -b`
Expected: PASS, and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/parse.ts tests/terraform-parse.test.ts
git commit -m "feat: HCL expressions: operators, calls, lists, objects (TF1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Diagnostic formatter

**Files:**
- Create: `src/game/terraform/diag.ts`
- Test: `tests/terraform-diag.test.ts`

**Interfaces:**
- Consumes: `Diagnostic` from Task 1.
- Produces: `formatDiagnostic(d: Diagnostic, source?: string): string` (the boxed Terraform error), `wrap(text: string, width: number): string[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-diag.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatDiagnostic, wrap } from '../src/game/terraform/diag.ts'
import { parseHcl } from '../src/game/terraform/parse.ts'

describe('formatDiagnostic', () => {
  it('prints the boxed error with location, source line and detail', () => {
    const out = formatDiagnostic(
      { severity: 'error', summary: 'Bad thing', detail: 'short detail', file: 'main.tf', line: 2, col: 3, context: 'resource "a" "b"' },
      'x\n  cidr_block\n',
    )
    expect(out).toBe(
      [
        '╷',
        '│ Error: Bad thing',
        '│ ',
        '│   on main.tf line 2, in resource "a" "b":',
        '│    2:   cidr_block',
        '│ ',
        '│ short detail',
        '╵',
      ].join('\n'),
    )
  })

  it('omits the location for diagnostics without a file, such as a cycle', () => {
    expect(formatDiagnostic({ severity: 'error', summary: 'Cycle: a, b', detail: '', file: '', line: 0, col: 0 })).toBe('╷\n│ Error: Cycle: a, b\n╵')
  })

  it('omits ", in ..." when there is no context', () => {
    const out = formatDiagnostic({ severity: 'error', summary: 'S', detail: '', file: 'f.tf', line: 1, col: 1 }, 'a = 1')
    expect(out).toContain('│   on f.tf line 1:')
  })

  it('formats a real parse error end to end', () => {
    const text = 'resource "a" "b" {\n  cidr_block\n}\n'
    const out = formatDiagnostic(parseHcl('main.tf', text).diagnostics[0], text)
    expect(out.startsWith('╷\n│ Error: Argument or block definition required\n')).toBe(true)
    expect(out).toContain('│    2:   cidr_block')
    expect(out.endsWith('╵')).toBe(true)
  })
})

describe('wrap', () => {
  it('wraps on word boundaries without losing words', () => {
    const text = Array.from({ length: 30 }, () => 'aaaa').join(' ')
    const lines = wrap(text, 76)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every((l) => l.length <= 76)).toBe(true)
    expect(lines.join(' ')).toBe(text)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-diag.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/diag.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/diag.ts`:

```ts
// Render a diagnostic the way the Terraform CLI prints an error.
import type { Diagnostic } from './types.ts'

export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > width) {
      lines.push(cur)
      cur = word
    } else cur = cur ? `${cur} ${word}` : word
  }
  if (cur) lines.push(cur)
  return lines
}

export function formatDiagnostic(d: Diagnostic, source = ''): string {
  const out = ['╷', `│ Error: ${d.summary}`]
  if (d.file && d.line) {
    out.push('│ ', `│   on ${d.file} line ${d.line}${d.context ? `, in ${d.context}` : ''}:`)
    const src = source.split('\n')[d.line - 1]
    if (src !== undefined) out.push(`│ ${String(d.line).padStart(4)}: ${src.replace(/\r$/, '')}`)
  }
  if (d.detail) out.push('│ ', ...wrap(d.detail, 76).map((l) => `│ ${l}`))
  out.push('╵')
  return out.join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-diag.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/diag.ts tests/terraform-diag.test.ts
git commit -m "feat: Terraform-style diagnostic rendering (TF1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Resource graph: nodes, dependencies, order, cycles

**Files:**
- Create: `src/game/terraform/graph.ts`
- Test: `tests/terraform-graph.test.ts`

**Interfaces:**
- Consumes: `parseHcl`, `Block`, `Diagnostic`, `Expr`, `Pos`.
- Produces: `buildGraph(files: { name: string; text: string }[]): Graph` with
  `Graph = { nodes: Map<string, GNode>; order: string[]; diagnostics: Diagnostic[] }`,
  `GNode = { address: string; kind: NodeKind; file: string; pos: Pos; block?: Block; value?: Expr; refs: Ref[]; deps: string[] }`,
  `NodeKind = 'resource' | 'data' | 'variable' | 'local' | 'output' | 'module'`, `Ref = { path: string[]; pos: Pos }`.
  Addresses: `aws_vpc.main`, `data.aws_ami.x`, `var.region`, `local.tags`, `output.id`, `module.net`. `order` lists dependencies before dependents (stable: ties broken by address). Nodes that cannot be ordered (a cycle) are left out of `order`.

- [ ] **Step 1: Write the failing test**

Create `tests/terraform-graph.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildGraph } from '../src/game/terraform/graph.ts'

const g = (text: string) => buildGraph([{ name: 'main.tf', text }])

const CHAIN = `
variable "region" {}
locals {
  tags = { env = var.region }
}
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = local.tags
}
resource "aws_subnet" "a" {
  vpc_id = aws_vpc.main.id
}
output "subnet" {
  value = aws_subnet.a.id
}
`

describe('graph', () => {
  it('names every node and orders dependencies first', () => {
    const r = g(CHAIN)
    expect(r.diagnostics).toEqual([])
    expect([...r.nodes.keys()].sort()).toEqual(['aws_subnet.a', 'aws_vpc.main', 'local.tags', 'output.subnet', 'var.region'])
    expect(r.nodes.get('aws_subnet.a')!.deps).toEqual(['aws_vpc.main'])
    expect(r.order).toEqual(['var.region', 'local.tags', 'aws_vpc.main', 'aws_subnet.a', 'output.subnet'])
  })

  it('reads depends_on, data and module references as dependencies', () => {
    const r = g(`
data "aws_ami" "x" {}
module "net" {
  source = "./net"
}
resource "aws_vpc" "main" {}
resource "aws_instance" "a" {
  ami        = data.aws_ami.x.id
  subnet_id  = module.net.subnet_id
  depends_on = [aws_vpc.main]
}
`)
    expect(r.diagnostics).toEqual([])
    expect(r.nodes.get('aws_instance.a')!.deps.sort()).toEqual(['aws_vpc.main', 'data.aws_ami.x', 'module.net'])
  })

  it('does not treat ignore_changes names as references', () => {
    const r = g('resource "aws_instance" "a" {\n  ami = "x"\n  lifecycle {\n    ignore_changes = [tags, ami]\n  }\n}\n')
    expect(r.diagnostics).toEqual([])
    expect(r.nodes.get('aws_instance.a')!.deps).toEqual([])
  })

  it('does not flag each, count, self, path, terraform, provider or providers references', () => {
    const r = g(`
resource "aws_s3_bucket" "b" {
  for_each = toset(["a", "b"])
  provider = aws.west
  bucket   = "\${each.key}-\${terraform.workspace}-\${path.module}"
}
resource "aws_subnet" "s" {
  count = 2
  cidr  = cidrsubnet("10.0.0.0/16", 8, count.index)
}
module "m" {
  source    = "./m"
  providers = { aws = aws.west }
}
`)
    expect(r.diagnostics).toEqual([])
  })

  it('reports undeclared references with the Terraform wording', () => {
    const r = g('resource "aws_subnet" "a" {\n  vpc_id = aws_vpc.nope.id\n  x = var.zip\n  y = local.q\n  z = module.m.o\n  w = data.aws_ami.d.id\n}\n')
    const by = (s: string) => r.diagnostics.find((d) => d.summary === s)!
    expect(by('Reference to undeclared resource')).toMatchObject({ file: 'main.tf', line: 2 })
    expect(r.diagnostics.map((d) => d.detail)).toEqual(
      expect.arrayContaining([
        'A managed resource "aws_vpc" "nope" has not been declared in the root module.',
        'An input variable with the name "zip" has not been declared. This variable can be declared with a variable "zip" {} block.',
        'A local value with the name "q" has not been declared.',
        'No module call named "m" is declared in the root module.',
        'A data resource "aws_ami" "d" has not been declared in the root module.',
      ]),
    )
  })

  it('reports a bare resource type as an invalid reference', () => {
    const r = g('resource "aws_subnet" "a" {\n  x = aws_vpc\n}\n')
    expect(r.diagnostics[0]).toMatchObject({ summary: 'Invalid reference', line: 2 })
  })

  it('reports a cycle, naming only the nodes in it', () => {
    const r = g(`
resource "aws_security_group" "a" {
  ingress = aws_security_group.b.id
}
resource "aws_security_group" "b" {
  ingress = aws_security_group.a.id
}
resource "aws_instance" "web" {
  sg = aws_security_group.a.id
}
`)
    expect(r.diagnostics).toEqual([
      { severity: 'error', summary: 'Cycle: aws_security_group.a, aws_security_group.b', detail: '', file: '', line: 0, col: 0 },
    ])
    expect(r.order).toEqual([])
  })

  it('reports a resource that depends on itself, and terminates', () => {
    const r = g('resource "x" "a" {\n  depends_on = [x.a]\n}\n')
    expect(r.diagnostics.map((d) => d.summary)).toEqual(['Cycle: x.a'])
  })

  it('reports duplicate declarations', () => {
    const r = g('resource "aws_vpc" "main" {}\nresource "aws_vpc" "main" {}\nvariable "v" {}\nvariable "v" {}\n')
    expect(r.diagnostics.map((d) => d.summary)).toEqual(['Duplicate resource "aws_vpc" configuration', 'Duplicate variable declaration'])
    expect(r.diagnostics[0].detail).toBe('A aws_vpc resource named "main" was already declared at main.tf:1,1. Resource names must be unique per type in each module.')
  })

  it('reports a block with the wrong number of labels', () => {
    expect(g('resource "aws_vpc" {}\n').diagnostics[0]).toMatchObject({ summary: 'Invalid resource block', line: 1 })
  })

  it('combines files and passes syntax errors through', () => {
    const r = buildGraph([
      { name: 'a.tf', text: 'resource "x" "a" {}\n' },
      { name: 'b.tf', text: 'resource "x" "b" {\n  depends_on = [x.a]\n}\n' },
      { name: 'c.tf', text: 'resource "x" "c" {\n  oops\n}\n' },
    ])
    expect(r.nodes.get('x.b')!.deps).toEqual(['x.a'])
    expect(r.diagnostics[0]).toMatchObject({ file: 'c.tf', summary: 'Argument or block definition required' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/terraform-graph.test.ts`
Expected: FAIL, "Failed to resolve import ../src/game/terraform/graph.ts".

- [ ] **Step 3: Write the implementation**

Create `src/game/terraform/graph.ts`:

```ts
// The resource graph: which configuration objects exist, what each refers to,
// the order they can be applied in, and whether that order is possible.
import { parseHcl } from './parse.ts'
import type { Block, Diagnostic, Expr, Pos } from './types.ts'

export type NodeKind = 'resource' | 'data' | 'variable' | 'local' | 'output' | 'module'
export interface Ref {
  path: string[]
  pos: Pos
}
export interface GNode {
  address: string
  kind: NodeKind
  file: string
  pos: Pos
  block?: Block // not set for locals
  value?: Expr // set for locals
  refs: Ref[]
  deps: string[]
}
export interface Graph {
  nodes: Map<string, GNode>
  order: string[] // dependencies before dependents; cycle members are left out
  diagnostics: Diagnostic[]
}

function exprRefs(e: Expr, out: Ref[]): void {
  switch (e.kind) {
    case 'lit':
      return
    case 'tmpl':
      for (const p of e.parts) if (typeof p !== 'string') exprRefs(p, out)
      return
    case 'ref':
      out.push({ path: e.path, pos: e.pos })
      return
    case 'attr':
      exprRefs(e.base, out)
      return
    case 'idx':
      exprRefs(e.base, out)
      exprRefs(e.index, out)
      return
    case 'call':
      for (const a of e.args) exprRefs(a, out)
      return
    case 'list':
      for (const a of e.items) exprRefs(a, out)
      return
    case 'obj':
      for (const en of e.entries) {
        exprRefs(en.key, out)
        exprRefs(en.value, out)
      }
      return
    case 'cond':
      exprRefs(e.test, out)
      exprRefs(e.yes, out)
      exprRefs(e.no, out)
      return
    case 'bin':
      exprRefs(e.left, out)
      exprRefs(e.right, out)
      return
    case 'un':
      exprRefs(e.expr, out)
  }
}

// provider/providers name a provider configuration; ignore_changes names
// attributes. Neither is a reference to another object.
function blockRefs(b: Block, out: Ref[], top: boolean): void {
  for (const a of b.attrs) {
    if (top && (a.name === 'provider' || a.name === 'providers')) continue
    if (b.type === 'lifecycle' && a.name === 'ignore_changes') continue
    exprRefs(a.value, out)
  }
  for (const n of b.blocks) blockRefs(n, out, false)
}

const DECL: Record<string, [NodeKind, number]> = {
  resource: ['resource', 2],
  data: ['data', 2],
  variable: ['variable', 1],
  output: ['output', 1],
  module: ['module', 1],
}
const PREFIX: Record<NodeKind, string> = { resource: '', data: 'data.', variable: 'var.', local: 'local.', output: 'output.', module: 'module.' }
const SPECIAL = new Set(['each', 'count', 'self', 'path', 'terraform'])

type Resolved = { want: string } | { summary: string; detail: string } | undefined

function resolve(path: string[]): Resolved {
  const [a, b, c] = path
  if (SPECIAL.has(a)) return undefined
  if (a === 'var' || a === 'local' || a === 'module') {
    if (!b) return { summary: 'Invalid reference', detail: `The "${a}" object must be followed by a name.` }
    return { want: `${a}.${b}` }
  }
  if (a === 'data') {
    if (!c) return { summary: 'Invalid reference', detail: 'A reference to a data source must be followed by the data source type and name.' }
    return { want: `data.${b}.${c}` }
  }
  if (!b) return { summary: 'Invalid reference', detail: 'A reference to a resource type must be followed by at least one attribute access, specifying the resource name.' }
  return { want: `${a}.${b}` }
}

function missing(path: string[]): { summary: string; detail: string } {
  const [a, b, c] = path
  if (a === 'var') return { summary: 'Reference to undeclared input variable', detail: `An input variable with the name "${b}" has not been declared. This variable can be declared with a variable "${b}" {} block.` }
  if (a === 'local') return { summary: 'Reference to undeclared local value', detail: `A local value with the name "${b}" has not been declared.` }
  if (a === 'module') return { summary: 'Reference to undeclared module', detail: `No module call named "${b}" is declared in the root module.` }
  if (a === 'data') return { summary: 'Reference to undeclared resource', detail: `A data resource "${b}" "${c}" has not been declared in the root module.` }
  return { summary: 'Reference to undeclared resource', detail: `A managed resource "${a}" "${b}" has not been declared in the root module.` }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

function duplicate(prev: GNode, address: string, kind: NodeKind, file: string, pos: Pos): Diagnostic {
  const at = `${prev.file}:${prev.pos.line},${prev.pos.col}`
  const [type, name] = address.replace(/^data\./, '').split('.')
  const mk = (summary: string, detail: string): Diagnostic => ({ severity: 'error', summary, detail, file, line: pos.line, col: pos.col })
  if (kind === 'resource') return mk(`Duplicate resource "${type}" configuration`, `A ${type} resource named "${name}" was already declared at ${at}. Resource names must be unique per type in each module.`)
  if (kind === 'data') return mk(`Duplicate data "${type}" configuration`, `A ${type} data resource named "${name}" was already declared at ${at}. Resource names must be unique per type in each module.`)
  const word = kind === 'variable' ? 'variable' : kind === 'local' ? 'local value' : kind
  return mk(`Duplicate ${word} ${kind === 'local' ? 'definition' : 'declaration'}`, `A ${word} named "${name}" was already declared at ${at}. ${cap(word)} names must be unique within a module.`)
}

export function buildGraph(files: { name: string; text: string }[]): Graph {
  const diagnostics: Diagnostic[] = []
  const blocks: Block[] = []
  for (const f of files) {
    const r = parseHcl(f.name, f.text)
    blocks.push(...r.blocks)
    diagnostics.push(...r.diagnostics)
  }

  const nodes = new Map<string, GNode>()
  const put = (address: string, kind: NodeKind, file: string, pos: Pos, refs: Ref[], block?: Block, value?: Expr) => {
    const prev = nodes.get(address)
    if (prev) diagnostics.push(duplicate(prev, address, kind, file, pos))
    else nodes.set(address, { address, kind, file, pos, block, value, refs, deps: [] })
  }

  for (const b of blocks) {
    if (b.type === 'locals') {
      for (const a of b.attrs) {
        const refs: Ref[] = []
        exprRefs(a.value, refs)
        put(`local.${a.name}`, 'local', b.file, a.pos, refs, undefined, a.value)
      }
      continue
    }
    const d = DECL[b.type]
    if (!d) continue // provider, terraform, moved, import, removed: not graph nodes
    const [kind, n] = d
    if (b.labels.length !== n) {
      diagnostics.push({ severity: 'error', summary: `Invalid ${b.type} block`, detail: `A ${b.type} block requires exactly ${n} label${n > 1 ? 's' : ''}.`, file: b.file, line: b.pos.line, col: b.pos.col })
      continue
    }
    const refs: Ref[] = []
    blockRefs(b, refs, true)
    put(PREFIX[kind] + b.labels.join('.'), kind, b.file, b.pos, refs, b)
  }

  // Resolve references into dependencies.
  for (const node of [...nodes.values()].sort((x, y) => x.address.localeCompare(y.address))) {
    const deps = new Set<string>()
    for (const ref of node.refs) {
      const r = resolve(ref.path)
      if (!r) continue
      const bad = 'want' in r ? (nodes.has(r.want) ? undefined : missing(ref.path)) : r
      if (bad) diagnostics.push({ severity: 'error', ...bad, file: node.file, line: ref.pos.line, col: ref.pos.col })
      else if ('want' in r) deps.add(r.want)
    }
    node.deps = [...deps].sort()
  }

  // Order dependencies first; what can't be ordered is in, or after, a cycle.
  const left = new Map<string, number>()
  const users = new Map<string, string[]>()
  for (const node of nodes.values()) {
    left.set(node.address, node.deps.length)
    for (const d of node.deps) users.set(d, [...(users.get(d) ?? []), node.address])
  }
  const ready = [...nodes.keys()].filter((a) => left.get(a) === 0)
  const order: string[] = []
  while (ready.length) {
    ready.sort()
    const a = ready.shift()!
    order.push(a)
    for (const u of users.get(a) ?? []) {
      const k = left.get(u)! - 1
      left.set(u, k)
      if (k === 0) ready.push(u)
    }
  }
  if (order.length < nodes.size) {
    const stuck = new Set([...nodes.keys()].filter((a) => !order.includes(a)))
    // Drop what merely waits on the cycle (nothing in the set depends on it).
    for (let changed = true; changed; ) {
      changed = false
      for (const a of stuck) {
        if (!(users.get(a) ?? []).some((u) => stuck.has(u))) {
          stuck.delete(a)
          changed = true
        }
      }
    }
    diagnostics.push({ severity: 'error', summary: `Cycle: ${[...stuck].sort().join(', ')}`, detail: '', file: '', line: 0, col: 0 })
    return { nodes, order: [], diagnostics }
  }
  return { nodes, order, diagnostics }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/terraform-graph.test.ts && npx tsc -b`
Expected: PASS, and `tsc` prints nothing. If the `CHAIN` order test fails, check that `local.tags` is `deps: ['var.region']` (the `var.region` reference sits inside an object value).

- [ ] **Step 5: Commit**

```bash
git add src/game/terraform/graph.ts tests/terraform-graph.test.ts
git commit -m "feat: Terraform resource graph with dependencies and cycle detection (TF1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Log unverified wording, full check

**Files:**
- Modify: `CONTENT_TODO.md` (append a section)

- [ ] **Step 1: Append to `CONTENT_TODO.md`**

```markdown

## terraform simulator (diagnostics, TF1)
Wording the parser and graph print that is representative, not copied from the docs. Check against a real run.
- [ ] The boxed error layout (`╷`/`│`/`╵`, `on FILE line N, in resource "a" "b":`, the right-aligned source line number) and the 76-column wrap of the detail text.
- [ ] `Argument or block definition required`, `Unclosed configuration block`, `Attribute redefined`, `Missing newline after argument` / `block`, `Unsupported argument` (top-level), `Invalid character`: summaries are from experience; detail strings are paraphrased.
- [ ] String and comment errors: `Unterminated template string`, `Unterminated comment`, `Unterminated heredoc`, `Unterminated template interpolation`, `Invalid escape sequence`.
- [ ] `Reference to undeclared resource` / `input variable` / `local value` / `module`, `Invalid reference`: the resource and variable detail strings match the Terraform language docs closely; the local, module and data ones are paraphrased.
- [ ] `Duplicate resource "T" configuration` and the variable, output, local and module duplicate messages: real ones also print an end column (`main.tf:1,1-27`); this prints only line,col.
- [ ] `Cycle: a, b`: modern Terraform may add `(expand)` suffixes or list more nodes; the node list order is sorted here.
- [ ] `Invalid <type> block` for a wrong label count: real Terraform has separate `Missing name for resource` / `Extraneous label` messages.
- [ ] Unsupported on purpose (reported as `Unsupported ...`): `for` expressions, splats, template directives (`%{ }`).
```

- [ ] **Step 2: Run the full check**

Run: `npm test 2>&1 | tail -15 && npm run lint 2>&1 | tail -5 && npx tsc -b`
Expected: all test files PASS (the existing suite plus the four new `terraform-*.test.ts` files), lint clean, `tsc` silent. Do not edit unrelated failing tests; report them.

- [ ] **Step 3: Commit**

```bash
git add CONTENT_TODO.md
git commit -m "docs: log unverified Terraform diagnostic wording (TF1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done)

- **Spec coverage:** TF1 in the spec is "HCL parser and graph, no UI". Blocks listed in the spec (`terraform`, `provider`, `resource`, `data`, `variable`, `locals`, `output`, `module`, `moved`, `import`, `removed`) all parse via the generic block grammar; `lifecycle` arguments parse as ordinary nested blocks and arguments (TF2 interprets them). Expressions: literals, references, `count`/`each`/`var`/`local` (as references), interpolation, function calls (names are not allowlisted here; the TF2 evaluator owns the function allowlist and reports unsupported functions). Unsupported syntax gives `Unsupported ...`. Cycles give `Cycle:`. Parser errors carry line, column and context. The spec's error formatting is covered by `diag.ts`. Not in TF1 by design: state, plan, apply, CLI.
- **Placeholders:** none. **Type consistency:** `Block`, `Expr`, `Diagnostic`, `Ref`, `GNode`, `Graph` names match across tasks; `parseHcl`, `buildGraph`, `formatDiagnostic`, `wrap`, `lex`, `template` signatures match their consumers.
- **Review Focus:** all five lines have a named test (CRLF/BOM: Tasks 1 and 2; empty file: Task 2; `ignore_changes`, `each`/`provider`, self-cycle: Task 5).
