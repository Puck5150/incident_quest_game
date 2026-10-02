# Plan: Command breakdown in the debrief

Status: **approved 2026-10-02 (key + verify + what you ran; shared library); B1
done with Linux as the first track; B2 done (AWS, Azure, Google Cloud); B3 done (every track; missing entries now fail the build); B4 next.** Requested: "a breakdown of
the commands that are used to troubleshoot these challenges ... what each
command does, explain the switches and regex (if needed), and why this command
is the best one, show some alternative commands ... available after
completing a challenge."

## 1. What the player gets

A **Command breakdown** card in the after-action report, one entry per command
that mattered in this incident:

```
$ ss -ltn sport = :5432
  What it does   Lists listening TCP sockets, filtered to port 5432.
  Parts          ss            socket statistics (replaces netstat)
                 -l            listening sockets only
                 -t            TCP only
                 -n            numeric: show 5432, not "postgresql"
                 sport = :5432 filter on source (local) port 5432
  Why this one   Answers "is anything listening, and on which address?" in one
                 line, which is exactly what "Connection refused" asks.
  Alternatives   netstat -ltnp | grep 5432   older tool, same idea
                 lsof -iTCP:5432 -sTCP:LISTEN   also shows the process
  Docs           man ss (man7.org)
  You ran it     yes, before declaring the cause
```

Regex and filters inside commands (grep -E patterns, awk conditions, jq and
JMESPath queries, kubectl jsonpath) get a plain-English line of their own under
**Parts**.

## 2. Where the content lives

389 distinct commands appear across 101 incidents, but they're built from 151
tool+subcommand pairs (curl, kubectl get, aws ec2, gh run...). Writing a
breakdown per incident would repeat the same explanations dozens of times. So:

- **A shared command library** (`content/commands/*.yaml`, one file per tool
  family: linux, networking, kubernetes, aws, azure, gcp, git-github, terraform,
  databases). Each entry: a pattern that matches the commands it explains, what
  it does, the parts (flags, arguments, filters), why it's the right tool for
  that kind of question, alternatives, and an official docs link.
- **An optional per-incident note** (`command_notes` in the incident file) for
  "why this command, here": one sentence tying it to this incident's evidence.
- The debrief matches each of the incident's commands to the library and shows
  the generic breakdown plus the incident note.

## 3. Which commands appear (open question 1)

Default: commands that produce **key evidence**, plus the **verification**
commands (outputs that change after the fix), plus any other command **the
player actually ran**. That keeps each card focused (usually 3 to 6 entries)
while still explaining whatever you typed.

## 4. Checks

- Build check: every command that produces key evidence or verifies a fix must
  match a library entry, so new incidents can't ship without breakdowns.
- Library entries need an official docs link (link checker covers them).
- Each **Parts** list must account for every flag in the matched form (checked
  loosely: every token starting with `-` in the example must be explained).

## 5. Milestones

| # | Work | Done when |
|---|---|---|
| B1 | Library format, matching, debrief card, build check (warn-only at first) | Card shows for one track end to end (Linux); tests |
| B2 | Library entries: AWS, then Azure, then Google Cloud | Those tracks pass the check |
| B3 | Library entries: Linux, Networking, Databases, Containers, CI/CD, IaC, Microservices | All pass; check becomes an error |
| B4 | Per-incident notes where the generic "why" isn't enough; AUTHORING section | Docs updated |

Roughly 150 library entries in all. Facts come from official docs (man7.org,
OpenSSH, AWS/Azure/Google CLI references, kubectl, gh, Terraform, PostgreSQL,
MySQL), with representative-output caveats as usual.

## 6. Open questions (my default in **bold**)

1. Which commands appear? **Key evidence + verification + anything the player
   ran** / every command in the incident / only what the player ran.
2. Shared library plus optional per-incident note? **Yes.**
3. Order: **AWS, Azure, Google Cloud first**, then the other tracks.
4. Also reachable from the Field manual during play? **No**, after completion
   only, as requested (it would give away which commands matter).
