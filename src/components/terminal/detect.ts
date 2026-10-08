import type { Action, Predicate } from '../../schema/scenario.ts'

// Whether the world shows an action as done, so the terminal can take it: it
// needs a `file` or `done_when` (or both), and every one it has must hold.
// Taken actions are never checked; `done_when` is checked only after the
// cheaper `file` test passed.
export async function detectAction(
  a: Pick<Action, 'id' | 'file' | 'done_when'>,
  check: { taken: Set<string>; fileMatches: (file: NonNullable<Action['file']>) => Promise<boolean>; doneWhen: (p: Predicate) => Promise<boolean> },
): Promise<boolean> {
  if (check.taken.has(a.id) || (!a.file && !a.done_when)) return false
  if (a.file && !(await check.fileMatches(a.file))) return false
  return !a.done_when || (await check.doneWhen(a.done_when))
}
