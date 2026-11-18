// The planner fleet's admin page: sign in, list the planners on this box, add
// and remove them, manage users. Dependency-free node, like server/index.mjs.
//
// It never touches Docker, nginx or certbot. Adding or removing a planner only
// writes a request file; planner-ctl.sh on the HOST (systemd: planner-fleet.path)
// does the work and reports back in status/<id>.json and logs/<id>.log.
//
// Roles
//   viewer  sees the planners and opens them
//   user    + adds planners, removes the ones they added
//   admin   + removes any planner, manages users, reads the activity log.
//            The user "admin" is the root account: it cannot be deleted or demoted.
//
// State in FLEET_HOME: users.json (scrypt hashes), activity.jsonl (who did what;
// the host appends the outcome of each job), planners.tsv (owner = 5th column).
//
//   POST   /api/login {username,password}   GET /api/me   POST /api/logout
//   POST   /api/me/password {current,password}
//   GET    /api/planners                    POST /api/planners {subdomain}       (user, admin)
//   DELETE /api/planners/:name              (admin, or the user who added it)
//   GET    /api/jobs   GET /api/jobs/:id
//   GET    /api/users  POST /api/users {username,password,role}                  (admin)
//   PATCH  /api/users/:name {role?,password?}   DELETE /api/users/:name          (admin)
//   GET    /api/activity?limit=200                                               (admin)
import { createServer } from 'node:http'
import { appendFile, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)
const HOME = process.env.FLEET_HOME || '/fleet'
const DOMAIN = process.env.FLEET_DOMAIN || ''
const PUBLIC_IP = process.env.PUBLIC_IP || ''
const ADMIN_HOST = (process.env.ADMIN_SITE || '').split('=')[0]
const ROOT = 'admin'
const BOOT_PASSWORD = process.env.FLEET_ADMIN_PASSWORD || ''
const PROTECTED = [process.env.FLEET_EDGE_CHECKOUT, process.env.FLEET_TEMPLATE].filter(Boolean).map((p) => resolve(p))
const HOSTNAME = process.env.FLEET_ADMIN_BIND || '127.0.0.1'
const PORT = Number(process.env.FLEET_ADMIN_PORT || 8090)
const SECURE_COOKIE = process.env.FLEET_COOKIE_SECURE !== 'false'
const SESSION_HOURS = 12
const PAGE = join(dirname(fileURLToPath(import.meta.url)), 'index.html')
const USERS = join(HOME, 'users.json')
const ACTIVITY = join(HOME, 'activity.jsonl')

if (!DOMAIN) { console.error('fleet-admin: set FLEET_DOMAIN'); process.exit(1) }

const ROLES = ['viewer', 'user', 'admin']
// The same rules as planner-ctl.sh's valid_label / valid_user; the host checks again.
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/
const JOB_ID = /^[A-Za-z0-9-]{1,64}$/
const MIN_PASSWORD = 8

// ---- users ----------------------------------------------------------------
async function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 32)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}
async function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const got = await scryptAsync(password, Buffer.from(salt, 'base64'), 32)
  return timingSafeEqual(got, Buffer.from(hash, 'base64'))
}
// Compared against when the username does not exist, so timing doesn't say which.
const DUMMY_HASH = await hashPassword(randomUUID())

let usersCache = null
async function loadUsers() {
  if (usersCache) return usersCache
  try { usersCache = JSON.parse(await readFile(USERS, 'utf8')) } catch { usersCache = { users: [] } }
  return usersCache
}
// One write at a time, temp file + rename.
let writing = Promise.resolve()
function saveUsers(doc) {
  usersCache = doc
  writing = writing.then(async () => {
    const tmp = `${USERS}.tmp`
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, USERS)
  })
  return writing
}
const publicUser = (u) => ({ username: u.username, role: u.role, createdAt: u.createdAt, createdBy: u.createdBy })

