import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ACTIVE_OWNERS as OWNERS, LEAVE_SETS, OWNER_BY_ID, WEEKS, markerDay } from '../lib/model.js'
import { OwnerFilter } from '../components/OwnerFilter.jsx'
import { usePlan } from '../lib/store.jsx'
import {
  BLOCKS as FORTNIGHTS,
  TIMELINE_DAYS,
  TIMELINE_END,
  TIMELINE_START,
  durationOf,
  isComplete,
  isHoliday,
  progressOf,
  segmentsOf,
} from '../lib/schedule.js'
import { MONTH_NAMES, addDays, clamp, diffDays, label, parse } from '../lib/dates.js'
import { SummaryEditor, SummaryTooltip, hasNote, summaryText } from '../components/WeekSummary.jsx'

const ZOOMS = [16, 26, 40]

function monthBands(days, dayW) {
  const bands = []
  for (const d of days) {
    const m = Number(d.slice(5, 7))
    const last = bands[bands.length - 1]
    if (last && last.m === m) last.span += 1
    else bands.push({ m, span: 1, year: d.slice(0, 4) })
  }
  return bands.map((b) => ({ ...b, width: b.span * dayW }))
}

/** One task bar: drag the middle to move, the edges to resize. */
function Bar({ task, dayW, onOpen }) {
  const { dispatch } = usePlan()
  const [drag, setDrag] = useState(null) // {mode, dx}
  const startRef = useRef(null)
  const owner = OWNER_BY_ID[task.owner]

  const offset = diffDays(TIMELINE_START, task.start)
  const len = durationOf(task)
  const shiftDays = drag ? Math.round(drag.dx / dayW) : 0

  let left = offset
  let width = len
  if (drag?.mode === 'move') left += shiftDays
  if (drag?.mode === 'start') {
    left += shiftDays
    width -= shiftDays
  }
  if (drag?.mode === 'end') width += shiftDays
  width = Math.max(1, width)

  const begin = (mode) => (e) => {
    e.preventDefault()
    e.stopPropagation()
    startRef.current = e.clientX
    setDrag({ mode, dx: 0 })
    const move = (ev) => setDrag({ mode, dx: ev.clientX - startRef.current })
    const up = (ev) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const delta = Math.round((ev.clientX - startRef.current) / dayW)
      setDrag(null)
      if (!delta) {
        // A press that went nowhere is a click: open the task in the drawer.
        if (mode === 'move' && Math.abs(ev.clientX - startRef.current) < 4) onOpen(task.id)
        return
      }
      if (mode === 'move') {
        dispatch({ type: 'shift', id: task.id, start: clamp(addDays(task.start, delta), TIMELINE_START, TIMELINE_END) })
      } else if (mode === 'start') {
        const next = clamp(addDays(task.start, delta), TIMELINE_START, task.end)
        dispatch({ type: 'set-dates', id: task.id, start: next })
      } else {
        const next = clamp(addDays(task.end, delta), task.start, TIMELINE_END)
        dispatch({ type: 'set-dates', id: task.id, end: next })
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const pct = progressOf(task)

  // Off a drag, the bar is drawn as the runs of days its owner can work, so it
  // never paints across a holiday or their leave. Mid-drag it goes solid, since
  // the preview is about where it is landing, not which days it will eat.
  const segs = drag ? [] : segmentsOf(task)
  const worked = segs.reduce((n, s) => n + diffDays(s.start, s.end) + 1, 0)
  let doneSoFar = pct * worked
  const widest = segs.reduce((a, b) => (diffDays(b.start, b.end) > diffDays(a.start, a.end) ? b : a), segs[0])

  return (
    <div
      className={`bar${drag ? ' dragging' : ' split'}${task.milestone ? ' milestone' : ''}`}
      style={{
        left: left * dayW,
        width: width * dayW - 2,
        background: drag ? owner?.color : undefined,
        color: owner?.fg,
      }}
      onPointerDown={begin('move')}
      title={`${task.title}\n${task.start} → ${task.end}\nClick to open, drag to move, drag an edge to resize`}
    >
      <span className="handle left" onPointerDown={begin('start')} />
      {segs.map((s) => {
        const len = diffDays(s.start, s.end) + 1
        const fill = Math.max(0, Math.min(len, doneSoFar))
        doneSoFar -= len
        return (
          <span
            key={s.start}
            className="bar-seg"
            style={{
              left: diffDays(task.start, s.start) * dayW,
              width: len * dayW - 1,
              background: owner?.color,
            }}
          >
            {fill > 0 && <i className="seg-progress" style={{ width: `${(fill / len) * 100}%` }} />}
          </span>
        )
      })}
      <span
        className="bar-label"
        style={
          widest
            ? {
                left: diffDays(task.start, widest.start) * dayW + 6,
                width: (diffDays(widest.start, widest.end) + 1) * dayW - 12,
              }
            : undefined
        }
      >
        {task.title}
      </span>
      {drag && pct > 0 && <span className="bar-progress" style={{ width: `${pct * 100}%` }} />}
      <span className="handle right" onPointerDown={begin('end')} />
    </div>
  )
}

export function Gantt({ filter, setFilter, query, onOpen }) {
  const { tasks, plan, checkpoints } = usePlan()
  const marker = markerDay(plan)
  const [zoom, setZoom] = useState(1)
  // The chart reads down the page in date order; inside each two-week block it
  // still reads best clustered by person, so that is the default.
  const [chronoByOwner, setChronoByOwner] = useState(true)
  // A week header opens its summary on click and previews it on hover. Both
  // carry the header's screen position so the bubble can be placed against the
  // viewport rather than the (scrolling, clipping) track.
  const [openWeek, setOpenWeek] = useState(null)
  const [hoverWeek, setHoverWeek] = useState(null)
  // The leave hatching can be busy on a full chart, so it can be turned off.
  const [showLeave, setShowLeave] = useState(true)

  // Reading down the page walks the chart along with it: whichever week's block
  // is at the top of the view, its columns are the ones brought into view.
  const scrollRef = useRef(null)
  const headRef = useRef(null)
  const groupRefs = useRef({})
  const lastTop = useRef(0)
  const dayW = ZOOMS[zoom]
  const days = TIMELINE_DAYS
  const totalW = days.length * dayW
  const bands = useMemo(() => monthBands(days, dayW), [days, dayW])

  const visible = tasks.filter(
    (t) =>
      (filter.size === 0 || filter.has(t.owner)) &&
      (!query || t.title.toLowerCase().includes(query.toLowerCase()))
  )

  // The project down the page, week by week — grouped by the week work actually
  // starts in, which after the leave-first redraw is not always its doc week.
  const chrono = useMemo(() => {
    const dated = visible
      .filter((t) => t.start)
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
    return plan.weeks
      .map((w) => {
        const tasks = dated.filter((t) => t.start >= w.start && t.start <= w.end)
        return {
          week: w,
          tasks,
          owners: OWNERS.map((o) => ({ owner: o, tasks: tasks.filter((t) => t.owner === o.id) })).filter(
            (g) => g.tasks.length > 0
          ),
        }
      })
      .filter((g) => g.tasks.length > 0)
  }, [visible, plan])

  // Every window a summary can hang off: each week, and each two-week block.
  const windows = useMemo(() => {
    const byId = {}
    for (const w of plan.weeks) byId[w.id] = { ...w, notes: w.note ? [w.note] : [] }
    for (const f of FORTNIGHTS) {
      byId[f.id] = {
        id: f.id,
        name: f.name,
        start: f.start,
        end: f.end,
        // A block's notes come from both its weeks, so say which is which.
        notes: f.weeks
          .filter((x) => byId[x.id]?.note)
          .map((x) => `${byId[x.id].name}: ${byId[x.id].note}`),
      }
    }
    return byId
  }, [plan])

  // Which summary is showing, and where to put it so it stays on screen.
  const anchor = openWeek || hoverWeek
  const popWeek = anchor ? windows[anchor.id] : null
  const popWidth = openWeek ? 460 : 380
  const popStyle = anchor && {
    left: Math.max(8, Math.min(anchor.left, window.innerWidth - popWidth - 8)),
    top: anchor.bottom + 6,
  }

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // Only react to vertical movement, so panning sideways is never fought.
    if (el.scrollTop === lastTop.current) return
    lastTop.current = el.scrollTop

    const cutoff = el.getBoundingClientRect().top + (headRef.current?.offsetHeight || 0) + 8
    let active = null
    for (const key of Object.keys(groupRefs.current)) {
      const node = groupRefs.current[key]
      if (node && node.getBoundingClientRect().top <= cutoff) active = key
    }
    const week = plan.weeks.find((w) => w.id === active)
    if (!week) return

    const target = Math.max(
      0,
      Math.min(diffDays(TIMELINE_START, week.start) * dayW - 12, el.scrollWidth - el.clientWidth)
    )
    if (Math.abs(el.scrollLeft - target) > 2) el.scrollLeft = target
  }, [plan, dayW])

  // React's onScroll does not fire reliably on a scroll container, so the
  // listener goes on the node itself.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [onScroll])

  const holidayCols = days.map((d, i) => (isHoliday(d) ? i : -1)).filter((i) => i >= 0)
  const weekEdges = WEEKS.map((w) => diffDays(TIMELINE_START, w.start)).filter((i) => i > 0)
  const fortnightEdges = FORTNIGHTS.map((f) => diffDays(TIMELINE_START, f.start)).filter((i) => i > 0)

  const Backdrop = ({ ownerId }) => (
    <>
      {holidayCols.map((i) => (
        <div key={`h${i}`} className="col-holiday" style={{ left: i * dayW, width: dayW }} />
      ))}
      {showLeave &&
        ownerId &&
        days.map((d, i) =>
          LEAVE_SETS[ownerId]?.has(d) ? (
            <div key={`l${i}`} className="col-leave" style={{ left: i * dayW, width: dayW }} />
          ) : null
        )}
      {weekEdges.map((i) => (
        <div key={`w${i}`} className="col-weekline" style={{ left: i * dayW }} />
      ))}
      {fortnightEdges.map((i) => (
        <div key={`f${i}`} className="col-fortnight" style={{ left: i * dayW }} />
      ))}
      {marker && <div className="gate" style={{ left: diffDays(TIMELINE_START, marker) * dayW }} title={`${plan.marker.label} ${label(marker)}`} />}
    </>
  )

  return (
    <div className="gantt-wrap">
      <div className="subbar">
        <label className="checkbox" title="Cluster each block by person instead of interleaving them by date">
          <input type="checkbox" checked={chronoByOwner} onChange={() => setChronoByOwner((v) => !v)} />
          group by owner
        </label>
        <span className="muted small">Zoom</span>
        <div className="seg">
          {['S', 'M', 'L'].map((z, i) => (
            <button key={z} className={zoom === i ? 'on' : ''} onClick={() => setZoom(i)}>{z}</button>
          ))}
        </div>
        <span className="muted small">
          Click a task for its details, a week above the chart for its summary.
        </span>
        <div className="spacer" />
        <span className="legend"><i className="swatch holiday-sw" /> holiday</span>
        {marker && <span className="legend"><i className="swatch gate-sw" /> {plan.marker.label} ({label(marker)})</span>}
        <label className="legend checkbox" title="Hide the hatching over each owner's leave">
          <input type="checkbox" checked={showLeave} onChange={() => setShowLeave((v) => !v)} />
          <i className="swatch leave-sw" /> owner unavailable
        </label>
      </div>

      <div className="subbar">
        <OwnerFilter filter={filter} setFilter={setFilter} />
      </div>

      <div className="gantt-scroll" ref={scrollRef}>
        <div className="gantt-inner" style={{ '--track': `${totalW}px`, '--dayw': `${dayW}px` }}>
          <div className="grow head-row" ref={headRef}>
            <div className="side head-side">Project, in date order</div>
            <div className="track">
              <div className="band-row">
                {bands.map((b, i) => (
                  <div key={i} className="band" style={{ width: b.width }}>
                    {MONTH_NAMES[b.m - 1]} {b.year}
                  </div>
                ))}
              </div>
              <div className="day-row">
                {days.map((d) => (
                  <div key={d} className={`day${isHoliday(d) ? ' holiday' : ''}`} style={{ width: dayW }}>
                    <span>{parse(d).getUTCDate()}</span>
                  </div>
                ))}
              </div>
              <div className="week-row">
                {plan.weeks.map((w) => {
                  const a = diffDays(TIMELINE_START, w.start)
                  const b = diffDays(TIMELINE_START, w.end) + 1
                  return (
                    <button
                      key={w.id}
                      className={`week-tag${hasNote(w, checkpoints) ? ' noted' : ''}${
                        openWeek && openWeek.id === w.id ? ' on' : ''
                      }`}
                      style={{ left: a * dayW, width: (b - a) * dayW - 2 }}
                      onMouseEnter={(e) => {
                        const r = e.currentTarget.getBoundingClientRect()
                        setHoverWeek({ id: w.id, left: r.left, bottom: r.bottom })
                      }}
                      onMouseLeave={() => setHoverWeek((h) => (h && h.id === w.id ? null : h))}
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect()
                        setOpenWeek((o) => (o && o.id === w.id ? null : { id: w.id, left: r.left, bottom: r.bottom }))
                      }}
                    >
                      {w.name}
                    </button>
                  )
                })}
              </div>
              <div className="week-row">
                {FORTNIGHTS.map((f) => {
                  const a = diffDays(TIMELINE_START, f.start)
                  const b = diffDays(TIMELINE_START, f.end) + 1
                  return (
                    <button
                      key={f.id}
                      className={`week-tag fortnight-tag${hasNote(f, checkpoints) ? ' noted' : ''}${
                        openWeek && openWeek.id === f.id ? ' on' : ''
                      }`}
                      style={{ left: a * dayW, width: (b - a) * dayW - 2 }}
                      onMouseEnter={(e) => {
                        const r = e.currentTarget.getBoundingClientRect()
                        setHoverWeek({ id: f.id, left: r.left, bottom: r.bottom })
                      }}
                      onMouseLeave={() => setHoverWeek((h) => (h && h.id === f.id ? null : h))}
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect()
                        setOpenWeek((o) => (o && o.id === f.id ? null : { id: f.id, left: r.left, bottom: r.bottom }))
                      }}
                    >
                      {f.name}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {chrono.map((group) => {
              const taskRow = (t) => {
                const o = OWNER_BY_ID[t.owner]
                return (
                  <div className="grow row" key={t.id}>
                    <div className="side task-side" onClick={() => onOpen(t.id)} title={t.title}>
                      {isComplete(t) && <span className="tick">✓</span>}
                      <span className="dot" style={{ background: o?.color }} />
                      <span className="task-name">{t.title}</span>
                      <span className="spacer" />
                      <span className="muted tiny">{label(t.start)}</span>
                    </div>
                    <div className="track">
                      <Backdrop ownerId={t.owner} />
                      <Bar task={t} dayW={dayW} onOpen={onOpen} />
                    </div>
                  </div>
                )
              }

              return (
                <div
                  key={group.week.id}
                  className="lane"
                  ref={(el) => {
                    groupRefs.current[group.week.id] = el
                  }}
                >
                  <div className="grow lane-head">
                    <div className="side">
                      <strong>{group.week.name}</strong>
                      <span className="muted tiny">{label(group.week.start)} – {label(group.week.end)}</span>
                    </div>
                    <div className="track lane-track">
                      <Backdrop />
                    </div>
                  </div>

                  {chronoByOwner
                    ? group.owners.map((g) => (
                        <Fragment key={g.owner.id}>
                          <div className="grow owner-row">
                            <div className="side sub-side">
                              <span className="dot" style={{ background: g.owner.color }} />
                              <span>{g.owner.name}</span>
                            </div>
                            <div className="track">
                              <Backdrop ownerId={g.owner.id} />
                            </div>
                          </div>
                          {g.tasks.map(taskRow)}
                        </Fragment>
                      ))
                    : group.tasks.map(taskRow)}
                </div>
              )
          })}
        </div>
      </div>

      {popWeek &&
        (openWeek ? (
          <SummaryEditor
            win={popWeek}
            tasks={tasks}
            style={popStyle}
            onClose={() => setOpenWeek(null)}
          />
        ) : (
          <SummaryTooltip
            win={popWeek}
            style={popStyle}
            text={summaryText(popWeek, tasks, checkpoints)}
          />
        ))}
    </div>
  )
}
