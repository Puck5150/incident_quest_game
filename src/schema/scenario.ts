// Single source of truth for what a scenario file may contain.
// The TypeScript types below are inferred from these schemas, so the
// validator and the types can never disagree.
//
// Checks that span MULTIPLE files (track exists, ids unique, id matches
// filename) live in vite-plugin-content.ts, because a single schema only
// ever sees one file.

import { z } from 'zod'
import { artifacts } from './constants.ts'
import { atStage } from './stages.ts'
import { filesOnDisk } from '../game/paths.ts'
import { MODULE_PATH_SOURCE, parseModuleAddr, parseResAddr } from '../game/terraform/address.ts'
import { schemaFor } from '../game/terraform/resources.ts'
import { isRegistrySource, normalizeRegistry, REGISTRY_SOURCE, registryDir } from '../game/terraform/layout.ts'
import { compareVersions, parseVersion } from '../game/terraform/versions.ts'

export { artifacts, type ArtifactKind } from './constants.ts'

export const id = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be kebab-case (a-z, 0-9, dashes)')

// `evidence` tags mark artifacts that matter for the diagnosis. Scoring and
// the debrief use them to show what the player found vs. missed.
const evidenceTag = id.optional()

const terminalCommand = z
  .strictObject({
    match: z.string().min(1).optional(),
    match_regex: z.string().min(1).optional(),
    // For match_regex commands: one concrete command it accepts. `help` lists it
    // and Tab completes it, so every investigation command is discoverable.
    example: z.string().min(1).optional(),
    when_actions: z.array(id).optional(),
    evidence: evidenceTag,
    output: z.string(),
  })
  .refine((c) => (c.match === undefined) !== (c.match_regex === undefined), {
    message: 'set exactly one of `match` or `match_regex`',
  })

// Shared by incidents and design challenges.
export const HintsSchema = z.strictObject({
  nudge: z.string().min(1),
  direction: z.string().min(1),
  answer: z.string().min(1),
})
export const AnalogySchema = z.strictObject({ title: z.string().min(1), text: z.string().min(1) })
export const SourcesSchema = z
  .array(
    z.strictObject({
      title: z.string().min(1),
      url: z.url(),
      // YAML 1.2 parses 2026-09-30 as a string, so validate the string.
      retrieved: z.iso.date(),
    }),
  )
  .min(1)

export const TrackSchema = z.strictObject({
  id,
  name: z.string().min(1),
  requires: z.array(id),
  // true: unlocks once ANY one required track has a completion (default: all of them).
  requires_any: z.boolean().optional(),
  // Where the sector's ops station sits on the ops-board wall map (shown only if set);
  // `side` puts its label left of the light when it would run off the map or into another.
  station: z
    .strictObject({ city: z.string().min(1), lat: z.number().min(-55).max(75), lon: z.number().min(-180).max(180), side: z.enum(['left', 'right']).optional() })
    .optional(),
})

const LogsSchema = z
  .array(z.strictObject({ name: z.string().min(1), evidence: evidenceTag, lines: z.string() }))
const FilesSchema = z
  .array(
    z.strictObject({
      path: z.string().min(1),
      language: z.string().default('text'),
      evidence: evidenceTag,
      content: z.string(),
    }),
  )
const TracesSchema = z
  .array(
    z.strictObject({
      name: z.string().min(1),
      evidence: evidenceTag,
      spans: z
        .array(
          z.strictObject({
            id,
            parent: id.optional(),
            service: z.string().min(1),
            operation: z.string().min(1),
            start_ms: z.number().min(0),
            duration_ms: z.number().min(0),
            status: z.enum(['ok', 'error']).default('ok'),
            note: z.string().optional(), // e.g. an attribute or event worth showing
          }),
        )
        .min(1),
    }),
  )
const MetricsSchema = z
  .array(
    z.strictObject({
      name: z.string().min(1),
      unit: z.string().min(1),
      evidence: evidenceTag,
      threshold: z.strictObject({ value: z.number(), label: z.string().min(1) }).optional(),
      // Every series shares the same x labels (usually clock times).
      series: z
        .array(
          z.strictObject({
            label: z.string().min(1),
            points: z.array(z.tuple([z.string(), z.number()])).min(2),
          }),
        )
        .min(1)
        .max(3), // the chart palette has 3 validated colors
    }),
  )
const HypothesesSchema = z
  .array(
    z.strictObject({
      id,
      text: z.string().min(1),
      correct: z.boolean().default(false),
      feedback: z.string().optional(),
    }),
  )
  .min(2)
