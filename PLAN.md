# Incident Quest: Plan (Milestone 1)

Status: **draft, awaiting your approval.** No code has been written.

---

## 1. What we're building, in one paragraph

A single-page browser game with no backend. You pick an incident from a queue. The incident screen shows a ticket and a few investigation tools: a fake terminal, logs, config files, and a system diagram. You dig through the evidence, declare what you think the root cause is, and apply a fix. Then a debrief explains what actually happened, the ideal troubleshooting path, how your approach compared, a non-IT analogy, and links to official docs. XP, ranks, streaks, and a skill tree sit on top. Every incident is a YAML file. Adding content means writing YAML, not code.

---

## 2. Tech stack

| Choice | Decision | Why / notes |
|---|---|---|
| Language + UI | **TypeScript + React + Vite** | Agree. Boring, well documented, fast dev loop. |
| Styling | **Tailwind CSS** | Agree. Design tokens (status colors, glow) go in one theme file. Dark/light mode through Tailwind's `dark:` variant driven by a class on `<html>`. |
| Animation | **Motion** (formerly Framer Motion) | Same library under a new package name. I'll confirm the current package and import path against the official docs at scaffold time. Its built-in reduced-motion support covers the accessibility requirement. |
| Terminal | **Small custom React component. Not xterm.js.** | *I disagree with xterm.js here.* xterm.js emulates a real terminal: it expects a byte stream from a pty, and we'd still have to write line editing, history, and prompt handling ourselves. It also renders to a canvas/grid, which works against screen readers and text selection. Our terminal just matches a typed command against a lookup table. A text input plus a scrolling output list is about 150 lines, fully accessible, and styled like everything else. |
| Charts | **Recharts** (added in Milestone 5, when the first metric graph is needed) | React-native API, widely used, good docs. uPlot is smaller and faster, but its imperative API is harder to read. We're plotting maybe 60 points, so performance doesn't matter. |
| Trace waterfall, pipeline view, architecture diagram | **Plain React + CSS/SVG. No library.** | These are boxes positioned by numbers from the scenario file. A diagram library (Mermaid, React Flow, dagre) is heavier than the problem. |
| Content format | **YAML** | Incidents are mostly multi-line text (logs, command output, configs). YAML block scalars (`\|`) keep that readable. In JSON it becomes `\n`-escaped soup. |
| Schema + validation | **Zod** | One schema that works as both TypeScript types and a runtime validator. No hand-kept duplicate type definitions. |
| Build-time validation | **A small Vite plugin (~30 lines)** that parses each `.yaml` file and validates it with the Zod schema | A bad scenario **fails `npm run build`** and shows an error overlay in dev with the file name and field path. The same validator runs in a Vitest test. |
| State | **React `useReducer` + a pure game engine module.** No Redux/Zustand. | One incident session is one reducer. The engine is pure functions, so it's easy to unit test and easy to read. |
| Routing | **None for MVP.** A top-level `screen` state switches views. | Four screens don't need a router. Deep links and back-button support go in the parking lot. |
| Persistence | **localStorage**, one versioned key (`incident-quest:v1`) | The version number lets us migrate or reset cleanly if the save format changes. |
| Tests | **Vitest** (+ React Testing Library for a couple of component tests) | Priority: schema test over all content, then engine/scoring unit tests. |

