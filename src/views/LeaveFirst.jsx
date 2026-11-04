import { useEffect, useMemo, useRef, useState } from 'react'
import { ACTIVE_OWNERS as OWNERS, FLAGS, HOLIDAY_NAMES, HOLIDAY_SET, LEAVE_SETS, OWNER_BY_ID, WORKDAYS, markerDay } from '../lib/model.js'
import { usePlan, sortTasks } from '../lib/store.jsx'
import { useConfig } from '../lib/config.jsx'
import { applyDaysOff, draftSize, emptyDraft } from '../lib/daysOff.js'
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
import { MONTH_NAMES, diffDays, dow, label, parse, range } from '../lib/dates.js'

const ZOOMS = [11, 16, 24]

// Saving the config rebuilds the whole app; these carry the editor across it.
const EDIT_KEY = 'planner-lf-editing'
const SCROLL_KEY = 'planner-lf-scroll'
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
      v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v)
    } catch {
      /* storage blocked: the editor just closes after a save */
    }
  },
}

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

const isWorkday = (d) => WORKDAYS.has(dow(d))

export function LeaveFirst({ filter, setFilter, query, onOpen }) {
  const { tasks, plan, dispatch } = usePlan()
  const cfg = useConfig()
  const [zoom, setZoom] = useState(1)
  const dayW = ZOOMS[zoom]
  const days = TIMELINE_DAYS
  const totalW = days.length * dayW
  const bands = useMemo(() => monthBands(days, dayW), [days, dayW])
  const gate = markerDay(plan)
  const gateLeft = gate ? diffDays(TIMELINE_START, gate) * dayW : null

  /* ---- days-off editor ---------------------------------------------------- */

  const [editing, setEditing] = useState(() => session.get(EDIT_KEY) === '1')
  const [draft, setDraft] = useState(emptyDraft)
  const [paint, setPaint] = useState(null) // { kind: 'holiday' | 'leave', pid, value, anchor, cur }
  const [holidayName, setHolidayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const scroller = useRef(null)
  const changes = draftSize(draft)

  // Back from a save: same place on the timeline.
  useEffect(() => {
    const left = session.get(SCROLL_KEY)
    if (left && scroller.current) scroller.current.scrollLeft = Number(left)
    session.set(SCROLL_KEY, null)
  }, [])

  const savedHoliday = (d) => HOLIDAY_SET.has(d)
  const savedLeave = (pid, d) => !!LEAVE_SETS[pid]?.has(d)
  const draftHoliday = (d) => (draft.holidays.has(d) ? draft.holidays.get(d) !== null : savedHoliday(d))
  const draftLeave = (pid, d) => (draft.leave[pid]?.has(d) ? draft.leave[pid].get(d) : savedLeave(pid, d))

  const editable = (kind, pid, d) => isWorkday(d) && (kind === 'holiday' || !draftHoliday(d))
  const painted = (kind, pid, d) => {
    if (!paint || paint.kind !== kind || paint.pid !== pid) return undefined
    const [a, b] = paint.anchor <= paint.cur ? [paint.anchor, paint.cur] : [paint.cur, paint.anchor]
    return d >= a && d <= b && editable(kind, pid, d) ? paint.value : undefined
  }
  /** What a cell shows right now: saved, plus the draft, plus the drag in progress. */
  const holidayShown = (d) => painted('holiday', null, d) ?? draftHoliday(d)
  const leaveShown = (pid, d) => painted('leave', pid, d) ?? draftLeave(pid, d)

  const dayAt = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    const i = Math.floor((e.clientX - box.left) / dayW)
    return days[Math.max(0, Math.min(days.length - 1, i))]
  }

  const startPaint = (e, kind, pid = null) => {
    if (!editing || e.button !== 0) return
    const d = dayAt(e)
    if (!editable(kind, pid, d)) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const on = kind === 'holiday' ? draftHoliday(d) : draftLeave(pid, d)
    setPaint({ kind, pid, value: !on, anchor: d, cur: d })
  }
  const movePaint = (e) => {
    if (!paint) return
    const d = dayAt(e)
    if (d !== paint.cur) setPaint((p) => ({ ...p, cur: d }))
  }
  const endPaint = () => {
    if (!paint) return
    const { kind, pid, value, anchor, cur } = paint
    const span = range(anchor <= cur ? anchor : cur, anchor <= cur ? cur : anchor).filter((d) => editable(kind, pid, d))
    setDraft((dr) => {
      const next = { holidays: new Map(dr.holidays), leave: { ...dr.leave } }
      if (kind === 'holiday') {
        for (const d of span) {
          if (value === savedHoliday(d)) next.holidays.delete(d)
          else next.holidays.set(d, value ? holidayName.trim() : null)
        }
      } else {
        const m = new Map(next.leave[pid] || [])
        for (const d of span) value === savedLeave(pid, d) ? m.delete(d) : m.set(d, value)
        next.leave[pid] = m
      }
      return next
    })
    setPaint(null)
  }

  const stopEditing = () => {
    if (changes && !confirm(`Discard ${changes} unsaved change${changes === 1 ? '' : 's'} to days off?`)) return
    setDraft(emptyDraft())
    setEditing(false)
    setMessage('')
    session.set(EDIT_KEY, null)
  }
  const startEditing = () => {
    setEditing(true)
    session.set(EDIT_KEY, '1')
  }

  const save = async () => {
    setBusy(true)
    setMessage('')
    try {
      const { model } = cfg.validate(cfg.raw)
      const next = applyDaysOff(cfg.raw, model, draft)
      session.set(SCROLL_KEY, String(scroller.current?.scrollLeft || 0))
      await cfg.save(next) // rebuilds the app on the new calendar
    } catch (err) {
      session.set(SCROLL_KEY, null)
      setMessage(err.errors ? err.errors.join('; ') : err.message)
      setBusy(false)
    }
  }

  /* ---- lanes -------------------------------------------------------------- */

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
  }).filter((l) => l.all.length > 0 || editing)

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

  const offCount = (pid) => days.filter((d) => isWorkday(d) && !draftHoliday(d) && draftLeave(pid, d)).length

  return (
    <div className={`lf-wrap${editing ? ' lf-editing' : ''}`}>
      {editing ? (
        <div className="subbar edit-bar">
          <strong>Editing days off</strong>
          <span className="muted small">
            Drag across a person's lane to mark leave, or across the dates to mark a holiday for everyone. Drag over
            marked days to clear them.
          </span>
          <div className="spacer" />
          <label className="row small">
            <span className="muted">New holidays are called</span>
            <input className="holiday-name" value={holidayName} onChange={(e) => setHolidayName(e.target.value)} placeholder="e.g. Diwali" />
          </label>
          <span className="muted small">{changes ? `${changes} change${changes === 1 ? '' : 's'}` : 'no changes'}</span>
          <button className="ghost" disabled={!changes || busy} onClick={() => setDraft(emptyDraft())}>Undo all</button>
          <button
            className="ghost primary"
            disabled={!changes || busy || cfg.source === 'bundled'}
            title={cfg.source === 'bundled' ? 'No server reachable — nothing can be saved' : 'Writes these days into the shared configuration'}
            onClick={save}
          >
            {busy ? 'Saving…' : 'Save for everyone'}
          </button>
          <button className="ghost" disabled={busy} onClick={stopEditing}>Done</button>
          {message && <span className="warn small">{message}</span>}
        </div>
      ) : (
        <div className="subbar">
          <button className="ghost" onClick={startEditing} title="Mark holidays and people's leave on this timeline">
            Edit days off
          </button>
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
      )}

      <div className="subbar">
        <OwnerFilter filter={filter} setFilter={setFilter} label="Show tasks for" />
        <div className="spacer" />
        <span className="muted small">
          {editing
            ? 'Task bars keep their dates; they re-segment around the new days off once saved. Use Redraw afterwards to re-place work around them.'
            : "The plan's order, week by week, worth a full week each; leave pushes a week later and everything after it with it. Drag a task onto a lane to plan it by hand (another person's lane hands it over), or onto the tray to take its dates off."}
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

        <div className="lf-scroll" ref={scroller}>
          <div className="lf-inner" style={{ '--track': `${totalW}px` }}>
            <div className="grow head-row">
              <div className="side head-side">{editing ? 'Holidays — drag the dates' : 'Availability'}</div>
              <div className="track">
                <div className="band-row">
                  {bands.map((b, i) => (
                    <div key={i} className="band" style={{ width: b.width }}>{MONTH_NAMES[b.m - 1]}</div>
                  ))}
                </div>
                <div
                  className="day-row"
                  onPointerDown={(e) => startPaint(e, 'holiday')}
                  onPointerMove={movePaint}
                  onPointerUp={endPaint}
                  onPointerCancel={() => setPaint(null)}
                >
                  {days.map((d) => {
                    const hol = editing ? !isWorkday(d) || holidayShown(d) : isHoliday(d)
                    const changed = editing && isWorkday(d) && holidayShown(d) !== savedHoliday(d)
                    const name = HOLIDAY_NAMES[d] || (draft.holidays.get(d) ?? '')
                    return (
                      <div
                        key={d}
                        className={`day${hol ? ' holiday' : ''}${changed ? ' changed' : ''}${editing && isWorkday(d) ? ' paintable' : ''}`}
                        style={{ width: dayW }}
                        title={`${label(d)}${hol ? (isWorkday(d) ? ` · holiday${name ? `: ${name}` : ''}` : ' · not a workday') : ''}`}
                      >
                        <span>{parse(d).getUTCDate()}</span>
                      </div>
                    )
                  })}
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
                        {editing
                          ? `${offCount(o.id)} days off`
                          : `${lane.scheduled.length} tasks${lane.waiting ? ` · ${lane.waiting} waiting` : ''}`}
                      </span>
                    </div>
                    <div
                      className="track avail-track"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => onDropInLane(e, o.id)}
                      onPointerDown={(e) => startPaint(e, 'leave', o.id)}
                      onPointerMove={movePaint}
                      onPointerUp={endPaint}
                      onPointerCancel={() => setPaint(null)}
                    >
                      {days.map((d, i) => {
                        const hol = editing ? !isWorkday(d) || holidayShown(d) : isHoliday(d)
                        const off = editing ? !hol && leaveShown(o.id, d) : LEAVE_SETS[o.id]?.has(d)
                        const changed = editing && !hol && leaveShown(o.id, d) !== savedLeave(o.id, d)
                        return (
                          <div
                            key={d}
                            className={`avail${hol ? ' holiday' : ''}${off ? ' leave' : ''}${changed ? ' changed' : ''}`}
                            style={{ left: i * dayW, width: dayW }}
                            title={`${label(d)} · ${hol ? 'holiday' : off ? `${o.name} unavailable` : 'available'}`}
                          />
                        )
                      })}
                      {gate && <div className="gate" style={{ left: gateLeft }} title={`${plan.marker.label} ${label(gate)}`} />}
                      {!editing && (
                        <span className="lane-end muted tiny" style={{ left: 4 }}>
                          {lane.lastDay ? `ends ${label(lane.lastDay)}` : 'nothing scheduled'}
                        </span>
                      )}
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