// The root account exists from the first start, with FLEET_ADMIN_PASSWORD.
// After that its password lives in users.json and is changed from the page.
{
  const doc = await loadUsers()
  if (!doc.users.some((u) => u.username === ROOT)) {
    if (BOOT_PASSWORD.length < MIN_PASSWORD) { console.error(`fleet-admin: set FLEET_ADMIN_PASSWORD (at least ${MIN_PASSWORD} characters) to create "${ROOT}"`); process.exit(1) }
    doc.users.unshift({ username: ROOT, role: 'admin', password: await hashPassword(BOOT_PASSWORD), createdAt: new Date().toISOString(), createdBy: 'setup' })
    await saveUsers(doc)
    console.log(`fleet-admin: created the root user "${ROOT}"`)
  }
}

// ---- sessions -------------------------------------------------------------
// In memory: a restart signs everyone out, which is fine for a handful of people.
const sessions = new Map() // token -> { username, expires }
function newSession(username) {
  const token = randomBytes(32).toString('base64url')
  sessions.set(token, { username, expires: Date.now() + SESSION_HOURS * 3600_000 })
  return token
}
function cookie(token, maxAge) {
  return `fleet_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`
}
function tokenOf(req) {
  const m = /(?:^|;\s*)fleet_session=([^;]+)/.exec(req.headers.cookie || '')
  return m ? m[1] : null
}
async function currentUser(req) {
  const token = tokenOf(req)
  const s = token && sessions.get(token)
  if (!s || s.expires < Date.now()) { if (token) sessions.delete(token); return null }
  // Re-read the role every time: a demotion or deletion takes effect at once.
  const u = (await loadUsers()).users.find((x) => x.username === s.username)
  if (!u) { sessions.delete(token); return null }
  return u
}
function endSessionsOf(username, except) {
  for (const [t, s] of sessions) if (s.username === username && t !== except) sessions.delete(t)
}

// Failed sign-ins: 10 per address per 15 minutes.
const failures = new Map()
const clientIp = (req) => String(req.headers['x-real-ip'] || req.socket.remoteAddress || '')
function blocked(ip) {
  const f = failures.get(ip)
  if (!f || f.until < Date.now()) { failures.delete(ip); return false }
  return f.count >= 10
}
function recordFailure(ip) {
  const f = failures.get(ip)
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 15 * 60_000 })
  else f.count++
}

// ---- activity log -----------------------------------------------------------
async function activity(req, user, action, target, result = 'ok', detail = '') {
  const line = { at: new Date().toISOString(), user: user || '-', action, target: target || '', result, detail, ip: req ? clientIp(req) : '', source: 'admin' }
  try { await appendFile(ACTIVITY, JSON.stringify(line) + '\n', { mode: 0o644 }) } catch (err) { console.error('activity log:', err.message) }
}
async function readActivity(limit) {
  let text = ''
  try { text = await readFile(ACTIVITY, 'utf8') } catch {}
  const lines = text.trimEnd().split('\n').filter(Boolean).slice(-limit)
  return lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse()
}

