import { useMemo, useState } from 'react'
import { ACTIVE_OWNERS as OWNERS, FLAGS, LEAVE_SETS, OWNER_BY_ID, markerDay } from '../lib/model.js'
import { usePlan, sortTasks } from '../lib/store.jsx'
import { OwnerFilter } from '../components/OwnerFilter.jsx'
import {
  TIMELINE_DAYS,
  TIMELINE_START,
  durationOf,
  effortDaysOf,
  isAvailable,
  isHoliday,
  segmentsOf,
} from '../lib/schedule.js'
import { MONTH_NAMES, diffDays, label, parse } from '../lib/dates.js'

const ZOOMS = [11, 16, 24]

/** Put a bar's label on its widest segment, clipped so it never crosses a gap. */
function labelBox(task, dayW) {
  const segs = segmentsOf(task)
  if (!segs.length) return undefined
  const widest = segs.reduce((a, b) => (diffDays(b.start, b.end) > diffDays(a.start, a.end) ? b : a))
  return {
    left: diffDays(task.start, widest.start) * dayW + 5,
    width: (diffDays(widest.start, widest.end) + 1) * dayW - 10,
  }
}

/** Stack bars into as few sub-rows as their overlaps allow (usually one). */
function packRows(list) {
  const rows = []
  for (const t of [...list].sort((a, b) => a.start.localeCompare(b.start))) {
    const row = rows.find((r) => r[r.length - 1].end < t.start)
    if (row) row.push(t)
    else rows.push([t])
  }
  return rows
}

function monthBands(days, dayW) {
  const bands = []
  for (const d of days) {
    const m = Number(d.slice(5, 7))
    const last = bands[bands.length - 1]
    if (last && last.m === m) last.span += 1
    else bands.push({ m, span: 1 })
  }
  return bands.map((b) => ({ ...b, width: b.span * dayW }))
}

