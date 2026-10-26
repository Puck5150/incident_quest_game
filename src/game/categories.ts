// The Ops-board filter chips. The ids come from the track schema, so a
// category can't exist here without being valid in tracks.yaml (and the
// Record below fails to compile if one is missing a label).

import type { Track } from '../schema/scenario.ts'

export type Category = Track['category']

const LABELS: Record<Category, string> = {
  foundations: 'Foundations',
  platform: 'Platform',
  cloud: 'Cloud',
  'private-cloud': 'Private cloud',
}

// Chip order is the key order above.
export const CATEGORIES = (Object.keys(LABELS) as Category[]).map((id) => ({ id, label: LABELS[id] }))
