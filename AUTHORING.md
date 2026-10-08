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
- **Unscripted commands:** a real tool your incident doesn't script (say
  `kubectl get nodes`) prints "no simulated output for that here" by default;
  set `terminal.unknown_output` to change it. Unknown names get bash's own
  "command not found", and shell commands just work (see "The terminal is a
  real shell").
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

## Difficulty

Rate by the shape of the problem, not by how obscure the tool is
(PLAN_DIFFICULTY_5.md). Base score is `100 × difficulty`.

| Level | Shape | Typical |
|---|---|---|
| 1 | One fault; the first obvious command shows it | Disk full, service stopped |
| 2 | One fault; two or three pieces of evidence pin it down | Wrong health check path |
| 3 | One fault hiding behind a plausible wrong answer, or two stages | Expired cert vs incomplete chain |
| 4 | Two stages, or one fault that crosses two domains | DNS failover plus TTL |
| 5 | Major incident: everything below | |

**Difficulty 5** has three stages (each fix reveals the next fault), crosses at
least two domains (say network, then identity, then data), has at least one red
herring, and its last stage cleans up what the outage left behind (unreplicated
objects, writes on the wrong disk, a backlog). The validator requires the three
stages, a red herring, `par_minutes` of 25 or more and a SEV1 ticket; crossing
domains and the clean-up stage are on you. It shows as MAJOR INCIDENT on the board.

**Severity** (`ticket.severity`) is how urgent the page is, separate from how hard
the incident is to solve. SEV1 is reserved for major incidents (difficulty 5, and
the validator enforces it both ways). For the rest: SEV2 for an outage of
something customers use, SEV3 for a serious degradation or a part of it down,
SEV4 for a contained problem, SEV5 for minor. In on-call shifts each severity has
an acknowledge target (SEV1 1 minute, SEV2 2, SEV3 5, SEV4 and SEV5 10).

**Red herrings** (optional below 5): a real anomaly in the evidence that isn't
the cause, such as a noisy alarm, an old error or a high but harmless metric.
Tag its artifact or command with an `evidence` tag that is *not* in
`key_evidence`, and explain it:

```yaml
red_herrings:
  - evidence: cpu-alert
    label: "CPU alert on the app plan"
    why: "It fires every night during the batch job; requests were failing before it started."
```

The debrief's "What wasn't the cause" lists each one, where it was, and whether
the player checked it. Make the anomaly genuinely tempting, and make `why` point
at the evidence that rules it out.

## The terminal is a real shell

Since PLAN_TERMINAL.md the terminal is bash (just-bash, in the browser) on a
simulated Linux host. What that means for an incident:

- **Scripted lines still come first.** `help`, every scripted `match`, typed
  fixes and their gate are answered by the engine exactly as written, so
  evidence and scoring don't depend on the shell. Everything else runs in the
  shell: pipes, redirection, variables, `cd`, loops, and its text tools.
- **Your tools work in pipelines.** `aws`, `kubectl`, `systemctl`... answer from
  your scripted commands wherever they appear: `kubectl get pods -n shop | grep
  -c Error` works with nothing extra. Flags can come in any order, `--a=b` or
  `--a b`, long or short (`-n`/`--namespace`), quotes ignored. A tool run inside
  a pipeline counts for evidence like typing it alone. A scripted
  `TOOL ... | grep X` also answers `TOOL ...` alone with the same lines.
- **Write commands as valid bash.** Quote arguments with `()`, `{}`, `[]`, `*`,
  `|` or spaces: `--format='value(tags.items)'`, `--query '[].{name:name}'`.
  Unquoted, a real shell would fail, and so does this one.
- **Files are on disk.** Starting directory = the prompt's (`you@laptop:~/infra$`
  starts in `~/infra`). On disk: files and logs whose name is a path
  (`/etc/fstab`, `deploy/main.tf (excerpt)`, `backend.tf`), anything a scripted
  `cat FILE` / `tail FILE` / `head -n N FILE` prints, and `terminal.files`
  (disk-only files, with `changes` that apply once actions are taken):

  ```yaml
  terminal:
    files:
      - path: /etc/fstab
        content: |
          UUID=...4f71  /srv/media  ext4  defaults,nofail  0  2
        changes:
          - when_actions: [fix-fstab]
            content: |
              UUID=...4f17  /srv/media  ext4  defaults,nofail  0  2
  ```

  Reading a file that's on disk (`cat`, `grep`, `tail`...) runs in the shell, so
  the file must say what your scripted output says; a test checks every one.
