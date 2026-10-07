// What the simulated providers know about each resource type: which
// attributes the provider computes, which are secret, and which force the
// resource to be destroyed and re-created when they change ("forces
// replacement" in a plan). Types not listed here are not modeled.
import type { Value } from './eval.ts'

export interface AttrSpec {
  forceNew?: boolean // changing it replaces the resource
  computed?: boolean // configurable, but the provider fills it in when omitted
  sensitive?: boolean // printed as (sensitive value)
  readOnly?: boolean // set by the provider only (id, arn); never configurable
  default?: Value // the provider's default when the configuration omits it
}
export interface ResourceSchema {
  provider: string
  attrs: Record<string, AttrSpec>
}

const AWS = 'registry.terraform.io/hashicorp/aws'
const RO: AttrSpec = { readOnly: true }
const NEW: AttrSpec = { forceNew: true }
const NEWC: AttrSpec = { forceNew: true, computed: true }
const aws = (attrs: Record<string, AttrSpec>): ResourceSchema => ({ provider: AWS, attrs: { id: RO, arn: RO, ...attrs } })

export const SCHEMAS: Record<string, ResourceSchema> = {
  aws_vpc: aws({
    cidr_block: NEWC,
    enable_dns_support: { default: true },
    enable_dns_hostnames: { default: false },
    tags: {},
    tags_all: RO,
    default_security_group_id: RO,
  }),
  aws_subnet: aws({ vpc_id: NEW, cidr_block: NEWC, availability_zone: NEWC, map_public_ip_on_launch: { default: false }, tags: {}, tags_all: RO }),
  aws_security_group: aws({
    name: NEWC,
    name_prefix: NEWC,
    description: { forceNew: true, default: 'Managed by Terraform' },
    vpc_id: NEWC,
    ingress: { computed: true },
    egress: { computed: true },
    tags: {},
    tags_all: RO,
  }),
  aws_instance: aws({
    ami: NEW,
    instance_type: {},
    subnet_id: NEWC,
    availability_zone: NEWC,
    key_name: NEWC,
    user_data: {},
    tags: {},
    tags_all: RO,
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
  aws_s3_bucket: aws({ bucket: NEWC, force_destroy: { default: false }, tags: {}, tags_all: RO, bucket_domain_name: RO }),
  aws_sqs_queue: aws({
    name: NEWC,
    fifo_queue: { forceNew: true, default: false },
    visibility_timeout_seconds: { default: 30 },
    message_retention_seconds: { default: 345600 },
    tags: {},
    tags_all: RO,
    url: RO,
  }),
  aws_iam_role: aws({ name: NEWC, path: { forceNew: true, default: '/' }, assume_role_policy: {}, tags: {}, tags_all: RO }),
  aws_ecs_service: aws({ name: NEW, cluster: NEWC, task_definition: {}, desired_count: { default: 0 }, tags: {}, tags_all: RO }),
  aws_cloudwatch_log_group: aws({ name: NEWC, retention_in_days: { default: 0 }, tags: {}, tags_all: RO }),
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
