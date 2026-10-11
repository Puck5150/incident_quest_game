import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-count-index-shift')
const { play, detectedAll } = playbook(scenario)

const URL = (n: string) => `https://sqs.us-east-1.amazonaws.com/123456789012/${n}`
const NONE = { 'for-each-moved': false, 'apply-anyway': false, 'keep-placeholder': false, 'state-rm': false }
const FIXED = { ...NONE, 'for-each-moved': true }
const TRAPPED = { ...NONE, 'apply-anyway': true }

const FOR_EACH_TF = (extra = '') => `cat > queues.tf <<'EOF'
variable "queue_names" {
  default = ["orders", "refunds", "shipping"]
}

resource "aws_sqs_queue" "queue" {
  for_each = toset(var.queue_names)
  name     = each.key
}
${extra}EOF`
const MOVE = (i: number, k: string) => `
moved {
  from = aws_sqs_queue.queue[${i}]
  to   = aws_sqs_queue.queue["${k}"]
}
`
const MOVED3 = MOVE(0, 'orders') + MOVE(2, 'refunds') + MOVE(3, 'shipping')
const MOVED4 = MOVE(0, 'orders') + MOVE(1, 'returns') + MOVE(2, 'refunds') + MOVE(3, 'shipping')
// the same switch done with sed on the checked-out file
const SED_FOR_EACH = "sed -i -e 's/count = length(var.queue_names)/for_each = toset(var.queue_names)/' -e 's/var.queue_names\\[count.index\\]/each.key/' queues.tf"
const MOVED_FILE = (blocks: string) => `cat >> moved.tf <<'EOF'${blocks}EOF`
const mv = (from: string, to: string) => `terraform state mv '${from}' '${to}'`
const MV_KEYED = [mv('aws_sqs_queue.queue[0]', 'aws_sqs_queue.queue["orders"]'), mv('aws_sqs_queue.queue[2]', 'aws_sqs_queue.queue["refunds"]'), mv('aws_sqs_queue.queue[3]', 'aws_sqs_queue.queue["shipping"]')]
const MV_COUNT = (returnsTo: number) => [
  mv('aws_sqs_queue.queue[1]', `aws_sqs_queue.queue[${returnsTo}]`),
  mv('aws_sqs_queue.queue[2]', 'aws_sqs_queue.queue[1]'),
  mv('aws_sqs_queue.queue[3]', 'aws_sqs_queue.queue[2]'),
]