Versions get pinned at scaffold time (Milestone 2) from each project's current official install docs. I'm not choosing version numbers from memory.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  content/**/*.yaml ──(Vite plugin: parse + Zod validate)──┐      │
│                                                            ▼      │
│  src/content/index.ts   ← all scenarios, typed, as one list      │
│                                                            │      │
│  src/game/engine.ts     ← pure: (session, event) → session       │
│  src/game/scoring.ts    ← pure: session → score breakdown        │
│  src/game/progress.ts   ← load/save localStorage, ranks, unlocks │
│                                                            │      │
│  src/screens/*          ← Home (queue), Incident, Debrief,       │
│                           SkillTree                               │
│  src/components/*       ← Terminal, LogViewer, FileViewer,       │
│                           SystemDiagram, TraceWaterfall,         │
│                           MetricChart, PipelineView, HintPanel,  │
│                           ActionPanel, Ticket                    │
└─────────────────────────────────────────────────────────────────┘
```

**Key rule: UI components hold no game logic.** They render state and send events such as `RUN_COMMAND`, `OPEN_ARTIFACT`, `REQUEST_HINT`, `DECLARE_HYPOTHESIS`, and `TAKE_ACTION`. The engine decides what those events mean. So the rules live in one file you can read top to bottom, and they're tested without a browser.

### Proposed folder layout

```
/content
  _template.yaml
  tracks.yaml                 # track names, order, prerequisites
  networking/dns-resolution-failure.yaml
  linux/full-disk.yaml
  containers/crashloopbackoff.yaml
  iac/terraform-state-lock.yaml
  cicd/failing-github-actions.yaml
  microservices/cascading-failure.yaml
/src
  schema/scenario.ts          # Zod schema = single source of truth for content shape
  content/index.ts            # imports validated scenarios
  game/engine.ts, scoring.ts, progress.ts
  screens/…, components/…
  styles/theme.css
/tests
  content.test.ts             # every scenario validates + cross-reference checks
  engine.test.ts, scoring.test.ts
vite-plugin-scenarios.ts
AUTHORING.md  PARKING_LOT.md  CONTENT_TODO.md  PLAN.md
```

---

## 4. Data model

### 4.1 Scenario (one YAML file per incident)

Shown here as an abbreviated example rather than a type definition, since that's how you'll actually write them:

```yaml
id: linux-full-disk-01            # unique, kebab-case, stable forever (progress is keyed on it)
track: linux                      # must exist in tracks.yaml
difficulty: 1                     # 1–5
title: "Web app returning 500s — disk full?"
par_minutes: 8                    # time bonus reference

ticket:                           # what the player sees first
  from: "Monitoring bot"
  priority: P2
  body: |
    Checkout page returns HTTP 500 since 02:14. No deploys today.

environment: |                    # short plain-English description of the system
  Single Ubuntu VM running nginx + a Python app, logs to /var/log/app.

# ---------- Investigation artifacts ----------
terminal:
  prompt: "ops@web-01:~$"
  commands:                       # matched top-down; first match wins
    - match: "df -h"              # exact match after whitespace normalization
      when_actions: [clear-old-logs]   # optional: only matches after this action was taken
      output: |
        Filesystem      Size  Used Avail Use% Mounted on
        /dev/sda1        40G   22G   18G  55% /
    - match: "df -h"
      evidence: disk-full          # marks this as key evidence (used for scoring + debrief)
      output: |
        Filesystem      Size  Used Avail Use% Mounted on
        /dev/sda1        40G   40G     0 100% /
    - match_regex: "^du .*/var/log"
      evidence: big-logs
      output: |
        ...
  unknown_output: "bash: {cmd}: command not found"   # optional per-scenario override

logs:
  - name: "/var/log/app/error.log"
    evidence: write-failure
    lines: |
      2026-09-30T02:14:03Z ERROR OSError: [Errno 28] No space left on device

files:                            # config/file viewer
  - path: "/etc/logrotate.d/app"
    language: text
    content: |
      ...

diagram:                          # optional; simple grid positions, no auto-layout
  nodes:
    - { id: lb,  label: "nginx", col: 0, row: 0, status: ok }
    - { id: app, label: "app",   col: 1, row: 0, status: down }
  edges:
    - { from: lb, to: app }

# Optional distributed-systems artifacts (same idea, all data-driven):
# traces:   [{ name, spans: [{ service, operation, start_ms, duration_ms, status, parent? }] }]
# metrics:  [{ name, unit, series: [{ label, points: [[t, value], ...] }] }]
# pipeline: { run_name, stages: [{ name, status, duration_s, log }] }

# ---------- Reasoning + resolution ----------
hypotheses:                       # player must pick one before fix actions unlock
  - id: disk-full
    text: "The root filesystem is full; the app can't write."
    correct: true
  - id: db-down
    text: "The database is unreachable."
    feedback: "Error log shows Errno 28, which is a local write failure, not a connection error."

actions:
  - id: clear-old-logs
    label: "Compress/remove rotated logs older than 7 days"
    kind: fix                     # fix | wrong | destructive
    feedback: "Frees space without touching live data."
  - id: reboot
    label: "Reboot the server"
    kind: destructive             # penalized: "shotgun" action
    feedback: "Disk is still full after reboot. You caused downtime and fixed nothing."
  - id: fix-logrotate
    label: "Fix the logrotate config so it can't recur"
    kind: fix

solution_paths:                   # resolved when ALL actions of ANY one path are taken
  - [clear-old-logs, fix-logrotate]

key_evidence: [disk-full, write-failure]   # the "methodical" path; debrief shows what you found

