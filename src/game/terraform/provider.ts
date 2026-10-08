// Simulated cloud provider: deterministic ids, arns, durations and error texts.
import { UNKNOWN, type Value } from './eval.ts'
import { realityKey, type Reality } from './refresh.ts'

const ACCOUNT = '123456789012'
const REGION = 'us-east-1'

type Attrs = Record<string, Value>
type Op = 'create' | 'update' | 'delete'
type Ctx = { h: (salt: string, n: number) => string; p: Attrs }
interface TypeInfo {
  id: (c: Ctx) => string
  arn?: (id: string, c: Ctx) => string
  defaults?: (id: string, c: Ctx) => Attrs
  natural?: { key: string; error: (name: string, rid: string) => string }
  seconds: [number, number, number]
}

export function hex(seed: string, len: number): string {
  let out = ''
  for (let round = 0; out.length < len; round++) {
    let h = 0x811c9dc5
    for (const ch of `${seed}#${round}`) {
      h ^= ch.charCodeAt(0)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    out += h.toString(16).padStart(8, '0')
  }
  return out.slice(0, len)
}

export function requestId(seed: string): string {
  const x = hex(seed, 32)
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

export function formatDuration(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
}

const str = (v: Value | undefined): string | undefined => (typeof v === 'string' ? v : undefined)
const ec2 = (kind: string) => (id: string) => `arn:aws:ec2:${REGION}:${ACCOUNT}:${kind}/${id}`

const TYPES: Record<string, TypeInfo> = {
  aws_vpc: {
    id: (c) => `vpc-0${c.h('vpc', 8)}`,
    arn: ec2('vpc'),
    defaults: (_i, c) => ({ default_security_group_id: `sg-0${c.h('dsg', 8)}` }),
    seconds: [1, 1, 1],
  },
  aws_subnet: {
    id: (c) => `subnet-0${c.h('subnet', 8)}`,
    arn: ec2('subnet'),
    defaults: () => ({ availability_zone: `${REGION}a` }),
    seconds: [1, 1, 1],
  },
  aws_security_group: {
    id: (c) => `sg-0${c.h('sg', 8)}`,
    arn: ec2('security-group'),
    defaults: (_i, c) => ({ name: `terraform-${c.h('name', 20)}`, ingress: [], egress: [] }),
    seconds: [2, 2, 1],
  },
  aws_instance: {
    id: (c) => `i-0${c.h('i', 16)}`,
    arn: ec2('instance'),
    defaults: (_i, c) => {
      const ip = c.h('ip', 4)
      return { availability_zone: `${REGION}a`, private_ip: `10.0.${parseInt(ip.slice(0, 2), 16) % 256}.${parseInt(ip.slice(2), 16) % 256}` }
    },
    seconds: [13, 5, 33],
  },
  aws_db_instance: {
    id: (c) => str(c.p.identifier) ?? `db-${c.h('db', 8)}`,
    arn: (id) => `arn:aws:rds:${REGION}:${ACCOUNT}:db:${id}`,
    defaults: (id, c) => ({ endpoint: `${id}.c${c.h('ep', 10)}.${REGION}.rds.amazonaws.com:5432`, engine_version: '15.4', allocated_storage: 20, multi_az: false }),
    natural: {
      key: 'identifier',
      error: (n, rid) => `creating RDS DB Instance (${n}): operation error RDS: CreateDBInstance, https response error StatusCode: 400, RequestID: ${rid}, DBInstanceAlreadyExists: DB instance already exists`,
    },
    seconds: [130, 100, 180],
  },
  aws_s3_bucket: {
    id: (c) => str(c.p.bucket) ?? `bucket-${c.h('b', 8)}`,
    arn: (id) => `arn:aws:s3:::${id}`,
    defaults: (id) => ({ bucket_domain_name: `${id}.s3.amazonaws.com` }),
    natural: {
      key: 'bucket',
      error: (n, rid) => `creating S3 Bucket (${n}): operation error S3: CreateBucket, https response error StatusCode: 409, RequestID: ${rid}, BucketAlreadyOwnedByYou: Your previous request to create the named bucket succeeded and you already own it.`,
    },
    seconds: [1, 1, 1],
  },
  aws_sqs_queue: {
    id: (c) => `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${str(c.p.name) ?? `queue-${c.h('q', 8)}`}`,
    arn: (id) => `arn:aws:sqs:${REGION}:${ACCOUNT}:${id.slice(id.lastIndexOf('/') + 1)}`,
    defaults: (id) => ({ url: id }),
    natural: {
      key: 'name',
      error: (n) => `creating SQS Queue (${n}): QueueNameExists: A queue already exists with the same name and a different value for attribute VisibilityTimeout`,
    },
    seconds: [1, 1, 1],
  },
  aws_iam_role: {
    id: (c) => str(c.p.name) ?? `role-${c.h('r', 8)}`,
    arn: (id, c) => `arn:aws:iam::${ACCOUNT}:role${str(c.p.path) ?? '/'}${id}`,
    natural: {
      key: 'name',
      error: (n, rid) => `creating IAM Role (${n}): operation error IAM: CreateRole, https response error StatusCode: 409, RequestID: ${rid}, EntityAlreadyExists: Role with name ${n} already exists.`,
    },
    seconds: [1, 1, 1],
  },
  aws_ecs_service: {
    id: (c) => `arn:aws:ecs:${REGION}:${ACCOUNT}:service/${str(c.p.cluster) ?? 'default'}/${str(c.p.name) ?? `svc-${c.h('s', 8)}`}`,
    arn: (id) => id,
    seconds: [13, 2, 10],
  },
  aws_cloudwatch_log_group: {
    id: (c) => str(c.p.name) ?? `/log-${c.h('l', 8)}`,
    arn: (id) => `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${id}`,
    natural: {
      key: 'name',
      error: (n, rid) => `creating CloudWatch Logs Log Group (${n}): operation error CloudWatch Logs: CreateLogGroup, https response error StatusCode: 400, RequestID: ${rid}, ResourceAlreadyExistsException: The specified log group already exists`,
    },
    seconds: [1, 1, 1],
  },
}

const info = (type: string): TypeInfo | undefined => (Object.hasOwn(TYPES, type) ? TYPES[type] : undefined)

export function seconds(type: string, op: Op): number {
  const s = info(type)?.seconds ?? [2, 1, 1]
  return s[op === 'create' ? 0 : op === 'update' ? 1 : 2]
}

export function fillOnCreate(type: string, address: string, planned: Attrs, seed: string): Attrs {
  const t = info(type)
  const ctx: Ctx = { h: (salt, n) => hex(`${address}:${seed}:${salt}`, n), p: planned }
  const unset = (k: string) => !Object.hasOwn(planned, k) || planned[k] === UNKNOWN
  const id = unset('id') ? (t ? t.id(ctx) : `${type.replace(/^[^_]*_/, '').replaceAll('_', '-')}-0${ctx.h('id', 8)}`) : (planned.id as string)
  const gen = new Map<string, Value>([['id', id]])
  if (t?.arn) gen.set('arn', t.arn(id, ctx))
  for (const [k, v] of Object.entries(t?.defaults?.(id, ctx) ?? {})) gen.set(k, v)
  const out = new Map<string, Value>()
  for (const [k, v] of Object.entries(planned)) out.set(k, v)
  for (const [k, v] of gen) if (unset(k)) out.set(k, v)
  return Object.fromEntries([...out].map(([k, v]) => [k, v === UNKNOWN ? null : v]))
}

export function fillOnUpdate(prior: Attrs, next: Attrs): Attrs {
  return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === UNKNOWN ? (Object.hasOwn(prior, k) ? prior[k] : null) : v]))
}

