// What the simulated providers know about each resource type: which
// attributes the provider computes, which are secret, and which force the
// resource to be destroyed and re-created when they change ("forces
// replacement" in a plan). Types not listed here are not modeled.
import { equal, hasUnknown, UNKNOWN, type Value } from './eval.ts'

export interface AttrSpec {
  forceNew?: boolean // changing it replaces the resource
  computed?: boolean // configurable, but the provider fills it in when omitted
  sensitive?: boolean // printed as (sensitive value)
  readOnly?: boolean // set by the provider only (id, arn); never configurable
  default?: Value // the provider's default when the configuration omits it
  copyOf?: string // its configured value is the configured value of this other attribute (tags_all follows tags)
  set?: boolean // a set: elements match by value, not by position
}
export interface ResourceSchema {
  provider: string
  attrs: Record<string, AttrSpec>
}

const AWS = 'registry.terraform.io/hashicorp/aws'
const RO: AttrSpec = { readOnly: true }
const TAGS_ALL: AttrSpec = { computed: true, copyOf: 'tags' }
const NEW: AttrSpec = { forceNew: true }
const NEWC: AttrSpec = { forceNew: true, computed: true }
const aws = (attrs: Record<string, AttrSpec>): ResourceSchema => ({ provider: AWS, attrs: { id: RO, arn: RO, ...attrs } })

export const SCHEMAS: Record<string, ResourceSchema> = {
  aws_vpc: aws({
    cidr_block: NEWC,
    enable_dns_support: { default: true },
    enable_dns_hostnames: { default: false },
    tags: {},
    tags_all: TAGS_ALL,
    default_security_group_id: RO,
  }),
  aws_subnet: aws({ vpc_id: NEW, cidr_block: NEWC, availability_zone: NEWC, map_public_ip_on_launch: { default: false }, tags: {}, tags_all: TAGS_ALL }),
  aws_security_group: aws({
    name: NEWC,
    name_prefix: NEWC,
    description: { forceNew: true, default: 'Managed by Terraform' },
    vpc_id: NEWC,
    ingress: { computed: true, set: true },
    egress: { computed: true, set: true },
    tags: {},
    tags_all: TAGS_ALL,
  }),
  aws_instance: aws({
    ami: NEW,
    instance_type: {},
    subnet_id: NEWC,
    availability_zone: NEWC,
    key_name: NEWC,
    user_data: {},
    tags: {},
    tags_all: TAGS_ALL,
    private_ip: RO,
    public_ip: RO,
  }),
  aws_db_instance: aws({
    identifier: NEWC,
    engine: NEW,
    engine_version: { computed: true },
    instance_class: {},
    allocated_storage: { computed: true },
    storage_encrypted: { forceNew: true, computed: true },
    kms_key_id: NEWC,
    db_name: NEWC,
    username: NEWC,
    password: { sensitive: true },
    multi_az: { computed: true },
    skip_final_snapshot: { default: false },
    endpoint: RO,
  }),
  aws_s3_bucket: aws({ bucket: NEWC, force_destroy: { default: false }, tags: {}, tags_all: TAGS_ALL, bucket_domain_name: RO }),
  aws_sqs_queue: aws({
    name: NEWC,
    fifo_queue: { forceNew: true, default: false },
    visibility_timeout_seconds: { default: 30 },
    message_retention_seconds: { default: 345600 },
    tags: {},
    tags_all: TAGS_ALL,
    url: RO,
  }),
  aws_iam_role: aws({ name: NEWC, path: { forceNew: true, default: '/' }, assume_role_policy: {}, tags: {}, tags_all: TAGS_ALL }),
  aws_ecs_service: aws({ name: NEW, cluster: NEWC, task_definition: {}, desired_count: { default: 0 }, tags: {}, tags_all: TAGS_ALL }),
  aws_cloudwatch_log_group: aws({ name: NEWC, retention_in_days: { default: 0 }, tags: {}, tags_all: TAGS_ALL }),
}

export function schemaFor(type: string): ResourceSchema | undefined {
  return Object.hasOwn(SCHEMAS, type) ? SCHEMAS[type] : undefined
}

// The error for a resource type the lab doesn't model.
export function unsupportedType(type: string): { summary: string; detail: string } {
  const provider = type.split('_')[0]
  return {
    summary: 'Invalid resource type',
    detail: `The provider hashicorp/${provider} does not support resource type "${type}". (This lab only models some resource types.)`,
  }
}

