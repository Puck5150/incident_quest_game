// The 12-component limit belongs to scored challenges; a challenge can carry
// its own cap (the sandbox uses 40).

import path from 'node:path'
import { expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { addNode, emptyDesign } from '../src/game/canvasEdit.ts'
import { MAX_NODES } from '../src/schema/constants.ts'
import type { Design } from '../src/schema/canvas.ts'

const { canvases } = loadContent(path.resolve(import.meta.dirname, '../content'))
const aws = canvases.find((c) => c.id === 'aws-checkout-canvas')!

const fill = (c: Parameters<typeof addNode>[0], n: number): Design | string => {
  let d: Design | string = emptyDesign()
  for (let i = 0; i < n && typeof d !== 'string'; i++) d = addNode(c, d, 'ec2-web', 'use1-az1')
  return d
}

it('a scored challenge stops at 12 components', () => {
  expect(typeof fill(aws, MAX_NODES)).toBe('object')
  const full = fill(aws, MAX_NODES) as Design
  expect(addNode(aws, full, 'ec2-web', 'use1-az1')).toBe(`A design can have at most ${MAX_NODES} components.`)
})

it('a challenge with its own cap uses it', () => {
  const roomy = { ...aws, max_nodes: MAX_NODES + 2 }
  const d = fill(roomy, MAX_NODES + 1) as Design
  expect(d.nodes).toHaveLength(MAX_NODES + 1)
  expect(addNode(roomy, fill(roomy, MAX_NODES + 2) as Design, 'ec2-web', 'use1-az1')).toBe(
    `A design can have at most ${MAX_NODES + 2} components.`,
  )
})