describe('terraform-count-index-shift on the simulator', () => {
  it('is backed by the simulator, not by scripted terraform output', () => {
    expect(scenario.terraform).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? c.example ?? '').startsWith('terraform'))).toBe(false)
    for (const c of scenario.terminal!.commands) expect(scenario.command_notes?.[c.match ?? c.example!], c.match ?? c.example).toBeDefined()
    expect(scenario.terminal!.commands.some((c) => (c.match ?? '').startsWith('cat '))).toBe(false)
  })

  it('keeps the old action ids, kinds and solution path', () => {
    expect(scenario.actions.map((a) => [a.id, a.kind])).toEqual([
      ['for-each-moved', 'fix'],
      ['apply-anyway', 'destructive'],
      ['keep-placeholder', 'wrong'],
      ['state-rm', 'wrong'],
    ])
    expect(scenario.solution_paths).toEqual([['for-each-moved']])
    for (const p of scenario.solution_paths) for (const id of p) expect(scenario.actions.some((a) => a.id === id)).toBe(true)
  })

  it('(a) the plan replaces two live queues and destroys a third; state is indexed', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform plan', 'terraform state list')
    const plan = out[1].output
    expect(out[1].exitCode).toBe(0)
    expect(plan).toContain('# aws_sqs_queue.queue[1] must be replaced')
    expect(plan).toContain('~ name                       = "returns" -> "refunds" # forces replacement')
    expect(plan).toContain('# aws_sqs_queue.queue[2] must be replaced')
    expect(plan).toContain('~ name                       = "refunds" -> "shipping" # forces replacement')
    expect(plan).toContain('# aws_sqs_queue.queue[3] will be destroyed')
    expect(plan.match(/must be replaced/g)).toHaveLength(2)
    expect(plan).toContain('Plan: 2 to add, 0 to change, 3 to destroy.')
    expect(out[2].output.trim().split('\n')).toEqual([0, 1, 2, 3].map((i) => `aws_sqs_queue.queue[${i}]`))
    expect(out[1].hits).toContain('evidence:shift-plan')
    expect(out[2].hits).toContain('evidence:indexed-state')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(b0) the drain check accepts --region', async () => {
    const q = 'aws sqs get-queue-attributes --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/returns'
    const { out } = await play('cd ~/infra', `${q} --region us-east-1 --attribute-names All`, `${q} --attribute-names ApproximateNumberOfMessages --region=us-east-1`)
    expect(out[1].output).toContain('"ApproximateNumberOfMessages": "0"')
    expect(out[2].output).toContain('"ApproximateNumberOfMessages": "0"')
  })

  it('(b) every key evidence tag is obtainable before any fix', async () => {
    const drain = 'aws sqs get-queue-attributes --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/returns --attribute-names ApproximateNumberOfMessages'
    const { out } = await play('cd ~/infra', 'terraform plan', 'terraform state list', drain)
    expect(out[3].output).toContain('"ApproximateNumberOfMessages": "0"')
    const hits = out.flatMap((r) => r.hits)
    const tags = new Set([
      ...hits.filter((h) => h.startsWith('evidence:')).map((h) => h.slice('evidence:'.length)),
      ...scenario.terminal!.commands.filter((c) => hits.includes(c.match ?? c.example ?? '')).map((c) => c.evidence),
    ])
    for (const t of scenario.key_evidence) expect(tags.has(t), t).toBe(true)
    expect(out[1].hits).toContain('evidence:count-list')
  })

  it('(b2) the real file is what cat shows, before and after the edit', async () => {
    const { out } = await play('cd ~/infra', 'cat queues.tf', SED_FOR_EACH, 'cat queues.tf', 'cd / && cat ~/infra/queues.tf | grep for_each')
    expect(out[1].output).toContain('count = length(var.queue_names)')
    expect(out[3].output).toContain('for_each = toset(var.queue_names)')
    expect(out[3].output).not.toContain('count = length')
    expect(out[4].output).toContain('for_each')
  })

  it('(c) route a: for_each + moved blocks; plan destroys only returns; apply credits the fix', async () => {
    const { sh, out } = await play('cd ~/infra', FOR_EACH_TF(MOVED3), 'terraform plan', 'terraform apply -auto-approve', 'terraform plan', 'terraform state list')
    expect(out[2].output).toContain('# aws_sqs_queue.queue[1] will be destroyed')
    for (const [i, k] of [[0, 'orders'], [2, 'refunds'], [3, 'shipping']] as const) expect(out[2].output).toContain(`# aws_sqs_queue.queue[${i}] has moved to aws_sqs_queue.queue["${k}"]`)
    expect(out[2].output).not.toContain('must be replaced')
    expect(out[2].output).toContain('Plan: 0 to add, 0 to change, 1 to destroy.')
    // the plan alone is not the fix
    const before = await play('cd ~/infra', FOR_EACH_TF(MOVED3), 'terraform plan')
    expect(await detectedAll(before.sh)).toEqual(NONE)
    expect(out[3].output).toContain('Apply complete! Resources: 0 added, 0 changed, 1 destroyed.')
    expect(out[4].output).toContain('No changes.')
    expect(out[5].output.trim().split('\n')).toEqual(['aws_sqs_queue.queue["orders"]', 'aws_sqs_queue.queue["refunds"]', 'aws_sqs_queue.queue["shipping"]'])
    expect(await detectedAll(sh)).toEqual(FIXED)
    for (const n of ['orders', 'refunds', 'shipping']) expect(await sh.doneWhen({ reality_has: { type: 'aws_sqs_queue', id: URL(n) } })).toBe(true)
    expect(await sh.doneWhen({ reality_lacks: { type: 'aws_sqs_queue', id: URL('returns') } })).toBe(true)
  })

  it('(c2) spelling variants: sed edit of the checked-out file + a separate moved.tf, with or without a moved block for returns', async () => {
    for (const blocks of [MOVED3, MOVED4]) {
      const { sh, out } = await play('cd ~/infra', SED_FOR_EACH, MOVED_FILE(blocks), 'terraform apply -auto-approve', 'terraform plan')
      expect(out[3].exitCode).toBe(0)
      expect(out[3].output).toContain('1 destroyed.')
      expect(out[3].output).toMatch(/aws_sqs_queue\.queue(\[1\]|\["returns"\]): Destroying\.\.\. \[id=.*\/returns\]/)
      expect(out[4].output).toContain('No changes.')
      expect(await detectedAll(sh)).toEqual(FIXED)
    }
    // plain `terraform apply` answered yes
    const { sh } = await play('cd ~/infra', FOR_EACH_TF(MOVED3), 'echo yes | terraform apply')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(d) route b: for_each with terraform state mv of each index to its key', async () => {
    const { sh, out } = await play('cd ~/infra', SED_FOR_EACH, ...MV_KEYED, 'terraform plan', 'terraform apply -auto-approve', 'terraform plan')
    for (const r of out.slice(2, 5)) expect(r.output).toContain('Successfully moved 1 object(s).')
    expect(out[5].output).toContain('Plan: 0 to add, 0 to change, 1 to destroy.')
    expect(out[5].output).toContain('# aws_sqs_queue.queue[1] will be destroyed')
    expect(out[7].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(d2) route b needs the moves for all three live queues: moving two is not the fix and applying then hurts', async () => {
    const { sh, out } = await play('cd ~/infra', SED_FOR_EACH, MV_KEYED[0], MV_KEYED[1], 'terraform plan')
    expect(out[4].output).toContain('aws_sqs_queue.queue["shipping"] will be created')
    expect(await detectedAll(sh)).toEqual(NONE)
    await sh.run('terraform apply -auto-approve', atStage(scenario, 0), new Set())
    expect((await detectedAll(sh))['for-each-moved']).toBe(false)
  })

  it('(e) route c: stay on count, shuffle state so only returns is destroyed (returns parked at a free index)', async () => {
    const { sh, out } = await play('cd ~/infra', ...MV_COUNT(4), 'terraform plan', 'terraform apply -auto-approve', 'terraform plan')
    expect(out[4].output).toContain('Plan: 0 to add, 0 to change, 1 to destroy.')
    expect(out[4].output).toContain('# aws_sqs_queue.queue[4] will be destroyed')
    expect(out[4].output).not.toContain('must be replaced')
    expect(out[5].output).toContain('Apply complete! Resources: 0 added, 0 changed, 1 destroyed.')
    expect(out[6].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(e2) route c where returns is rotated to index 3 and destroyed there is still the fix, not the trap', async () => {
    const { sh, out } = await play(
      'cd ~/infra',
      mv('aws_sqs_queue.queue[1]', 'aws_sqs_queue.queue[4]'),
      mv('aws_sqs_queue.queue[2]', 'aws_sqs_queue.queue[1]'),
      mv('aws_sqs_queue.queue[3]', 'aws_sqs_queue.queue[2]'),
      mv('aws_sqs_queue.queue[4]', 'aws_sqs_queue.queue[3]'),
      'terraform plan',
      'terraform apply -auto-approve',
    )
    expect(out[5].output).toContain('# aws_sqs_queue.queue[3] will be destroyed')
    expect(out[5].output).toContain('Plan: 0 to add, 0 to change, 1 to destroy.')
    expect(await detectedAll(sh)).toEqual(FIXED)
  })

  it('(f) route c half done (shift without parking returns) is not the fix', async () => {
    const { sh, out } = await play('cd ~/infra', mv('aws_sqs_queue.queue[2]', 'aws_sqs_queue.queue[4]'), 'terraform plan')
    expect(out[2].output).toContain('must be replaced')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(g) trap: applying the shifted plan recreates two live queues and destroys a third; fixing afterwards cannot earn the fix', async () => {
    const { sh, out } = await play('cd ~/infra', 'terraform apply -auto-approve')
    expect(out[1].output).toContain('Plan: 2 to add, 0 to change, 3 to destroy.')
    expect(out[1].output).toContain('Apply complete! Resources: 2 added, 0 changed, 3 destroyed.')
    expect(out[1].output).toContain(`aws_sqs_queue.queue[2]: Destroying... [id=${URL('refunds')}]`)
    expect(await detectedAll(sh)).toEqual(TRAPPED)
    // A replaced queue keeps its URL, so the damage is tracked by history, not by ids.
    for (const l of [FOR_EACH_TF(MOVE(0, 'orders') + MOVE(1, 'returns') + MOVE(2, 'refunds')), 'terraform apply -auto-approve']) await sh.run(l, atStage(scenario, 0), new Set())
    expect(await detectedAll(sh)).toEqual(TRAPPED)
    expect((await sh.run('terraform plan', atStage(scenario, 0), new Set())).output).toContain('No changes')
  })

  it('(h) trap: converting to for_each with no moves and applying recreates all four queues', async () => {
    const { sh, out } = await play('cd ~/infra', SED_FOR_EACH, 'terraform plan')
    expect(out[2].output).toContain('Plan: 3 to add, 0 to change, 4 to destroy.')
    expect(out[2].output).toContain('# (because resource does not use count)')
    expect(await detectedAll(sh)).toEqual(NONE)
    await sh.run('terraform apply -auto-approve', atStage(scenario, 0), new Set())
    expect(await detectedAll(sh)).toEqual(TRAPPED)
    // moved blocks written after the fact change nothing
    await sh.run(MOVED_FILE(MOVED3), atStage(scenario, 0), new Set())
    expect(await detectedAll(sh)).toEqual(TRAPPED)
  })

  it('(i) keep-placeholder: leaving returns in the list gives a clean plan but is not credited', async () => {
    const list = `sed -i 's/\\["orders", "refunds", "shipping"\\]/["orders", "returns", "refunds", "shipping"]/' queues.tf`
    const { sh, out } = await play('cd ~/infra', list, 'terraform plan')
    expect(out[2].output).toContain('No changes.')
    expect(await detectedAll(sh)).toEqual(NONE)
    expect(await sh.doneWhen({ plan_clean: true })).toBe(true)
    expect(await sh.doneWhen({ reality_lacks: { type: 'aws_sqs_queue', id: URL('returns') } })).toBe(false)
  })

  it('(j) state-rm of all queues: the plan wants to create them all again (visible, not credited)', async () => {
    const { sh, out } = await play('cd ~/infra', ...[0, 1, 2, 3].map((i) => `terraform state rm 'aws_sqs_queue.queue[${i}]'`), 'terraform state list', 'terraform plan')
    expect(out[5].output.trim()).not.toContain('aws_sqs_queue')
    expect(out[6].output).toContain('Plan: 3 to add, 0 to change, 0 to destroy.')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(k) state-rm then applying fails against the queues that still exist; no damage, nothing credited', async () => {
    const { sh, out } = await play('cd ~/infra', ...[0, 1, 2, 3].map((i) => `terraform state rm 'aws_sqs_queue.queue[${i}]'`), 'terraform apply -auto-approve')
    expect(out[5].exitCode).toBe(1)
    expect(out[5].output).toContain('QueueNameExists')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('(l) state-rm and import of the three live queues under for_each keys is a fix route too', async () => {
    const lines = [
      SED_FOR_EACH,
      ...[0, 1, 2, 3].map((i) => `terraform state rm 'aws_sqs_queue.queue[${i}]'`),
      ...['orders', 'refunds', 'shipping'].map((n) => `terraform import 'aws_sqs_queue.queue["${n}"]' ${URL(n)}`),
      'terraform plan',
    ]
    const { sh, out } = await play('cd ~/infra', ...lines)
    expect(out.at(-1)!.output).toContain('No changes.')
    expect(await sh.doneWhen({ reality_lacks: { type: 'aws_sqs_queue', id: URL('returns') } })).toBe(false)
    // returns still exists in the cloud (orphaned), so the fix is not credited until it is deleted: the old scripted
    // incident also called this error-prone surgery rather than the fix.
    expect(await detectedAll(sh)).toEqual(NONE)
  })
})
