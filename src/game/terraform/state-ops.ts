// The state-only commands: `terraform state mv`, `state rm`, `taint`, `untaint`
// and `import`. Each takes a state and returns a new one with serial + 1, or the
// error the CLI prints; the input is never changed.
import { compareAddresses, formatModule, modulePathCovers, parseModuleAddr, parseResAddr, staticKey, stepsOf, type ModStep } from './address.ts'
import { realityKey, type Reality } from './refresh.ts'
import { schemaFor } from './resources.ts'
import { findInstance, instanceAddress, renameDependencies, type State, type StateInstance, type StateResource } from './state.ts'

export type OpResult<T = object> = ({ ok: true; state: State } & T) | { ok: false; summary: string; detail: string } // detail '' = plain one-line message form

type Parsed = { ok: true; type: string; name: string; key?: string | number; mode: 'managed' | 'data'; module?: string }
type ParsedModule = { ok: true; kind: 'module'; steps: ModStep[]; module: string }

// aws_x.y, aws_x.y[0], aws_x.y["k"], data.aws_x.y, each optionally under module.NAME[key]. prefixes.
export function parseAddress(text: string): Parsed | { ok: false } {
  const r = parseResAddr(text)
  if (!r) return { ok: false }
  const { module, ...rest } = r
  return { ok: true, ...rest, ...(module.length ? { module: formatModule(module) } : {}) }
}

// Like parseAddress, but a whole module (module.net, module.net["a"].module.sub) is also a target.
export function parseTarget(text: string): Parsed | ParsedModule | { ok: false } {
  const steps = parseModuleAddr(text)
  return steps ? { ok: true, kind: 'module', steps, module: text } : parseAddress(text)
}

const fail = (summary: string, detail = '') => ({ ok: false as const, summary, detail })
const bumped = (state: State): State => ({ ...structuredClone(state), serial: state.serial + 1 })
const sameResource = (r: StateResource, a: Parsed) => r.mode === a.mode && r.type === a.type && r.name === a.name && r.module === a.module
const staticOf = (r: Pick<StateResource, 'module' | 'mode' | 'type' | 'name'>) => staticKey({ ...r, module: stepsOf(r.module) })
const NOT_ADDRESS = 'address is not a valid resource instance or resource address.'

function moveModule(state: State, from: string, to: string, src: ParsedModule, dst: ParsedModule): OpResult<{ moved: { from: string; to: string }[] }> {
  const s = bumped(state)
  const n = src.steps.length
  const last = src.steps[n - 1]
  const dlast = dst.steps[dst.steps.length - 1]
  const hit = s.resources.filter((r) => modulePathCovers(src.steps, stepsOf(r.module)))
  if (hit.length === 0) return fail('Invalid source address', `Cannot move ${from}: does not match anything in the current state.`)
  if (last.key === undefined && dlast.key !== undefined) return fail('Invalid target address', `Cannot move ${from} to ${to}: the target must also be a whole module.`)
  const rewrite = (r: StateResource): string => {
    const at = stepsOf(r.module)
    const key = last.key === undefined ? at[n - 1].key : dlast.key
    return formatModule([...dst.steps.slice(0, -1), { name: dlast.name, ...(key === undefined ? {} : { key }) }, ...at.slice(n)])
  }
  const taken = new Set(s.resources.filter((r) => !hit.includes(r)).flatMap((r) => r.instances.map((i) => instanceAddress(r, i.index_key))))
  const moved = hit.flatMap((r) => r.instances.map((i) => ({ from: instanceAddress(r, i.index_key), to: instanceAddress({ ...r, module: rewrite(r) }, i.index_key) })))
  if (moved.some((m) => taken.has(m.to))) return fail('Invalid target address', `Cannot move to ${to}: there is already a resource instance at that address in the current state.`)
  const renamed = new Map(hit.map((r) => [staticOf(r), staticOf({ ...r, module: rewrite(r) })]))
  for (const r of hit) r.module = rewrite(r)
  renameDependencies(s.resources, renamed)
  return { ok: true, state: s, moved: moved.sort((a, b) => compareAddresses(a.from, b.from)) }
}

