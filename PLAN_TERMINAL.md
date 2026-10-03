# Plan: A terminal that feels real

Status: **approved 2026-10-03 with the defaults; T1 done (shell behind the terminal, xterm.js view, simple-terminal setting; verified in headless Chrome). T2 next.** Requested: "I want this to feel
much more real than it does currently ... as close to fully functional as
practical as possible."

## 1. Where we are

Today's terminal is a lookup table. A typed line is normalized and compared with
the incident's scripted commands; a match prints canned output, anything else
prints "no simulated output". There are no pipes, no files you can `cat`, no
`cd`, no variables, and `kubectl logs ... | grep -c error` only works if an
author scripted that exact line. Tab completion, history and `help` are ours.

## 2. What "real" means here

A player should be able to work the way they would on the job:

- **Real shell syntax:** pipes, `&&`/`||`/`;`, redirection (`>`, `>>`, `2>&1`),
  quoting, variables and `export`, globs, `$(...)`, loops, `history`, `!!`.
- **Real text tools on real output:** `grep`, `awk`, `sed`, `sort`, `uniq -c`,
  `wc`, `head`, `tail`, `cut`, `jq`, `xargs`, `diff`, all actually computing on
  whatever came before them in the pipe.
- **A filesystem to explore:** `cd`, `ls -la`, `cat`, `less`, `find`, `du`, on
  each host: `/etc`, `/var/log`, the app's directories, populated from the
  incident's files and logs plus a believable skeleton.
- **The incident's tools:** `aws`, `az`, `gcloud`, `kubectl`, `systemctl`,
  `journalctl`, `psql`, `curl`, `dig`, `ss`... answering from the incident's
  scripted data, accepting flags in any order and the usual spellings, with
  `--help` and realistic errors for unknown subcommands or resources.
- **More than one machine:** `ssh db-01` changes host, prompt and filesystem.
- **A proper terminal:** line editing, Ctrl-C, Ctrl-L, Ctrl-R history search,
  Ctrl-A/E, Tab completion of commands, subcommands, flags and paths, and colour.
- **Changes you make stick:** editing a config (`sed -i`, `>>`, a small editor)
  or restarting a service changes what later commands show, and can be the fix.

What stays simulated: there is no real cloud, network or kernel. Cloud CLIs,
`kubectl`, `systemctl` and network tools are programs that read the incident's
data. Anything the incident doesn't cover says so honestly (section 6, Q3).

## 3. Approach

**Shell engine: [just-bash](https://github.com/vercel-labs/just-bash)** (Vercel
Labs, Apache-2.0). A bash interpreter written in TypeScript with an in-memory
filesystem and 70+ reimplemented commands (grep, sed, awk, jq, find, sort,
head, tail, wc, tar...). It runs in the browser, and it lets us register our own
commands (`defineCommand`) that receive argv, stdin, cwd, env and the
filesystem. Writing our own shell would take months to reach the same fidelity.
It isn't on the browser's main bundle: the terminal loads it on first use.

**Terminal UI: [xterm.js](https://xtermjs.org/)** (MIT), the terminal VS Code
uses: real cursor, line editing, key bindings, colour, copy/paste. It has a
screen reader mode; we keep a plain-text transcript view as an accessible
fallback and for small screens (Q2).

**Incident programs as custom commands.** Each incident's scripted commands
become a program table: `aws`, `kubectl`, `systemctl`... look up the invocation
against the scripted entries (flag order ignored, `--flag=value` and
`--flag value` equivalent, quotes normalized), respect `when_actions` as now,
and write the scripted output to stdout so the rest of the pipeline works on
it. Typed fixes keep their `match_regex` actions and their gating ("declare a
root cause first").

**Files and hosts.** An incident's `files` and `logs` with a path are mounted
at that path; the prompt's host (`ops@media-01`) names the machine. A shared
skeleton gives each host-type the basics (`/etc/hostname`, `/etc/os-release`,
`/etc/hosts`, `/var/log`, home directory, `/proc/meminfo`-style files where the
incident's data implies them). `ssh HOST` switches to that host's filesystem.

**Evidence and the debrief still work.** Evidence is awarded when a tagged
program runs (even inside a pipeline) or a tagged file is read (`cat`, `less`,
`grep`, `tail`...). The command breakdown records which programs ran.

## 4. Schema additions (backwards compatible)

Every existing incident keeps working unchanged; these are opt-in.

- `hosts`: per-host prompt, filesystem additions and which commands exist there.
- File paths on scripted command output: e.g. a log can live at
  `/var/log/nginx/error.log` so `tail -f`, `grep` and `wc -l` work on it.
- `state` predicates for fixes: an action can be satisfied by a file's
  content (`/etc/fstab` contains the right UUID) or a service state, not only by
  a typed regex. That's how editing a config becomes the fix.
- Optional `help` text per program (generated from the command library where
  possible, so `kubectl get --help` says something useful).

## 5. Milestones

| # | Work | Done when |
|---|---|---|
| T1 | Spike and swap: just-bash + xterm.js behind a lazy chunk, at parity with today (help, Tab, history, transcript replay, evidence); measure bundle size and mobile behaviour | All 487 tests pass; no incident changes; bundle report |
| T2 | Incident programs: scripted commands as custom commands with lenient matching; pipes and redirection over their output; evidence from pipelines; `--help` and realistic errors | `kubectl logs ... \| grep -c X` works with no extra authoring in any incident |
| T3 | Filesystem and hosts: mount files and logs at their paths, host skeletons, `ssh`, `cd`/`ls`/`cat`/`less`/`find` everywhere, prompt shows user@host:cwd | Every Linux and networking incident explorable by path |
| T4 | Changes that stick: file edits (`sed -i`, redirection, a small `nano`), `systemctl restart`/`reload`, state predicates as fixes | Two Linux incidents converted so editing the file is the fix |
| T5 | Content realism pass: move logs onto paths, add hosts, review every incident's ideal path in the new shell; accessibility and mobile check | Every incident's ideal path works typed, start to finish |

## 6. Open questions (my default in **bold**)

1. Use just-bash rather than writing our own shell? **Yes** (T1 confirms bundle
   size and browser behaviour before we commit; if it's unworkable we fall back
   to a smaller in-house shell with pipes and the 20 most-used tools).
2. xterm.js for everyone, or keep today's plain transcript as an option? **xterm
   by default, with a "simple terminal" setting** (screen readers, phones).
3. When a player runs a real tool the incident doesn't cover (say
   `aws ec2 describe-vpcs` in an S3 incident): realistic empty or error output,
   or an honest note? **Realistic where it's safe** (empty lists, "not found"
   for unknown names) **and an honest one-line note otherwise**, never invented
   data that could mislead the diagnosis.
4. Should fixes be typable as real commands and edits everywhere, keeping the
   action buttons as a fallback? **Yes**, buttons stay for accessibility and
   for players who know the fix but not the syntax.
5. Order: **T1-T3 first** (most of the "feels real" gain), then T4 and T5.
