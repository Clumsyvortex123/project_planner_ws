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
//   GET  /api/release        -> { current, latest, updater }   (GitHub releases)
//   POST /api/release/update -> asks the host updater to deploy the latest release
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
// Releases are read from GitHub; deploying one is the host updater's job
// (devops/updater/), which watches UPDATE_DIR. No updater, no update button.
const RELEASE_REPO = process.env.RELEASE_REPO || 'Clumsyvortex123/project_planner_ws'
const UPDATE_DIR = process.env.UPDATE_DIR || '/updates'
const RELEASE_TTL_MS = Number(process.env.RELEASE_TTL_MS || 10 * 60 * 1000)
const HERE = dirname(fileURLToPath(import.meta.url))

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

const SPEC_FILE = join(HERE, 'openapi.yaml')

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

/* ---- releases -------------------------------------------------------------
 * The version this server runs is the package.json it was built from. The
 * newest release is GitHub's "latest" (published, not a draft or prerelease),
 * cached so a room full of open tabs costs one GitHub call per TTL.
 */

let runningVersion = null
async function currentVersion() {
  if (runningVersion) return runningVersion
  for (const p of [join(HERE, '..', 'package.json'), resolve('package.json')]) {
    try {
      runningVersion = JSON.parse(await readFile(p, 'utf8')).version
      return runningVersion
    } catch {
      /* try the next */
    }
  }
  return null
}

const cleanVersion = (tag) => String(tag || '').replace(/^v/i, '')
/** Semver-ish compare of "1.2.3": >0 when a is newer. Non-numeric parts compare as 0. */
export function compareVersions(a, b) {
  const pa = cleanVersion(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  const pb = cleanVersion(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

let releaseCache = { at: 0, latest: null, error: null }
async function latestRelease() {
  if (Date.now() - releaseCache.at < RELEASE_TTL_MS) return releaseCache
  try {
    const r = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'project-planner-release-check' },
      signal: AbortSignal.timeout(8000),
    })
    if (r.status === 404) releaseCache = { at: Date.now(), latest: null, error: null } // no releases yet
    else if (!r.ok) throw new Error(`GitHub answered ${r.status}`)
    else {
      const j = await r.json()
      releaseCache = {
        at: Date.now(),
        error: null,
        latest: {
          tag: j.tag_name,
          version: cleanVersion(j.tag_name),
          name: j.name || j.tag_name,
          url: j.html_url,
          publishedAt: j.published_at,
          notes: String(j.body || '').slice(0, 4000),
        },
      }
    }
  } catch (err) {
    // Keep the last good answer; try again after a short pause, not every request.
    releaseCache = { ...releaseCache, at: Date.now() - RELEASE_TTL_MS + 60_000, error: err.message }
  }
  return releaseCache
}

/** The host updater's own report, or null when no updater is installed. */
async function updaterStatus() {
  let status
  try {
    status = JSON.parse(await readFile(join(UPDATE_DIR, 'status.json'), 'utf8'))
  } catch {
    return null
  }
  // Asked for, but the updater has not picked it up yet.
  if (status.state !== 'updating') {
    try {
      const req = JSON.parse(await readFile(join(UPDATE_DIR, 'request.json'), 'utf8'))
      return { ...status, state: 'requested', target: req.version, message: 'waiting for the updater to start' }
    } catch {
      /* no pending request */
    }
  }
  return status
}

async function releaseInfo() {
  const [current, rel, updater] = await Promise.all([currentVersion(), latestRelease(), updaterStatus()])
  const latest = rel.latest
  return {
    repo: RELEASE_REPO,
    current,
    latest,
    updateAvailable: !!(latest && current && compareVersions(latest.version, current) > 0),
    error: rel.error,
    updater: updater ? { enabled: true, ...updater } : { enabled: false },
  }
}

async function handleRelease(req, res, url) {
  if (url.pathname === '/api/release' && req.method === 'GET') return send(res, 200, await releaseInfo())
  if (url.pathname === '/api/release/update' && req.method === 'POST') {
    const info = await releaseInfo()
    if (!info.updater.enabled) return send(res, 501, { error: 'no updater is installed on this server' })
    if (!info.updateAvailable) return send(res, 409, { error: 'already on the latest release', ...info })
    if (info.updater.state === 'updating' || info.updater.state === 'requested') return send(res, 202, info)
    // Only a nudge: the updater re-reads GitHub itself and deploys whatever is
    // latest there, so nothing in this request decides what code runs.
    const request = { requestedAt: new Date().toISOString(), version: info.latest.version, site: req.headers.host || null }
    const tmp = join(UPDATE_DIR, `request.json.${process.pid}.tmp`)
    await writeFile(tmp, JSON.stringify(request) + '\n')
    await rename(tmp, join(UPDATE_DIR, 'request.json'))
    return send(res, 202, await releaseInfo())
  }
  res.writeHead(405, { Allow: url.pathname === '/api/release' ? 'GET' : 'POST' })
  return res.end()
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  try {
    if (url.pathname === '/api/health') return send(res, 200, { ok: true })
    if (url.pathname === '/api/docs' || url.pathname === '/api/docs/') return sendText(res, 'text/html; charset=utf-8', DOCS_HTML)
    if (url.pathname === '/api/openapi.yaml') return sendText(res, 'application/yaml; charset=utf-8', await readFile(SPEC_FILE, 'utf8'))
    if (url.pathname === '/api/config') return await handleConfig(req, res)
    if (url.pathname === '/api/release' || url.pathname === '/api/release/update') return await handleRelease(req, res, url)

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
