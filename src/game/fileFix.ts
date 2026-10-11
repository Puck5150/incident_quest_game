import type { Action } from '../schema/scenario.ts'
import { ingressPolicyOk } from './vpcscIngress.ts'

// Whether a file's text counts as fixed for a `file` action: it matches the regex and, when the
// action names a structural check, passes it.
export const fileFixed = (f: NonNullable<Action['file']>, text: string) =>
  new RegExp(f.matches, 'm').test(text) && (f.ingress_policy === undefined || ingressPolicyOk(text, f.ingress_policy))