- **Fixes can be edits.** Give the action a `file`; editing it until it matches
  (sed -i, `>`, `nano`, `vi`) takes the action, behind the same gate as the
  buttons, and the button writes `after`:

  ```yaml
  - id: fix-logrotate
    kind: fix
    file:
      path: /etc/logrotate.d/app
      matches: '^/var/log/app/\*\.log'   # multiline regex, true once fixed
      after: |                            # what the button writes
        /var/log/app/*.log { ... }
  ```
- **Hosts.** The prompt's host is where the player starts. Hosts in scripted
  `ssh HOST ...` lines exist: `ssh HOST cmd` runs there, `ssh HOST` logs in
  until `exit`. Local scripts (`./order-sync`) exist and answer from their
  scripted lines.
- **Database prompts** (`postgres=#`, `mysql>`) aren't a shell: they stay
  scripted only.

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

## Terraform incidents (the `terraform:` block)

Add a top-level `terraform:` block and the player gets a real `terraform`
command working on real `.tf` files in a lab directory. Its output (plan,
errors, state) comes from the simulator, not from scripted text, so do NOT
script `terraform …` commands in `terminal.commands`. Keep scripting other
tools (`git`, `aws`) as usual.

```yaml
terraform:
  dir: "~/infra"            # where the files live (players cd there)
  files:
    - path: main.tf         # relative paths only, no leading / or ..
      content: |
        resource "aws_s3_bucket" "logs" { bucket = "acme-logs" }
  state:                    # what Terraform last applied
    - type: aws_s3_bucket
      name: logs
      attrs: { id: acme-logs, bucket: acme-logs }
  evidence:
    - { evidence: drift, command: plan, contains: "must be replaced" }
```

