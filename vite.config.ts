import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { contentPlugin } from './vite-plugin-content.ts'

// https://vite.dev/config/
export default defineConfig({
  base: './', // relative asset paths, so the build works under GitHub Pages' /incident_quest_game/
  plugins: [react(), tailwindcss(), contentPlugin(path.resolve(import.meta.dirname, 'content'))],
})
