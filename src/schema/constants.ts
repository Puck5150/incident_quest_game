// Runtime values the game itself needs. Kept free of zod so the browser
// bundle doesn't pull in the schema library; the schema files re-export these.

// How much data an option can lose in a failure, best to worst.
export const RPO_LEVELS = ['zero', 'seconds', 'minutes', 'hours'] as const

export const MAX_NODES = 12
export const ROLES = ['route', 'serve', 'write-store'] as const
export const USERS = 'users' // implicit source of all traffic

export const PROVIDERS = ['aws', 'azure', 'gcp'] as const
export type Provider = (typeof PROVIDERS)[number]
export const PROVIDER_NAMES: Record<Provider, string> = { aws: 'AWS', azure: 'Azure', gcp: 'Google Cloud' }

export type ArtifactKind = 'log' | 'file' | 'trace' | 'metric' | 'stage'

// Everything the player can "open", flattened. Used by the validator, the
// engine (evidence tracking) and the debrief (where evidence lived).
export function artifacts(s: {
  logs?: { name: string; evidence?: string }[]
  files?: { path: string; evidence?: string }[]
  traces?: { name: string; evidence?: string }[]
  metrics?: { name: string; evidence?: string }[]
  pipeline?: { stages: { name: string; evidence?: string }[] }
}): { kind: ArtifactKind; name: string; evidence?: string }[] {
  return [
    ...(s.logs ?? []).map((a) => ({ kind: 'log' as const, name: a.name, evidence: a.evidence })),
    ...(s.files ?? []).map((a) => ({ kind: 'file' as const, name: a.path, evidence: a.evidence })),
    ...(s.traces ?? []).map((a) => ({ kind: 'trace' as const, name: a.name, evidence: a.evidence })),
    ...(s.metrics ?? []).map((a) => ({ kind: 'metric' as const, name: a.name, evidence: a.evidence })),
    ...(s.pipeline?.stages ?? []).map((a) => ({ kind: 'stage' as const, name: a.name, evidence: a.evidence })),
  ]
}
