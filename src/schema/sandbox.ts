// Sandbox content (content/sandbox/*.yaml): one file per cloud. It extends
// that cloud's single-provider canvas challenge (reusing its palette, link
// facts and sources) with extra parts and a fixed layout. resolveSandbox() in
// src/game/sandbox.ts turns one into an ordinary CanvasChallenge for the
// engine, so every editor and check downstream is reused.

import { z } from 'zod'
import { SourcesSchema, id } from './scenario.ts'
import { LayoutSchema, PaletteItemSchema, type CanvasChallenge } from './canvas.ts'
import { PROVIDERS } from './constants.ts'

export const SandboxSchema = z
  .strictObject({
    type: z.literal('sandbox'),
    id,
    provider: z.enum(PROVIDERS),
    title: z.string().min(1),
    extends: id, // the canvas challenge whose palette is reused
    layout: LayoutSchema,
    palette: z.array(PaletteItemSchema).min(1), // extra parts, all neutral
    sources: SourcesSchema,
  })
  .superRefine((f, ctx) => {
    f.palette.forEach((p, i) => {
      if (p.roles.length !== 1 || p.roles[0] !== 'neutral')
        ctx.addIssue({ code: 'custom', message: 'sandbox parts are neutral: roles must be [neutral]', path: ['palette', i, 'roles'], input: f })
    })
    const zones = f.layout.regions.flatMap((r) => r.zones.map((z) => z.id))
    const lanes = [...zones, ...f.layout.regions.map((r) => r.id), 'global']
    if (new Set(lanes).size !== lanes.length)
      ctx.addIssue({ code: 'custom', message: 'lane ids must be unique across regions and zones', path: ['layout'], input: f })
    if (!f.layout.global)
      ctx.addIssue({ code: 'custom', message: 'the sandbox layout needs the global lane (global: true)', path: ['layout', 'global'], input: f })
  })

export type SandboxFile = z.infer<typeof SandboxSchema>

// A resolved sandbox: an ordinary canvas challenge plus its own node cap.
export type SandboxChallenge = CanvasChallenge & { max_nodes: number }
