// Generates JSON Schemas for content files from the Zod schemas, for YAML
// autocomplete and inline errors in editors (see AUTHORING.md). Run with
// `npm run schemas`; a test fails if the committed files are out of date.
//
// Checks that span fields or files (solution paths name real actions,
// reference designs pass...) can't be expressed in JSON Schema, so the
// editor catches shape errors and `npm test` still catches the rest.

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { ScenarioSchema } from '../src/schema/scenario.ts'
import { ChallengeSchema } from '../src/schema/challenge.ts'
import { CanvasChallengeSchema } from '../src/schema/canvas.ts'
import { MultiCanvasSchema, MultiSlotSchema } from '../src/schema/multi.ts'
import type { ContentKind } from '../vite-plugin-content.ts'

// One schema per kind of content file (see contentKind() in vite-plugin-content.ts).
export const SCHEMAS: Record<ContentKind, z.ZodType> = {
  incident: ScenarioSchema,
  challenge: ChallengeSchema,
  canvas: CanvasChallengeSchema,
  'pick-cloud-canvas': MultiCanvasSchema,
  'pick-cloud-slot': MultiSlotSchema,
}

export const OUT_DIR = path.resolve(import.meta.dirname, '../schemas')

// `io: 'input'` describes what authors write: fields with defaults are optional.
// Draft 7 because it's what editors' YAML/JSON language servers support best.
export const render = (schema: z.ZodType) => JSON.stringify(z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }), null, 2) + '\n'

if (import.meta.main) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  for (const [name, schema] of Object.entries(SCHEMAS)) fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), render(schema))
  console.log(`Wrote ${Object.keys(SCHEMAS).length} schemas to schemas/`)
}
