// How `terraform state show`, `show` and `output` print values: attributes at
// four spaces, `=` aligned, maps with quoted keys, lists one element per row.
import { formatDiagnostic } from './diag.ts'
import { isUnknown, type Value } from './eval.ts'
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
    .sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
  return blocks.length ? blocks.map((b) => b.text).join('\n\n') : 'The state file is empty. No resources are represented.'
}

function valueText(v: Value): string {
  if (Array.isArray(v) && v.length) return ['[', ...v.flatMap((x) => element(4, x)), ']'].join('\n')
  if (isObj(v) && Object.keys(v).length) return ['{', ...body(v, 4, true), '}'].join('\n')
  return scalar(v)
}

export function outputsText(outputs: State['outputs'], name?: string, mode: 'hcl' | 'raw' | 'json' = 'hcl'): { stdout: string; stderr: string; exitCode: number } {
  const names = Object.keys(outputs).sort()
  const box = (severity: 'error' | 'warning', summary: string, detail: string) => formatDiagnostic({ severity, summary, detail, file: '', line: 0, col: 0 })
  if (name !== undefined) {
    if (!Object.hasOwn(outputs, name)) {
      return { stdout: '', stderr: box('error', `Output "${name}" not found`, 'The output variable requested could not be found in the state file. If you recently added this to your configuration, be sure to run `terraform apply`, since the state won\'t be updated with new output variables until that command is run.'), exitCode: 1 }
    }
    const v = outputs[name].value
    const out = mode === 'json' ? JSON.stringify(v, null, 2) : mode === 'raw' ? (typeof v === 'string' ? v : String(JSON.stringify(v))) : valueText(v)
    return { stdout: out, stderr: '', exitCode: 0 }
  }
  if (!names.length) {
    return {
      stdout: '',
      stderr: box('warning', 'No outputs found', 'The state file either has no outputs defined, or all the defined outputs are empty. Please define an output in your configuration with the `output` keyword and run `terraform refresh` for it to become available. If you are using interpolation, please verify the interpolated value is not empty. You can use the `terraform console` command to assist.'),
      exitCode: 0,
    }
  }
  const out = names.flatMap((n) => (outputs[n].sensitive ? [`${n} = <sensitive>`] : entry(0, n, n.length, outputs[n].value)))
  return { stdout: out.join('\n'), stderr: '', exitCode: 0 }
}
