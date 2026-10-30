// The plan store: one JSON document per plan, shared by everyone on the box.
//
// No dependencies and no database. Each plan is a single document that is small
// (tens of KB) and always read and written whole, so a file per plan is the
// honest shape — and `cat /data/lf3.json` is a complete backup.
//
//   GET  /api/health
//   GET  /api/docs           -> Swagger UI for this API
//   GET  /api/openapi.yaml   -> the OpenAPI 3 spec (server/openapi.yaml)
//   GET  /api/config         -> { version, source, updatedAt, config }
//   PUT  /api/config         -> { baseVersion, config }   (an in-app edit)
//   DELETE /api/config       -> back to the file on disk
//   GET  /api/plans/:id      -> { version, updatedAt, tasks, checkpoints, trash, meta }
//   PUT  /api/plans/:id      -> { baseVersion, tasks, checkpoints, trash, meta }
//   GET  /api/notes          -> { version, updatedAt, notes }
//   PUT  /api/notes          -> { baseVersion, notes }
//        200 with the new version, or 409 with the CURRENT document so the
//        client can merge rather than guess.
//
// The config is the single document every plan is built from. It starts as
// planner.config.json (PLANNER_CONFIG); an edit made in the app's Settings page
// is stored as config.json in the data dir and wins until it is reverted. Its
// version is a content hash, so editing the file on disk is noticed too.
//
// Notes are one wall for the whole project, not one per plan: a note about the
// wifi card is not about a scenario.
//
// Concurrency is a version integer, checked on every write. Last-write-wins
// would quietly drop whichever of two people saved first; a 409 that carries the
// current document lets the browser merge task by task and keep both edits.

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = process.env.PLAN_DATA_DIR || '/data'
const PORT = Number(process.env.PORT || 3000)
const MAX_BODY = 8 * 1024 * 1024
const CONFIG_FILE = resolve(process.env.PLANNER_CONFIG || 'planner.config.json')

// Plan ids come from the app's own list, but this is a filename, so it is
// validated rather than trusted.
const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/

const pathOf = (id) => join(DATA_DIR, `${id}.json`)

