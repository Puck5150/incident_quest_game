import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { ScenarioSchema, type Scenario } from '../src/schema/scenario.ts'
import { atStage, stageAt } from '../src/schema/stages.ts'
import { evidenceSeen, newSession, step, transcript, type GameEvent, type Session } from '../src/game/engine.ts'
import { score } from '../src/game/scoring.ts'

const raw = () => parse(readFileSync(path.resolve(import.meta.dirname, 'fixtures/two-stage.yaml'), 'utf8'))
const scenario: Scenario = ScenarioSchema.parse(raw())
const errors = (mutate: (r: ReturnType<typeof raw>) => void) => {
  const r = raw()
  mutate(r)
  const res = ScenarioSchema.safeParse(r)
  return res.success ? [] : res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}

let t = 0
const ev = (e: Record<string, unknown>) => ({ ...e, at: (t += 60_000) }) as GameEvent
const start = ev({ type: 'START' })
const run = (input: string) => ev({ type: 'RUN_COMMAND', input })
const open = (name: string) => ev({ type: 'OPEN_ARTIFACT', kind: 'log', name })
const hyp = (id: string) => ev({ type: 'DECLARE_HYPOTHESIS', id })
const act = (id: string) => ev({ type: 'TAKE_ACTION', id })
const hint = () => ev({ type: 'REQUEST_HINT' })
const close = () => ev({ type: 'CLOSE_INCIDENT' })
const play = (...events: GameEvent[]): Session => events.reduce((s, e) => step(scenario, s, e), newSession())

describe('schema', () => {
  it('accepts a two-stage incident', () => expect(errors(() => {})).toEqual([]))

  it('checks each stage like an incident of its own', () => {
    expect(errors((r) => (r.stages[0].hypotheses[1].correct = true))).toContain('stages.0.hypotheses: exactly one hypothesis must be correct (found 2)')
    expect(errors((r) => (r.stages[0].solution_paths = [['open-port']]))).toEqual(
      expect.arrayContaining(['stages.0.solution_paths.0.0: "open-port" is not an action with kind: fix in this stage']),
    )
  })

  it('stage key evidence must show after the earlier stages\' fixes, before its own', () => {
    // Only visible after this stage's own fix: impossible to find first.
    expect(
      errors((r) => {
        r.stages[0].terminal.commands[0].evidence = 'wrong-path'
        delete r.stages[0].terminal.commands[1].evidence
      }),
    ).toContain('stages.0.key_evidence.0: key evidence "wrong-path" is only visible after one of this stage\'s actions')
    // Visible once stage 1 is fixed: fine for stage 2.
    expect(
      errors((r) => {
        r.terminal.commands[0].evidence = 'got-404'
        r.stages[0].key_evidence.push('got-404')
        r.stages[0].evidence_labels['got-404'] = 'Now a 404'
      }),
    ).toEqual([])
  })

  it('ids are unique across stages; references must exist', () => {
    expect(errors((r) => (r.stages[0].actions[1].id = 'reboot'))).toEqual(
      expect.arrayContaining(['actions: duplicate action id "reboot" (ids are unique across stages)']),
    )
    expect(errors((r) => (r.stages[0].diagram_status = { nope: 'down' }))).toContain('stages.0.diagram_status.nope: unknown diagram node "nope"')
    expect(errors((r) => (r.stages[0].terminal.commands[0].when_actions = ['nope']))).toContain(
      'stages.0.terminal.commands.0.when_actions: unknown action "nope"',
    )
  })
})

