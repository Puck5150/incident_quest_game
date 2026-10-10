import type { Scenario } from '../../src/schema/scenario.ts'
import { loadIncident } from './terraform-incident.ts'

// The first typed action whose regex accepts the line, as the terminal credits it.
export const load = (id: string) => {
  const sc = loadIncident(id)
  const actions = [sc, ...(sc.stages ?? [])].flatMap((p) => p.actions)
  const credit = (cmd: string) => actions.find((a) => a.match_regex !== undefined && new RegExp(a.match_regex).test(cmd.trim().replace(/\s+/g, ' ')))
  return { sc: sc as Scenario, credit, actions }
}