export type Action = 'create' | 'update' | 'replace' | 'noop'
export interface AttrChange {
  name: string
  before: Value | undefined
  after: Value
  forcesReplacement: boolean
  sensitive: boolean
}
export interface InstancePlan {
  action: Action
  changes: AttrChange[] // sorted by attribute name, like a plan prints them
  planned: Record<string, Value> // the attributes after apply; UNKNOWN where only apply can say
}

const byName = (a: AttrChange, b: AttrChange) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

// Diff one resource instance's configuration against what state holds.
// `config` holds the evaluated arguments (null means "unset"); `prior` is the
// instance's attributes in state (undefined if it doesn't exist yet).
export function diffInstance(
  schema: ResourceSchema,
  config: Record<string, Value>,
  prior: Record<string, Value> | undefined,
  ignore: string[] | 'all' = [],
  force = false, // replace an existing instance even if nothing changed (tainted, -replace, replace_triggered_by)
): InstancePlan {
  const ignored = (n: string) => ignore === 'all' || ignore.includes(n)
  const specOf = (n: string): AttrSpec => (Object.hasOwn(schema.attrs, n) ? schema.attrs[n] : {})
  // What the configuration asks for, with the provider's default if omitted.
  const desired = (n: string): Value | undefined => {
    const spec = specOf(n)
    if (spec.readOnly) return undefined
    if (spec.copyOf !== undefined) {
      if (ignored(spec.copyOf)) return undefined // core hands the provider the prior source value, so it sees no change
      const source = desired(spec.copyOf)
      if (source !== undefined) return source
      // source removed from the configuration: the provider's tag diff empties the copy too
      const old = prior !== undefined && Object.hasOwn(prior, spec.copyOf) ? prior[spec.copyOf] : null
      if (typeof old === 'object' && old !== null && !Array.isArray(old) && Object.keys(old).length) return {}
    }
    if (Object.hasOwn(config, n) && config[n] !== null) return config[n]
    return spec.default
  }
  const names = [...new Set([...Object.keys(schema.attrs), ...Object.keys(config)])].sort()
  const change = (name: string, before: Value | undefined, after: Value, forcesReplacement = false): AttrChange => ({
    name,
    before,
    after,
    forcesReplacement,
    sensitive: !!specOf(name).sensitive,
  })

  // The attributes of a brand-new object.
  const fresh = (): Record<string, Value> => {
    const entries: [string, Value][] = []
    for (const n of names) {
      const spec = specOf(n)
      const d = desired(n)
      if (spec.readOnly) entries.push([n, UNKNOWN])
      else if (d !== undefined) entries.push([n, d])
      else if (spec.computed) entries.push([n, UNKNOWN])
    }
    return Object.fromEntries(entries)
  }

  if (!prior) {
    const planned = fresh()
    return { action: 'create', planned, changes: Object.entries(planned).map(([n, after]) => change(n, undefined, after)) }
  }

  const next = new Map(Object.entries(prior))
  const changes: AttrChange[] = []
  for (const n of names) {
    const spec = specOf(n)
    if (spec.readOnly || ignored(n)) continue
    // a state that predates a default-bearing attribute counts as holding the default
    const before = (Object.hasOwn(prior, n) ? prior[n] : undefined) ?? spec.default
    let d = desired(n)
    if (d === undefined) {
      if (spec.computed) continue // the provider keeps its own value
      if (before === undefined || before === null) continue
      d = null // removed from the configuration
    }
    if (!hasUnknown(d) && equal(before ?? null, d)) continue
    changes.push(change(n, before, d, !!spec.forceNew))
    next.set(n, d)
  }

  if (!changes.length && !force) return { action: 'noop', changes, planned: Object.fromEntries(next) }
  if (force || changes.some((c) => c.forcesReplacement)) {
    // Ignored attributes are settled before planning, so the replacement keeps the prior values.
    const kept = names.filter((n) => ignored(n) && !specOf(n).readOnly && Object.hasOwn(prior, n)).map((n): [string, Value] => [n, prior[n]])
    const planned = Object.fromEntries([...Object.entries(fresh()), ...kept])
    // What the new object will get from the provider instead of the old one.
    const recomputed = Object.entries(planned)
      .filter(([n, v]) => v === UNKNOWN && !changes.some((c) => c.name === n))
      .map(([n]) => change(n, Object.hasOwn(prior, n) ? prior[n] : undefined, UNKNOWN))
    return { action: 'replace', planned, changes: [...changes, ...recomputed].sort(byName) }
  }
  return { action: 'update', changes, planned: Object.fromEntries(next) }
}