export function LeaveFirst({ filter, setFilter, query, onOpen }) {
  const { tasks, plan, dispatch } = usePlan()
  const [zoom, setZoom] = useState(1)
  const dayW = ZOOMS[zoom]
  const days = TIMELINE_DAYS
  const totalW = days.length * dayW
  const bands = useMemo(() => monthBands(days, dayW), [days, dayW])
  const gate = markerDay(plan)
  const gateLeft = gate ? diffDays(TIMELINE_START, gate) * dayW : null

  const shown = (ownerId) => filter.size === 0 || filter.has(ownerId)
  const matches = (t) => !query || t.title.toLowerCase().includes(query.toLowerCase())

  const unscheduled = sortTasks(tasks.filter((t) => !t.start && matches(t)))

  const lanes = OWNERS.map((o) => {
    const mine = tasks.filter((t) => t.owner === o.id)
    const scheduled = mine.filter((t) => t.start && matches(t))
    const ends = scheduled.map((t) => t.end).sort()
    return {
      owner: o,
      all: mine,
      scheduled,
      rows: packRows(scheduled),
      lastDay: ends[ends.length - 1] || null,
      waiting: mine.filter((t) => !t.start).length,
    }
  }).filter((l) => l.all.length > 0)

  const dropDay = (e, track) => {
    const box = track.getBoundingClientRect()
    const i = Math.floor((e.clientX - box.left) / dayW)
    return days[Math.max(0, Math.min(days.length - 1, i))]
  }

  const onDropInLane = (e, ownerId) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    if (!id) return
    dispatch({ type: 'place', id, day: dropDay(e, e.currentTarget), owner: ownerId })
  }

  return (
    <div className="lf-wrap">
      <div className="subbar">
        <button className="ghost" onClick={() => dispatch({ type: 'autofill' })}>
          Redraw from the plan
        </button>
        <button
          className="ghost"
          onClick={() => confirm('Take the dates off every task and start from availability?') && dispatch({ type: 'clear-dates' })}
        >
          Clear all dates
        </button>
        <span className="muted small">Zoom</span>
        <div className="seg">
          {['S', 'M', 'L'].map((z, i) => (
            <button key={z} className={zoom === i ? 'on' : ''} onClick={() => setZoom(i)}>{z}</button>
          ))}
        </div>
        <div className="spacer" />
        <span className="legend"><i className="swatch holiday-sw" /> holiday</span>
        <span className="legend"><i className="swatch leave-sw" /> unavailable</span>
        {gate && <span className="legend"><i className="swatch gate-sw" /> {plan.marker.label} ({label(gate)})</span>}
      </div>

      <div className="subbar">
        <OwnerFilter filter={filter} setFilter={setFilter} label="Show tasks for" />
        <div className="spacer" />
        <span className="muted small">
          The plan's order, week by week, worth a full week each; leave pushes a week later and everything
          after it with it. Drag a task onto a lane to plan it by hand (another person's lane hands it over), or
          onto the tray to take its dates off.
        </span>
      </div>

      <div className="lf-body">
        <aside
          className={`tray${unscheduled.length ? '' : ' empty-tray'}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const id = e.dataTransfer.getData('text/plain')
            if (id) dispatch({ type: 'unschedule', id })
          }}
        >
          <header>
            <h3>Not scheduled</h3>
            <span className="count">{unscheduled.length}</span>
          </header>
          {unscheduled.length === 0 && (
            <p className="muted tiny tray-hint">
              Every task has a home. Drag a bar back here to free it up, or use <b>Clear all dates</b> to
              start from a blank calendar and <b>Redraw from the plan</b> to put them all back.
            </p>
          )}
          {unscheduled.map((t) => {
            const o = OWNER_BY_ID[t.owner]
            return (
              <article
                key={t.id}
                className="tray-card"
                style={{ '--owner': o?.color }}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)}
                onClick={() => onOpen(t.id)}
              >
                <div className="row tiny">
                  <span className="chip chip-sm" style={{ background: o?.color, color: o?.fg }}>{o?.name}</span>
                  <span className="muted">{effortDaysOf(t)}d</span>
                  {(t.flags || []).map((f) => <span key={f} className="pill">{FLAGS[f]?.label || f}</span>)}
                </div>
                <h4>{t.title}</h4>
              </article>
            )
          })}
        </aside>

        <div className="lf-scroll">
          <div className="lf-inner" style={{ '--track': `${totalW}px` }}>
            <div className="grow head-row">
              <div className="side head-side">Availability</div>
              <div className="track">
                <div className="band-row">
                  {bands.map((b, i) => (
                    <div key={i} className="band" style={{ width: b.width }}>{MONTH_NAMES[b.m - 1]}</div>
                  ))}
                </div>
                <div className="day-row">
                  {days.map((d) => (
                    <div key={d} className={`day${isHoliday(d) ? ' holiday' : ''}`} style={{ width: dayW }}>
                      <span>{parse(d).getUTCDate()}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {lanes.map((lane) => {
              const o = lane.owner
              const visible = shown(o.id)
              return (
                <section key={o.id} className="lf-lane">
                  <div className="grow lane-head">
                    <div className="side">
                      <span className="dot" style={{ background: o.color }} />
                      <strong>{o.name}</strong>
                      <span className="spacer" />
                      <span className="muted tiny">
                        {lane.scheduled.length} tasks
                        {lane.waiting ? ` · ${lane.waiting} waiting` : ''}
                      </span>
                    </div>
                    <div
                      className="track avail-track"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => onDropInLane(e, o.id)}
                    >
                      {days.map((d, i) => {
                        const hol = isHoliday(d)
                        const off = LEAVE_SETS[o.id]?.has(d)
                        return (
                          <div
                            key={d}
                            className={`avail${hol ? ' holiday' : ''}${off ? ' leave' : ''}`}
                            style={{ left: i * dayW, width: dayW }}
                            title={`${label(d)} · ${hol ? 'holiday' : off ? `${o.name} unavailable` : 'available'}`}
                          />
                        )
                      })}
                      {gate && <div className="gate" style={{ left: gateLeft }} title={`${plan.marker.label} ${label(gate)}`} />}
                      <span className="lane-end muted tiny" style={{ left: 4 }}>
                        {lane.lastDay ? `ends ${label(lane.lastDay)}` : 'nothing scheduled'}
                      </span>
                    </div>
                  </div>

                  {visible &&
                    lane.rows.map((row, ri) => (
                      <div className="grow" key={ri}>
                        <div className="side sub-side muted tiny">
                          {ri === 0 ? (lane.rows.length > 1 ? `${lane.rows.length} in parallel` : 'tasks') : ''}
                        </div>
                        <div
                          className="track bar-track"
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => onDropInLane(e, o.id)}
                        >
                          {days.map((d, i) =>
                            isAvailable(o.id, d) ? null : (
                              <div
                                key={d}
                                className={`avail thin${isHoliday(d) ? ' holiday' : ' leave'}`}
                                style={{ left: i * dayW, width: dayW }}
                              />
                            )
                          )}
                          {gate && <div className="gate" style={{ left: gateLeft }} />}
                          {row.map((t) => (
                            <div
                              key={t.id}
                              className="lf-bar split"
                              style={{
                                left: diffDays(TIMELINE_START, t.start) * dayW,
                                width: durationOf(t) * dayW - 2,
                                color: o.fg,
                              }}
                              draggable
                              onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)}
                              onClick={() => onOpen(t.id)}
                              title={`${t.title}\n${effortDaysOf(t)} working days · ${t.start} → ${t.end}\nClick to open, drag to replan`}
                            >
                              {segmentsOf(t).map((s) => (
                                <span
                                  key={s.start}
                                  className="bar-seg"
                                  style={{
                                    left: diffDays(t.start, s.start) * dayW,
                                    width: (diffDays(s.start, s.end) + 1) * dayW - 1,
                                    background: o.color,
                                  }}
                                />
                              ))}
                              <span className="bar-label" style={labelBox(t, dayW)}>
                                {t.title}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                </section>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
