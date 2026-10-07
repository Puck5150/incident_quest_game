// Terraform's recorded view of the world: the tfstate (version 4) shape, the
// addresses of its resources, and its JSON rendering for `terraform state pull`
// and `cat terraform.tfstate`.
import { hasUnknown, type Value } from './eval.ts'

export interface StateInstance {
  index_key?: string | number
  attributes: Record<string, Value>
  status?: 'tainted'
}
export interface StateResource {
  mode: 'managed' | 'data'
  type: string
  name: string
  provider: string // provider["registry.terraform.io/hashicorp/aws"]
  instances: StateInstance[]
}
export interface State {
  version: 4
  terraform_version: string
  serial: number
  lineage: string
  outputs: Record<string, { value: Value; sensitive?: boolean }>
  resources: StateResource[]
}

export const emptyState = (terraformVersion = '1.9.8', lineage = '00000000-0000-4000-8000-000000000000'): State => ({
  version: 4,
  terraform_version: terraformVersion,
  serial: 0,
  lineage,
  outputs: {},
  resources: [],
})

export function instanceAddress(r: Pick<StateResource, 'mode' | 'type' | 'name'>, key?: string | number): string {
  const base = `${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}`
  if (key === undefined) return base
  return typeof key === 'number' ? `${base}[${key}]` : `${base}[${JSON.stringify(key)}]`
}

export function listAddresses(state: State): string[] {
  return state.resources.flatMap((r) => r.instances.map((i) => instanceAddress(r, i.index_key))).sort()
}

export function findInstance(state: State, address: string): { resource: StateResource; instance: StateInstance } | undefined {
  for (const resource of state.resources) {
    for (const instance of resource.instances) {
      if (instanceAddress(resource, instance.index_key) === address) return { resource, instance }
    }
  }
  return undefined
}

const sortedAttributes = (attrs: Record<string, Value>): Record<string, Value> =>
  Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

export function stateJson(state: State): string {
  const doc = {
    version: state.version,
    terraform_version: state.terraform_version,
    serial: state.serial,
    lineage: state.lineage,
    outputs: state.outputs,
    resources: state.resources.map((r) => ({
      mode: r.mode,
      type: r.type,
      name: r.name,
      provider: r.provider,
      instances: r.instances.map((i) => {
        if (hasUnknown(i.attributes)) throw new Error(`cannot write ${instanceAddress(r, i.index_key)} to state: it holds an unknown value`)
        return {
          ...(i.index_key === undefined ? {} : { index_key: i.index_key }),
          ...(i.status ? { status: i.status } : {}),
          schema_version: 0,
          attributes: sortedAttributes(i.attributes),
          sensitive_attributes: [],
        }
      }),
    })),
    check_results: null,
  }
  return JSON.stringify(doc, null, 2)
}
