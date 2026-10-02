# Writing Incident Quest scenarios

Scenarios are data. You don't write any code to add an incident.

## Quick start

1. Copy `content/_template.yaml` to `content/<track>/<id>.yaml`.
   - `<track>` must be a folder whose name is listed in `content/tracks.yaml`.
     A new track can add a `station` (city, lat, lon, optional `side: left`) to
     appear on the ops-board wall map; pick a spot whose label won't overlap another.
   - `<id>` must match the `id:` field exactly (kebab-case). Never rename it after
     release, because player progress is saved by id.
2. Fill it in. The template has a comment on every field.
3. Run `npm test`. Errors name the file and the exact field path:
   ```
   content/linux/full-disk.yaml:
   ✖ "typo" is not an action with kind: fix
     → at solution_paths[0][1]
   ```
4. Run `npm run dev` and play it. The page reloads when you save a YAML file.

### Preview without the repo

No dev setup? Open the game's preview page,
https://puck5150.github.io/incident_quest_game/#/preview, then paste a file or
pick one. It runs the same per-file checks as `npm test` (everything except id
matching the filename and ids being unique across all content) and lets you play
it. Nothing played there is saved to progress. Useful for reviewing a pull
request's YAML, too.

### Editor support

Line 1 of every content file names its JSON Schema:

```yaml
# yaml-language-server: $schema=../../schemas/incident.json
```

With a YAML language server (in VS Code, the recommended Red Hat YAML
extension), that gives autocomplete for field names and enum values, and inline
errors for typos, wrong types and missing fields as you type. The templates already have
the line; keep it when you copy one, and point it at the schema for the kind of
file (`incident`, `challenge`, `canvas`, `pick-cloud-canvas`,
`pick-cloud-slot`). `npm test` fails if it's missing or wrong.

The schemas cover each file's shape. Rules that span fields or files (solution
paths name real actions, evidence is findable, reference designs pass) are
still only checked by `npm test`. The schemas are generated from the Zod
schemas: after changing anything in `src/schema/`, run `npm run schemas` and
commit the result (a test fails if you forget).

`npm run build` runs the same validation, so a broken scenario can't ship.

## How a scenario plays

1. **Briefing:** the player reads `ticket` and `environment`.
2. **Investigating:** the player explores `terminal`, `logs`, `files`, and `diagram`.
3. **Hypothesis:** the player picks from `hypotheses`. The wrong ones show their
   `feedback`. Fix actions stay locked until the player picks the correct one.
4. **Acting:** the player chooses from `actions`. Once every action in any one
   `solution_paths` entry has been taken (in any order), a **Close out**
   button appears. The gap between fixing and closing is where the player verifies.
5. **Hints** are available the whole time: nudge, then direction (which also shows
   the `analogy`), then answer.
6. **Debrief:** shows `debrief`, `analogy`, and `sources`.

A multi-stage incident repeats steps 2 to 4 for each stage: closing out a
stage reopens the incident into the next one (see below).

## Writing good incidents

- **Ticket = symptoms, not causes.** "Checkout returning 500s", not "Disk is full".
- **Evidence should chain.** Each artifact should point at the next place to look.
  Tag the essential ones with `evidence:` and list them in `key_evidence`. Players
  who find all of them before declaring a hypothesis earn the methodical bonus.
  Give each one a line in `evidence_labels` saying what it shows in plain words
  ("The root filesystem is at 100%"); the debrief lists those, found or missed.
- **Prose fields reflow.** `ticket.body`, `environment`, `analogy.text` and the
  debrief text are shown like Markdown paragraphs: single line breaks become
  spaces, and a blank line starts a new paragraph. Wrap lines wherever you like.
- **Unscripted commands** print "no simulated output for that here" by default.
  Set `terminal.unknown_output` if you want something else.
- **Wrong hypotheses must be plausible.** Their `feedback` should say which evidence
  rules them out. That's where the learning happens.
- **Every scenario needs a shotgun trap:** a `destructive` action a panicked
  engineer might take (reboot, restart everything, delete data). The feedback
  explains the cost.
