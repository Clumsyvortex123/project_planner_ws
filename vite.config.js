import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The plan store runs beside the app in every environment: nginx routes /api/
// to it in docker, and these proxies do the same for `npm run dev` and
// `npm run preview`. PLAN_API defaults to the server's own default port.
const api = process.env.PLAN_API || 'http://127.0.0.1:3000'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: false, proxy: { '/api': api } },
  preview: { port: 4173, proxy: { '/api': api } },
  build: {
    // Two pages, one model: the board, and the standalone availability page.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        availability: resolve(__dirname, 'availability/index.html'),
      },
    },
  },
})