Fields:
- `dir`: the lab directory (default the shell's starting directory; `~/` and absolute paths work). `version`: Terraform version like `1.9.8`. `initialized`: false makes the player run `terraform init` first.
- `files`: the starting `.tf` files (at least one). `vars`: values for `variable` blocks.
- `state`: managed (or `mode: data`) objects. Every `attrs` needs a string `id`. `key` makes a `count` or `for_each` instance; `status: tainted` marks one tainted. `outputs`: output values (`sensitive: true` hides them).
- `cloud`: what really exists. By default it is exactly what `state` says. `cloud.patch` changes attributes of an existing object (drift), `cloud.delete` removes one, `cloud.add` creates one Terraform does not manage.
- `evidence`: awards a tag when the named subcommand's output contains the substring. Check the exact text by running the command in the shell.

- `lock`: a state lock someone else holds (see "State locks" below). `workspace`, `workspaces`: extra workspaces (see "Workspaces" below).

Commands that work: `init`, `validate`, `plan`, `apply`, `destroy`, `show`, `state list|show|pull|mv|rm`, `import`, `taint`, `untaint`, `refresh`, `force-unlock`, `output`, `workspace show|list|new|select|delete`, `version`. The rest (`console`, `state push`, `state replace-provider`, …) answer "not simulated yet".

`evidence[].command` is one of: `plan`, `validate`, `init`, `show`, `output`, `version`, `state list`, `state show`, `state pull`, `state mv`, `state rm`, `apply`, `destroy`, `import`, `taint`, `untaint`, `refresh`, `force-unlock`, `workspace show`, `workspace list`, `workspace new`, `workspace select`, `workspace delete`.

Making a fix detectable: use a `file:` action on the `.tf` file (`path` absolute under `dir`, `matches` a regex that the fixed file satisfies, `after` the full fixed content for the button). Verification is the player running `terraform plan` again, so the usual rule that a terminal command needs `when_actions` is skipped for these incidents. Only resource types listed in `src/game/terraform/resources.ts` are supported.

### Apply, destroy and faults

`terraform apply` and `terraform destroy` really change the simulated state
and cloud. They print the plan, ask for confirmation, then one progress line
per resource (`Creating...`, `Still creating... [10s elapsed]`,
`Creation complete after 3s [id=...]`) and `Apply complete! Resources: ...`,
plus an `Outputs:` section.

- Confirmation: the player types `yes` in a dialog, passes `-auto-approve`, or pipes it (`echo yes | terraform apply`). Anything else (or empty piped input) prints `Apply cancelled.` / `Destroy cancelled.` and exits 1.
- Saved plans: `terraform plan -out=f` then `terraform apply f` applies exactly that plan without asking. If the state has changed since (another apply, for example), it fails as stale. Variables and `-replace` cannot be given with a saved plan.
- A failed apply leaves a half-applied world: what succeeded before the error stays in state and the cloud; the rest does not happen. The player fixes the cause and applies again.
- `terraform destroy` honours `prevent_destroy` and fails the same way a plan would.
- Evidence matches per command: a `terraform.evidence` entry with `command: plan` does not match the same text printed by `apply` or `destroy`. If the player might see the clue there, add a second entry with `command: apply` (or `destroy`).

`faults` script provider failures. They are the only way a create/update/delete
fails besides the simulator's own errors:

```yaml
terraform:
  faults:
    - at: aws_s3_bucket.logs        # instance or resource address
      on: create                    # create | update | delete
      error: "creating S3 Bucket (acme-logs): operation error S3: CreateBucket, https response error StatusCode: 403, api error AccessDenied: Access Denied"
      until_actions: [attach_policy]  # stops failing once the player takes this action
    - at: aws_sqs_queue.jobs
      on: create
      error: "creating SQS Queue (jobs): RequestError: send request failed (timeout)"
      times: 2                      # fails twice, then succeeds
```

Fields: `at`, `on`, `error` (the full text shown after `Error:`), `times`
(default: always), `if: { attr, equals }` (only when the new object's
attribute has that value; create/update), `until_actions` (list of action ids;
the fault stops once ALL are taken).

Rules:
- `times` counts across the whole play session. A reload replays the player's commands, so the counts rebuild the same way.
- A fault with `on: update` never fires for an item the plan makes a replacement (it runs as delete then create); use `delete`/`create` faults.
- Faults are checked before the simulator's own already-exists and `DependencyViolation` errors.
- Without `until_actions` (or with an empty list) a fault is never switched off by an action; limit it with `times` or the player's edit to the `.tf`.

### State commands

These change the current workspace's state only, never the cloud:
- `terraform state mv SRC DST`: renames an address in state (whole resources or single instances; a resource with one unkeyed instance can move into an indexed address, e.g. `aws_vpc.main` to `aws_vpc.main[0]`). `-dry-run` prints what would move without changing anything.
- `terraform state rm ADDR...`: forgets objects; they stay in the cloud, so the next plan wants to create them again. `-dry-run` works here too.
- `terraform import ADDR ID`: adopts a cloud object into state. The resource block must be declared in the configuration, a keyed address must be an instance the configuration produces (`count = 1` means only `[0]`; accepted if `count`/`for_each` can't be evaluated yet), and the object must exist in the cloud: put it in `cloud.add`, or in another workspace's state. Importing an address already in state fails. Works without a state file.
- `terraform taint ADDR` / `untaint ADDR`: marks or clears an instance as tainted; a tainted instance plans as `-/+` replace. `-allow-missing` turns a missing address into a silent success.
- `terraform refresh`: saves cloud drift into state (serial + 1 only when something changed) and prints the outputs. It plans no resource changes, so plan errors such as `prevent_destroy` do not stop it.

`state mv`, `state rm`, `taint` and `untaint` need a state file; `import` and `refresh` do not. Each successful change bumps the state serial.

### State locks

`lock` makes the state look locked by someone else, the way a cancelled CI run leaves it. Locks are authored only: a failed or cancelled apply in the game never leaves one behind.

```yaml
terraform:
  lock:
    id: 9db590f1-b6fe-c5f2-2678-8804f089deba    # required; what force-unlock needs
    who: ci@runner-7                            # required
    created: "2026-10-08 09:14:02.123456789 +0000 UTC"   # required
    operation: OperationTypeApply               # default OperationTypeApply
    path: terraform.tfstate                     # default terraform.tfstate
    info: ""                                    # default empty
    message: resource temporarily unavailable   # the "Error message:" line; this is the default
```

- A held lock stops `plan`, `apply` (including a saved plan), `destroy`, `refresh`, `import`, `taint`, `untaint`, `state mv`, `state rm`, `workspace new` and `workspace delete` with `Error acquiring the state lock` and the Lock Info (ID, path, operation, who, version, created, info). Argument and configuration errors still come first.
- Read-only commands ignore it: `init`, `validate`, `show`, `output`, `state list|show|pull`, `workspace show|list|select`, `version`, `fmt`.
- `-lock=false` on a blocked command runs it anyway (the lock stays). `-lock-timeout` is accepted but never waits.
- `terraform force-unlock LOCK_ID` asks for `yes` (dialog, or `echo yes | terraform force-unlock ID`) and clears the lock; `-force` skips the question. A wrong ID or no lock fails with `Failed to unlock state`. Declining prints `force-unlock cancelled.`.
- There is one lock for the lab, shared by all workspaces. Runs outside the lab directory never see it.

Example, a stuck lock after a cancelled CI run: the pipeline was cancelled mid-apply, and now every `terraform plan` fails.

```yaml
terraform:
  dir: "~/infra"
  files:
    - path: main.tf
      content: |
        resource "aws_s3_bucket" "logs" { bucket = "acme-logs" }
  state:
    - type: aws_s3_bucket
      name: logs
      attrs: { id: acme-logs, bucket: acme-logs }
  lock:
    id: 9db590f1-b6fe-c5f2-2678-8804f089deba
    who: runner@ci-build-4411
    created: "2026-10-08 09:14:02.123456789 +0000 UTC"
  evidence:
    - { evidence: stuck_lock, command: plan, contains: "runner@ci-build-4411" }
```

The player reads the Who/Created lines, confirms in the CI logs (scripted commands) that the run is dead, then runs `terraform force-unlock 9db590f1-…` and a clean `terraform plan`. A trap worth a `destructive` action: force-unlocking a lock that a live run still holds.

### Workspaces

The top-level `state` and `outputs` are the `default` workspace. `workspaces` adds others by name; `workspace` picks the one the player starts in (default `default`). Names use letters, digits, `.`, `_` and `-`.

- Each workspace has its own state; a workspace without `state:` has no state file yet. The cloud is shared: every workspace's objects exist in it, and `cloud.add|patch|delete` apply on top.
- `terraform.workspace` evaluates to the current name. A saved plan made in another workspace is refused as stale.
- `workspace new NAME` creates an empty workspace and switches to it, so `plan` wants to create everything (and `apply` then collides with the objects the other workspace owns). `workspace select NAME` switches (`-or-create` creates a missing one). `workspace delete NAME` refuses the current workspace, `default` and (without `-force`) one that still tracks objects; deleting never touches the cloud.

Example, the wrong workspace: the player starts in `staging` and plan offers to create prod's resources.

```yaml
terraform:
  dir: "~/infra"
  files:
    - path: main.tf
      content: |
        resource "aws_s3_bucket" "logs" { bucket = "acme-logs" }
  workspace: staging         # where the player starts
  state:                     # the default workspace (prod)
    - type: aws_s3_bucket
      name: logs
      attrs: { id: acme-logs, bucket: acme-logs }
  workspaces:
    staging: {}              # exists, no state file yet
  evidence:
    - { evidence: wrong_ws, command: workspace show, contains: staging }
```

The fix is `terraform workspace select default` and a clean plan; applying in `staging` fails with the bucket already owned.

### `done_when`: actions detected from the world

An action (top level or in a stage) can carry `done_when`, a predicate about the lab's live world. It is taken once the predicate holds, whichever commands got it there. It needs a `terraform:` block.

```yaml
actions:
  - id: remove-guard
    kind: destructive
    done_when: { applied: { op: delete, address: aws_db_instance.orders } }
  - id: revert-and-migrate
    kind: fix
    done_when:
      all:
        - plan_clean: true
        - not: { applied: { op: delete, address: aws_db_instance.orders } }
        - not: { applied: { op: create, address: aws_db_instance.orders } }
```

Leaves (one key each):

| Leaf | True when |
|---|---|
| `plan_clean: true` | A real refresh and plan, run now on the files on disk with variables resolved as `terraform plan` does (including exported `TF_VAR_*` from the saved shell environment), shows no changes and no diagnostics. It ignores locks. False when the configuration cannot be planned (syntax error, missing variable, no config). |
| `plan_has: { no_destroy: [ADDR, …] }` | That same plan would not destroy or replace any listed address. Same plan caveats as `plan_clean`; false if it cannot be planned. |
| `state_has: ADDR` / `state_lacks: ADDR` | The address is (or is not) in state. |
| `lock_free: true` | No state lock is held. |
| `reality_has: { type, id, attr?, equals? }` | The cloud holds that object. With `attr` it must have the attribute, and with `equals` the value must match. `type` must be a supported resource type. |
| `reality_lacks: { type, id }` | The cloud no longer holds it. |
| `applied: { op, address }` | An apply did `op` (`create`, `update`, `delete`, `import`, `forget`) to the address at some point in this lab. It survives a recreate, so it catches "destroyed at some point". Only apply steps count (including `import` and `removed` blocks); the CLI's `terraform import` and `terraform state rm` record nothing. The history is not per workspace: an apply in any workspace counts. |
| `file_contains: { path, matches }` | The file at the absolute `path` matches the regex (multiline). |

```yaml
done_when: { state_lacks: aws_instance.web }
done_when: { reality_has: { type: aws_s3_bucket, id: logs, attr: versioning, equals: true } }
done_when: { plan_has: { no_destroy: [aws_db_instance.orders] } }
done_when: { lock_free: true }
done_when: { file_contains: { path: /home/you/infra/db.tf, matches: 'ignore_changes\s*=\s*\[[^\]]*storage_encrypted' } }
```

An address without a key (`aws_instance.web`) covers every instance (`aws_instance.web[0]`, `["a"]`); one ending in `]` matches only that instance.

Nesting (the validator enforces it): a leaf; `not: LEAF`; `all: [...]` or `any: [...]`, non-empty, whose members are each a leaf or `not: LEAF`. Nothing deeper: no `all` inside `all`, no `not` of `not`.

How it runs:
- It is evaluated after each terminal command and after each log change, against the live world (state, cloud, lock, apply history, and the files on disk as they are now).
- With a `file:` on the same action, both must hold. `file:` is checked first, so use it for the cheap text test.
- Buttons still take actions directly, as the accessible fallback, so `done_when` is not enforced on a click.
- The root-cause gate applies: an action detected before the player names the root cause is not lost, it is taken once the cause is named (the terminal prints a "(Saved. …)" note meanwhile).
- Anything that goes wrong while evaluating counts as not satisfied.

Author guidance:
- Pair every `destructive` trap with an `applied` or `reality_*` predicate, so the penalty comes from the real destroy, not from a button.
- A fix whose file text could look fixed after the resource was destroyed and recreated needs `not: { applied: { op: delete, address: … } }` as well as the plan or file check. Use `terraform-forces-replacement.yaml` as the model: the trap is `applied delete`, the fix is `plan_clean` and neither `applied delete` nor `applied create` (a `state rm` then apply would otherwise recreate it), and the wrong fix is a `file_contains` for `ignore_changes`.
- Evidence timing: `terraform.evidence` entries are visible from the start at every stage. Do not make evidence that depends on a world a fix changes (for example the lock error after `force-unlock`) a `key_evidence` tag of a later stage; the player may already have lost the chance to see it.

Known gaps to design around:
- Sensitive values are not tracked through expressions: a secret copied into another attribute prints in the clear.
- Lists and sets render the way the AWS provider shows its attributes.
- The block is top-level only; there are no per-stage `terraform` blocks.
