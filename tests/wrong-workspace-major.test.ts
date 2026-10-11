import { describe, expect, it } from 'vitest'
import { actionFor } from '../src/game/engine.ts'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident } from './helpers/terraform-incident.ts'

const scenario = loadIncident('wrong-workspace-major')

describe('wrong-workspace-major', () => {
  it('prod-apply accepts the equivalent spellings of the prod apply and nothing else', () => {
    for (const ok of ['terraform apply -var-file=prod.tfvars', 'terraform apply -var-file prod.tfvars', 'terraform apply --var-file=prod.tfvars', 'terraform apply -auto-approve -var-file=prod.tfvars', 'terraform apply -var-file=prod.tfvars -auto-approve'])
      expect(actionFor(scenario, ok)?.id, ok).toBe('prod-apply')
    for (const no of ['terraform apply -var-file=staging.tfvars', 'terraform apply -var-file=prod.tfvars -target=aws_db_instance.orders', 'terraform apply -var-file=prod.tfvars-old', 'terraform apply'])
      expect(actionFor(scenario, no)?.id, no).not.toBe('prod-apply')
  })

  it('the prod fix needs the guard too: apply alone does not finish stage 1', () => {
    expect(atStage(scenario, 0).solution_paths).toEqual([['prod-apply', 'workspace-guard']])
    expect(scenario.actions.find((a) => a.id === 'workspace-guard')!.kind).toBe('fix')
  })
})
