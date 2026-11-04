// GitHub releases, as seen by this server (GET /api/release), shared by the
// pop-up prompt and Settings → Updates. Whoever fetches fresh info announces
// it, so both show the same state without waiting for their own next poll.

const EVENT = 'planner-release'

export class UpdateError extends Error {}

export async function fetchRelease({ refresh = false } = {}) {
  const res = await fetch(`/api/release${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' })
  if (!res.ok) throw new UpdateError(`${res.status}`)
  return announce(await res.json())
}

/** Ask the server's updater to deploy the latest release. */
export async function requestUpdate() {
  const res = await fetch('/api/release/update', { method: 'POST', cache: 'no-store' })
  const body = await res.json().catch(() => ({}))
  if (res.status === 501) throw new UpdateError('This server has no updater installed.')
  if (res.status === 409) {
    announce(body)
    throw new UpdateError('Already on the latest release.')
  }
  if (!res.ok && res.status !== 202) throw new UpdateError(body.error || `The server refused (${res.status}).`)
  return announce(body)
}

function announce(info) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: info }))
  return info
}

export function onRelease(fn) {
  const handler = (e) => fn(e.detail)
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}

export const isBusy = (info) => ['requested', 'updating'].includes(info?.updater?.state)

/** >0 when version a is newer than b ("0.10.0" > "0.9.1"). */
export function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '').replace(/^v/i, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}
