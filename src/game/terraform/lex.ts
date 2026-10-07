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
