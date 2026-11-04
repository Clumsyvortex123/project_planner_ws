import { useCallback, useEffect, useState } from 'react'
import { usePlan } from '../lib/store.jsx'

/** The build this tab is running (set by vite.config.js). */
export const RELEASE = typeof __PLANNER_RELEASE__ !== 'undefined' ? __PLANNER_RELEASE__ : { version: 'dev', build: 'dev' }

const BUILD_CHECK_MS = 60_000 // is a different build being served? (cheap, static file)
const RELEASE_CHECK_MS = 5 * 60_000 // is there a newer GitHub release? (server caches GitHub)
const BUSY_CHECK_MS = 5_000 // while the server is deploying one
const LATER_KEY = 'planner-update-later'

const session = {
  get(k) {
    try {
      return sessionStorage.getItem(k)
    } catch {
      return null
    }
  },
  set(k, v) {
    try {
      sessionStorage.setItem(k, v)
    } catch {
      /* private mode: it will just ask again */
    }
  },
}

async function getJson(url, init) {
  const res = await fetch(url, { cache: 'no-store', ...init })
  if (!res.ok && res.status !== 202) throw new Error(`${res.status}`)
  return res.json()
}

/**
 * Silent until there is something to update. Then it blurs the page and says
 * what, in this order of precedence:
 *   ready      a newer build is already being served here  → Reload
 *   updating   the server is deploying a release           → wait
 *   available  GitHub has a newer release than this server  → Update now / Later
 * "Later" hides it for that version only; the next one asks again.
 */
export function UpdatePrompt() {
  const { dirty } = usePlan()
  const [served, setServed] = useState(null) // /version.json
  const [release, setRelease] = useState(null) // /api/release
  const [later, setLater] = useState(() => session.get(LATER_KEY))
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')

  const checkBuild = useCallback(async () => {
    try {
      setServed(await getJson(`/version.json?t=${Date.now()}`))
    } catch {
      /* offline, or mid-deploy */
    }
  }, [])
  const checkRelease = useCallback(async () => {
    try {
      setRelease(await getJson('/api/release'))
    } catch {
      /* no API (static preview) or mid-deploy */
    }
  }, [])

  const updaterState = release?.updater?.state
  const busy = updaterState === 'updating' || updaterState === 'requested'

  useEffect(() => {
    checkBuild()
    checkRelease()
    const b = setInterval(checkBuild, busy ? BUSY_CHECK_MS : BUILD_CHECK_MS)
    const r = setInterval(checkRelease, busy ? BUSY_CHECK_MS : RELEASE_CHECK_MS)
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      checkBuild()
      checkRelease()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(b)
      clearInterval(r)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [checkBuild, checkRelease, busy])

  const dismiss = (key) => {
    session.set(LATER_KEY, key)
    setLater(key)
  }

  const requestUpdate = async () => {
    setAsking(true)
    setError('')
    try {
      setRelease(await getJson('/api/release/update', { method: 'POST' }))
    } catch (err) {
      setError(err.message === '501' ? 'This server has no updater installed.' : `The server refused (${err.message}).`)
      checkRelease()
    } finally {
      setAsking(false)
    }
  }

  const ready = served?.build && served.build !== RELEASE.build && served.build !== later
  const latest = release?.latest
  const available = release?.updateAvailable && release.updater?.enabled && latest && latest.version !== later
  const failedHere = updaterState === 'failed' && release?.updater?.target === latest?.version

  let card = null
  if (ready) {
    const same = served.version === RELEASE.version
    card = (
      <>
        <h3 id="update-title">A new version is ready</h3>
        <p className="muted small">
          {same ? `A new build of v${served.version} is live` : `v${RELEASE.version} → v${served.version}`}
          {served.builtAt ? ` (${new Date(served.builtAt).toLocaleString()})` : ''}. Reload to use it — your plan is saved on
          the server and nothing is lost.
        </p>
        <div className="row">
          <button className="ghost" onClick={() => dismiss(served.build)}>Later</button>
          <button className="ghost primary" disabled={dirty} onClick={() => window.location.reload()}>
            {dirty ? 'Saving…' : 'Reload now'}
          </button>
        </div>
      </>
    )
  } else if (busy && later !== `busy-${release.updater.target}`) {
    card = (
      <>
        <h3 id="update-title">Updating to v{release.updater.target}…</h3>
        <p className="muted small">
          The server is installing the new release ({release.updater.message || 'starting'}). This takes a few minutes; the
          board keeps working, and you'll be offered a reload when it's done.
        </p>
        <div className="update-progress" aria-hidden="true"><span /></div>
        <div className="row">
          <button className="ghost" onClick={() => dismiss(`busy-${release.updater.target}`)}>Hide</button>
        </div>
      </>
    )
  } else if (available) {
    card = (
      <>
        <h3 id="update-title">v{latest.version} is available</h3>
        <p className="muted small">
          {latest.name && latest.name !== latest.tag ? `${latest.name} · ` : ''}
          Released {new Date(latest.publishedAt).toLocaleDateString()}. This planner runs v{release.current}.{' '}
          <a href={latest.url} target="_blank" rel="noopener noreferrer">Release notes ↗</a>
        </p>
        {latest.notes && <pre className="update-notes">{latest.notes}</pre>}
        {failedHere && (
          <p className="warn small">The last attempt failed: {release.updater.message}. The previous version is still running.</p>
        )}
        {error && <p className="warn small">{error}</p>}
        <p className="muted tiny">Updating installs it on the server for everyone. Boards keep working while it builds.</p>
        <div className="row">
          <button className="ghost" onClick={() => dismiss(latest.version)}>Later</button>
          <button className="ghost primary" disabled={asking} onClick={requestUpdate}>
            {asking ? 'Starting…' : failedHere ? 'Try again' : 'Update now'}
          </button>
        </div>
      </>
    )
  }

  if (!card) return null
  return (
    <div className="update-veil" role="dialog" aria-modal="true" aria-labelledby="update-title">
      <div className="update-card">{card}</div>
    </div>
  )
}
