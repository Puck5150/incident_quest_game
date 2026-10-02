# Plan: On-call shift mode

Status: **approved 2026-10-01 with the defaults in section 9; S1 and S2 done.** Active-time
scoring moved from S1 to S2, where the shift first needs it. From PARKING_LOT.md: "Timed
'on-call shift' mode: multiple incidents queued at once". Fits the Ops Center
theme (PLAN_THEME.md).

## 1. The idea

You start a shift. Pages arrive over time, several are open at once, and you
decide what to work on: acknowledge the P1 first, park the P3, come back to it.
The skill being practised is the one real on-call needs and single incidents
can't teach: **triage and context switching** under a clock.

Each incident still plays exactly as it does today. The shift adds a queue,
arrivals, switching between incidents, response targets per priority, and a
shift report.

## 2. Principles

1. **No new incident content.** Shifts draw from the 53 existing incidents.
   Design challenges stay out: they're planning work, not pages.
2. **Same incident, same learning.** The terminal, hypotheses, actions, hints,
   Field manual and debrief work as they do now.
3. **Pressure is opt-out.** Relaxed mode turns off the clock and response
   targets; a relaxed shift is just "several incidents at once".
4. **Fair scoring.** Time on an incident counts only while you're looking at it,
   so switching away to handle a P1 doesn't cost the P3's score.

## 3. How a shift plays

1. **Start:** "Start shift" on the ops board (unlocked once you've resolved 3
   incidents, so new players learn one incident at a time first). Pick a length:

   | Shift | Pages | Roughly |
   |---|---|---|
   | Short | 2 | 20 min |
   | Standard | 3 | 35 min |
   | Long | 5 | 60 min |

2. **Pages:** the first page arrives at once; the rest arrive on a schedule
   (for example every 4 to 6 minutes of shift time), each with a pager alert
   (visual, plus the opt-in sound). Incidents are picked from unlocked tracks,
   preferring ones you haven't resolved, with at least one P1 or P2 per shift.
3. **Queue panel:** a strip down the side (or across the top on narrow
   screens): each page's ID, priority, title, status (New, Acknowledged,
   Investigating, Fixing, Resolved) and its response timer.
4. **Acknowledge:** opening a page acknowledges it (the existing "Accept
   mission"). Time from arrival to acknowledgement is the **response time**.
5. **Switch:** you can move between open incidents at any time. Each keeps its
   full state: transcript, opened logs, hypothesis, actions.
6. **Resolve:** closing an incident shows a short result card in the shift
   (score, root cause in one line), not the full after-action report, so the
   shift keeps moving. Full reports are in the shift report.
7. **End:** when every page is resolved, or you end the shift early (unresolved
   pages count as handed over: no XP, no penalty beyond the missed targets).

## 4. Scoring

- **Each incident** scores as today (base, methodical, verified, hints, wrong
  answers), **minus the per-incident time bonus**, which assumes one incident
  at a time. It's recorded to progress like any other completion.
- **Shift bonus**, on top:

  | Target | P1 | P2 | P3/P4 |
  |---|---|---|---|
  | Acknowledge within | 2 min | 5 min | 10 min |
  | Resolve within (active time) | par | 1.5 × par | 2 × par |

  Each target met adds a small bonus (for example +5% of that incident's base).
  **Triage bonus** if every P1 was acknowledged before any lower-priority page
  that arrived at the same time or later.
- **Clean shift:** every page resolved cleanly. Shown in the report; it doesn't
  add to the clean streak again, since each clean incident already does.
- **Relaxed mode:** no response targets, no triage bonus, no clock on screen.
  The shift report still lists what happened.

## 5. Shift report

The ops-center close of the shift: shift duration, pages handled, targets met
or missed per page, triage result, shift bonus, XP total, and a link to each
incident's full after-action report. The wall map shows the shift's stations,
lit by result.

## 6. Engineering

- **Session state moves up.** IncidentScreen keeps its session in a local
  `useReducer`, and Terminal keeps its transcript in local state, so switching
  away would lose both. Change: the shift holds each incident's `Session`; the
  Terminal rebuilds its transcript from the session log (`RUN_COMMAND` events
  plus `runCommand` output), which also means single incidents survive a
  remount. No engine changes: `step` is already pure.
- **Active time.** The shift tracks it (time advances only for the focused
  page), so the incident log is unchanged; `score()` takes an `inShift` option
  that drops the time bonus.
- **Shift state** is one reducer: pages, arrival schedule, focus, results.
  Pure and unit-tested like the engine. Not saved across reloads in v1: a
  reload ends the shift (completed incidents are already recorded).
- **Routing:** `#/shift` for the shift, `#/shift/report` for its report. Back
  from an incident goes to the queue, not out of the shift.
- **Arrivals use shift time**, which pauses when the tab is hidden, so a shift
  doesn't run on while you're away.

## 7. Milestones

| # | Work | Done when |
|---|---|---|
| S1 | Lift session state; terminal transcript from the log | Single incidents behave exactly as before; tests |
| S2 | Shift reducer (arrivals, picking, targets, bonuses); active-time scoring | Unit tests for scheduling and scoring |
| S3 | Shift screen: queue panel, switching, result cards, end shift; shift report | Playable end to end; UI tests |
| S4 | Theme: pager alerts, shift clock, wall map lighting, relaxed behaviour, docs | Reduce motion and relaxed mode respected |

## 8. Risks

- **Too long to play.** Short shifts (2 pages) exist; ending early is allowed.
- **Stress over learning.** Relaxed mode removes the clock; targets are bonuses,
  never penalties to the incident's own score.
- **Refactor breaks single incidents.** S1 ships alone, with the existing UI
  tests unchanged as the guard.
- **Duplicate IDs in the DOM** if several incidents render at once. Only the
  focused incident is rendered; others are just state.

## 9. Open questions (my default in **bold**)

1. Shift lengths: 2 / 3 / 5 pages? **Yes.**
2. Arrivals on a timer (pages arrive while you work) or one after each
   resolve? **Timer**, since that's what makes it on-call. Relaxed mode could
   use "after each resolve".
3. Unlock after 3 resolved incidents? **Yes.**
4. Per-incident time bonus replaced by response targets in shifts? **Yes.**
5. Pages only from tracks you've unlocked, preferring unresolved ones? **Yes.**
