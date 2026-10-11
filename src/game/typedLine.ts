// What a typed line may contain to earn an action (AUTHORING.md "What a typed line may contain").
// ONE scanner does quoting, escaping and operator detection together, so the guard, the repeated-flag
// check and the scripted-command "is this a pipeline?" test all read the line the way bash does.

type Scan = { ops: boolean; bad: boolean; glob: boolean; tokens: string[] }

// bash-like words: backslash escapes the next char (outside single quotes, and for $ ` " \ inside double
// quotes), single quotes are literal, double quotes keep their content but expansions in them are unsafe.
// `ops`: an unquoted, unescaped ; & | < >. `bad`: anything else the shell would do beyond passing words
// (substitution, ANSI-C $'..', backticks, unterminated quote, trailing backslash, whitespace bash treats
// differently from the regex view). `glob` (only with `strict`): unquoted globs/braces/~/# that bash would
// expand: fixable by quoting, so it is reported apart (see quoteHint). Tokens have quotes and escapes removed.
function scan(line: string, strict: boolean, opChars = ';&|<>'): Scan {
  const tokens: string[] = []
  let cur: string | undefined
  let ops = false
  let glob = false
  // newline, NBSP and other unicode spaces: bash keeps most of them in a word while normalize() splits there.
  let bad = /[^\S \t]/.test(line)
  const end = () => {
    if (cur !== undefined) tokens.push(cur)
    cur = undefined
  }
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\') {
      if (i + 1 >= line.length) {
        bad = true
        break
      }
      cur = (cur ?? '') + line[++i]
    } else if (ch === "'") {
      const j = line.indexOf("'", i + 1)
      if (j < 0) {
        bad = true
        break
      }
      cur = (cur ?? '') + line.slice(i + 1, j)
      i = j
    } else if (ch === '"') {
      let s = ''
      let k = i + 1
      for (; k < line.length && line[k] !== '"'; k++) {
        const c = line[k]
        if (c === '\\' && k + 1 < line.length) {
          if ('$`"\\'.includes(line[k + 1])) s += line[++k]
          else s += c
        } else if (c === '`' || (c === '$' && /[({\w?*@#!$-]/.test(line[k + 1] ?? ''))) bad = true
        else s += c
      }
      if (k >= line.length) {
        bad = true
        break
      }
      cur = (cur ?? '') + s
      i = k
    } else if (ch === ' ' || ch === '\t') end()
    else if (opChars.includes(ch)) {
      ops = true
      end()
    } else if (ch === '$' || ch === '`' || ch === '(' || ch === ')') bad = true // (..) is a subshell, and a stray one is a syntax error
    else if (strict && '{}'.includes(ch) && !(cur === undefined && /^ ?$/.test(line[i + 1] ?? ''))) glob = true // `{ 6379 }` (nft) is a word of its own; `{a,b}` expands
    else if (strict && ('*?['.includes(ch) || (cur === undefined && (ch === '~' || ch === '#')))) glob = true
    else if (strict && ch === '~' && /^[A-Za-z_]\w*=([^]*:)?$/.test(cur ?? '')) glob = true // NAME=~ and NAME=a:~ expand in assignment-like words
    else cur = (cur ?? '') + ch
  }
  end()
  return { ops, bad, glob, tokens }
}

// Whether a line uses shell operators (pipes, lists, redirection) outside quotes.
export const hasShellOperators = (cmd: string): boolean => scan(cmd, false).ops

// Terminal kinds: a shell (default), or a SQL client where the line is statements, not a command line.
export type Mode = 'shell' | 'sql' | 'mysql'

// SQL at a database prompt: no shell, so the danger is a second statement. Quoting is SQL's: '..' strings
// with '' for a quote, ".." identifiers with "" for a quote, no backslash escapes (MySQL: inside strings
// only), `--` and `/* */` comments (MySQL also `#`), `;` only as the last significant thing.
function sqlUnsafe(line: string, mysql: boolean): boolean {
  if (/[^\S ]/.test(line)) return true // newlines and odd spaces
  let semi = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    const two = line.slice(i, i + 2)
    if (ch === ' ') continue
    if (two === '--' && (!mysql || line[i + 2] === ' ' || i + 2 >= line.length) || (mysql && ch === '#')) break // comment to the end of the line
    if (two === '/*') {
      const j = line.indexOf('*/', i + 2)
      if (j < 0) return true
      i = j + 1
      continue
    }
    if (semi) return true // something after a `;`
    if (ch === ';') semi = true
    else if (ch === '$') return true // $$ and $tag$ quoting hide statements
    else if (ch === '\\') return true // psql meta-command (\!) or a stray escape
    else if (ch === "'" || ch === '"' || (mysql && ch === '`')) {
      let k = i + 1
      for (; k < line.length; k++) {
        if (mysql && ch !== '`' && line[k] === '\\') k++
        else if (line[k] === ch) {
          if (line[k + 1] === ch) k++ // doubled quote
          else break
        }
      }
      if (k >= line.length) return true
      i = k
    }
  }
  return false
}

// Not ONE plain command: operators, substitutions, expansions, newlines, broken quoting. One closing `;` is
// allowed (it does nothing in a shell). In a shell, unquoted `{ } * ? [` and a leading `~` or `#` are
// expansions too (`glob`). Mode 'sql'/'mysql': see sqlUnsafe.
export function hasUnsafeSyntax(line: string, mode: Mode | boolean = 'shell'): boolean {
  const m: Mode = mode === true ? 'shell' : mode === false ? 'sql' : mode
  if (m !== 'shell') return sqlUnsafe(line.trim(), m === 'mysql')
  const s = scan(line.trim().replace(/;$/, ''), true)
  return s.ops || s.bad || s.glob
}

// True when the ONLY thing wrong with a shell line is an unquoted glob/brace/~/#, so quoting would fix it.
export function onlyNeedsQuoting(line: string): boolean {
  const s = scan(line.trim().replace(/;$/, ''), true)
  return s.glob && !s.ops && !s.bad
}

// The words bash would pass to a command for a line (quotes and escapes removed); meaningful only for a safe line.
export const shellWords = (line: string): string[] => scan(line, false).tokens

// A `--flag` (or `-x`) given twice: the real CLI takes the last value, a regex saw the first. Words come
// from the same scanner, so a quoted value (`--msg="a --a b"`) is one word; after a bare `--` nothing is a flag.
export function repeatsFlag(cmd: string): boolean {
  const seen = new Set<string>()
  for (const tok of scan(cmd, false).tokens) {
    if (tok === '--') return false
    const m = /^(--[A-Za-z][\w-]*|-[A-Za-z])(?:=|$)/.exec(tok)
    if (!m) continue
    if (seen.has(m[1])) return true
    seen.add(m[1])
  }
  return false
}

// `allow_shell` is safe only when the regex pins the whole line: every top-level `|` branch starts with `^`
// and ends with an unescaped `$`, and nothing in it can match text beyond what is spelled out: no unescaped
// `.`, `\S \W \D \P \p` (alone or in a class), negated class, class with an operator character or a range
// spanning one (`[ -~]`), and no lookahead/lookbehind. One linear pass. Returns the problem, or undefined.
export function looseAllowShellRegex(src: string): string | undefined {
  const OPS = ';&|<>$`\n\r'
  let depth = 0
  let cls = false
  let branch = 0 // start of the current top-level branch
  const branchOk = (end: number) => {
    const b = src.slice(branch, end)
    return b.startsWith('^') && /(^|[^\\])(\\\\)*\$$/.test(b) ? undefined : `every | branch must start with ^ and end with an unescaped $ (found "${b}")`
  }
  const wide = 'a can match operators: spell the text out'
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      const n = src[++i]
      if (n === undefined) return 'a trailing backslash'
      if ('SWDPp'.includes(n)) return `\\${n} ${wide}`
      if (cls && OPS.includes(n)) return 'a class holding an operator character'
    } else if (cls) {
      if (c === ']') cls = false
      else if (OPS.includes(c)) return 'a class holding an operator character'
      else if (c === '-' && i > 0 && src[i - 1] !== '[' && src[i + 1] !== ']' && src[i + 1] !== undefined) {
        const lo = src[i - 1].charCodeAt(0)
        const hi = (src[i + 1] === '\\' ? src[i + 2] ?? '' : src[i + 1]).charCodeAt(0)
        if ([...OPS].some((o) => o.charCodeAt(0) >= lo && o.charCodeAt(0) <= hi)) return 'a class range spanning operator characters'
      }
    } else if (c === '[') {
      cls = true
      if (src[i + 1] === '^') return `a negated class [^…] ${wide}`
    } else if (c === '(') {
      depth++
      if (src[i + 1] === '?' && /[=!]|<[=!]/.test(src.slice(i + 2, i + 4))) return 'lookahead/lookbehind'
    } else if (c === ')') depth--
    else if (c === '.') return `an unescaped . ${wide}`
    else if (c === '|' && depth === 0) {
      const bad = branchOk(i)
      if (bad) return bad
      branch = i + 1
    }
  }
  if (cls) return 'an unclosed [ class'
  return branchOk(src.length)
}
