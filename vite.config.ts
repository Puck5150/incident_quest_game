/// <reference types="vitest/config" />
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { contentPlugin } from './vite-plugin-content.ts'

// https://vite.dev/config/
export default defineConfig({
  base: './', // relative asset paths, so the build works under GitHub Pages' /incident_quest_game/
  plugins: [react(), tailwindcss(), contentPlugin(path.resolve(import.meta.dirname, 'content'))],
  // Per-test limit above the 10 s each lazy screen may take to appear (tests/setup.ts),
  // so a slow CI runner fails on a real wait, not on a long click-through test.
  test: { setupFiles: ['tests/setup.ts'], testTimeout: 20_000 },
})
