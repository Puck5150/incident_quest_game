// How `terraform state show`, `show` and `output` print values: attributes at
// four spaces, `=` aligned, maps with quoted keys, lists one element per row
// (and, separately, `output`).
import { formatDiagnostic } from './diag.ts'
import { isUnknown, type Value } from './eval.ts'
import { compareAddresses } from './address.ts'
import { instanceAddress, type State, type StateInstance, type StateResource } from './state.ts'

type Obj = { [key: string]: Value }
const isObj = (v: Value): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !isUnknown(v)
const sp = (n: number) => ' '.repeat(n)

function scalar(v: Value): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[]'
  if (isObj(v)) return '{}'
  return String(v)
}

function entry(col: number, name: string, width: number, v: Value, masked = false): string[] {
  const head = `${sp(col)}${name.padEnd(width)} = `
  if (masked) return [`${head}(sensitive value)`]
  if (Array.isArray(v) && v.length) return [`${head}[`, ...v.flatMap((x) => element(col + 4, x)), `${sp(col)}]`]
  if (isObj(v) && Object.keys(v).length) return [`${head}{`, ...body(v, col + 4, true), `${sp(col)}}`]
  return [`${head}${scalar(v)}`]
}

function element(col: number, x: Value): string[] {
  if (isObj(x) && Object.keys(x).length) return [`${sp(col)}{`, ...body(x, col + 4, false), `${sp(col)}},`]
  if (Array.isArray(x) && x.length) return [`${sp(col)}[`, ...x.flatMap((y) => element(col + 4, y)), `${sp(col)}],`]
  return [`${sp(col)}${scalar(x)},`]
}

function body(o: Obj, col: number, quote: boolean, masked: (k: string) => boolean = () => false): string[] {
  const keys = Object.keys(o).filter((k) => o[k] !== null).sort()
  const label = (k: string) => (quote ? JSON.stringify(k) : k)
  const w = Math.max(0, ...keys.map((k) => label(k).length))
  return keys.flatMap((k) => entry(col, label(k), w, o[k], masked(k)))
}

export function stateShow(r: StateResource, inst: StateInstance, sensitive: (attr: string) => boolean = () => false): string {
  const addr = instanceAddress(r, inst.index_key)
  const open = r.mode === 'data' ? `data "${r.type}" "${r.name}" {` : `resource "${r.type}" "${r.name}" {`
  return [`# ${addr}:${inst.status === 'tainted' ? ' (tainted)' : ''}`, open, ...body(inst.attributes, 4, false, sensitive), '}'].join('\n')
}

export function showState(state: State, sensitive: (type: string, attr: string) => boolean = () => false): string {
  const blocks = state.resources
    .flatMap((r) => r.instances.map((i) => ({ addr: instanceAddress(r, i.index_key), text: stateShow(r, i, (a) => sensitive(r.type, a)) })))
    .sort((a, b) => compareAddresses(a.addr, b.addr))
  return blocks.length ? blocks.map((b) => b.text).join('\n\n') : 'The state file is empty. No resources are represented.'
}

// `terraform output` values: two-space indent, map keys quoted and not aligned,
// every mapping key quoted at every depth. Not the aligned state-show body.
function outValue(v: Value, ind: number): string {
  const pad = sp(ind)
  const inner = sp(ind + 2)
  if (Array.isArray(v) && v.length) return `[\n${v.map((x) => `${inner}${outValue(x, ind + 2)},\n`).join('')}${pad}]`
  if (isObj(v) && Object.keys(v).length) {
    const o = v as Obj
    return `{\n${Object.keys(o).sort().map((k) => `${inner}${JSON.stringify(k)} = ${outValue(o[k], ind + 2)}\n`).join('')}${pad}}`
  }
  return scalar(v)
}

type OutResult = { stdout: string; stderr: string; exitCode: number }
// Go's JSON encoder orders object keys; so does this.
const sortedJson = (v: Value): Value => (Array.isArray(v) ? v.map(sortedJson) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedJson((v as Obj)[k])])) : v)
const jsonType = (v: Value) => (typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'dynamic')

export function outputsText(outputs: State['outputs'], name?: string, mode: 'hcl' | 'raw' | 'json' = 'hcl'): OutResult {
  const names = Object.keys(outputs).sort()
  const none = {
    stdout: formatDiagnostic({ severity: 'warning', summary: 'No outputs found', detail: 'The state file either has no outputs defined, or all the defined outputs are empty. Please define an output in your configuration with the `output` keyword and run `terraform refresh` for it to become available. If you are using interpolation, please verify the interpolated value is not empty. You can use the `terraform console` command to assist.', file: '', line: 0, col: 0 }),
    stderr: '',
    exitCode: 0,
  }
  if (name !== undefined && !names.length) return none
  const box = (severity: 'error' | 'warning', summary: string, detail: string) => formatDiagnostic({ severity, summary, detail, file: '', line: 0, col: 0 })
  const err = (summary: string, detail: string): OutResult => ({ stdout: '', stderr: box('error', summary, detail), exitCode: 1 })
  if (name !== undefined) {
    if (!Object.hasOwn(outputs, name)) {
      return err(`Output "${name}" not found`, 'The output variable requested could not be found in the state file. If you recently added this to your configuration, be sure to run `terraform apply`, since the state won\'t be updated with new output variables until that command is run.')
    }
    const v = outputs[name].value
    if (mode === 'raw' && v === null) return err('Unsupported value for raw output', `The value for output value "${name}" is null, so -raw mode cannot print it.`)
    if (mode === 'raw' && (typeof v === 'object' || v === undefined)) {
      return err('Unsupported value for raw output', `The -raw option only supports strings, numbers, and boolean values, but output value "${name}" is not of a type that can be rendered as plain text.`)
    }
    const out = mode === 'json' ? JSON.stringify(sortedJson(v)) : mode === 'raw' ? String(v) : outValue(v, 0)
    return { stdout: out, stderr: '', exitCode: 0 }
  }
  if (mode === 'raw') return err('Raw output format is only supported for single outputs', '')
  if (mode === 'json') {
    const doc = names.map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify({ sensitive: outputs[n].sensitive === true, type: jsonType(outputs[n].value), value: sortedJson(outputs[n].value) }, null, 2).replace(/\n/g, '\n  ')}`)
    return { stdout: names.length ? `{\n${doc.join(',\n')}\n}` : '{}', stderr: '', exitCode: 0 }
  }
  if (!names.length) return none
  return { stdout: names.map((n) => `${n} = ${outputs[n].sensitive ? '<sensitive>' : outValue(outputs[n].value, 0)}`).join('\n'), stderr: '', exitCode: 0 }
}