hints:                            # exactly 3 tiers
  nudge: "What does Errno 28 mean?"
  direction: "Check free space on the filesystems."
  answer: "Run df -h, then find what's filling / with du."

analogy:
  title: "A full filing cabinet"
  text: |
    The clerk isn't broken. There's just no drawer space left for new paperwork...

debrief:
  root_cause: |
    ...
  ideal_path:                     # ordered steps shown on the debrief screen
    - "Read the error log: Errno 28 points at storage."
    - "Confirm with df -h."
    - ...
  real_world: |                   # optional "how this shows up in production" note
    ...

sources:                          # required, at least 1
  - title: "df(1) — Linux manual page"
    url: "https://man7.org/linux/man-pages/man1/df.1.html"
    retrieved: 2026-09-30
```

### 4.2 Cross-reference checks (in the validator, beyond field types)

Zod checks field shapes. A second pass checks the references between fields:

- `track` exists in `tracks.yaml`; `id` is unique across all files and matches the filename.
- Every id in `solution_paths`, `when_actions`, and `key_evidence` points at a real action or evidence tag.
- Exactly one hypothesis has `correct: true`.
- Every `kind: fix` action appears in at least one solution path.
- Every `match_regex` compiles.
- `sources` is non-empty, and each `retrieved` is a valid date.

These catch the typos that would otherwise produce an incident nobody can finish.

### 4.3 Tracks (`content/tracks.yaml`)

```yaml
- { id: networking,    name: "Networking",         requires: [] }
- { id: linux,         name: "Linux Admin",        requires: [] }
- { id: containers,    name: "Containers & K8s",   requires: [linux] }
- { id: iac,           name: "Infrastructure as Code", requires: [] }
- { id: cicd,          name: "CI/CD",              requires: [] }
- { id: microservices, name: "Microservices",      requires: [networking, containers] }
```

All 14 tracks are defined here eventually. **The skill tree only renders tracks that have at least one scenario.**

### 4.4 Player progress (localStorage)

```ts
{
  version: 1,
  xp: number,
  completed: { [scenarioId]: { bestScore, completedAt, hintsUsed, clean: boolean } },
  streak: { current, best, lastDay },   // see open question 3
  settings: { theme: "dark" | "light", reducedMotion: "system" | "on" | "off" }
}
```

Rank and unlocks are **computed from `xp` and `completed`, never stored**, so they can't drift out of sync.

Ranks (XP thresholds tuned in Milestone 4): Help Desk, Support Engineer, Systems Engineer, Senior Engineer, Staff Engineer, Principal Engineer.

---

## 5. Game loop

```
 BRIEFING ──start──▶ INVESTIGATING ──declare hypothesis──▶ ACTING ──solution path complete──▶ RESOLVED ──▶ DEBRIEF
                       ▲    │                                 │
                       │    └── hints (any time, cost XP)     │
                       └────── wrong hypothesis / "back to investigating" ◀──┘