// ---- planners and jobs -----------------------------------------------------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}
async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}
async function registry() {
  let text = ''
  try { text = await readFile(join(HOME, 'planners.tsv'), 'utf8') } catch {}
  return text.split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
    .map((l) => {
      const [name, dir, port, host, owner] = l.split('\t')
      return { name, dir, port: Number(port), host, owner: owner || ROOT }
    })
}
async function healthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
    return r.ok && (await r.json()).ok === true
  } catch { return false }
}
async function jobs() {
  let names = []
  try { names = (await readdir(join(HOME, 'status'))).filter((f) => f.endsWith('.json')) } catch {}
  const list = (await Promise.all(names.map((f) => readJson(join(HOME, 'status', f))))).filter(Boolean)
  // Requests still waiting for the host have no status file yet.
  try {
    for (const f of await readdir(join(HOME, 'requests'))) {
      if (!f.endsWith('.json')) continue
      const r = await readJson(join(HOME, 'requests', f))
      if (r) list.push({ id: r.id, action: r.action, target: r.subdomain || r.name, requestedBy: r.requestedBy, state: 'queued', message: 'waiting for the host', at: r.requestedAt })
    }
  } catch {}
  for (const j of list) j.target ??= j.subdomain // jobs from before roles existed
  return list.sort((a, b) => String(b.at).localeCompare(String(a.at)))
}
async function queue(action, fields, user) {
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`
  const request = { id, action, ...fields, requestedBy: user.username, requestedAt: new Date().toISOString() }
  const tmp = join(HOME, 'requests', `.${id}.tmp`)
  await writeFile(tmp, JSON.stringify(request) + '\n')
  await rename(tmp, join(HOME, 'requests', `${id}.json`))
  return id
}
const busy = async (target) => (await jobs()).find((j) => j.target === target && (j.state === 'queued' || j.state === 'running'))

async function readBody(req) {
  let body = ''
  for await (const chunk of req) { body += chunk; if (body.length > 8192) throw new Error('too large') }
  return JSON.parse(body || '{}')
}

const can = {
  add: (u) => u.role === 'user' || u.role === 'admin',
  remove: (u, p) => u.role === 'admin' || (u.role === 'user' && p.owner === u.username),
  admin: (u) => u.role === 'admin',
}

// ---- handlers ---------------------------------------------------------------
async function login(req, res) {
  const ip = clientIp(req)
  if (blocked(ip)) return send(res, 429, { error: 'too many failed sign-ins; try again in 15 minutes' })
  let body
  try { body = await readBody(req) } catch { return send(res, 400, { error: 'bad request' }) }
  const username = String(body.username || '').trim().toLowerCase()
  const password = String(body.password || '')
  const u = (await loadUsers()).users.find((x) => x.username === username)
  const ok = await checkPassword(password, u ? u.password : DUMMY_HASH)
  if (!u || !ok) {
    recordFailure(ip)
    await activity(req, username || '-', 'login', '', 'failed')
    return send(res, 401, { error: 'wrong username or password' })
  }
  failures.delete(ip)
  await activity(req, u.username, 'login', '')
  send(res, 200, publicUser(u), { 'Set-Cookie': cookie(newSession(u.username), SESSION_HOURS * 3600) })
}

async function listPlanners(res) {
  const planners = await registry()
  await Promise.all(planners.map(async (p) => {
    p.healthy = await healthy(p.port)
    p.protected = PROTECTED.includes(resolve(p.dir))
    delete p.dir
  }))
  send(res, 200, { domain: DOMAIN, publicIp: PUBLIC_IP, planners })
}

async function addPlanner(req, res, user) {
  if (!can.add(user)) return send(res, 403, { error: 'viewers cannot add plans' })
  let sub
  try { sub = String((await readBody(req)).subdomain || '').trim().toLowerCase() } catch { return send(res, 400, { error: 'bad request' }) }
  if (sub.endsWith(`.${DOMAIN}`)) sub = sub.slice(0, -DOMAIN.length - 1)
  if (!LABEL.test(sub)) return send(res, 400, { error: 'use a-z, 0-9 and -, up to 63 characters, not starting or ending with -' })
  const host = `${sub}.${DOMAIN}`
  if (host === ADMIN_HOST) return send(res, 409, { error: `${host} is this admin page` })
  const existing = (await registry()).find((p) => p.name === sub || p.host === host)
  if (existing) return send(res, 409, { error: `${host} already exists (${existing.name})` })
  const pending = await busy(sub)
  if (pending) return send(res, 409, { error: `${host} is already being changed`, id: pending.id })
  const id = await queue('add', { subdomain: sub }, user)
  await activity(req, user.username, 'plan.add.requested', sub)
  send(res, 202, { id })
}

async function removePlanner(req, res, user, name) {
  const p = (await registry()).find((x) => x.name === name)
  if (!p) return send(res, 404, { error: 'no such plan' })
  if (!can.remove(user, p)) {
    await activity(req, user.username, 'plan.remove.denied', name, 'denied')
    return send(res, 403, { error: user.role === 'viewer' ? 'viewers cannot delete plans' : 'you can only delete plans you added' })
  }
  if (PROTECTED.includes(resolve(p.dir))) return send(res, 409, { error: `${name} runs the box's edge / is the template for new plans, so it cannot be deleted here` })
  const pending = await busy(name)
  if (pending) return send(res, 409, { error: `${name} is already being changed`, id: pending.id })
  const id = await queue('remove', { name }, user)
  await activity(req, user.username, 'plan.remove.requested', name)
  send(res, 202, { id })
}

