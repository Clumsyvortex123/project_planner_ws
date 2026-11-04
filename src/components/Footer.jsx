import { useEffect, useState } from 'react'
import avatar from '../assets/clumsyvortex123.jpg'

const PROFILE = 'https://github.com/Clumsyvortex123'
const KEY = 'planner-footer-hidden'

// Indexed by Date#getDay() in the browser's own time zone (0 = Sunday).
const LINES = [
  'Clumsyvortex123 is resting. The tasks are not.',
  'Monday motivation, built by Clumsyvortex123. Backlog: infinite.',
  "Estimated: 2 weeks. Actual: ...we don't talk about it. Built by Clumsyvortex123",
  'Mid-sprint check-in: Clumsyvortex123 is still shipping, mostly.',
  'Clumsyvortex123 was here. (git blame confirms)',
  'Deployed on a Friday by Clumsyvortex123. Living dangerously.',
  'Side quest by Clumsyvortex123, now your main quest.',
]

/** Per-browser on/off switch for the footer, shared by the footer and Settings. */
export function useFooterPref() {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== '1'
    } catch {
      return true
    }
  })
  const set = (on) => {
    setShown(on)
    try {
      on ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, '1')
    } catch {
      /* storage blocked: applies to this visit only */
    }
  }
  return [shown, set]
}

export function Footer() {
  const [day, setDay] = useState(() => new Date().getDay())
  // Roll over at local midnight for tabs left open.
  useEffect(() => {
    const id = setInterval(() => setDay(new Date().getDay()), 60_000)
    return () => clearInterval(id)
  }, [])

  return (
    <footer className="credit">
      <a href={PROFILE} target="_blank" rel="noopener noreferrer" title="Clumsyvortex123 on GitHub">
        <img src={avatar} alt="" width="16" height="16" />
        <span>{LINES[day]}</span>
      </a>
    </footer>
  )
}
