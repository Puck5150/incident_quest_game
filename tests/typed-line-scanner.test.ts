// The typed-line scanner against real bash, the SQL rules, prompt classification and the allow_shell regex check.
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { actionFor, quoteHint } from '../src/game/engine.ts'
import { typedMode } from '../src/game/paths.ts'
import { hasUnsafeSyntax, looseAllowShellRegex, onlyNeedsQuoting, shellWords } from '../src/game/typedLine.ts'
import { atStage } from '../src/schema/stages.ts'

const scenarios = loadContent(path.resolve(import.meta.dirname, '../content')).scenarios
const byId = (id: string) => scenarios.find((s) => s.id === id)!

describe('prompt classification is explicit: SQL only for SQL prompts, shell otherwise', () => {
  const expected = new Map<string, string>([
    ['postgres=#', 'sql'],
    ['postgres=# (on the primary)', 'sql'],
    ['shop=>', 'sql'],
    ['mysql>', 'mysql'],
  ])
  const prompts = new Set(scenarios.map((s) => s.terminal?.prompt).filter((p): p is string => !!p))
  for (const p of prompts)
    it(`${p}`, () => {
      const sc = scenarios.find((s) => s.terminal?.prompt === p)!
      expect(typedMode(sc)).toBe(expected.get(p) ?? 'shell')
    })
  it('the two prompts that looked like SQL are shells: operators and globs are rejected there', () => {
    for (const id of ['azure-private-endpoint-dns', 'selinux-file-context']) {
      const sc = byId(id)
      expect(typedMode(sc), id).toBe('shell')
      for (const bad of ['ls | id', 'ls & id', 'ls > f', 'ls < f', 'ls *', 'ls {a,b}']) expect(hasUnsafeSyntax(bad, typedMode(sc)), `${id}: ${bad}`).toBe(true)
    }
  })
  it('every explicit SQL prompt in the table exists in content (so the table cannot go stale)', () => {
    for (const p of expected.keys()) expect(prompts.has(p), p).toBe(true)
  })
})

describe('double quotes and assignment tildes, unicode spaces', () => {
  it('rejects $ + digit/special inside double quotes, =~ in assignment words, and unicode spaces', () => {
    for (const bad of ['a "$1"', 'a "$?"', 'a "$*"', 'a "$@"', 'a "$#"', 'a "$!"', 'a "$$"', 'a "$-"', 'a=~ b', 'a=x:~ b', 'a b', 'a b', 'a b'])
      expect(hasUnsafeSyntax(bad), JSON.stringify(bad)).toBe(true)
    for (const ok of ['a "$"', 'a "5$"', 'a "$ x"', 'a --p=~x'.replace('~x', 'x'), 'a "=~"', "a '=~'"]) expect(hasUnsafeSyntax(ok), ok).toBe(false)
  })
})

describe('SQL prompts follow SQL quoting, not shell quoting', () => {
  const sql = (l: string) => hasUnsafeSyntax(l, 'sql')
  it('comments may hold apostrophes; strings and identifiers hold operators', () => {
    expect(sql("select 1 -- it's")).toBe(false)
    expect(sql("select 1; -- it's")).toBe(false)
    expect(sql("select /* it's ; */ 1")).toBe(false)
    expect(sql("select 'a;b', \"c;d\" from t where x <> 1 and y || 'z' = 'q'")).toBe(false)
    expect(sql("select 'it''s; fine'")).toBe(false)
    expect(sql('select "a""; b"')).toBe(false)
    expect(sql('select 1;')).toBe(false)
    expect(sql('select 1 ;  ')).toBe(false)
  })
  it('a real second statement, however it is disguised, is rejected', () => {
    expect(sql('select "a\\"; drop table t; -- "')).toBe(true) // Postgres: the identifier ends at the second ", so ; drop table t; is real
    expect(sql('select 1; drop table t')).toBe(true)
    expect(sql('select 1; /* c */ drop table t')).toBe(true)
    expect(sql("select 'a'; select 'b'")).toBe(true)
    expect(sql("select 'unterminated")).toBe(true)
    expect(sql('select /* unterminated')).toBe(true)
    expect(sql('select 1\ndrop table t')).toBe(true)
    expect(sql('\\! id')).toBe(true) // psql meta-command
    expect(sql('do $$ begin perform 1; end $$')).toBe(true)
  })
  it('MySQL: backslash escapes inside strings, # comments, backtick identifiers', () => {
    const my = (l: string) => hasUnsafeSyntax(l, 'mysql')
    expect(my("select 'a\\'; drop table t; -- '")).toBe(false) // \' is an escaped quote: the whole thing is one string... up to the final quote
    expect(my("select 'a'; drop table t")).toBe(true)
    expect(my('select 1 # it\'s')).toBe(false)
    expect(my('select `a;b` from t')).toBe(false)
  })
})

