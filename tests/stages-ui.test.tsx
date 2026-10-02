// @vitest-environment jsdom
// A two-stage incident through the real incident and debrief screens.

import { parse } from 'yaml'
import fixture from './fixtures/two-stage.yaml?raw'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ScenarioSchema } from '../src/schema/scenario.ts'
import IncidentScreen from '../src/screens/IncidentScreen.tsx'
import DebriefScreen from '../src/screens/DebriefScreen.tsx'
import { score } from '../src/game/scoring.ts'
import type { GameEvent } from '../src/game/engine.ts'

afterEach(cleanup)
const scenario = ScenarioSchema.parse(parse(fixture))

const type = (cmd: string) => {
  const input = screen.getByLabelText('Terminal command')
  fireEvent.change(input, { target: { value: cmd } })
  fireEvent.keyDown(input, { key: 'Enter' })
}
const radios = () => screen.getAllByRole('radio').map((r) => r.closest('label')!.textContent)

it('play both stages: reopen, update timeline, new causes and logs, then the debrief by stage', () => {
  let finished: GameEvent[] = []
  render(<IncidentScreen scenario={scenario} onResolved={(log) => (finished = log)} />)
  expect(screen.getByText('Stage 1 of 2')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Accept mission' }))

  // Stage 1
  type('curl -I http://web')
  type('show sg')
  expect(screen.queryByRole('tab', { name: 'Logs' })).toBeTruthy()
  expect(radios()).toEqual(expect.arrayContaining(['The security group blocks 8080.', 'DNS is wrong.']))
  fireEvent.click(screen.getByLabelText('The security group blocks 8080.'))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  type('allow 8080')
  type('curl -I http://web') // verify: the next symptom shows
  expect(screen.getByRole('log', { name: 'Terminal output' }).textContent).toMatch(/404 Not Found/)
  fireEvent.click(screen.getByRole('button', { name: 'Close out' }))

  // Reopened into stage 2
  expect(finished).toEqual([])
  expect(screen.getByText('Stage 2 of 2')).toBeTruthy()
  expect(screen.getByText('Reopened:', { selector: 'strong' }).closest('p')!.textContent).toMatch(/health checks now fail with 404/)
  expect(screen.getByRole('heading', { name: 'Updates' })).toBeTruthy()
  expect([...radios()].sort()).toEqual(['The health check path is wrong.', 'The security group again.'])
  fireEvent.click(screen.getByRole('tab', { name: 'Logs' }))
  fireEvent.click(screen.getByRole('button', { name: /app routes/ }))
  fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }))
  type('show health-check')
  fireEvent.click(screen.getByLabelText('The health check path is wrong.'))
  fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
  fireEvent.click(screen.getByRole('button', { name: 'Set the path to /health' }))
  fireEvent.click(screen.getByRole('button', { name: 'Close out' }))
  expect(finished.filter((e) => e.type === 'CLOSE_INCIDENT')).toHaveLength(2)

  // The debrief, by stage
  cleanup()
  render(
    <DebriefScreen
      scenario={scenario}
      log={finished}
      score={score(scenario, finished)}
      gained={0}
      unlocked={[]}
      streak={0}
      onHome={() => {}}
      onTree={() => {}}
    />,
  )
  const card = (title: string) => within(screen.getByRole('heading', { name: title }).closest('section')!)
  expect(card('Root cause').getByText('Stage 2')).toBeTruthy()
  expect(card('Root cause').getByText(/The health check path was wrong/)).toBeTruthy()
  expect(card('Ideal path').getByText('Compare the path with the routes')).toBeTruthy()
  expect(card('Key evidence').getAllByText('Found')).toHaveLength(4)
  expect(card("What wasn't the cause").getByText('A deploy just before the outage')).toBeTruthy()
  expect(card("What wasn't the cause").getByText('v2 changed no network settings.')).toBeTruthy()
  expect(card('Your path').getByText('Closed stage 1: reopened')).toBeTruthy()
  expect(card('Score breakdown').getByText('Methodical: found all key evidence before deciding')).toBeTruthy()
})