const json = z.json()
// done_when (TF3d): a check on the Terraform world that takes the action once it holds.
// One level of all/any over leaves or negated leaves; no deeper nesting.
const ADDR_HINT = 'must be a resource or instance address like aws_s3_bucket.b, aws_s3_bucket.b["x"], module.net.aws_x.y, module.net["a"].aws_x.y or a bare module.net' // module-qualified and module-only forms are accepted too
const resAddr = (s: string) => /^(?:module\.|data\.)?[a-z]/.test(s) && parseResAddr(s) !== undefined
// A module path (module.net, module.net["a"].module.sub) also names everything under it.
const tfAddrOrModule = z.string().refine((s) => resAddr(s) || parseModuleAddr(s) !== undefined, ADDR_HINT)
const tfType = z
  .string()
  .min(1)
  .superRefine((t, ctx) => {
    if (!schemaFor(t)) ctx.addIssue({ code: 'custom', message: `"${t}" is not a resource type the Terraform lab models`, input: t })
  })
const regex = z
  .string()
  .min(1)
  .superRefine((r, ctx) => {
    try {
      new RegExp(r, 'm')
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: `invalid regex: ${(e as Error).message}`, input: r })
    }
  })
const LeafSchema = z.union([
  z.strictObject({ plan_clean: z.literal(true) }),
  z.strictObject({ plan_has: z.strictObject({ no_destroy: z.array(tfAddrOrModule).min(1) }) }),
  z.strictObject({ state_has: tfAddrOrModule }),
  z.strictObject({ state_lacks: tfAddrOrModule }),
  z.strictObject({ lock_free: z.literal(true) }),
  z.strictObject({ reality_has: z.strictObject({ type: tfType, id: z.string().min(1), attr: z.string().min(1).optional(), equals: json.optional() }) }),
  z.strictObject({ reality_lacks: z.strictObject({ type: tfType, id: z.string().min(1) }) }),
  z.strictObject({ applied: z.strictObject({ op: z.enum(['create', 'update', 'delete', 'import', 'forget']), address: tfAddrOrModule, lock_bypassed: z.literal(true).optional() }) }),
  z.strictObject({ file_contains: z.strictObject({ path: z.string().regex(/^\//, 'an absolute path'), matches: regex }) }),
])
const LeafOrNot = z.union([LeafSchema, z.strictObject({ not: LeafSchema })])
const PredicateSchema = z.union([LeafOrNot, z.strictObject({ all: z.array(LeafOrNot).min(1) }), z.strictObject({ any: z.array(LeafOrNot).min(1) })])
export type Leaf = z.infer<typeof LeafSchema>
export type Predicate = z.infer<typeof PredicateSchema>
const ActionsSchema = z
  .array(
    z.strictObject({
      id,
      label: z.string().min(1),
      kind: z.enum(['fix', 'wrong', 'destructive']),
      feedback: z.string().min(1),
      // Typing a matching command in the terminal takes this action too.
      match_regex: z.string().min(1).optional(),
      // A fix made by editing a file (PLAN_TERMINAL.md T4): the action is taken
      // once the file on disk matches `matches`; the button writes `after`.
      file: z
        .strictObject({ path: z.string().regex(/^\//, 'an absolute path'), matches: z.string().min(1), after: z.string() })
        .optional(),
      // A Terraform fix (TF3d): taken once this holds of the lab's world. Needs a terraform block.
      done_when: PredicateSchema.optional(),
    }),
  )
  .min(2)
const SolutionPathsSchema = z.array(z.array(id).min(1)).min(1)
// What each key evidence tag shows, in plain words, for the debrief.
const EvidenceLabelsSchema = z.record(id, z.string().min(1))

// Stage 2 onwards of a multi-stage incident (PLAN_MULTI_STAGE.md). The top
// level is stage 1. Artifacts and commands listed here appear from this
// stage on; everything else is this stage's own.
const StageSchema = z.strictObject({
  id,
  update: z.string().min(1), // shown when the incident reopens into this stage
  diagram_status: z.record(id, z.enum(['ok', 'degraded', 'down'])).optional(),
  terminal: z.strictObject({ commands: z.array(terminalCommand).min(1) }).optional(),
  logs: LogsSchema.optional(),
  files: FilesSchema.optional(),
  traces: TracesSchema.optional(),
  metrics: MetricsSchema.optional(),
  hypotheses: HypothesesSchema,
  actions: ActionsSchema,
  solution_paths: SolutionPathsSchema,
  key_evidence: z.array(id).min(1),
  evidence_labels: EvidenceLabelsSchema,
  hints: HintsSchema,
  debrief: z.strictObject({ root_cause: z.string().min(1), ideal_path: z.array(z.string().min(1)).min(1) }),
})

// A Terraform world (docs/superpowers/plans/2026-10-07-terraform-tf2c2-cli-and-shell.md): the
// files on disk, what state holds, and what the simulated cloud holds. The
// cloud defaults to exactly what state says; `cloud` lists only the differences.
const TfAttrs = z.record(z.string(), json)
const TfState = z.array(
  z.strictObject({
    type: z.string().min(1),
    name: z.string().min(1),
    module: z.string().refine((m) => parseModuleAddr(m) !== undefined, 'must be a module path like module.net, module.net["a"] or module.a.module.b').optional(),
    key: z.union([z.string(), z.int()]).optional(),
    mode: z.enum(['managed', 'data']).optional(),
    status: z.literal('tainted').optional(),
    attrs: TfAttrs,
  }),
)
const TfOutputs = z.record(z.string(), z.strictObject({ value: json, sensitive: z.boolean().optional() }))
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/
const wsName = z.string().regex(/^[A-Za-z0-9._-]+$/, 'may only contain letters, digits, ".", "_" and "-"')
export const TerraformSchema = z.strictObject({
  dir: z.string().min(1).optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must look like 1.9.8').optional(),
  initialized: z.boolean().optional(),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'must be a relative path under the working directory'),
        content: z.string(),
      }),
    )
    .min(1),
  vars: TfAttrs.optional(),
  // Provider versions by provider name (aws for hashicorp/aws): `lock` is what the lock file selects, `available`
  // what `terraform init -upgrade` can choose from. Absent: 5.67.0, and only that.
  providers: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_-]*$/, 'must be a provider name like aws'),
      z.strictObject({
        lock: z.string().regex(SEMVER, 'must be a version like 5.31.0').optional(),
        available: z.array(z.string().regex(SEMVER, 'must be a version like 5.31.0')).min(1).optional(),
      }),
    )
    .optional(),
  // Upstream states that data "terraform_remote_state" can read: matched by backend type, every authored `config`
  // key (equal to the data source's) and workspace. `outputs` are the upstream's root outputs.
  remote_states: z
    .array(
      z.strictObject({
        backend: z.enum(['local', 'remote', 'azurerm', 'consul', 'cos', 'gcs', 'http', 'inmem', 'kubernetes', 'oss', 'pg', 's3']),
        config: TfAttrs,
        workspace: wsName.optional(),
        outputs: TfAttrs,
      }),
    )
    .optional(),
  // `registry`: the authored offline "registry.terraform.io" (module files per version). `installed`: what
  // .terraform/modules/modules.json holds when the scenario starts. A registry module's `dir` is
  // .terraform/modules/<key> (leave it out) and its files are those of the installed `version`.
  modules: z
    .strictObject({
      registry: z
        .array(
          z.strictObject({
            source: z.string().regex(REGISTRY_SOURCE, 'must look like NAMESPACE/NAME/PROVIDER (optionally HOST/ in front)'),
            versions: z
              .array(
                z.strictObject({
                  version: z.string().regex(SEMVER, 'must be a version like 2.1.0 or 2.1.0-beta.1'),
                  files: z
                    .array(
                      z.strictObject({
                        path: z.string().regex(/\.tf$/, 'must be a .tf file').refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'must be a relative path inside the module'),
                        content: z.string(),
                      }),
                    )
                    .min(1),
                }),
              )
              .min(1),
          }),
        )
        .optional(),
      installed: z
        .array(
          z.strictObject({
            key: z.string().regex(/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/, 'must be the call name, or dotted call names for nested modules (net.inner)'),
            source: z.string().min(1),
            version: z.string().regex(SEMVER, 'must be a version like 2.1.0').optional(),
            dir: z.string().min(1).refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'must be a relative path under the working directory').optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  state: TfState.optional(),
  outputs: TfOutputs.optional(),
  lock: z
    .strictObject({
      id: z.string().min(1),
      who: z.string().min(1),
      operation: z.string().min(1).optional(),
      created: z.string().min(1),
      path: z.string().min(1).optional(),
      info: z.string().optional(),
      message: z.string().min(1).optional(),
    })
    .optional(),
  workspace: wsName.optional(),
  workspaces: z
    .record(
      wsName.refine((n) => n !== 'default', 'the default workspace is the top-level state'),
      z.strictObject({ state: TfState.optional(), outputs: TfOutputs.optional() }),
    )
    .optional(),
  cloud: z
    .strictObject({
      patch: z.array(z.strictObject({ type: z.string().min(1), id: z.string().min(1), set: TfAttrs })).optional(),
      delete: z.array(z.strictObject({ type: z.string().min(1), id: z.string().min(1) })).optional(),
      add: z.array(z.strictObject({ type: z.string().min(1), attrs: TfAttrs })).optional(),
    })
    .optional(),
  evidence: z
    .array(
      z.strictObject({
        evidence: id,
        command: z.enum(['plan', 'validate', 'init', 'show', 'output', 'version', 'state list', 'state show', 'state pull', 'workspace show', 'workspace list', 'apply', 'destroy', 'import', 'taint', 'untaint', 'refresh', 'force-unlock', 'providers', 'state mv', 'state rm', 'workspace new', 'workspace select', 'workspace delete', 'get']),
        contains: z.string().min(1),
      }),
    )
    .optional(),
  faults: z
    .array(
      z.strictObject({
        at: z.string().regex(new RegExp(`^${MODULE_PATH_SOURCE}[a-z][\\w]*\\.[\\w-]+(\\[(\\d+|"[^"]*")\\])?$`), 'must be a resource or instance address like aws_s3_bucket.b, aws_s3_bucket.b["x"] or module.net.aws_s3_bucket.b'),
        on: z.enum(['create', 'update', 'delete']),
        error: z.string().min(1),
        times: z.int().min(1).optional(),
        if: z.union([z.strictObject({ attr: z.string().min(1), equals: json }), z.strictObject({ attr: z.string().min(1), matches: z.string().min(1) })]).optional(),
        until_actions: z.array(id).optional(),
      }),
    )
    .optional(),
})
export type TerraformBlock = z.infer<typeof TerraformSchema>

export const ScenarioSchema = z
  .strictObject({
    type: z.literal('incident').optional(), // the default; challenges say `type: challenge`
    id,
    track: id,
    difficulty: z.int().min(1).max(5),
    title: z.string().min(1),
    par_minutes: z.number().positive(),

    ticket: z.strictObject({
      from: z.string().min(1),
      // SEV1 is a major incident (difficulty 5); SEV2 (urgent) to SEV5 (minor) for the rest.
      severity: z.enum(['SEV1', 'SEV2', 'SEV3', 'SEV4', 'SEV5']),
      body: z.string().min(1),
    }),
    environment: z.string().min(1),

    terminal: z
      .strictObject({
        prompt: z.string().min(1),
        commands: z.array(terminalCommand).min(1),
        unknown_output: z.string().optional(),
        // Files on the simulated disk that aren't artifacts (PLAN_TERMINAL.md):
        // config the player greps or edits. `changes` replace the content once
        // their actions are taken, so the disk agrees with the scripted commands.
        files: z
          .array(
            z.strictObject({
              path: z.string().min(1),
              content: z.string(),
              changes: z.array(z.strictObject({ when_actions: z.array(id).min(1), content: z.string() })).optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    terraform: TerraformSchema.optional(),
    logs: LogsSchema.optional(),
    files: FilesSchema.optional(),
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

    // Distributed-systems views. Each trace, metric and pipeline stage is an
    // artifact the player opens, so each can carry an evidence tag.
    traces: TracesSchema.optional(),
    metrics: MetricsSchema.optional(),
    pipeline: z
      .strictObject({
        name: z.string().min(1),
        trigger: z.string().min(1),
        stages: z
          .array(
            z.strictObject({
              name: z.string().min(1),
              status: z.enum(['success', 'failure', 'skipped', 'cancelled']),
              duration_s: z.number().min(0).optional(),
              evidence: evidenceTag,
              log: z.string().default(''),
            }),
          )
          .min(1),
      })
      .optional(),

    hypotheses: HypothesesSchema,
    actions: ActionsSchema,
    solution_paths: SolutionPathsSchema,
    key_evidence: z.array(id).min(1),
    evidence_labels: EvidenceLabelsSchema,

    hints: HintsSchema,
    analogy: AnalogySchema,
    debrief: z.strictObject({
      root_cause: z.string().min(1),
      ideal_path: z.array(z.string().min(1)).min(1),
      real_world: z.string().optional(),
    }),
    // Optional, for basics incidents: plain-English definitions shown in the
    // debrief, each linked to the provider's own docs.
    concepts: z
      .array(z.strictObject({ term: z.string().min(1), text: z.string().min(1), url: z.url() }))
      .min(1)
      .max(4)
      .optional(),
    sources: SourcesSchema,
    stages: z.array(StageSchema).min(1).max(2).optional(), // up to 3 stages in all
    // Optional "why this command, here" for the after-action command breakdown,
    // keyed by a terminal command as written (its match, or its example).
    command_notes: z.record(z.string(), z.string().min(1)).optional(),
    // Real anomalies in the evidence that aren't the cause (PLAN_DIFFICULTY_5.md).
    // Each names an evidence tag that is not key evidence; the debrief's "What
    // wasn't the cause" explains it. Required at difficulty 5.
    red_herrings: z
      .array(z.strictObject({ evidence: id, label: z.string().min(1), why: z.string().min(1) }))
      .min(1)
      .optional(),
  })
  // Cross-references inside one file. These catch typos that would otherwise
  // produce an incident nobody can finish.
  .superRefine((s, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path, input: s })

    const stages = s.stages ?? []
    const everyAction = [s.actions, ...stages.map((x) => x.actions)].flat()
    const actionIds = new Set(everyAction.map((a) => a.id))
    dupes(everyAction.map((a) => a.id)).forEach((d) => issue(`duplicate action id "${d}" (ids are unique across stages)`, ['actions']))
    dupes([s.hypotheses, ...stages.map((x) => x.hypotheses)].flat().map((h) => h.id)).forEach((d) =>
      issue(`duplicate hypothesis id "${d}" (ids are unique across stages)`, ['hypotheses']),
    )
    dupes(stages.map((x) => x.id)).forEach((d) => issue(`duplicate stage id "${d}"`, ['stages']))

    // Commands anywhere may react to any action in the incident (a stage 1
    // command can show the stage 2 symptom once stage 1 is fixed).
    const commandLists: [(string | number)[], z.infer<typeof terminalCommand>[]][] = [
      [['terminal', 'commands'], s.terminal?.commands ?? []],
      ...stages.map((x, k): [(string | number)[], z.infer<typeof terminalCommand>[]] => [['stages', k, 'terminal', 'commands'], x.terminal?.commands ?? []]),
    ]
    commandLists.forEach(([path, commands]) =>
      commands.forEach((c, i) => {
        c.when_actions?.forEach((a) => {
          if (!actionIds.has(a)) issue(`unknown action "${a}"`, [...path, i, 'when_actions'])
        })
        if (c.match_regex !== undefined) {
          try {
            const rx = new RegExp(c.match_regex)
            if (c.example !== undefined && !rx.test(c.example.trim().replace(/\s+/g, ' ')))
              issue(`example "${c.example}" doesn't match match_regex`, [...path, i, 'example'])
          } catch (e) {
            issue(`invalid regex: ${(e as Error).message}`, [...path, i, 'match_regex'])
          }
        } else if (c.example !== undefined) issue('example is only for match_regex commands (help lists `match` as is)', [...path, i, 'example'])
      }),
    )
    // Every pattern command must be discoverable: some entry with the same
    // pattern (they often come in before/after-the-fix pairs) gives an example.
    const allCommands = commandLists.flatMap(([, commands]) => commands)
    commandLists.forEach(([path, commands]) =>
      commands.forEach((c, i) => {
        if (c.match_regex !== undefined && !allCommands.some((o) => o.match_regex === c.match_regex && o.example))
          issue('match_regex commands need an `example` (on this entry or another with the same pattern) so players can find them', [...path, i, 'example'])
      }),
    )
    const canonical = new Set(allCommands.flatMap((c) => (c.match ?? c.example ? [c.match ?? c.example!] : [])))
    Object.keys(s.command_notes ?? {}).forEach((k) => {
      if (!canonical.has(k)) issue(`"${k}" isn't a terminal command in this incident (use its match or example exactly)`, ['command_notes', k])
    })
    stages.forEach((x, k) => {
      if (x.terminal && !s.terminal) issue('stage commands need a terminal at the top level', ['stages', k, 'terminal'])
      const nodes = new Set(s.diagram?.nodes.map((n) => n.id) ?? [])
      Object.keys(x.diagram_status ?? {}).forEach((n) => {
        if (!nodes.has(n)) issue(`unknown diagram node "${n}"`, ['stages', k, 'diagram_status', n])
      })
    })

    // Each stage is checked as the plain scenario the player sees at that stage.
    for (let k = 0; k <= stages.length; k++) {
      const v = atStage(s, k)
      const at = (...path: (string | number)[]) => (k === 0 ? path : ['stages', k - 1, ...path])
      // Actions of the stages before this one (their fixes are in by now).
      const earlier = new Set(k === 0 ? [] : [s, ...stages.slice(0, k - 1)].flatMap((x) => x.actions.map((a) => a.id)))
      const fixIds = new Set(v.actions.filter((a) => a.kind === 'fix').map((a) => a.id))

      const correct = v.hypotheses.filter((h) => h.correct).length
      if (correct !== 1) issue(`exactly one hypothesis must be correct (found ${correct})`, at('hypotheses'))

      v.solution_paths.forEach((path, i) =>
        path.forEach((a, j) => {
          if (!fixIds.has(a)) issue(`"${a}" is not an action with kind: fix in this stage`, at('solution_paths', i, j))
        }),
      )
      const inSomePath = new Set(v.solution_paths.flat())
      fixIds.forEach((f) => {
        if (!inSomePath.has(f)) issue(`fix action "${f}" is not in any solution path`, at('actions'))
      })
      // Continuity: the player must be able to check this stage's fix, so some
      // terminal command's output has to change once a fix is applied.
      // A terraform block verifies itself: the simulator's output changes when the files do.
      if (!s.terraform && !(v.terminal?.commands ?? []).some((c) => c.when_actions?.some((a) => fixIds.has(a))))
        issue("no terminal command changes after this stage's fixes: add one with when_actions so players can verify the fix", at('solution_paths'))

      v.actions.forEach((a, i) => {
        if (a.match_regex === undefined) return
        if (!v.terminal) issue('match_regex needs a terminal to type into', at('actions', i, 'match_regex'))
        let rx: RegExp
        try {
          rx = new RegExp(a.match_regex)
        } catch (e) {
          return issue(`invalid regex: ${(e as Error).message}`, at('actions', i, 'match_regex'))
        }
        // A typed command either shows scripted output or takes an action, never both.
        v.terminal?.commands.forEach((c) => {
          if (c.match && rx.test(c.match.trim().replace(/\s+/g, ' ')))
            issue(`also matches the scripted command "${c.match}"`, at('actions', i, 'match_regex'))
        })
      })

      // Key evidence must be findable after the earlier stages' fixes and
      // BEFORE this stage's own, or the methodical bonus (evidence before
      // hypothesis) would be impossible to earn.
      // Terraform evidence is visible from the start, at every stage.
      const tfTags = (s.terraform?.evidence ?? []).map((e) => e.evidence)
      const evidence = new Set([...[...(v.terminal?.commands ?? []), ...artifacts(v)].map((a) => a.evidence).filter(Boolean), ...tfTags])
      const beforeFix = new Set(
        [...(v.terminal?.commands ?? []).filter((c) => (c.when_actions ?? []).every((a) => earlier.has(a))), ...artifacts(v)]
          .map((a) => a.evidence)
          .filter(Boolean)
          .concat(tfTags),
      )
      Object.keys(v.evidence_labels).forEach((e) => {
        if (!v.key_evidence.includes(e)) issue(`"${e}" is labelled but not in key_evidence`, at('evidence_labels', e))
      })
      v.key_evidence.forEach((e, i) => {
        if (!evidence.has(e)) issue(`no artifact is tagged with evidence "${e}"`, at('key_evidence', i))
        else if (!beforeFix.has(e)) issue(`key evidence "${e}" is only visible after one of this stage's actions`, at('key_evidence', i))
        if (!v.evidence_labels[e]) issue(`key evidence "${e}" needs a label in evidence_labels`, at('evidence_labels'))
      })
    }

    ;[s, ...stages].forEach((part, k) => {
      const at = (...path: (string | number)[]) => (k === 0 ? path : ['stages', k - 1, ...path])
      part.traces?.forEach((t, i) => {
        const spans = new Set(t.spans.map((x) => x.id))
        t.spans.forEach((x, j) => {
          if (x.parent && !spans.has(x.parent)) issue(`unknown parent span "${x.parent}"`, at('traces', i, 'spans', j))
        })
      })
      part.metrics?.forEach((m, i) => {
        const xs = JSON.stringify(m.series[0].points.map((p) => p[0]))
        m.series.forEach((ser, j) => {
          if (JSON.stringify(ser.points.map((p) => p[0])) !== xs)
            issue('every series must use the same x labels', at('metrics', i, 'series', j))
        })
      })
    })

    const tagged = new Set([...[...allCommands, ...[s, ...stages].flatMap((x) => artifacts(x))].map((a) => a.evidence).filter(Boolean), ...(s.terraform?.evidence ?? []).map((e) => e.evidence)])
    const key = new Set([s, ...stages].flatMap((x) => x.key_evidence))
    dupes((s.red_herrings ?? []).map((r) => r.evidence)).forEach((d) => issue(`duplicate red herring "${d}"`, ['red_herrings']))
    s.red_herrings?.forEach((r, i) => {
      if (!tagged.has(r.evidence)) issue(`no artifact or command is tagged with evidence "${r.evidence}"`, ['red_herrings', i, 'evidence'])
      if (key.has(r.evidence)) issue(`"${r.evidence}" is key evidence, so it can't be a red herring`, ['red_herrings', i, 'evidence'])
    })

    if (!s.terraform)
      [s, ...stages].forEach((part, k) =>
        part.actions.forEach((act, i) => {
          if (act.done_when) issue('done_when needs a terraform block', k === 0 ? ['actions', i, 'done_when'] : ['stages', k - 1, 'actions', i, 'done_when'])
        }),
      )

    // File fixes: the file must be on disk, start out unfixed, and `after` must count as fixed.
    ;[s, ...stages].forEach((part, k) => {
      part.actions.forEach((act, i) => {
        if (!act.file) return
        const at = (...p: (string | number)[]) => (k === 0 ? ['actions', i, 'file', ...p] : ['stages', k - 1, 'actions', i, 'file', ...p])
        let rx: RegExp
        try {
          rx = new RegExp(act.file.matches, 'm')
        } catch (e) {
          return issue(`invalid regex: ${(e as Error).message}`, at('matches'))
        }
        const initial = filesOnDisk(atStage(s, k)).get(act.file.path)
        if (initial === undefined) issue(`${act.file.path} isn't on disk at this stage (add it as a file, a log with that name, or a scripted cat)`, at('path'))
        else if (rx.test(initial)) issue('the file already matches before any fix', at('matches'))
        if (!rx.test(act.file.after)) issue("`after` doesn't match `matches`", at('after'))
      })
    })

    // Difficulty 5 is a major incident (PLAN_DIFFICULTY_5.md section 2).
    if (s.ticket.severity === 'SEV1' && s.difficulty !== 5) issue('SEV1 is reserved for major incidents (difficulty 5)', ['ticket', 'severity'])
    if (s.difficulty === 5) {
      if (stages.length !== 2) issue('difficulty 5 needs three stages (two in `stages`)', ['difficulty'])
      if (!s.red_herrings) issue('difficulty 5 needs at least one red herring', ['difficulty'])
      if (s.par_minutes < 25) issue('difficulty 5 needs par_minutes of at least 25', ['par_minutes'])
      if (s.ticket.severity !== 'SEV1') issue('difficulty 5 is a major incident: ticket severity must be SEV1', ['ticket', 'severity'])
    }

    if (s.terraform) {
      const tf = s.terraform
      if (!s.terminal) issue('terraform needs a terminal to type into', ['terraform'])
      const checkState = (entries: NonNullable<typeof tf.state>, path: (string | number)[], into?: Set<string>) => {
        const seen = new Set<string>()
        entries.forEach((e, i) => {
          const mode = e.mode ?? 'managed'
          if (mode === 'managed' && !schemaFor(e.type)) issue(`"${e.type}" is not a resource type the Terraform lab models`, [...path, i, 'type'])
          if (mode === 'managed') {
            if (typeof e.attrs.id !== 'string') issue('needs a string id attribute', [...path, i, 'attrs'])
            else into?.add(`${e.type}:${e.attrs.id}`)
          }
          const k = `${e.module ?? ''}|${mode}.${e.type}.${e.name}[${JSON.stringify(e.key ?? null)}]`
          if (seen.has(k)) issue(`duplicate state entry ${e.module ? `${e.module}.` : ''}${e.type}.${e.name}[${e.key ?? ''}]`, [...path, i])
          seen.add(k)
        })
      }
      Object.entries(tf.providers ?? {}).forEach(([name, p]) => dupes(p.available ?? []).forEach((d) => issue(`duplicate available version "${d}" of provider ${name}`, ['terraform', 'providers', name, 'available'])))
      const installed = tf.modules?.installed ?? []
      if (installed.length && tf.initialized === false) issue('modules.installed needs the lab to start initialised', ['terraform', 'modules', 'installed'])
      dupes(installed.map((m) => m.key)).forEach((d) => issue(`duplicate installed module key "${d}"`, ['terraform', 'modules', 'installed']))
      const registry = tf.modules?.registry ?? []
      const sources = registry.map((r) => normalizeRegistry(r.source))
      dupes(sources).forEach((d) => issue(`duplicate registry module "${d}"`, ['terraform', 'modules', 'registry']))
      registry.forEach((r, i) => {
        const vs = r.versions.map((v) => {
          const p = parseVersion(v.version)
          return p ? `${p.major}.${p.minor}.${p.patch}${p.pre === undefined ? '' : `-${p.pre}`}` : v.version
        })
        dupes(vs).forEach((d) => issue(`duplicate version "${d}" of ${r.source}`, ['terraform', 'modules', 'registry', i, 'versions']))
        r.versions.forEach((v, j) => {
          dupes(v.files.map((f) => f.path)).forEach((d) => issue(`duplicate file "${d}" in ${r.source} ${v.version}`, ['terraform', 'modules', 'registry', i, 'versions', j, 'files']))
          // Local calls inside a registry module need their own files; the module itself needs a .tf at its top.
          if (!v.files.some((f) => !f.path.includes('/'))) issue(`${r.source} ${v.version} needs a .tf file at the top of the module`, ['terraform', 'modules', 'registry', i, 'versions', j, 'files'])
        })
      })
      installed.forEach((m, i) => {
        if (isRegistrySource(m.source)) {
          const at = ['terraform', 'modules', 'installed', i]
          const r = registry.find((x) => normalizeRegistry(x.source) === normalizeRegistry(m.source))
          if (m.version === undefined) issue('a registry module needs the installed version', [...at, 'version'])
          else if (!r) issue(`${m.source} is not in modules.registry`, [...at, 'source'])
          else if (!r.versions.some((v) => { const a = parseVersion(v.version); const b = parseVersion(m.version!); return a && b && compareVersions(a, b) === 0 })) issue(`${m.source} has no version ${m.version} in modules.registry`, [...at, 'version'])
          if (m.dir !== undefined && m.dir.replace(/^\.\//, '').replace(/\/+$/, '') !== registryDir(m.key)) issue(`a registry module is installed in ${registryDir(m.key)}: leave dir out`, [...at, 'dir'])
          return
        }
        if (m.version !== undefined) issue('only a registry module has a version', ['terraform', 'modules', 'installed', i, 'version'])
        if (m.dir === undefined) return issue('needs the module directory', ['terraform', 'modules', 'installed', i, 'dir'])
        const dir = m.dir.replace(/^\.\//, '').replace(/\/+$/, '')
        if (!tf.files.some((f) => f.path.endsWith('.tf') && f.path.slice(0, Math.max(0, f.path.lastIndexOf('/'))) === (dir === '.' ? '' : dir))) issue(`no .tf file in terraform.files under "${m.dir}"`, ['terraform', 'modules', 'installed', i, 'dir'])
      })
      const seenRs = new Set<string>()
      tf.remote_states?.forEach((r, i) => {
        const k = JSON.stringify([r.backend, r.workspace ?? 'default', Object.entries(r.config).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))])
        if (seenRs.has(k)) issue('duplicate remote state (same backend, config and workspace)', ['terraform', 'remote_states', i])
        seenRs.add(k)
      })
      const known = new Set<string>()
      checkState(tf.state ?? [], ['terraform', 'state'], known)
      for (const [name, w] of Object.entries(tf.workspaces ?? {})) checkState(w.state ?? [], ['terraform', 'workspaces', name, 'state'], known)
      if (tf.workspace && tf.workspace !== 'default' && !Object.hasOwn(tf.workspaces ?? {}, tf.workspace))
        issue(`workspace "${tf.workspace}" is not a key of terraform.workspaces`, ['terraform', 'workspace'])
      tf.cloud?.add?.forEach((a, i) => {
        if (typeof a.attrs.id !== 'string') issue('needs a string id attribute', ['terraform', 'cloud', 'add', i, 'attrs'])
        else known.add(`${a.type}:${a.attrs.id}`)
      })
      ;(['patch', 'delete'] as const).forEach((w) =>
        tf.cloud?.[w]?.forEach((c, i) => {
          if (!known.has(`${c.type}:${c.id}`)) issue(`no object with id "${c.id}" in state or cloud.add`, ['terraform', 'cloud', w, i, 'id'])
        }),
      )
      tf.faults?.forEach((f, i) => {
        f.until_actions?.forEach((a) => {
          if (!actionIds.has(a)) issue(`unknown action "${a}"`, ['terraform', 'faults', i, 'until_actions'])
        })
        if (f.if && 'matches' in f.if) {
          try {
            new RegExp(f.if.matches)
          } catch {
            issue(`invalid regex "${f.if.matches}"`, ['terraform', 'faults', i, 'if', 'matches'])
          }
        }
      })
      dupes((tf.evidence ?? []).map((e) => e.evidence)).forEach((d) => issue(`duplicate terraform evidence tag "${d}"`, ['terraform', 'evidence']))
    }

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
