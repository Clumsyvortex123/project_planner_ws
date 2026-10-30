import { useState } from 'react'
import { ACTIVE_OWNERS as OWNERS, HOLIDAY_NAMES, HOLIDAY_SET, LEAVE_SETS, MONTHS, OWNER_BY_ID, markerDay } from '../lib/model.js'
import { usePlan, sortTasks } from '../lib/store.jsx'
import { isAvailable, isHoliday } from '../lib/schedule.js'
import { DOW_NAMES, MONTH_NAMES, addDays, dow, iso, parse } from '../lib/dates.js'

/** Open on this month if the plan covers it, else on its first month. */
function startMonth() {
  const today = new Date().toISOString().slice(0, 7)
  const i = MONTHS.findIndex(({ y, m }) => `${y}-${String(m).padStart(2, '0')}` === today)
  return i >= 0 ? i : 0
}

function gridFor(y, m) {
  const first = iso(y, m, 1)
  const lead = dow(first)
  const startKey = addDays(first, -lead)
  const days = []
  for (let i = 0; i < 42; i++) days.push(addDays(startKey, i))
  return days
}

export function Calendar({ filter, query, onOpen }) {
  const { tasks, plan, dispatch } = usePlan()
  const [idx, setIdx] = useState(startMonth)
  const marker = markerDay(plan)
  const { y, m } = MONTHS[idx]
  const days = gridFor(y, m)
  const [dragOver, setDragOver] = useState(null)

  const visible = sortTasks(
    tasks.filter(
      (t) =>
        (filter.size === 0 || filter.has(t.owner)) &&
        (!query || t.title.toLowerCase().includes(query.toLowerCase()))
    )
  )

  // Nothing is shown on a day its owner cannot work — a span that covers a week
  // crosses holidays, but no work happens on them.
  const tasksOn = (day) =>
    visible.filter((t) => t.start && t.start <= day && day <= t.end && isAvailable(t.owner, day))
  const leaveOn = (day) => OWNERS.filter((o) => LEAVE_SETS[o.id]?.has(day))

  return (
    <div className="calendar-wrap">
      <div className="subbar">
        <button className="icon-btn" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>←</button>
        <h3 className="month-title">{MONTH_NAMES[m - 1]} {y}</h3>
        <button className="icon-btn" disabled={idx === MONTHS.length - 1} onClick={() => setIdx(idx + 1)}>→</button>
        <span className="muted small">Drag a task chip onto a day to move it (its length is kept).</span>
        <div className="spacer" />
        <span className="legend"><i className="swatch holiday-sw" /> holiday</span>
        <span className="legend"><i className="swatch leave-sw" /> non-availability</span>
        {marker && <span className="legend"><i className="swatch gate-sw" /> {plan.marker.label}</span>}
      </div>

      <div className="cal-grid">
        {DOW_NAMES.map((d) => (
          <div key={d} className="cal-dow">{d}</div>
        ))}
        {days.map((day) => {
          const inMonth = parse(day).getUTCMonth() + 1 === m
          const hol = isHoliday(day)
          const named = HOLIDAY_SET.has(day)
          const items = tasksOn(day)
          const leave = leaveOn(day)
          return (
            <div
              key={day}
              className={`cal-cell${inMonth ? '' : ' muted-cell'}${hol ? ' holiday' : ''}${dragOver === day ? ' over' : ''}${marker === day ? ' marker-day' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(day)
              }}
              onDragLeave={() => setDragOver((d) => (d === day ? null : d))}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(null)
                const id = e.dataTransfer.getData('text/plain')
                if (id) dispatch({ type: 'shift', id, start: day })
              }}
            >
              <div className="cal-daynum">
                <span>{parse(day).getUTCDate()}</span>
                {named && <span className="tiny holiday-tag">{HOLIDAY_NAMES[day] || 'holiday'}</span>}
                {marker === day && <span className="tiny marker-tag">{plan.marker.label}</span>}
              </div>
              {leave.length > 0 && (
                <div className="leave-row">
                  {leave.map((o) => (
                    <span key={o.id} className="leave-tag" style={{ borderColor: o.color, color: o.color }}>
                      {o.name} off
                    </span>
                  ))}
                </div>
              )}
              <div className="cal-items">
                {items.slice(0, 4).map((t) => {
                  const o = OWNER_BY_ID[t.owner]
                  return (
                    <button
                      key={t.id}
                      className="cal-chip"
                      style={{ background: o.color, color: o.fg }}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)}
                      onClick={() => onOpen(t.id)}
                      title={`${t.title} (${t.start} → ${t.end})`}
                    >
                      {t.start === day ? '▶ ' : ''}{t.title}
                    </button>
                  )
                })}
                {items.length > 4 && <span className="tiny muted">+{items.length - 4} more</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
