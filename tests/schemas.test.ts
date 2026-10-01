// The JSON Schemas in schemas/ (editor autocomplete for content YAML) must
// match the Zod schemas, and every content file must point at the right one.

import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { contentKind } from '../vite-plugin-content.ts'
import { OUT_DIR, SCHEMAS, render } from '../scripts/schemas.ts'

const CONTENT = path.resolve(import.meta.dirname, '../content')

it.each(Object.entries(SCHEMAS))('schemas/%s.json is up to date (run npm run schemas)', (name, schema) => {
  expect(fs.readFileSync(path.join(OUT_DIR, `${name}.json`), 'utf8')).toBe(render(schema))
})

const files = fs
  .readdirSync(CONTENT, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.yaml') && f !== 'tracks.yaml')

it.each(files)('%s names the schema for its kind on line 1', (f) => {
  const file = path.join(CONTENT, f)
  const raw = fs.readFileSync(file, 'utf8')
  const want = path.relative(path.dirname(file), path.join(OUT_DIR, `${contentKind(raw)}.json`))
  expect(raw.split('\n')[0]).toBe(`# yaml-language-server: $schema=${want}`)
})