- **Support verification.** Add a second terminal entry with `when_actions: [...]`
  that shows the healthy state after the fix, and put it **before** the
  pre-fix entry, because the first match wins.
- **Terminal matching:** `match` compares against what the player typed, ignoring
  extra spaces. Use `match_regex` for variants (`du -sh /var/log` vs
  `du -sh /var/log/*`). The regex runs against the input *after* spaces are
  collapsed. Remember to escape backslashes in YAML strings (`\\*`).
- **Typed fixes:** give an action a `match_regex` and typing a matching command in
  the terminal takes that action, the same as clicking it (only after the right
  hypothesis; before that it's refused). Use it for actions that really are one
  command (`kubectl rollout undo …`, `sudo reboot`); leave multi-step fixes as
  buttons. Anchor the regex (`^…$`): it must not also match a scripted terminal
  command, and the validator checks that.
- **Every investigation command is discoverable.** A `match_regex` command needs an
  `example`: one concrete command its pattern accepts (the validator checks it
  matches). `help` lists `match` commands as written and pattern commands by their
  example, and Tab completes from the same list plus file and log paths that start
  with `/`. Typed fixes are never listed: they're already action buttons.
  `clear` and `history` are built in.
- **Continuity: if the text tells players to check something, they must be able
  to.** Every step in the hints, `ideal_path` and debrief that says to run, check
  or verify something needs a command or artifact in that incident that does it,
  and verification after the fix needs a command whose output changes
  (`when_actions`). Read your ideal path back against `help`'s list before
  shipping.
- **The analogy should use no IT words.** If you need jargon to explain it, it's
  not an analogy yet.

## Concepts

Any incident can add `concepts`: 1 to 4 terms, each with a plain-English `text`
and a `url` to the provider's own docs. Players see them **during play**, free, in
the Field manual panel, and again in the debrief after the root cause. Write them
for someone who has never used the platform: what the thing is and why it
exists, not how to configure it.

Because they're free, concepts must not be hints. The test: would this text
still be true and useful in a *different* incident on the same services? Define
the pieces in play (including the ones behind the wrong hypotheses); don't say
what's wrong here, what the default is when the default is the cause, or which
option to pick. "Rule priority: lower numbers are processed first" passes;
"Key Vault Reader never reads values" (in the incident where that's the cause)
doesn't. Save those for `hints` and the debrief's `root_cause`.

## Distributed-systems views

Optional, and each item can carry `evidence:` like logs and files:

- **`traces`**: one entry per trace, with spans that have `start_ms`, `duration_ms`,
  an optional `parent` span id, `status: ok | error`, and a `note` for the attribute
  that matters ("rows scanned: 4,812,331"). Include a healthy "before" trace so
  players can compare.
- **`metrics`**: line charts. Every series must share the same x labels (clock
  times). There's a maximum of 3 series, since the chart palette has 3 colors that
  have been checked for color-blind safety. An optional `threshold` draws a labelled
  reference line (a pool size or an SLO).
- **`pipeline`**: a CI run: `name`, `trigger`, and `stages` in order, each with a
  `status` (success / failure / skipped / cancelled) and its `log`.
- **`diagram`**: node `status` is what *monitoring currently shows*, not the root
  cause. A slow-but-successful service is honestly "ok". That can be the lesson.

## Multi-stage incidents

A fix can reveal the next problem: open the security group and the health
check now fails for another reason. Add a `stages:` list (one or two entries,
so three stages at most). The top level of the file is stage 1, unchanged.

```yaml
stages:
  - id: health-path                # kebab-case, unique in the file
    update: |                      # shown when the incident reopens into this stage
      11:05 Reopened: targets now fail health checks with 404.
    diagram_status: { api: degraded }   # optional: node id -> new status
    terminal:                      # optional: commands that appear from now on
      commands: [...]
    logs: [...]                    # optional, like files, traces and metrics
    hypotheses: [...]              # this stage's causes, exactly one correct
    actions: [...]                 # this stage's actions
    solution_paths: [[fix-path]]
    key_evidence: [...]
    evidence_labels: { ... }
    hints: { nudge, direction, answer }
    debrief:
      root_cause: |
        ...
      ideal_path: [...]
```

(Not to be confused with a `pipeline`'s `stages`, which are CI steps.)

- **The next stage starts on close-out.** When the player closes a fixed
  stage, the incident reopens with the stage's `update`; closing the last
  stage resolves it.
- **Make verification show the next symptom.** Give a stage 1 command a
  `when_actions` entry for the stage 1 fix whose output shows the stage 2
  problem. A player who checks their fix before closing sees it coming; the
  key evidence for stage 2 can live there.
- **Artifacts accumulate:** everything from earlier stages stays available.
  A stage's own commands win over earlier ones with the same `match`.
- **One stage's options shouldn't fix another.** If a wrong option in stage 1
  would really fix stage 2 too, the scripted output can't follow it. Pick a
  different wrong option.
- Shared at the top level: title, difficulty (multi-stage incidents are 3 to
  5), par (for the whole incident), analogy, concepts, `real_world` and
  sources.
- **Scoring:** the methodical and verified bonuses are shared across stages;
  each stage has its own three hint tiers.

## Command breakdown library

After an incident, the after-action report explains the commands that found key
evidence or verify the fix, plus anything the player ran. The explanations come
from a shared library in `content/commands/` (one file per tool family), not from
each incident:

```yaml
- id: df-inodes
  match: "^(sudo )?df -i"          # regex over the command, spaces collapsed
  summary: "What it does, one or two sentences."
  parts:                           # every flag, argument, filter or regex
    - { token: "-i", meaning: "Count inodes instead of blocks." }
  why: "Why it's the right tool for this kind of question."
  alternatives:
    - { command: "stat -f /var", note: "How it differs." }
  docs: { title: "df(1)", url: "https://man7.org/linux/man-pages/man1/df.1.html" }
```

- **First match wins**, so put specific forms (`df -i`) before general ones (`df -h`).
  Files are read in filename order (aws, azure, databases, ...), so an entry in an
  earlier file beats one in a later file.
- Explain short-flag clusters letter by letter (`-sh` as `-s` and `-h`); the tests
  check every flag in a matched command is explained.
- An incident can add `command_notes` (keyed by a terminal command exactly as
  written) for "why this command, here".
- The build fails if a key-evidence or verification command has no entry.

## Things the validator enforces for you

- Every `key_evidence` tag has a label in `evidence_labels`, and every label
  belongs to a `key_evidence` tag.
- Every `key_evidence` tag must be findable **before** any fix (not only on a
  `when_actions` entry). Otherwise the methodical bonus can't be earned. In a
  multi-stage incident: after the earlier stages' fixes, before this stage's.
- Every stage has exactly one correct hypothesis, and its solution paths use
  only its own fix actions. Ids are unique across all stages.
- Every stage has at least one terminal command whose output changes after one
  of its fixes (`when_actions`), so players can always verify the fix.
- Every `match_regex` terminal command has an `example` that matches it.
- Every solution path, of every stage, is played through the real engine in the
  test suite.
- Hypotheses and actions are **shuffled** in the game, so list them in whatever
  order is easiest to write.

## Design challenges

A second kind of content: instead of diagnosing a broken system, the player
**builds** one. Start from `content/_challenge_template.yaml`; the file must
contain `type: challenge`.

- **Tiers and options.** Each tier is one decision (compute, database, edge…),
  with 2–5 options. The player picks exactly one per tier.
- **Facts vs. capabilities.** `facts` are shown to the player and must come from
  official docs. `capabilities` are hidden and decide the stress tests. Write the
  facts so a careful reader *can* infer the capabilities; that inference is the
  skill being practiced. Never put "survives an AZ outage" in a fact.
- **Stress tests** use one of three rules:
  - `every_tier_survives: <event>`: every picked option must list the event in
    `capabilities.survives`. Options that don't really take part (like "no edge
    service") should list the event so they don't fail it.
  - `tier: <id>, min_scales: <n>`: that tier's pick needs `scales >= n`.
  - `tier: <id>, rpo_at_most: zero | seconds | minutes | hours`: data-loss limit.
- **Cost units are illustrative.** Keep relative ordering sensible; never quote
  real prices, which vary by region and change often.
- **Over-engineering.** Give options that exceed the brief an `overkill` note and
  a budget that still lets them pass. Players can win with them but lose the
  lean bonus, and the debrief explains why.
- **The validator enforces:** every reference design passes all tests within
  budget, and every stress test is failed by at least one combination (no
  decorative tests).
- Keep `requirements` and `stress_tests` in step: every requirement should be
  checked by a test or by the budget.

## Canvas challenges

The canvas mode lets players build the architecture's *shape*: components in
zone/region lanes, traffic links, and sync/async replication links. Start from
`content/_canvas_template.yaml` (`type: challenge` plus `mode: canvas`).

- **Palette.** Each component has a `scope` (zonal, regional or global, which
  decides the lanes it can go in), `roles` (`route`, `serve`, `write-store`), a
  `capacity` for `serve`, a cost, and sourced `facts`. Keep it small: 3–5 parts.
- **How the engine judges a design** (`src/game/canvas.ts`):
  - A zone outage removes zonal parts in that zone. A region outage also removes
    that region's regional parts. `single_failure` removes each part of a type,
    one at a time.
  - The database nothing replicates *into* is the primary. A **sync** standby
    takes over automatically; an **async** replica does not.
  - Traffic must reach a `serve` part from `users`, and a part users can reach
    must link to the primary (or its sync standby, since apps connect to the
    database's endpoint). `capacity` counts only what survives.
- **Counter-examples replace enumeration.** Free-form designs can't all be
  checked, so list the mistakes the challenge is about, each with the exact
  tests it must fail. The validator runs them. If one fails for an *unintended*
  reason (say, a web server you forgot to link), the build tells you, and that's
  usually a sign the counter-example isn't isolating its lesson.
- **Capacity numbers and costs are scenario values.** Label them "(scenario
  number)" in facts, and keep the relative costs believable.

## "Pick your cloud" challenges

Add `providers: [aws, azure, gcp]` to a canvas or slot challenge and the
player chooses the cloud before starting. Start from
`content/_pick_cloud_template.yaml` (canvas) or copy
`content/cloud-design/traffic-spike-any-cloud.yaml` (slot).

- **Behavior once, names per provider.** Scope, roles, capacity, cost and
  capabilities are written once. Each part or option gets `as: { aws, azure,
  gcp }` with its label, short label and sourced facts. Lanes get per-provider
  names under `labels`, and `sources` and `link_facts` are per provider.
- **`differences` is required** on every part and option. Say what isn't
  equivalent (for example Azure's same-zone HA option), or "None that matter
  here". The debrief shows it in the "Same design on other clouds" table.
- **Tokens** keep the brief neutral: `{provider}`, `{region}`, `{zone:<id>}`,
  `{service:<id>}`. Any token left unfilled fails the build.
- **Checked per provider.** The build resolves the file into one ordinary
  challenge per cloud and runs every check on each. Errors are tagged
  `[aws]`, `[azure]` or `[gcp]`.
- **Overrides** (`overrides: { gcp: { palette: { … } } }`, canvas only) are
  for real, sourced differences in behavior. If one cloud needs its own
  reference design, that's a sign the difference belongs in the debrief too.

## Accuracy rules (non-negotiable)

- Commands, flags, output formats, and error messages must come from **official**
  documentation: vendor docs, man pages, RFCs, the Google SRE books.
- Record every page you relied on in `sources`, with the date you read it.
- When you base output on your own real-world experience and it isn't shown verbatim
  in the docs, that's fine, but add a line to `CONTENT_TODO.md` noting it.
- If you can't verify something, don't guess. Put it in `CONTENT_TODO.md`.
