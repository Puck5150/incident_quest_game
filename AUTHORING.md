# Writing Incident Quest scenarios

Scenarios are data. You don't write any code to add an incident.

## Quick start

1. Copy `content/_template.yaml` to `content/<track>/<id>.yaml`.
   - `<track>` must be a folder whose name is listed in `content/tracks.yaml`.
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

`npm run build` runs the same validation, so a broken scenario can't ship.

## How a scenario plays

1. **Briefing:** the player reads `ticket` and `environment`.
2. **Investigating:** the player explores `terminal`, `logs`, `files`, and `diagram`.
3. **Hypothesis:** the player picks from `hypotheses`. The wrong ones show their
   `feedback`. Fix actions stay locked until the player picks the correct one.
4. **Acting:** the player chooses from `actions`. Once every action in any one
   `solution_paths` entry has been taken (in any order), a **Close incident**
   button appears. The gap between fixing and closing is where the player verifies.
5. **Hints** are available the whole time: nudge, then direction (which also shows
   the `analogy`), then answer.
6. **Debrief:** shows `debrief`, `analogy`, and `sources`.

## Writing good incidents

- **Ticket = symptoms, not causes.** "Checkout returning 500s", not "Disk is full".
- **Evidence should chain.** Each artifact should point at the next place to look.
  Tag the essential ones with `evidence:` and list them in `key_evidence`. Players
  who find all of them before declaring a hypothesis earn the methodical bonus.
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
- **`help` in the terminal** lists your `match` commands, but not the regex ones.
  Use `match` for the obvious first steps and `match_regex` for the deeper digging
  you want players to think of themselves. `clear` and `history` are built in.
- **The analogy should use no IT words.** If you need jargon to explain it, it's
  not an analogy yet.

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

## Things the validator enforces for you

- Every `key_evidence` tag must be findable **before** any fix (not only on a
  `when_actions` entry). Otherwise the methodical bonus can't be earned.
- Every solution path is played through the real engine in the test suite.
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

## Accuracy rules (non-negotiable)

- Commands, flags, output formats, and error messages must come from **official**
  documentation: vendor docs, man pages, RFCs, the Google SRE books.
- Record every page you relied on in `sources`, with the date you read it.
- When you base output on your own real-world experience and it isn't shown verbatim
  in the docs, that's fine, but add a line to `CONTENT_TODO.md` noting it.
- If you can't verify something, don't guess. Put it in `CONTENT_TODO.md`.
