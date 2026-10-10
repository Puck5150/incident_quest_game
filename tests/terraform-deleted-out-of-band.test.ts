import { describe, expect, it } from 'vitest'
import { atStage } from '../src/schema/stages.ts'
import { loadIncident, playbook } from './helpers/terraform-incident.ts'

const scenario = loadIncident('terraform-deleted-out-of-band')
const { play, detectedAll } = playbook(scenario)

const NONE = { 'remove-instance-block': false, 'apply-reconcile': false, 'recreate-everything': false, 'remove-both-blocks': false, 'state-rm-both': false, 'refresh-false-apply': false, 'destroy-to-start-clean': false }
const A = 'terraform apply -auto-approve'
const CD = 'cd ~/jobs-infra'
const RM_WORKER = "sed -i '/^resource \"aws_instance\" \"worker\"/,/^}/d' main.tf"
const RM_QUEUE = "sed -i '/^resource \"aws_sqs_queue\" \"jobs\"/,/^}/d' main.tf"
const VPC = 'vpc-0a3c7e1d9b52f4680'
const SUBNET = 'subnet-0b8d2f6a4e1c73950'

describe('terraform-deleted-out-of-band', () => {
  it('plan shows the drift note and wants to create both; state still lists them', async () => {
    const { sh, out } = await play(CD, 'terraform plan', 'terraform state list')
    expect(out[1].exitCode).toBe(0)
    expect(out[1].output).toContain('Note: Objects have changed outside of Terraform')
    expect(out[1].output).toContain('# aws_sqs_queue.jobs has been deleted')
    expect(out[1].output).toContain('# aws_instance.worker will be created')
    expect(out[1].output).toContain('# aws_sqs_queue.jobs will be created')
    expect(out[1].output).toContain('Plan: 2 to add, 0 to change, 0 to destroy.')
    expect(out[1].hits).toContain('evidence:drift-in-plan')
    expect(out[2].output.trim().split('\n').sort()).toEqual(['aws_instance.worker', 'aws_sqs_queue.jobs', 'aws_subnet.app', 'aws_vpc.main'])
    expect(out[2].hits).toContain('evidence:state-still-lists')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('evidence is obtainable before any change, in several spellings', async () => {
    const { out } = await play(CD, 'aws sqs get-queue-url --queue-name app-jobs', 'aws sqs get-queue-url --queue-name app-jobs --region us-east-1 --output json', 'aws sqs get-queue-url --region us-east-1 --queue-name app-jobs', 'aws ec2 describe-instances --instance-ids i-0d6a3f8b2c71e9450', 'aws ec2 describe-instances --region us-east-1 --instance-ids i-0d6a3f8b2c71e9450 --output json', 'cat NOTES.md', 'aws sts get-caller-identity', 'terraform destroy -target=aws_sqs_queue.jobs -target=aws_instance.worker -auto-approve')
    for (const i of [1, 2, 3]) expect(out[i].output, `${i}`).toContain('NonExistentQueue')
    for (const i of [4, 5]) expect(out[i].output, `${i}`).toContain('InvalidInstanceID.NotFound')
    expect(out[6].output).toContain('app-jobs is NOT unused')
    expect(out[7].output).toContain('PlatformAdmin')
    expect(out[8].output).toContain('No changes. No objects need to be destroyed.')
    expect(out[8].hits).toContain('evidence:destroy-nothing')
  })

  it('the targeted destroy removes nothing but vpc and subnet stay, and the plan still wants both created', async () => {
    const { sh, out } = await play(CD, 'terraform destroy -target=aws_sqs_queue.jobs -target=aws_instance.worker -auto-approve', 'terraform state list', 'terraform plan')
    expect(out[1].output).toContain('Destroy complete! Resources: 0 destroyed.')
    expect(out[2].output.trim().split('\n').sort()).toEqual(['aws_subnet.app', 'aws_vpc.main'])
    expect(out[3].output).toContain('Plan: 2 to add, 0 to change, 0 to destroy.')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('trap: -refresh=false trusts stale state and says nothing is wrong', async () => {
    const { sh, out } = await play(CD, 'terraform plan -refresh=false', `${A} -refresh=false`, 'terraform plan')
    expect(out[1].output).toContain('No changes. Your infrastructure matches the configuration.')
    expect(out[2].output).toContain('No changes.')
    expect(out[3].output).toContain('Plan: 2 to add, 0 to change, 0 to destroy.')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('ideal path: remove the worker block, apply once; queue recreated, worker forgotten, vpc and subnet untouched', async () => {
    const { sh, out } = await play(CD, 'terraform plan', RM_WORKER, A, 'terraform plan', A, 'terraform state list', 'terraform state show aws_vpc.main', 'terraform state show aws_subnet.app', 'aws sqs get-queue-url --queue-name app-jobs')
    expect(out[3].exitCode).toBe(0)
    expect(out[3].output).toContain('Apply complete! Resources: 1 added, 0 changed, 0 destroyed.')
    expect(out[3].output).not.toContain('aws_instance.worker: Creating')
    expect(out[3].output).not.toContain('will be created\n  + resource "aws_instance"')
    expect(out[4].output).toContain('No changes. Your infrastructure matches the configuration.')
    expect(out[5].output).toContain('Apply complete! Resources: 0 added, 0 changed, 0 destroyed.')
    expect(out[6].output.trim().split('\n').sort()).toEqual(['aws_sqs_queue.jobs', 'aws_subnet.app', 'aws_vpc.main'])
    expect(out[7].output).toContain(VPC)
    expect(out[8].output).toContain(SUBNET)
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'remove-instance-block': true, 'apply-reconcile': true })
  })

  it('scripted get-queue-url after the fix does not contradict the world', async () => {
    const { sh } = await play(CD, RM_WORKER, A)
    const r = await sh.run('aws sqs get-queue-url --queue-name app-jobs', atStage(scenario, 0), new Set(['apply-reconcile']))
    expect(r.output).toContain('QueueUrl')
    const i = await sh.run('aws ec2 describe-instances --instance-ids i-0d6a3f8b2c71e9450', atStage(scenario, 0), new Set(['apply-reconcile']))
    expect(i.output).toContain('InvalidInstanceID.NotFound')
  })

  it('order does not matter: refresh first, then remove the block and apply', async () => {
    const { sh } = await play(CD, 'terraform apply -refresh-only -auto-approve', 'terraform plan', RM_WORKER, A)
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'remove-instance-block': true, 'apply-reconcile': true })
  })

  it('refresh-only alone is not the fix', async () => {
    const { sh, out } = await play(CD, 'terraform apply -refresh-only -auto-approve', 'terraform plan')
    expect(out[2].output).toContain('Plan: 2 to add')
    expect(await detectedAll(sh)).toEqual(NONE)
  })

  it('bulk route A: apply as-is recreates the retired worker too (wrong), and the fix is still earnable', async () => {
    const { sh, out } = await play(CD, A)
    expect(out[1].output).toContain('Apply complete! Resources: 2 added')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'recreate-everything': true })
    const more = await sh.run(RM_WORKER, atStage(scenario, 0), new Set())
    expect(more.exitCode).toBe(0)
    const ap = await sh.run(A, atStage(scenario, 0), new Set())
    expect(ap.output).toContain('1 destroyed')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'remove-instance-block': true, 'apply-reconcile': true, 'recreate-everything': true })
  })

  it('bulk route B: removing both blocks goes quiet and loses the queue', async () => {
    const { sh, out } = await play(CD, RM_WORKER, RM_QUEUE, A, 'terraform plan', 'terraform state list')
    expect(out[4].output).toContain('No changes.')
    expect(out[5].output.trim().split('\n').sort()).toEqual(['aws_subnet.app', 'aws_vpc.main'])
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'remove-both-blocks': true })
  })

  it('trap: state rm of both forgets them but the plan still creates; button-only wrong action; the world stays recoverable', async () => {
    const { sh, out } = await play(CD, 'terraform state rm aws_sqs_queue.jobs aws_instance.worker', 'terraform plan', RM_WORKER, A)
    expect(out[2].output).toContain('Plan: 2 to add')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'remove-instance-block': true, 'apply-reconcile': true })
  })

  it('trap: destroy to start clean takes the vpc and subnet', async () => {
    const { sh, out } = await play(CD, 'terraform destroy -auto-approve', 'terraform state list')
    expect(out[1].output).toContain('Plan: 0 to add, 0 to change, 2 to destroy.')
    expect(out[1].output).toContain('Destroy complete! Resources: 2 destroyed.')
    expect(out[2].output.trim()).toBe('')
    expect(await detectedAll(sh)).toEqual({ ...NONE, 'destroy-to-start-clean': true })
  })
})