function validPassword(pw) { return typeof pw === 'string' && pw.length >= MIN_PASSWORD && pw.length <= 200 }

async function createUser(req, res, admin) {
  let b
  try { b = await readBody(req) } catch { return send(res, 400, { error: 'bad request' }) }
  const username = String(b.username || '').trim().toLowerCase()
  if (!USERNAME.test(username)) return send(res, 400, { error: 'username: 2-32 of a-z, 0-9, . _ -, starting with a letter or digit' })
  if (!ROLES.includes(b.role)) return send(res, 400, { error: `role must be one of ${ROLES.join(', ')}` })
  if (!validPassword(b.password)) return send(res, 400, { error: `password: at least ${MIN_PASSWORD} characters` })
  const doc = await loadUsers()
  if (doc.users.some((u) => u.username === username)) return send(res, 409, { error: `${username} already exists` })
  const u = { username, role: b.role, password: await hashPassword(b.password), createdAt: new Date().toISOString(), createdBy: admin.username }
  await saveUsers({ ...doc, users: [...doc.users, u] })
  await activity(req, admin.username, 'user.create', username, 'ok', `role ${b.role}`)
  send(res, 201, publicUser(u))
}

async function updateUser(req, res, admin, name) {
  let b
  try { b = await readBody(req) } catch { return send(res, 400, { error: 'bad request' }) }
  const doc = await loadUsers()
  const u = doc.users.find((x) => x.username === name)
  if (!u) return send(res, 404, { error: 'no such user' })
  const changes = []
  if (b.role !== undefined && b.role !== u.role) {
    if (!ROLES.includes(b.role)) return send(res, 400, { error: `role must be one of ${ROLES.join(', ')}` })
    if (name === ROOT) return send(res, 409, { error: `"${ROOT}" is the root user and stays an admin` })
    changes.push(`role ${u.role} → ${b.role}`)
  }
  if (b.password !== undefined) {
    if (!validPassword(b.password)) return send(res, 400, { error: `password: at least ${MIN_PASSWORD} characters` })
    changes.push('password reset')
  }
  if (!changes.length) return send(res, 200, publicUser(u))
  const next = { ...u, ...(b.role !== undefined ? { role: b.role } : {}), ...(b.password !== undefined ? { password: await hashPassword(b.password) } : {}) }
  await saveUsers({ ...doc, users: doc.users.map((x) => (x.username === name ? next : x)) })
  if (b.password !== undefined && name !== admin.username) endSessionsOf(name)
  await activity(req, admin.username, 'user.update', name, 'ok', changes.join(', '))
  send(res, 200, publicUser(next))
}

async function deleteUser(req, res, admin, name) {
  if (name === ROOT) return send(res, 409, { error: `"${ROOT}" is the root user and cannot be deleted` })
  if (name === admin.username) return send(res, 409, { error: 'you cannot delete yourself' })
  const doc = await loadUsers()
  if (!doc.users.some((x) => x.username === name)) return send(res, 404, { error: 'no such user' })
  await saveUsers({ ...doc, users: doc.users.filter((x) => x.username !== name) })
  endSessionsOf(name)
  await activity(req, admin.username, 'user.delete', name)
  send(res, 200, { ok: true })
}