async function readDoc(id) {
  try {
    return JSON.parse(await readFile(pathOf(id), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// Write to a temp file and rename: a reader never sees a half-written document,
// and a crash mid-write leaves the previous version intact.
async function writeDoc(id, doc) {
  const tmp = `${pathOf(id)}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(doc))
  await rename(tmp, pathOf(id))
}

// One chain per plan, so two requests for the same plan cannot interleave their
// read-check-write. Node is single threaded, but `await` between the read and
// the write is exactly where a second request would slip in.
const chains = new Map()
function serialize(id, job) {
  const prev = chains.get(id) || Promise.resolve()
  const next = prev.then(job, job)
  chains.set(
    id,
    next.catch(() => {})
  )
  return next
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(Object.assign(new Error('body is not JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/** Read-check-write against the version the client last saw. */
async function put(res, id, body, build) {
  return serialize(id, async () => {
    const current = await readDoc(id)
    const version = current?.version ?? 0

    if (current && body.baseVersion !== version) {
      return send(res, 409, { error: 'version conflict', current })
    }

    const doc = { version: version + 1, updatedAt: new Date().toISOString(), ...build() }
    await writeDoc(id, doc)
    return send(res, 200, { version: doc.version, updatedAt: doc.updatedAt })
  })
}

/* ---- API docs ---- */

const SPEC_FILE = join(dirname(fileURLToPath(import.meta.url)), 'openapi.yaml')

// Swagger UI from a CDN, pointed at the spec next to it. Pinned, like the app's
// other dependencies, so the page cannot change under us.
const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Project planner API</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css" />
  <style>body { margin: 0; background: #fafafa; }</style>
</head>
<body>
  <div id="swagger"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: '/api/openapi.yaml', dom_id: '#swagger', deepLinking: true, tryItOutEnabled: false })
  </script>
</body>
</html>`

async function sendText(res, type, text) {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-cache' })
  res.end(text)
}

/* ---- the config document ---- */

const hashOf = (config) => createHash('sha1').update(JSON.stringify(config)).digest('hex').slice(0, 12)

async function currentConfig() {
  const override = await readDoc('config')
  if (override) return { version: hashOf(override.config), source: 'app', updatedAt: override.updatedAt, config: override.config }
  try {
    const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
    const { mtime } = await stat(CONFIG_FILE)
    return { version: hashOf(config), source: 'file', updatedAt: mtime.toISOString(), config }
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw Object.assign(new Error(`${CONFIG_FILE}: ${err.message}`), { status: 500 })
  }
}

async function handleConfig(req, res) {
  if (req.method === 'GET') {
    const cur = await currentConfig()
    return cur ? send(res, 200, cur) : send(res, 404, { error: `no config at ${CONFIG_FILE}` })
  }
  if (req.method === 'PUT') {
    const body = await readBody(req)
    const c = body.config
    // The app validates fully before saving; this only refuses what would
    // leave every browser unable to start.
    if (!c || typeof c !== 'object' || !Array.isArray(c.people) || !Array.isArray(c.tasks)) {
      return send(res, 400, { error: 'config must be an object with people and tasks lists' })
    }
    return serialize('config', async () => {
      const cur = await currentConfig()
      if (cur && body.baseVersion !== cur.version) return send(res, 409, { error: 'version conflict', current: cur })
      const updatedAt = new Date().toISOString()
      await writeDoc('config', { updatedAt, config: c })
      return send(res, 200, { version: hashOf(c), source: 'app', updatedAt })
    })
  }
  if (req.method === 'DELETE') {
    return serialize('config', async () => {
      await rm(pathOf('config'), { force: true })
      const cur = await currentConfig()
      return send(res, 200, cur || { version: null })
    })
  }
  res.writeHead(405, { Allow: 'GET, PUT, DELETE' })
  return res.end()
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  try {
    if (url.pathname === '/api/health') return send(res, 200, { ok: true })
    if (url.pathname === '/api/docs' || url.pathname === '/api/docs/') return sendText(res, 'text/html; charset=utf-8', DOCS_HTML)
    if (url.pathname === '/api/openapi.yaml') return sendText(res, 'application/yaml; charset=utf-8', await readFile(SPEC_FILE, 'utf8'))
    if (url.pathname === '/api/config') return await handleConfig(req, res)

    // The sticky-note wall: one document, same discipline as a plan.
    if (url.pathname === '/api/notes') {
      if (req.method === 'GET') {
        const doc = await readDoc('notes')
        return send(res, 200, doc || { version: 0, updatedAt: null, notes: [] })
      }
      if (req.method === 'PUT') {
        const body = await readBody(req)
        if (!Array.isArray(body.notes)) return send(res, 400, { error: 'notes must be an array' })
        return await put(res, 'notes', body, () => ({ notes: body.notes }))
      }
      res.writeHead(405, { Allow: 'GET, PUT' })
      return res.end()
    }

    const match = url.pathname.match(/^\/api\/plans\/([^/]+)$/)
    if (!match) return send(res, 404, { error: 'not found' })

    const id = decodeURIComponent(match[1])
    // "config" and "notes" are documents of their own, not plans.
    if (!VALID_ID.test(id) || id === 'config' || id === 'notes') return send(res, 400, { error: 'bad plan id' })

    if (req.method === 'GET') {
      const doc = await readDoc(id)
      // 404 rather than an empty plan: the browser holds the seed, and only it
      // knows how to build one from the docs.
      if (!doc) return send(res, 404, { error: 'no such plan' })
      return send(res, 200, doc)
    }

    if (req.method === 'PUT') {
      const body = await readBody(req)
      if (!Array.isArray(body.tasks)) return send(res, 400, { error: 'tasks must be an array' })

      return await put(res, id, body, () => ({
        tasks: body.tasks,
        checkpoints: body.checkpoints && typeof body.checkpoints === 'object' ? body.checkpoints : {},
        trash: Array.isArray(body.trash) ? body.trash : [],
        meta: body.meta && typeof body.meta === 'object' ? body.meta : null,
      }))
    }

    res.writeHead(405, { Allow: 'GET, PUT' })
    return res.end()
  } catch (err) {
    return send(res, err.status || 500, { error: err.message || 'server error' })
  }
})

await mkdir(DATA_DIR, { recursive: true })
server.listen(PORT, () => {
  console.log(`plan-api listening on :${PORT}, storing in ${DATA_DIR}, config from ${CONFIG_FILE}`)
})
