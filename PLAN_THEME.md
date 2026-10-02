# Plan: Ops Center theme

Status: **approved 2026-10-01; T1 done.** Shell-only theming, sound opt-in. Requested: "really feel like a
game, not just a test prep tutorial". Theme picked: cyber ops command center.

## 1. The idea

You're a responder on the night shift at a global operations center. Incidents
come in as missions on the ops board, light up regions on the wall map, and
you clear them under your own callsign. Design challenges are "build orders":
the center asks you to stand up infrastructure that will survive what's coming.

## 2. Principles

1. **The theme lives in the shell, the substance stays real.** Tickets,
   commands, logs, docs links and debriefs keep their real-world wording: the
   point is still to learn AWS, Azure and GCP as they actually are. Flavour goes
   in the chrome around them: names, screens, transitions, status, ranks.
2. **Dark first, but readable.** Ops-room look in dark mode; light mode still
   works ("day shift") through the existing color tokens. Contrast stays at
   current levels.
3. **Motion that respects settings.** Every animation is off under Reduce
   motion; any sound is opt-in and off by default.
4. **No new runtime dependencies.** CSS, SVG and the Web Audio API.

## 3. What changes

### 3.1 Vocabulary (T1)

| Now | Ops Center |
|---|---|
| Incident queue | Ops board |
| Track (AWS, Azure...) | Sector (Sector AWS...) |
| Take incident | Accept mission |
| Close incident | Close out |
| Debrief | After-action report |
| Design challenge | Build order |
| Skill tree | Clearance map |
| Hints | Ask HQ (still costs XP) |
| Field guide | Field manual |
| XP / rank | XP / clearance level |

Ranks retuned for today's ~65 items (the thresholds were sized for 6) and
renamed: Recruit, Operator, Specialist, Senior Specialist, Lead Responder,
Duty Commander, Ops Director.

### 3.2 Callsign (T1)

On first visit: "Choose your callsign" (free text, or a generated one like
NIGHTOWL-7). Shown in the header and the after-action report. Stored with
progress; changeable in settings.

### 3.3 Look (T2)

- Ops palette: near-black blue panels, cyan accent, amber warnings, red
  criticals; a faint grid behind the page; mono for headings and labels.
- Panels as "consoles": a thin header strip with a status light and a label
  (`TERMINAL // fs-finance-01`).
- Header becomes a status bar: callsign, clearance level, XP bar, missions
  cleared, current threat level (from how many missions are open).
- Ops board: sectors as tiles with lights (cleared, open, locked), each mission
  a row with priority, ID (`INC-0427`, stable from the item id) and status.

### 3.4 Moments (T3)

- **Mission accepted:** a short alert sequence (priority flash, ticket
  "decrypts" in) before the workspace opens.
- **Close out:** "MISSION CLEAR" stamp on the after-action report; XP counts up
  (already does) into the bar.
- **Promotion:** a clearance-level-up screen when you cross a threshold.
- **Sector cleared:** a badge when every mission in a sector is done.
- **Sound (opt-in):** pager tone on accept, confirmation on clear, made with
  Web Audio (no files).

### 3.5 World map (T4, optional)

An SVG wall map on the ops board with a light per sector/region; open missions
pulse. Content would need an optional `region` field per item for real
placement; otherwise lights sit per cloud.

## 4. Milestones

| # | Work | Done when |
|---|---|---|
| T1 | Vocabulary, callsign, rank retune | Playable, tests updated, docs |
| T2 | Ops look: palette, consoles, status bar, ops board | Both themes pass contrast; mobile ok |
| T3 | Moments: accept sequence, clear stamp, promotion, sector badge, opt-in sound | Reduce motion turns them off |
| T4 | World map (optional) | Decided after T3 |

Then back to content: build orders for Kinesis, ElastiCache, containers, Entra ID.

## 5. Risks

- **Gimmick over learning.** Principle 1; real wording stays everywhere the
  learning happens.
- **Slower play.** Accept sequence is under 1.5 s, skippable with any key, and
  skipped entirely under Reduce motion.
- **Test churn.** UI tests query by labels; renames touch them once in T1.
