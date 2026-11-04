import { useCallback, useEffect, useState } from 'react'
import { usePlan } from '../lib/store.jsx'

/** The build this tab is running (set by vite.config.js). */
export const RELEASE = typeof __PLANNER_RELEASE__ !== 'undefined' ? __PLANNER_RELEASE__ : { version: 'dev', build: 'dev' }

const CHECK_MS = 60_000
const LATER_KEY = 'planner-update-later'

function laterFor() {
  try {
    return sessionStorage.getItem(LATER_KEY)
  } catch {
    return null
  }
}

/**
 * Silent until a newer build is deployed. Then it blurs the page and offers a
 * reload. "Later" hides it for that release only; the next one asks again.
 */
export function UpdatePrompt() {
  const { dirty } = usePlan()
  const [next, setNext] = useState(null)

  const check = useCallback(async () => {
    try {
      const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) return
      const live = await res.json()
      if (live?.build && live.build !== RELEASE.build && live.build !== laterFor()) setNext(live)
    } catch {
      // Offline or not deployed with a version file: say nothing.
    }
  }, [])

  useEffect(() => {
    check()
    const id = setInterval(check, CHECK_MS)
    const onVisible = () => document.visibilityState === 'visible' && check()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [check])

  if (!next) return null

  const later = () => {
    try {
      sessionStorage.setItem(LATER_KEY, next.build)
    } catch {
      /* private mode: it will just ask again next check */
    }
    setNext(null)
  }

  const sameNumber = next.version === RELEASE.version
  return (
    <div className="update-veil" role="dialog" aria-modal="true" aria-labelledby="update-title">
      <div className="update-card">
        <h3 id="update-title">A new version is available</h3>
        <p className="muted small">
          {sameNumber ? `A new build of v${next.version} was released` : `v${RELEASE.version} → v${next.version}`}
          {next.builtAt ? ` (${new Date(next.builtAt).toLocaleString()})` : ''}. Reload to get it — your plan is
          saved on the server and nothing is lost.
        </p>
        <div className="row">
          <button className="ghost" onClick={later}>Later</button>
          <button className="ghost primary" disabled={dirty} onClick={() => window.location.reload()}>
            {dirty ? 'Saving…' : 'Update now'}
          </button>
        </div>
      </div>
    </div>
  )
}
