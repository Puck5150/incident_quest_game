// Regression test: new tracks once landed on top of existing boxes, and an
// edge once ran behind an unrelated box. Checked against the real content.

import path from 'node:path'
import { expect, it } from 'vitest'
import { loadContent } from '../vite-plugin-content.ts'
import { layout } from '../src/screens/skillTreeLayout.ts'
import { newProgress } from '../src/game/progress.ts'

const { tracks, scenarios, challenges } = loadContent(path.resolve(import.meta.dirname, '../content'))
const nodes = layout(tracks, [...scenarios, ...challenges], newProgress(), new Set())
const at = new Map(nodes.map((n) => [n.track.id, n]))

it('no two boxes in a column overlap', () => {
  nodes.forEach((a) =>
    nodes.forEach((b) => {
      if (a !== b && a.col === b.col) expect(Math.abs(a.row - b.row), `${a.track.id} vs ${b.track.id}`).toBeGreaterThanOrEqual(1)
    }),
  )
})

it('no edge that skips a column runs behind a box in that column', () => {
  nodes.forEach((to) =>
    to.track.requires.forEach((r) => {
      const from = at.get(r)
      if (!from) return
      nodes
        .filter((n) => n.col > from.col && n.col < to.col)
        .forEach((n) => {
          const y = from.row + ((to.row - from.row) * (n.col - from.col)) / (to.col - from.col)
          expect(Math.abs(y - n.row), `${r} -> ${to.track.id} behind ${n.track.id}`).toBeGreaterThanOrEqual(0.75)
        })
    }),
  )
})
