// The store, over HTTP. Same origin in every deployment: nginx routes /api/ to
// plan-api, and `npm run dev` proxies it (see vite.config.js).

const base = '/api/plans'

export class Conflict extends Error {
  constructor(current) {
    super('version conflict')
    this.name = 'Conflict'
    this.current = current
  }
}

/** The stored plan, or null when the server has never seen it. */
export async function fetchPlan(planId, signal) {
  const res = await fetch(`${base}/${planId}`, { signal, headers: { accept: 'application/json' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${planId}: ${res.status}`)
  return res.json()
}

/**
 * Save against the version this client last saw. A 409 comes back carrying the
 * server's current document, which is what makes a merge possible.
 */
export async function savePlan(planId, { baseVersion, tasks, checkpoints, trash, meta }) {
  const res = await fetch(`${base}/${planId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseVersion, tasks, checkpoints, trash, meta }),
  })
  if (res.status === 409) {
    const body = await res.json()
    throw new Conflict(body.current)
  }
  if (!res.ok) throw new Error(`PUT ${planId}: ${res.status}`)
  return res.json()
}

/* ---- the sticky-note wall: one document for the whole project ---------- */

export async function fetchNotes(signal) {
  const res = await fetch('/api/notes', { signal, headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`GET notes: ${res.status}`)
  return res.json()
}

export async function saveNotes({ baseVersion, notes }) {
  const res = await fetch('/api/notes', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseVersion, notes }),
  })
  if (res.status === 409) {
    const body = await res.json()
    throw new Conflict(body.current)
  }
  if (!res.ok) throw new Error(`PUT notes: ${res.status}`)
  return res.json()
}

/* ---- the config document: the single source every plan is built from ---- */

/** { version, source: 'app' | 'file', updatedAt, config }, or null when no server answers. */
export async function fetchConfig(signal) {
  const res = await fetch('/api/config', { signal, headers: { accept: 'application/json' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET config: ${res.status}`)
  return res.json()
}

export async function saveConfig({ baseVersion, config }) {
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseVersion, config }),
  })
  if (res.status === 409) {
    const body = await res.json()
    throw new Conflict(body.current)
  }
  if (!res.ok) throw new Error(`PUT config: ${res.status} ${(await res.json().catch(() => ({}))).error || ''}`)
  return res.json()
}

/** Drop the in-app edit and go back to planner.config.json on disk. */
export async function revertConfig() {
  const res = await fetch('/api/config', { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE config: ${res.status}`)
  return res.json()
}
