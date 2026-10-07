import { EvalError, type Value } from './eval.ts'

export function callFunction(name: string, _args: Value[]): Value {
  throw new EvalError('Call to unknown function', `There is no function named "${name}".`)
}
