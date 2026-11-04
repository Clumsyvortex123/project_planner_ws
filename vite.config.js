import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The plan store runs beside the app in every environment: nginx routes /api/
// to it in docker, and these proxies do the same for `npm run dev` and
// `npm run preview`. PLAN_API defaults to the server's own default port.
const api = process.env.PLAN_API || 'http://127.0.0.1:3000'

// Every build gets an id. It is baked into the bundle and also written to
// /version.json; an open tab polls that file and offers to reload when the id
// it finds is not its own (src/components/UpdatePrompt.jsx).
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'))
const release = {
  version: pkg.version,
  build: process.env.PLANNER_BUILD_ID || `${pkg.version}-${Date.now().toString(36)}`,
  builtAt: new Date().toISOString(),
}

function releaseFile() {
  const body = JSON.stringify(release) + '\n'
  return {
    name: 'planner-release',
    // Dev server: answer with the running build, so dev never prompts.
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(body)
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: body })
    },
  }
}

export default defineConfig({
  plugins: [react(), releaseFile()],
  define: { __PLANNER_RELEASE__: JSON.stringify(release) },
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
