import { useEffect, useMemo, useState } from 'react'
import { ACTIVE_OWNERS, TIMELINE_START } from '../lib/model.js'
import { usePlan } from '../lib/store.jsx'
import { placeAt, shiftWorkdays, workdaysIn } from '../lib/schedule.js'
import { label } from '../lib/dates.js'

/**
 * Move many tasks at once: everyone's (or some people's) work from a date on,
 * by N of each owner's working days. A slip announced in a stand-up is one
 * action here, and one undo.
 */
export function Reschedule({ filter, onClose }) {
  const { tasks, dispatch } = usePlan()
  const today = new Date().toISOString().slice(0, 10)
  const [owners, setOwners] = useState(() => (filter.size ? new Set(filter) : new Set(ACTIVE_OWNERS.map((o) => o.id))))
  const [from, setFrom] = useState(today > TIMELINE_START ? today : TIMELINE_START)
  const [days, setDays] = useState(1)
  const [skipDone, setSkipDone] = useState(true)
  const [keepWeeks, setKeepWeeks] = useState(true)

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const affected = useMemo(
    () =>
      tasks
        .filter((t) => t.start && owners.has(t.owner) && t.start >= from && !(skipDone && t.done))
        .sort((a, b) => a.start.localeCompare(b.start))
        .map((t) => {
          const effortDays = workdaysIn(t.owner, t.start, t.end) || 1
          return { t, next: placeAt({ ...t, effortDays }, shiftWorkdays(t.owner, t.start, days)) }
        }),
    [tasks, owners, from, days, skipDone]
  )

  const toggle = (id) => {
    const next = new Set(owners)
    next.has(id) ? next.delete(id) : next.add(id)
    setOwners(next)
  }

  const apply = () => {
    dispatch({ type: 'reschedule', owners: [...owners], from, days: Number(days), skipDone, keepWeeks })
    onClose()
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="dialog">
        <header className="drawer-head">
          <h3>Reschedule</h3>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </header>
        <div className="drawer-body">
          <p className="muted small">
            Moves every matching task by a number of its owner's <b>working days</b>, keeping each task's length —
            holidays and leave are stepped over, never landed on.
          </p>
          <div className="field-row">
            <label className="field">
              <span>Tasks starting on or after</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="field">
              <span>Move by (working days, − for earlier)</span>
              <input type="number" value={days} onChange={(e) => setDays(Number(e.target.value) || 0)} />
            </label>
          </div>
          <div className="row wrap">
            <span className="muted small">People</span>
            {ACTIVE_OWNERS.map((o) => (
              <label key={o.id} className="checkbox">
                <input type="checkbox" checked={owners.has(o.id)} onChange={() => toggle(o.id)} />
                <span className="dot" style={{ background: o.color }} /> {o.name}
              </label>
            ))}
          </div>
          <label className="check-row">
            <input type="checkbox" checked={skipDone} onChange={() => setSkipDone(!skipDone)} />
            <span>Leave completed tasks where they are</span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={keepWeeks} onChange={() => setKeepWeeks(!keepWeeks)} />
            <span>Keep their planned weeks (so Redraw still follows the original plan)</span>
          </label>

          <h4>{affected.length} task(s) will move</h4>
          <ul className="preview-list">
            {affected.slice(0, 60).map(({ t, next }) => (
              <li key={t.id}>
                <span className="task-name">{t.title}</span>
                <span className="muted tiny">
                  {label(t.start)}–{label(t.end)} → <b>{label(next.start)}–{label(next.end)}</b>
                </span>
              </li>
            ))}
          </ul>
          <div className="row">
            <button className="ghost primary" disabled={!affected.length || !days} onClick={apply}>
              Move {affected.length} task(s)
            </button>
            <button className="ghost" onClick={onClose}>Cancel</button>
            <span className="muted tiny">Undo with Ctrl+Z.</span>
          </div>
        </div>
      </div>
    </>
  )
}
