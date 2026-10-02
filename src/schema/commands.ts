// The command library behind the after-action "Command breakdown"
// (PLAN_COMMAND_BREAKDOWN.md). One entry explains a family of commands: the
// build matches every incident's terminal commands against `match`, and each
// incident's chunk carries only the entries it uses.

import { z } from 'zod'
import { id } from './scenario.ts'

export const CommandEntrySchema = z
  .strictObject({
    id,
    match: z.string().min(1), // regex over the command (spaces collapsed); first matching entry wins
    summary: z.string().min(1), // what it does, one or two sentences
    // Every flag, argument, filter or regex worth explaining, in order.
    parts: z.array(z.strictObject({ token: z.string().min(1), meaning: z.string().min(1) })).min(1),
    why: z.string().min(1), // why it's the right tool for this kind of question
    alternatives: z.array(z.strictObject({ command: z.string().min(1), note: z.string().min(1) })).min(1),
    docs: z.strictObject({ title: z.string().min(1), url: z.url() }),
  })
  .superRefine((e, ctx) => {
    try {
      new RegExp(e.match)
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: `invalid regex: ${(err as Error).message}`, path: ['match'], input: e })
    }
  })

export const CommandLibrarySchema = z.array(CommandEntrySchema).min(1)

export type CommandEntry = z.infer<typeof CommandEntrySchema>

// What one incident's debrief needs: its commands, which library entry
// explains each, and why each is listed (key evidence, verification).
export type Breakdown = {
  commands: { command: string; entry: string; key: boolean; verify: boolean }[]
  entries: Record<string, CommandEntry>
}