export function stateMove(state: State, from: string, to: string): OpResult<{ moved: { from: string; to: string }[] }> {
  const src = parseTarget(from)
  if (!src.ok) return fail('Invalid source address', `Cannot move ${from}: ${NOT_ADDRESS}`)
  const dst = parseTarget(to)
  if (!dst.ok) return fail('Invalid target address', `Cannot move to ${to}: ${NOT_ADDRESS}`)
  if ('kind' in src || 'kind' in dst) {
    if ('kind' in src && 'kind' in dst) return moveModule(state, from, to, src, dst)
    return fail('Invalid target address', `Cannot move ${from} to ${to}: a module can be moved only to another module address.`)
  }
  const s = bumped(state)
  const srcIndex = s.resources.findIndex((r) => sameResource(r, src))
  const srcRes = s.resources[srcIndex] as StateResource | undefined
  const moving = srcRes?.instances.filter((i) => src.key === undefined || i.index_key === src.key) ?? []
  if (!srcRes || moving.length === 0) return fail('Invalid source address', `Cannot move ${from}: does not match anything in the current state.`)
  if (src.mode !== dst.mode) return fail('Invalid target address', `Cannot move ${from} to ${to}: a ${src.mode} resource can be moved only to another ${src.mode} resource address.`)
  if (src.type !== dst.type) return fail('Invalid target address', `Cannot move to ${to}: resource types must match (${src.type} and ${dst.type}).`)
  const exists = fail('Invalid target address', `Cannot move to ${to}: there is already a resource instance at that address in the current state.`)
  let dstRes = s.resources.find((r) => sameResource(r, dst))
  let place: (i: StateInstance) => string | number | undefined
  if (src.key === undefined && dst.key !== undefined) {
    // A resource with one unkeyed instance can move into an indexed resource ("Move a Resource Into an Indexed Resource").
    if (moving.length !== 1 || moving[0].index_key !== undefined) return fail('Invalid target address', `Cannot move ${from} to ${to}: the target must also be a whole resource.`)
    if (findInstance(s, instanceAddress(dst, dst.key))) return exists
    place = () => dst.key
  } else if (src.key === undefined) {
    if (dstRes) return exists
    place = (i) => i.index_key
  } else {
    if (findInstance(s, instanceAddress(dst, dst.key))) return exists
    if (dst.key === undefined && dstRes?.instances.some((i) => i !== moving[0])) {
      return fail('Invalid target address', `Cannot move to ${to}: ${instanceAddress(dst)} already has instances with keys, so it has no unkeyed instance.`)
    }
    place = () => dst.key
  }
  const moved = moving.map((i) => ({ from: instanceAddress(srcRes, i.index_key), to: instanceAddress(dst, place(i)) })).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
  srcRes.instances = srcRes.instances.filter((i) => !moving.includes(i))
  if (!dstRes) {
    const { module: _drop, ...base } = srcRes
    dstRes = { ...base, ...(dst.module ? { module: dst.module } : {}), type: dst.type, name: dst.name, instances: [] }
    s.resources.splice(srcIndex + 1, 0, dstRes)
  }
  for (const i of moving) {
    const k = place(i)
    if (k === undefined) delete i.index_key
    else i.index_key = k
    dstRes.instances.push(i)
  }
  if (srcRes.instances.length === 0) {
    s.resources = s.resources.filter((r) => r !== srcRes)
    // The old resource address is gone; anything depending on it now depends on the new one.
    const oldBase = staticOf(srcRes)
    const newBase = staticOf(dstRes)
    for (const r of s.resources) for (const i of r.instances) if (i.dependencies) i.dependencies = i.dependencies.map((d) => (d === oldBase ? newBase : d))
  }
  return { ok: true, state: s, moved }
}

export function stateRemove(state: State, addresses: string[]): OpResult<{ removed: string[] }> {
  const targets = addresses.map(parseTarget).filter((a) => a.ok)
  const s = bumped(state)
  const removed: string[] = []
  for (const r of s.resources) {
    r.instances = r.instances.filter((i) => {
      const hit = targets.some((a) =>
        'kind' in a ? modulePathCovers(a.steps, stepsOf(r.module)) : r.mode === a.mode && r.type === a.type && r.name === a.name && modulePathCovers(stepsOf(a.module), stepsOf(r.module), true) && (a.key === undefined || a.key === i.index_key),
      )
      if (hit) removed.push(instanceAddress(r, i.index_key))
      return !hit
    })
  }
  if (removed.length === 0) return fail('No matching objects found.')
  s.resources = s.resources.filter((r) => r.instances.length > 0)
  return { ok: true, state: s, removed }
}

