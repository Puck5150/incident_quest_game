import type { Action } from '../schema/scenario.ts'
import { ingressPolicyOk } from './vpcscIngress.ts'

// Whether a file's text counts as fixed for a `file` action: it matches the regex and, when the
// action names a structural check, passes it.
export const fileFixed = (f: NonNullable<Action['file']>, text: string) =>
  new RegExp(f.matches, 'm').test(text) && (f.ingress_policy === undefined || ingressPolicyOk(text, f.ingress_policy))

// A file-gated typed fix (`requires_file`): the file's text passes the action's check.
export const gateOk = (rf: NonNullable<Action['requires_file']>, text: string) => ingressPolicyOk(text, rf.ingress_policy)

// The typed command points at the gate's file: some word (a bare word, or the value of --flag=value),
// without quotes, ends in the file's name and resolves, from the shell's cwd and home, to exactly that path.
export function commandNamesFile(cmd: string, path: string, cwd: string, home: string): boolean {
  const norm = (p: string) => {
    const out: string[] = []
    for (const seg of p.split('/')) {
      if (seg === '..') out.pop()
      else if (seg !== '' && seg !== '.') out.push(seg)
    }
    return '/' + out.join('/')
  }
  return cmd.split(' ').some((w) => {
    const word = w.replace(/^--[\w-]+=/, '').replace(/^["']|["']$/g, '')
    if (!word || word.startsWith('-')) return false
    const abs = word.startsWith('/') ? word : word === '~' || word.startsWith('~/') ? home + word.slice(1) : `${cwd}/${word}`
    return norm(abs) === path
  })
}