describe('engine', () => {
  const stage1Fixed = () => [start, run('curl -I http://web'), run('show sg'), hyp('sg'), act('open-port')]

  it('closing stage 1 reopens into stage 2 with its update', () => {
    const s = play(...stage1Fixed(), close())
    expect(s.phase).toBe('investigating')
    expect(stageAt(s.log)).toBe(1)
    expect(s.feedback).toEqual({ tone: 'reopened', text: 'Reopened: health checks now fail with 404.' })
  })

  it('stage 2 uses its own causes and actions, and can only resolve after its fix', () => {
    let s = play(...stage1Fixed(), close(), hyp('sg'))
    expect(s.log.at(-1)!.type).toBe('CLOSE_INCIDENT') // stage 1's cause isn't on the list any more
    s = [hyp('path'), act('reboot')].reduce((x, e) => step(scenario, x, e), s)
    expect(s.log.at(-1)!.type).toBe('DECLARE_HYPOTHESIS') // stage 1's action isn't either
    s = [close()].reduce((x, e) => step(scenario, x, e), s)
    expect(s.phase).toBe('acting') // not fixed yet
    s = [run('set path /health'), close()].reduce((x, e) => step(scenario, x, e), s)
    expect(s.phase).toBe('resolved')
  })

  it('artifacts and commands appear from their stage on; the diagram changes', () => {
    expect(atStage(scenario, 0).logs!.map((l) => l.name)).toEqual(['deploy log'])
    expect(atStage(scenario, 1).logs!.map((l) => l.name)).toEqual(['deploy log', 'app routes'])
    expect(atStage(scenario, 1).diagram!.nodes[0].status).toBe('degraded')
    const s = play(start, open('app routes'), run('show health-check'), ...stage1Fixed().slice(1), close(), open('app routes'), run('show health-check'))
    // Before stage 2 neither exists; after, both count as evidence.
    expect([...evidenceSeen(scenario, s.log)]).toEqual(expect.arrayContaining(['routes', 'wrong-path']))
    expect([...evidenceSeen(scenario, s.log.slice(0, 3))]).toEqual([])
  })

  it('each stage has its own three hint tiers', () => {
    let s = play(start, hint(), hint(), hint(), hint())
    expect(s.log.filter((e) => e.type === 'REQUEST_HINT')).toHaveLength(3)
    s = [run('curl -I http://web'), hyp('sg'), act('open-port'), close(), hint()].reduce((x, e) => step(scenario, x, e), s)
    expect(s.log.filter((e) => e.type === 'REQUEST_HINT')).toHaveLength(4)
  })

  it('verifying stage 1 shows the stage 2 symptom; the transcript rebuilds across stages', () => {
    const s = play(...stage1Fixed(), run('curl -I http://web'), close(), run('show health-check'), hyp('path'), run('set path /health'))
    const lines = transcript(scenario, s.log)
    expect(lines.map((l) => l.output)).toEqual([
      'curl: (28) Connection timed out',
      'port 8080: not allowed',
      'HTTP/1.1 404 Not Found',
      'path: /healthz',
      'Path fixed.', // the typed fix, once stage 2's cause is named
    ])
  })
})

describe('scoring', () => {
  it('bonuses are shared across stages; hints are labelled by stage', () => {
    const s = play(
      ...[start, run('curl -I http://web'), run('show sg'), hyp('sg'), act('open-port'), run('curl -I http://web'), close()],
      // Stage 2: decides before seeing the routes (not methodical), uses a hint, doesn't verify.
      hint(),
      run('show health-check'),
      hyp('path'),
      act('fix-path'),
      close(),
    )
    expect(s.phase).toBe('resolved')
    const r = score(scenario, s.log)
    const line = (label: string) => r.lines.find((l) => l.label === label)?.xp
    expect(line('Methodical: 1 of 2 stages')).toBe(30) // half of 20% of base 300
    expect(line('Verified the fix: 1 of 2 stages')).toBe(15) // half of 10%
    expect(line('Hint: nudge (stage 2)')).toBe(-30)
    expect(r.methodical).toBe(false)
    expect(r.hintsUsed).toBe(1)
  })

  it('a single-stage incident scores exactly as before', () => {
    const single = ScenarioSchema.parse({ ...raw(), stages: undefined })
    const log = [start, run('curl -I http://web'), run('show sg'), hyp('sg'), act('open-port'), run('curl -I http://web'), close()]
    const r = score(single, log.reduce((x, e) => step(single, x, e), newSession()).log)
    expect(r.lines.map((l) => l.label)).toEqual(expect.arrayContaining(['Methodical: found all key evidence before deciding', 'Verified the fix before closing']))
  })
})