export function alreadyExists(type: string, attrs: Attrs, reality: Reality, seed: string): string | undefined {
  const nat = info(type)?.natural
  if (!nat) return undefined
  const name = str(attrs[nat.key])
  if (name === undefined) return undefined
  const prefix = `${type}:`
  const taken = Object.keys(reality).some((k) => k.startsWith(prefix) && (k === realityKey(type, name) || (type === 'aws_sqs_queue' && reality[k].name === name)))
  return taken ? nat.error(name, requestId(seed)) : undefined
}

const mentions = (v: Value, id: string): boolean =>
  v === id || (Array.isArray(v) ? v.some((x) => mentions(x, id)) : typeof v === 'object' && v !== null && v !== UNKNOWN && Object.values(v).some((x) => mentions(x, id)))

export function referencedBy(reality: Reality, type: string, id: string): { type: string; id: string } | undefined {
  const self = realityKey(type, id)
  for (const k of Object.keys(reality).sort()) {
    if (k === self || !mentions(reality[k], id)) continue
    const i = k.indexOf(':')
    return { type: k.slice(0, i), id: k.slice(i + 1) }
  }
  return undefined
}

export function dependencyViolation(type: string, id: string, seed: string): string {
  const rid = requestId(seed)
  if (type === 'aws_vpc') return `deleting EC2 VPC (${id}): operation error EC2: DeleteVpc, https response error StatusCode: 400, RequestID: ${rid}, api error DependencyViolation: The vpc '${id}' has dependencies and cannot be deleted.`
  if (type === 'aws_subnet') return `deleting EC2 Subnet (${id}): operation error EC2: DeleteSubnet, https response error StatusCode: 400, RequestID: ${rid}, api error DependencyViolation: The subnet '${id}' has dependencies and cannot be deleted.`
  if (type === 'aws_security_group') return `deleting Security Group (${id}): DependencyViolation: resource ${id} has a dependent object`
  return `deleting ${type} (${id}): DependencyViolation: the object has dependencies and cannot be deleted`
}
