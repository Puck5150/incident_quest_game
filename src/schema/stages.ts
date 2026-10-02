// Multi-stage incidents (PLAN_MULTI_STAGE.md). The top level of a scenario is
// stage 0; `stages` adds the rest. `atStage` turns any stage into an ordinary
// Scenario, so the engine, scoring and checks work on one stage at a time
// without knowing about stages at all. Kept free of zod (browser bundle).

import type { Scenario } from './scenario.ts'

// Which stage the player is on: each close-out that was accepted moves to the
// next one. Derived from the log, so it needs no state of its own.
export const stageAt = (log: { type: string }[]) => log.filter((e) => e.type === 'CLOSE_INCIDENT').length

export const stageCount = (s: Scenario) => 1 + (s.stages?.length ?? 0)

// The events since the current stage began (after the last close-out).
export function sinceStageStart<E extends { type: string }>(log: E[]): E[] {
  const i = log.map((e) => e.type).lastIndexOf('CLOSE_INCIDENT')
  return log.slice(i + 1)
}

// Stage `k` as a plain scenario: that stage's causes, actions, fixes, evidence,
// hints and root cause; artifacts and terminal commands from every stage up to
// and including it (later stages' commands first, so they win a match); the
// diagram with each stage's status changes applied.
export function atStage(s: Scenario, k: number): Scenario {
  if (k === 0 || !s.stages?.length) return s
  const upTo = s.stages.slice(0, k)
  const st = upTo.at(-1)!
  const merged = <T>(top: T[] | undefined, pick: (x: (typeof upTo)[number]) => T[] | undefined) => {
    const all = [...(top ?? []), ...upTo.flatMap((x) => pick(x) ?? [])]
    return all.length ? all : undefined
  }
  const status = Object.assign({}, ...upTo.map((x) => x.diagram_status ?? {})) as Record<string, 'ok' | 'degraded' | 'down'>
  return {
    ...s,
    hypotheses: st.hypotheses,
    actions: st.actions,
    solution_paths: st.solution_paths,
    key_evidence: st.key_evidence,
    evidence_labels: st.evidence_labels,
    hints: st.hints,
    debrief: { ...s.debrief, root_cause: st.debrief.root_cause, ideal_path: st.debrief.ideal_path },
    terminal: s.terminal && {
      ...s.terminal,
      commands: [...[...upTo].reverse().flatMap((x) => x.terminal?.commands ?? []), ...s.terminal.commands],
    },
    logs: merged(s.logs, (x) => x.logs),
    files: merged(s.files, (x) => x.files),
    traces: merged(s.traces, (x) => x.traces),
    metrics: merged(s.metrics, (x) => x.metrics),
    diagram: s.diagram && { ...s.diagram, nodes: s.diagram.nodes.map((n) => ({ ...n, status: status[n.id] ?? n.status })) },
  }
}
