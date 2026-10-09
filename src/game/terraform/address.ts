// The one address model: [module.NAME[key].]*[data.]TYPE.NAME[key], with module-only addresses.
// Dependency-free so state, state-ops, the CLI, predicates and the scenario schema can all share it.

export interface ModStep {
  name: string
  key?: string | number
}
export interface ResAddr {
  module: ModStep[]
  mode: 'managed' | 'data'
  type: string
  name: string
  key?: string | number
}

const NOT_RESOURCES = new Set(['var', 'local', 'module', 'data', 'each', 'count', 'path', 'terraform', 'self'])
const NAME = '[A-Za-z_][\\w-]*'
const KEY = '\\[(?:\\d+|"(?:[^"\\\\]|\\\\.)*")\\]'
const MOD = `module\\.${NAME}(?:${KEY})?`
const RES = new RegExp(`^((?:${MOD}\\.)*)(data\\.)?(${NAME})\\.(${NAME})(${KEY})?$`)
const MODULE_ONLY = new RegExp(`^${MOD}(?:\\.${MOD})*$`)
const STEP = new RegExp(`module\\.(${NAME})(${KEY})?(\\.|$)`, 'y')

export const MODULE_PATH_SOURCE = `(?:${MOD}\\.)*`

const parseKey = (text: string | undefined): { ok: true; key?: string | number } | { ok: false } => {
  if (text === undefined) return { ok: true }
  const inner = text.slice(1, -1)
  if (!inner.startsWith('"')) return { ok: true, key: Number(inner) }
  try {
    return { ok: true, key: JSON.parse(inner) as string }
  } catch {
    return { ok: false }
  }
}

// Leading `module.NAME[key].` steps of text; `rest` is what follows the last complete step (steps end with a dot, or the text ends).
function leadingSteps(text: string): { steps: ModStep[]; rest: string } | undefined {
  const steps: ModStep[] = []
  let pos = 0
  for (;;) {
    STEP.lastIndex = pos
    const m = STEP.exec(text)
    if (!m) return { steps, rest: text.slice(pos) }
    const k = parseKey(m[2])
    if (!k.ok) return undefined
    steps.push({ name: m[1], ...(k.key === undefined ? {} : { key: k.key }) })
    pos = STEP.lastIndex
    if (m[3] === '') return { steps, rest: '' }
  }
}

export function parseModuleAddr(text: string): ModStep[] | undefined {
  if (!MODULE_ONLY.test(text)) return undefined
  return leadingSteps(text)?.steps
}

export function parseResAddr(text: string): ResAddr | undefined {
  const m = RES.exec(text)
  if (!m || NOT_RESOURCES.has(m[3])) return undefined
  const module = m[1] ? parseModuleAddr(m[1].slice(0, -1)) : []
  const k = parseKey(m[5])
  if (!module || !k.ok) return undefined
  return { module, mode: m[2] ? 'data' : 'managed', type: m[3], name: m[4], ...(k.key === undefined ? {} : { key: k.key }) }
}

export const formatKey = (key: string | number): string => (typeof key === 'number' ? `[${key}]` : `[${JSON.stringify(key)}]`)

export const formatModule = (steps: ModStep[]): string => steps.map((s) => `module.${s.name}${s.key === undefined ? '' : formatKey(s.key)}`).join('.')

const plain = (a: Pick<ResAddr, 'mode' | 'type' | 'name'>) => `${a.mode === 'data' ? 'data.' : ''}${a.type}.${a.name}`

export function formatResAddr(a: ResAddr): string {
  const base = `${a.module.length ? `${formatModule(a.module)}.` : ''}${plain(a)}`
  return a.key === undefined ? base : `${base}${formatKey(a.key)}`
}

// The resource-level identity (module instance path kept, no instance key): module.net["a"].aws_x.y
export const resourceKey = (a: Pick<ResAddr, 'module' | 'mode' | 'type' | 'name'>): string => formatResAddr({ module: a.module, mode: a.mode, type: a.type, name: a.name })

// The same without module instance keys: how dependencies name resources.
export const staticKey = (a: Pick<ResAddr, 'module' | 'mode' | 'type' | 'name'>): string =>
  resourceKey({ module: a.module.map((s) => ({ name: s.name })), mode: a.mode, type: a.type, name: a.name })

// A module path given as the tfstate "module" string (absent = root).
export const stepsOf = (module: string | undefined): ModStep[] => (module ? (parseModuleAddr(module) ?? []) : [])

const keyOrder = (a: string | number | undefined, b: string | number | undefined): number => {
  if (a === b) return 0
  if (a === undefined) return -1
  if (b === undefined) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return a < b ? -1 : 1
}

// Root before child modules, shorter module paths first, then module name and key; within one module
// (including root) the plain string order of the rest, which is what root-only lists always used.
export function compareAddresses(a: string, b: string): number {
  const x = leadingSteps(a)
  const y = leadingSteps(b)
  const xs = x?.steps ?? []
  const ys = y?.steps ?? []
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (xs[i].name !== ys[i].name) return xs[i].name < ys[i].name ? -1 : 1
    const k = keyOrder(xs[i].key, ys[i].key)
    if (k) return k
  }
  if (xs.length !== ys.length) return xs.length - ys.length
  const ra = x?.rest ?? a
  const rb = y?.rest ?? b
  return ra < rb ? -1 : ra > rb ? 1 : 0
}

// Does the module path `have` fall under `want`? An unkeyed step in `want` matches any key.
export function modulePathCovers(want: ModStep[], have: ModStep[], whole = false): boolean {
  if (whole ? want.length !== have.length : want.length > have.length) return false
  return want.every((s, i) => s.name === have[i].name && (s.key === undefined || s.key === have[i].key))
}

// Does a (resource, instance or module) address `given` cover the instance address `actual`?
// A key-less resource covers all its instances; a module covers everything under it.
export function addressCovers(given: string, actual: string): boolean {
  const mod = parseModuleAddr(given)
  const a = leadingSteps(actual)
  if (!a) return false
  if (mod) return modulePathCovers(mod, a.steps)
  const g = leadingSteps(given)
  if (!g || !modulePathCovers(g.steps, a.steps, true)) return false
  return a.rest === g.rest || (!g.rest.endsWith(']') && a.rest.startsWith(`${g.rest}[`))
}
