// What a typed line may contain to earn an action (AUTHORING.md "What a typed line may contain").
// ONE scanner does quoting, escaping and operator detection together, so the guard, the repeated-flag
// check and the scripted-command "is this a pipeline?" test all read the line the way bash does.

type Scan = { ops: boolean; bad: boolean; tokens: string[] }

// bash-like words: backslash escapes the next char (outside single quotes, and for $ ` " \ inside double
// quotes), single quotes are literal, double quotes keep their content but expansions in them are unsafe.
// `ops`: an unquoted, unescaped ; & | < >. `bad`: anything else the shell would do beyond passing words
// (substitution, ANSI-C $'..', backticks, unterminated quote or trailing backslash; and, with `strict`,
// unquoted globs/braces/~user/#comment). Tokens have their quotes and escapes removed.
function scan(line: string, strict: boolean, opChars = ';&|<>'): Scan {
  const tokens: string[] = []
  let cur: string | undefined
  let ops = false
  let bad = /[\n\r]/.test(line)
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
        } else if (c === '`' || (c === '$' && /[({A-Za-z_]/.test(line[k + 1] ?? ''))) bad = true
        else s += c
      }
      if (k >= line.length) {
        bad = true
        break
      }
      cur = (cur ?? '') + s
      i = k
    } else if (/\s/.test(ch)) end()
    else if (opChars.includes(ch)) {
      ops = true
      end()
    } else if (ch === '$' || ch === '`') bad = true
    else if (strict && '{}'.includes(ch) && !(cur === undefined && /^\s?$/.test(line[i + 1] ?? ''))) bad = true // `{ 6379 }` (nft) is a word of its own; `{a,b}` expands
    else if (strict && ('*?['.includes(ch) || (cur === undefined && (ch === '~' || ch === '#')))) bad = true
    else cur = (cur ?? '') + ch
  }
  end()
  return { ops, bad, tokens }
}

// Whether a line uses shell operators (pipes, lists, redirection) outside quotes.
export const hasShellOperators = (cmd: string): boolean => scan(cmd, false).ops

// Not ONE plain command: operators, substitutions, expansions, newlines, broken quoting. One closing `;`
// is allowed (it ends a SQL statement and does nothing in a shell). `shell`: the terminal is a real shell,
// where unquoted `{ } * ? [` and a leading `~` or `#` are expansions too. At a SQL prompt there is no shell:
// `& | < >` are SQL operators (`status <> 'void'`) and only a second statement (`;`) is compound.
export function hasUnsafeSyntax(line: string, shell = true): boolean {
  const s = scan(line.trim().replace(/;$/, ''), shell, shell ? undefined : ';')
  return s.ops || s.bad
}

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
// and ends with an unescaped `$`, and none can match arbitrary text (an unescaped `.`, `\S`, `\W`, `\D` or a
// negated class would let `;id` ride along). Returns the problem, or undefined if strict.
export function looseAllowShellRegex(src: string): string | undefined {
  const branches: string[] = []
  let depth = 0
  let cls = false
  let from = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') i++
    else if (cls) cls = c !== ']'
    else if (c === '[') {
      cls = true
      if (src[i + 1] === '^') return 'a negated class [^…] can match operators'
    } else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === '|' && depth === 0) {
      branches.push(src.slice(from, i))
      from = i + 1
    }
  }
  branches.push(src.slice(from))
  for (const b of branches) {
    if (!b.startsWith('^') || !/(^|[^\\])(\\\\)*\$$/.test(b)) return `every | branch must start with ^ and end with an unescaped $ (found "${b}")`
    if (/(^|[^\\])(\\\\)*\.|\\[SWD]/.test(b.replace(/\[(?:\\.|[^\]\\])*\]/g, ''))) return 'an unescaped . or \\S, \\W, \\D can match operators: spell the text out'
  }
  return undefined
}
