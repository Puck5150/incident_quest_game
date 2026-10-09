// Terraform's recorded view of the world: the tfstate (version 4) shape, the
// addresses of its resources, and its JSON rendering for `terraform state pull`
// and `cat terraform.tfstate`.
import { compareAddresses, formatKey } from './address.ts'
import { hasUnknown, type Value } from './eval.ts'

export interface StateInstance {
  index_key?: string | number
  attributes: Record<string, Value>
  status?: 'tainted'
  dependencies?: string[] // resource addresses (no instance keys) this instance depends on
}
export interface StateResource {
  module?: string // instance-qualified module path, as in tfstate v4: module.net or module.net["a"]; absent = root
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

export function instanceAddress(r: Pick<StateResource, 'mode' | 'type' | 'name' | 'module'>, key?: string | number): string {
  const base = `${r.module ? `${r.module}.` : ''}${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}`
  return key === undefined ? base : `${base}${formatKey(key)}`
}

export function listAddresses(state: State): string[] {
  return state.resources.flatMap((r) => r.instances.map((i) => instanceAddress(r, i.index_key))).sort(compareAddresses)
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
  for (const [name, o] of Object.entries(state.outputs)) if (hasUnknown(o.value)) throw new Error(`cannot write output "${name}" to state: it holds an unknown value`)
  const doc = {
    version: state.version,
    terraform_version: state.terraform_version,
    serial: state.serial,
    lineage: state.lineage,
    outputs: state.outputs,
    resources: state.resources.map((r) => ({
      ...(r.module ? { module: r.module } : {}),
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
          ...(i.dependencies?.length ? { dependencies: [...i.dependencies] } : {}),
        }
      }),
    })),
    check_results: null,
  }
  return JSON.stringify(doc, null, 2)
}
