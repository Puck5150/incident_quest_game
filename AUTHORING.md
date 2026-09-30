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
4. **Acting:** the player chooses from `actions`. The incident resolves when every
   action in any one `solution_paths` entry has been taken, in any order.
5. **Debrief:** shows `debrief`, `analogy`, and `sources`.

## Writing good incidents

- **Ticket = symptoms, not causes.** "Checkout returning 500s", not "Disk is full".
- **Evidence should chain.** Each artifact should point at the next place to look.
  Tag the essential ones with `evidence:` and list them in `key_evidence`. Players
  who find all of them before declaring a hypothesis earn the methodical bonus.
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
  `du -sh /var/log/*`). Remember to escape backslashes in YAML strings (`\\*`).
- **The analogy should use no IT words.** If you need jargon to explain it, it's
  not an analogy yet.

## Accuracy rules (non-negotiable)

- Commands, flags, output formats, and error messages must come from **official**
  documentation: vendor docs, man pages, RFCs, the Google SRE books.
- Record every page you relied on in `sources`, with the date you read it.
- When you base output on your own real-world experience and it isn't shown verbatim
  in the docs, that's fine, but add a line to `CONTENT_TODO.md` noting it.
- If you can't verify something, don't guess. Put it in `CONTENT_TODO.md`.
