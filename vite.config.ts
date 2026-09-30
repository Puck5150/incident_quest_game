import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { contentPlugin } from './vite-plugin-content.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), contentPlugin(path.resolve(import.meta.dirname, 'content'))],
})