```

1. **Briefing:** ticket, environment description, and the diagram if the scenario has one. The timer starts when you click "Take incident".
2. **Investigating:** terminal, logs, files, and the optional trace/metric/pipeline views. The engine records every command and artifact you open. That record drives both the scoring and the "what you did" section of the debrief.
3. **Hypothesis:** pick a root cause from the scenario's list. A wrong pick shows its feedback, costs a little XP, and sends you back to investigating. This step exists to make you *think before acting*, which is the core skill.
4. **Acting:** the action panel unlocks. `fix` actions move you toward a solution path. `wrong` actions show feedback with a small penalty. `destructive` actions show feedback with a large penalty; this is the "restart everything" trap. After an action, terminal output can change via `when_actions`, so you can **verify** the fix (e.g., run `df -h` again). Verifying is worth a small bonus.
5. **Resolved:** a short celebration animation, then the XP counter tallies up.
6. **Debrief:** root cause, the ideal path, a side-by-side of your path vs. the ideal, evidence you found and missed, the analogy, and the source links.

**Terminal behavior:** built-ins are `help` (lists commands this scenario understands, which is itself a mild hint and free), `clear`, and up/down history. Commands are matched after trimming and collapsing whitespace. Anything unmatched returns the scenario's `unknown_output` or a sensible default. **The terminal only reads.** Fixes happen through the action panel, so outcomes stay unambiguous. Typing fix commands is in the parking lot.

---

## 6. Scoring

Everything is computed from the session log by one pure function. The debrief shows the line-item breakdown so you can see *why* you got the score.

| Line item | Value (starting point, tuned in M4) |
|---|---|
| Base | 100 × difficulty |
| Time bonus | up to +20% of base, linear down to 0 at 2× `par_minutes` |
| Methodical bonus | +20% of base if you saw all `key_evidence` *before* declaring your hypothesis |
| Verification bonus | +10% of base if you re-checked after fixing |
| Hints | nudge −10%, direction −25%, answer −50% (cumulative) |
| Wrong hypothesis | −10% each |
| Wrong action | −10% each |
| Destructive action | −25% each |
| Floor | You always earn at least 10% of base for resolving |

The time bonus is capped deliberately low, so rushing never beats being methodical.

A "clean" resolution means no hints and no destructive actions.

---

## 7. Documentation accuracy workflow (Milestone 5)

For each scenario:
1. Fetch the official docs for every command, flag, error string, and behavior used (man7.org, kubernetes.io, developer.hashicorp.com, docs.github.com, opentelemetry.io, etc.).
2. Write the scenario, recording each page in `sources` with today's date.
3. **Honest caveat:** official docs often document an error *message* but not a full realistic *output block* (exact `kubectl get pods` column spacing, for example). Where I build output from documented formats rather than a verbatim doc example, I'll log it in `CONTENT_TODO.md` as "representative, verify against a real run", so you can check it against your own experience.
4. Anything I can't verify goes in `CONTENT_TODO.md`, not into the scenario.

---

## 8. Visual design & accessibility

- **Layout:** incident screen = ticket/status bar on top; left rail of tool tabs (Terminal / Logs / Files / Diagram / Traces / Metrics / Pipeline, showing only those the scenario has); main panel; right panel for hypothesis/actions/hints.
- **Theme:** dark by default and a light toggle. Status colors (ok / warn / crit / info) are always paired with an icon or text label, **never color alone**. Subtle glow only on focus and active status.
- **Type:** system UI font for prose, a monospace stack for terminal/logs/files.
- **Accessibility:** everything reachable by keyboard with visible focus rings; terminal output in an `aria-live="polite"` region; contrast checked against WCAG AA in both themes; all animation turns off when the OS has reduced motion set or the in-app setting is on.
- **Responsive:** comfortable on laptop and desktop; usable on tablet; phone gets a stacked layout. It's playable on a phone, but that isn't the primary target.

---

## 9. Milestones (restated with concrete "done when")

| # | Deliverable | Done when |
|---|---|---|
| 1 | This plan + `PARKING_LOT.md` | You approve it. |
| 2 | `git init`, Vite/React/TS/Tailwind scaffold, Zod schema, Vite validation plugin, content test, `_template.yaml`, `AUTHORING.md`, one hardcoded scenario (full disk, unverified placeholder text marked as such) rendering ticket → hypothesis → action → "resolved" | `npm run build` and `npm test` pass; a broken YAML file fails both; you can click through the incident. |
| 3 | Terminal, log viewer, file viewer, hint system, engine event log | You can investigate the incident by typing commands; hints reveal in tiers; engine unit tests pass. |
| 4 | Scoring, debrief screen, localStorage progress, ranks, streaks, theme toggle | Score breakdown matches the table in §6 (unit tested); progress survives a reload. |
| 5 | Six doc-verified scenarios + diagram, trace waterfall, metric chart, pipeline view components | All six pass validation, every one has sources, and `CONTENT_TODO.md` lists anything unverified. |
| 6 | Visual polish, animations, skill tree UI (content tracks only), accessibility pass | Keyboard-only playthrough works; reduced motion is respected; contrast checked. |

**I'll `git init` at the start of Milestone 2 and commit once per milestone,** so you can review each milestone as a single diff. (I won't push anywhere.)

---

## 10. Open questions (my default in **bold**; I'll use it unless you say otherwise)

1. **Hypothesis gate.** Must the player declare a root cause before fix actions unlock? **Yes.** It enforces think-before-act. The alternative: optional, with a bonus for declaring.
2. **Terminal is read-only; fixes go through the action panel.** **Yes for MVP.** Typing fix commands (`systemctl restart …`) and having them count as actions goes in the parking lot. It's more immersive, but it makes matching far fuzzier.
3. **Streak type.** **Clean-resolution streak** (consecutive incidents resolved with no hints or destructive actions), which rewards the behavior we want. The alternative is a daily-play streak.
4. **Scenario order.** **Free choice among unlocked tracks**, sorted by difficulty. The alternative is a fixed campaign order.
5. **Placeholder scenario in M2.** **Full disk**, written quickly and clearly marked unverified, then properly rewritten with sources in M5.