async function changeOwnPassword(req, res, user) {
  let b
  try { b = await readBody(req) } catch { return send(res, 400, { error: 'bad request' }) }
  if (!(await checkPassword(String(b.current || ''), user.password))) {
    await activity(req, user.username, 'password.change', user.username, 'failed', 'wrong current password')
    return send(res, 403, { error: 'current password is wrong' })
  }
  if (!validPassword(b.password)) return send(res, 400, { error: `new password: at least ${MIN_PASSWORD} characters` })
  const doc = await loadUsers()
  const hash = await hashPassword(b.password)
  await saveUsers({ ...doc, users: doc.users.map((x) => (x.username === user.username ? { ...x, password: hash } : x)) })
  endSessionsOf(user.username, tokenOf(req))
  await activity(req, user.username, 'password.change', user.username)
  send(res, 200, { ok: true })
}

// ---- routing ----------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname
    if (path === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' })
      return res.end(await readFile(PAGE))
    }
    // State-changing calls must be JSON: with SameSite=Strict that rules out
    // another site submitting a form on a signed-in browser's behalf.
    if (req.method !== 'GET' && req.method !== 'DELETE' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(res, 415, { error: 'send JSON' })
    }
    if (path === '/api/login' && req.method === 'POST') return await login(req, res)

    const user = await currentUser(req)
    if (!user) return send(res, 401, { error: 'sign in first' })

    if (path === '/api/me' && req.method === 'GET') return send(res, 200, publicUser(user))
    if (path === '/api/logout' && req.method === 'POST') {
      sessions.delete(tokenOf(req))
      await activity(req, user.username, 'logout', '')
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) })
    }
    if (path === '/api/me/password' && req.method === 'POST') return await changeOwnPassword(req, res, user)

    if (path === '/api/planners' && req.method === 'GET') return await listPlanners(res)
    if (path === '/api/planners' && req.method === 'POST') return await addPlanner(req, res, user)
    let m = /^\/api\/planners\/([^/]+)$/.exec(path)
    if (m && req.method === 'DELETE') {
      const name = decodeURIComponent(m[1])
      if (!LABEL.test(name)) return send(res, 404, { error: 'no such plan' })
      return await removePlanner(req, res, user, name)
    }

    if (path === '/api/jobs' && req.method === 'GET') return send(res, 200, { jobs: (await jobs()).slice(0, 20) })
    m = /^\/api\/jobs\/([^/]+)$/.exec(path)
    if (m && req.method === 'GET') {
      if (!JOB_ID.test(m[1])) return send(res, 404, { error: 'no such job' })
      const job = (await jobs()).find((j) => j.id === m[1])
      if (!job) return send(res, 404, { error: 'no such job' })
      let log = ''
      try { log = (await readFile(join(HOME, 'logs', `${m[1]}.log`), 'utf8')).slice(-20000) } catch {}
      return send(res, 200, { ...job, log })
    }

    // Everything below is for admins.
    if (path.startsWith('/api/users') || path === '/api/activity') {
      if (!can.admin(user)) return send(res, 403, { error: 'admins only' })
    }
    if (path === '/api/users' && req.method === 'GET') return send(res, 200, { users: (await loadUsers()).users.map(publicUser) })
    if (path === '/api/users' && req.method === 'POST') return await createUser(req, res, user)
    m = /^\/api\/users\/([^/]+)$/.exec(path)
    if (m) {
      const name = decodeURIComponent(m[1])
      if (!USERNAME.test(name)) return send(res, 404, { error: 'no such user' })
      if (req.method === 'PATCH') return await updateUser(req, res, user, name)
      if (req.method === 'DELETE') return await deleteUser(req, res, user, name)
    }
    if (path === '/api/activity' && req.method === 'GET') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 2000)
      return send(res, 200, { activity: await readActivity(limit) })
    }
    send(res, 404, { error: 'not found' })
  } catch (err) {
    console.error(err)
    send(res, 500, { error: 'internal error' })
  }
})

server.listen(PORT, HOSTNAME, () => console.log(`fleet-admin on ${HOSTNAME}:${PORT}, fleet home ${HOME}`))