export const NO_SUCH_INSTANCE = 'No such resource instance'

function withInstance(state: State, address: string, verb: string, change: (i: StateInstance) => OpResult | undefined): OpResult {
  const a = parseAddress(address)
  if (a.ok && a.mode === 'data') return fail('Invalid resource address', `Data sources cannot be ${verb}.`)
  const s = bumped(state)
  const found = a.ok ? findInstance(s, instanceAddress(a, a.key)) : undefined
  if (!found) return fail(NO_SUCH_INSTANCE, `There is no resource instance with the address ${address} in the current state.`)
  return change(found.instance) ?? { ok: true, state: s }
}

export const taintInstance = (state: State, address: string): OpResult =>
  withInstance(state, address, 'tainted', (i) => {
    i.status = 'tainted'
    return undefined
  })

export const untaintInstance = (state: State, address: string): OpResult =>
  withInstance(state, address, 'untainted', (i) => {
    if (i.status !== 'tainted') return fail('Resource instance is not tainted', `Resource instance ${address} is not currently tainted, and so it cannot be untainted.`)
    delete i.status
    return undefined
  })

// Shared with plan.ts's import blocks so both print the same words.
export const NO_REMOTE_OBJECT = 'Cannot import non-existent remote object'
export const noRemoteObjectDetail = (address: string) =>
  `While attempting to import an existing object to "${address}", the provider detected that no object exists with the given id. Only pre-existing objects can be imported; check that the id is correct and that it is associated with the provider's configured region or endpoint, or use "terraform apply" to create a new remote object for this resource.`

// Shared with plan.ts's import blocks: an import target whose instance the configuration does not produce.
export const NO_IMPORT_CONFIG = 'Configuration for import target does not exist'
export const noImportConfigDetail = (address: string) =>
  `The configuration for the given import target ${address} does not exist. All target instances must have an associated configuration to be imported.`

// The argument error for an address that does not parse (wording invented).
export const INVALID_ADDRESS = 'Invalid address'
export const invalidAddressDetail = (address: string) => `${address} is not a valid resource instance address.`

export function importObject(state: State, reality: Reality, address: string, id: string, declared: boolean): OpResult {
  const a = parseAddress(address)
  if (!a.ok) return fail(INVALID_ADDRESS, invalidAddressDetail(address))
  if (a.mode === 'data') return fail('Invalid resource address', 'Data sources cannot be imported.')
  if (!declared) {
    return fail(
      `Resource address "${instanceAddress(a)}" does not exist in the configuration.`,
      `Before importing this resource, please create its configuration in ${a.module ? formatModule(stepsOf(a.module).map((x) => ({ name: x.name }))) : 'the root module'}. For example:\n\nresource "${a.type}" "${a.name}" {\n  # (resource arguments)\n}`,
    )
  }
  if (findInstance(state, instanceAddress(a, a.key))) {
    return fail('Resource already managed by Terraform', `Terraform is already managing a remote object for ${address}. To import to this address you must first remove the existing object from the state.`)
  }
  const k = realityKey(a.type, id)
  if (!Object.hasOwn(reality, k)) return fail(NO_REMOTE_OBJECT, noRemoteObjectDetail(address))
  const s = bumped(state)
  let r = s.resources.find((x) => sameResource(x, a))
  if (!r) {
    r = { ...(a.module ? { module: a.module } : {}), mode: 'managed', type: a.type, name: a.name, provider: `provider["${schemaFor(a.type)?.provider ?? `registry.terraform.io/hashicorp/${a.type.split('_')[0]}`}"]`, instances: [] }
    s.resources.push(r)
  }
  r.instances.push({ ...(a.key === undefined ? {} : { index_key: a.key }), attributes: structuredClone(reality[k]) })
  return { ok: true, state: s }
}
