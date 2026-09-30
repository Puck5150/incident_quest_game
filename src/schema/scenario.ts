// Single source of truth for what a scenario file may contain.
// The TypeScript types below are inferred from these schemas, so the
// validator and the types can never disagree.
//
// Checks that span MULTIPLE files (track exists, ids unique, id matches
// filename) live in vite-plugin-content.ts, because a single schema only
// ever sees one file.

import { z } from 'zod'

const id = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be kebab-case (a-z, 0-9, dashes)')

// `evidence` tags mark artifacts that matter for the diagnosis. Scoring and
// the debrief use them to show what the player found vs. missed.
const evidenceTag = id.optional()

const terminalCommand = z
  .strictObject({
    match: z.string().min(1).optional(),
    match_regex: z.string().min(1).optional(),
    when_actions: z.array(id).optional(),
    evidence: evidenceTag,
    output: z.string(),
  })
  .refine((c) => (c.match === undefined) !== (c.match_regex === undefined), {
    message: 'set exactly one of `match` or `match_regex`',
  })

export const TrackSchema = z.strictObject({
  id,
  name: z.string().min(1),
  requires: z.array(id),
})

export const ScenarioSchema = z
  .strictObject({
    id,
    track: id,
    difficulty: z.int().min(1).max(5),
    title: z.string().min(1),
    par_minutes: z.number().positive(),

    ticket: z.strictObject({
      from: z.string().min(1),
      priority: z.enum(['P1', 'P2', 'P3', 'P4']),
      body: z.string().min(1),
    }),
    environment: z.string().min(1),

    terminal: z
      .strictObject({
        prompt: z.string().min(1),
        commands: z.array(terminalCommand).min(1),
        unknown_output: z.string().optional(),
      })
      .optional(),
    logs: z
      .array(z.strictObject({ name: z.string().min(1), evidence: evidenceTag, lines: z.string() }))
      .optional(),
    files: z
      .array(
        z.strictObject({
          path: z.string().min(1),
          language: z.string().default('text'),
          evidence: evidenceTag,
          content: z.string(),
        }),
      )
      .optional(),
    diagram: z
      .strictObject({
        nodes: z.array(
          z.strictObject({
            id,
            label: z.string().min(1),
            col: z.int().min(0),
            row: z.int().min(0),
            status: z.enum(['ok', 'degraded', 'down']),
          }),
        ),
        edges: z.array(z.strictObject({ from: id, to: id })),
      })
      .optional(),

    hypotheses: z
      .array(
        z.strictObject({
          id,
          text: z.string().min(1),
          correct: z.boolean().default(false),
          feedback: z.string().optional(),
        }),
      )
      .min(2),
    actions: z
      .array(
        z.strictObject({
          id,
          label: z.string().min(1),
          kind: z.enum(['fix', 'wrong', 'destructive']),
          feedback: z.string().min(1),
        }),
      )
      .min(2),
    solution_paths: z.array(z.array(id).min(1)).min(1),
    key_evidence: z.array(id).min(1),

    hints: z.strictObject({
      nudge: z.string().min(1),
      direction: z.string().min(1),
      answer: z.string().min(1),
    }),
    analogy: z.strictObject({ title: z.string().min(1), text: z.string().min(1) }),
    debrief: z.strictObject({
      root_cause: z.string().min(1),
      ideal_path: z.array(z.string().min(1)).min(1),
      real_world: z.string().optional(),
    }),
    sources: z
      .array(
        z.strictObject({
          title: z.string().min(1),
          url: z.url(),
          // YAML 1.2 parses 2026-09-30 as a string, so validate the string.
          retrieved: z.iso.date(),
        }),
      )
      .min(1),
  })
  // Cross-references inside one file. These catch typos that would otherwise
  // produce an incident nobody can finish.
  .superRefine((s, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path, input: s })

    const actionIds = new Set(s.actions.map((a) => a.id))
    const fixIds = new Set(s.actions.filter((a) => a.kind === 'fix').map((a) => a.id))
    const evidence = new Set(
      [...(s.terminal?.commands ?? []), ...(s.logs ?? []), ...(s.files ?? [])]
        .map((a) => a.evidence)
        .filter(Boolean),
    )

    dupes(s.actions.map((a) => a.id)).forEach((d) => issue(`duplicate action id "${d}"`, ['actions']))
    dupes(s.hypotheses.map((h) => h.id)).forEach((d) => issue(`duplicate hypothesis id "${d}"`, ['hypotheses']))

    const correct = s.hypotheses.filter((h) => h.correct).length
    if (correct !== 1) issue(`exactly one hypothesis must be correct (found ${correct})`, ['hypotheses'])

    s.solution_paths.forEach((path, i) =>
      path.forEach((a, j) => {
        if (!fixIds.has(a)) issue(`"${a}" is not an action with kind: fix`, ['solution_paths', i, j])
      }),
    )
    const inSomePath = new Set(s.solution_paths.flat())
    fixIds.forEach((f) => {
      if (!inSomePath.has(f)) issue(`fix action "${f}" is not in any solution path`, ['actions'])
    })

    s.terminal?.commands.forEach((c, i) => {
      c.when_actions?.forEach((a) => {
        if (!actionIds.has(a)) issue(`unknown action "${a}"`, ['terminal', 'commands', i, 'when_actions'])
      })
      if (c.match_regex !== undefined) {
        try {
          new RegExp(c.match_regex)
        } catch (e) {
          issue(`invalid regex: ${(e as Error).message}`, ['terminal', 'commands', i, 'match_regex'])
        }
      }
    })

    s.key_evidence.forEach((e, i) => {
      if (!evidence.has(e)) issue(`no artifact is tagged with evidence "${e}"`, ['key_evidence', i])
    })

    if (s.diagram) {
      const nodes = new Set(s.diagram.nodes.map((n) => n.id))
      s.diagram.edges.forEach((e, i) => {
        if (!nodes.has(e.from) || !nodes.has(e.to)) issue('edge points at an unknown node', ['diagram', 'edges', i])
      })
    }
  })

function dupes(xs: string[]): string[] {
  return [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))]
}

export type Scenario = z.infer<typeof ScenarioSchema>
export type Track = z.infer<typeof TrackSchema>
export type Action = Scenario['actions'][number]