describe('allow_shell regex check: classes, ranges, lookarounds, linear time', () => {
  it('rejects classes that can carry operators', () => {
    for (const rx of ['^a[\\S]$', '^a[\\W]$', '^a[\\D]$', '^a[ -~]$', '^a[;]$', '^a[\\x00-\\x7f]$'.replace('\\x00-\\x7f', ' -\\x7f'), '^a(?=b)b$', '^a(?!b)c$', '^a(?<=a)b$', '^a\\p{L}$', '^a[^b]$', '^a[abc$', '^a[<->]$'])
      expect(looseAllowShellRegex(rx), rx).toBeTypeOf('string')
  })
  it('accepts ordinary pinned classes and groups', () => {
    for (const rx of ['^a[0-9A-Za-z_-]+$', '^(?:a|b)[.]c$', '^a[ =]b$', '^a \\$HOME$']) expect(looseAllowShellRegex(rx), rx).toBeUndefined()
  })
  it('is linear on many unclosed [', () => {
    const t = Date.now()
    expect(looseAllowShellRegex('^' + '['.repeat(200000))).toBeTypeOf('string')
    expect(Date.now() - t).toBeLessThan(1000)
  })
})

describe('the quote hint', () => {
  const sc = byId('gcp-lifecycle-deleted-objects')
  const base = 'gcloud storage restore'
  const flags = '--async --deleted-after-time=2026-09-30T16:40:00Z'
  it('canonical quoted form is credited; the unquoted form is not, and says why', () => {
    const cur = atStage(sc, 0)
    expect(actionFor(cur, `${base} "gs://acme-user-docs/**" ${flags}`)?.id).toBe('bulk-restore')
    expect(actionFor(cur, `${base} 'gs://acme-user-docs/**' ${flags}`)?.id).toBe('bulk-restore')
    expect(actionFor(cur, `${base} gs://acme-user-docs/** ${flags}`)).toBeUndefined()
    expect(onlyNeedsQuoting(`${base} gs://acme-user-docs/** ${flags}`)).toBe(true)
    expect(quoteHint(cur, `${base} gs://acme-user-docs/** ${flags}`)).toMatch(/Quote that argument/)
  })
  it('no hint when something else is wrong or nothing would be credited', () => {
    const cur = atStage(sc, 0)
    expect(quoteHint(cur, `${base} gs://acme-user-docs/** ${flags}; id`)).toBeUndefined()
    expect(quoteHint(cur, 'ls *')).toBeUndefined()
    expect(quoteHint(cur, `${base} "gs://acme-user-docs/**" ${flags}`)).toBeUndefined()
  })
})

// Ground truth: whatever the scanner calls safe must reach a command as exactly the words it reports.
describe('scanner agrees with real bash', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'scan-'))
  const bashWords = (line: string) => execFileSync('bash', ['-c', `printf '<%s>' ${line}`], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
  const check = (line: string) => {
    if (hasUnsafeSyntax(line)) return
    const w = shellWords(line.trim().replace(/;$/, ''))
    if (!w.length) return
    expect(bashWords(line.trim().replace(/;$/, '')), JSON.stringify(line)).toBe(w.map((x) => `<${x}>`).join(''))
  }
  it('curated lines', () => {
    for (const l of ['a b', "a 'b c' d", 'a "b c" d', 'a\\ b', 'a "x \\" y"', 'a "x\\y"', 'a --p="q r"', "a 'it'\"'\"'s'", 'a "~ # *"', 'a b#c', 'a --p=~x', 'a { 6379 }', 'a "$"', 'a \\$HOME', 'a "5$"', 'a --x=1,2', 'a b;', "a ''", 'a "" b'])
      check(l)
  })
  it('random lines from a hostile alphabet (seeded)', () => {
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const alphabet = ['a', 'b', ' ', ' ', "'", '"', '\\', '$', ';', '&', '|', '<', '>', '*', '?', '[', ']', '~', '=', '#', '{', '}', ',', '-', '!', '(', ')']
    let safe = 0
    for (let n = 0; n < 1500; n++) {
      const len = 1 + Math.floor(rnd() * 9)
      const line = Array.from({ length: len }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('')
      if (!hasUnsafeSyntax(line) && shellWords(line).length) {
        safe++
        check(line)
      }
    }
    expect(safe).toBeGreaterThan(100) // the corpus really exercised the safe path
  }, 60000)
})
