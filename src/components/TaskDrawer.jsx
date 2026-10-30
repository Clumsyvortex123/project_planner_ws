import { useEffect, useState } from 'react'
import { ACTIVE_OWNERS as OWNERS, FLAGS, WEEKS, WEEK_BY_ID, configTask } from '../lib/model.js'
import { newTaskId, usePlan } from '../lib/store.jsx'
import { conflictsFor, durationOf, effortDaysOf, progressOf, shiftWorkdays, weekOfDate, workdaysIn } from '../lib/schedule.js'
import { label } from '../lib/dates.js'

export function TaskDrawer({ taskId, onClose, onOpen }) {
  const { tasks, planId, ripple, dispatch } = usePlan()
  const task = tasks.find((t) => t.id === taskId)
  const [newSub, setNewSub] = useState('')

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!task) return null

  const conflicts = conflictsFor(task)
  const pct = Math.round(progressOf(task) * 100)
  const effort = task.start ? workdaysIn(task.owner, task.start, task.end) : effortDaysOf(task)
  const actualWeek = task.start ? weekOfDate(task.start) : null
  const fromConfig = configTask(planId, task.id)
  const nudge = (n) => dispatch({ type: 'shift', id: task.id, start: shiftWorkdays(task.owner, task.start, n) })

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <header className="drawer-head">
          <input
            className="drawer-title"
            value={task.title}
            onChange={(e) => dispatch({ type: 'patch', id: task.id, patch: { title: e.target.value } })}
          />
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">✕</button>
        </header>

        <div className="drawer-body">
          <div className="field-row">
            <label className="field">
              <span>Owner</span>
              <select value={task.owner} onChange={(e) => dispatch({ type: 'move-to-owner', id: task.id, owner: e.target.value })}>
                {OWNERS.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Planned week</span>
              <select value={task.week} onChange={(e) => dispatch({ type: 'move-to-week', id: task.id, week: e.target.value })}>
                {WEEKS.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({label(w.start)} – {label(w.end)})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>Start date</span>
              <input type="date" value={task.start || ''} onChange={(e) => e.target.value && dispatch({ type: 'shift', id: task.id, start: e.target.value })} />
            </label>
            <label className="field">
              <span>Due date</span>
              <input type="date" value={task.end || ''} onChange={(e) => e.target.value && dispatch({ type: 'set-dates', id: task.id, end: e.target.value })} />
            </label>
            <label className="field narrow">
              <span>Working days</span>
              <input
                type="number"
                min={1}
                value={effort}
                onChange={(e) => Number(e.target.value) > 0 && dispatch({ type: 'set-effort', id: task.id, days: Number(e.target.value) })}
              />
            </label>
          </div>

          {task.start && (
            <div className="row wrap">
              <span className="muted small">Move by working days</span>
              <div className="seg">
                <button onClick={() => nudge(-5)}>−5</button>
                <button onClick={() => nudge(-1)}>−1</button>
                <button onClick={() => nudge(1)}>+1</button>
                <button onClick={() => nudge(5)}>+5</button>
              </div>
              <span className="muted tiny">{ripple ? "pushes this person's later work too" : 'moves this task only'}</span>
            </div>
          )}

          <p className="muted small">
            {task.start
              ? `${effort} working day${effort === 1 ? '' : 's'} over ${durationOf(task)} calendar day${durationOf(task) === 1 ? '' : 's'}`
              : 'not scheduled'}
            {' · planned in '}{WEEK_BY_ID[task.week]?.name || '—'}
            {actualWeek && actualWeek !== task.week ? ` · actually starts in ${WEEK_BY_ID[actualWeek]?.name}` : ''}
          </p>

          {(task.flags?.length > 0 || task.tag || task.milestone) && (
            <div className="row wrap">
              {task.milestone && <span className="pill">milestone</span>}
              {(task.flags || []).map((f) => <span key={f} className="pill">{FLAGS[f]?.label || f}</span>)}
              {task.tag && <span className="muted tiny">{task.tag}</span>}
            </div>
          )}

          {conflicts.length > 0 && (
            <div className="warn">
              Covers {conflicts.filter((c) => c.kind === 'holiday').length} holiday(s) and{' '}
              {conflicts.filter((c) => c.kind === 'leave').length} day(s) the owner is away (
              {conflicts.map((c) => label(c.day)).join(', ')}). No work is counted on those days.
            </div>
          )}

          <label className="check-row">
            <input
              type="checkbox"
              checked={!!task.done}
              onChange={() => dispatch({ type: 'patch', id: task.id, patch: { done: !task.done } })}
            />
            <span>Mark task complete</span>
          </label>

          <section>
            <h4>Subtasks <span className="muted">{pct}%</span></h4>
            <ul className="sub-list">
              {task.subtasks.map((s, i) => (
                <li key={i}>
                  <label>
                    <input type="checkbox" checked={s.done} onChange={() => dispatch({ type: 'toggle-sub', id: task.id, index: i })} />
                  </label>
                  <input
                    className={`sub-title${s.done ? ' done' : ''}`}
                    value={s.title}
                    onChange={(e) => dispatch({ type: 'rename-sub', id: task.id, index: i, title: e.target.value })}
                  />
                  <button className="icon-btn tiny" onClick={() => dispatch({ type: 'remove-sub', id: task.id, index: i })}>✕</button>
                </li>
              ))}
            </ul>
            <form
              className="add-sub"
              onSubmit={(e) => {
                e.preventDefault()
                if (!newSub.trim()) return
                dispatch({ type: 'add-sub', id: task.id, title: newSub.trim() })
                setNewSub('')
              }}
            >
              <input value={newSub} onChange={(e) => setNewSub(e.target.value)} placeholder="Add a subtask…" />
              <button type="submit">Add</button>
            </form>
          </section>

          <label className="field">
            <span>Notes</span>
            <textarea
              rows={4}
              value={task.notes || ''}
              onChange={(e) => dispatch({ type: 'patch', id: task.id, patch: { notes: e.target.value } })}
            />
          </label>

          <div className="row wrap">
            {task.start ? (
              <button className="ghost" onClick={() => dispatch({ type: 'unschedule', id: task.id })}>Take the dates off</button>
            ) : (
              <button className="ghost" onClick={() => dispatch({ type: 'move-to-week', id: task.id, week: task.week })}>
                Schedule in its planned week
              </button>
            )}
            <button
              className="ghost"
              onClick={() => {
                const id = newTaskId()
                dispatch({ type: 'duplicate', id: task.id, newId: id })
                onOpen?.(id)
              }}
            >
              Duplicate
            </button>
            {fromConfig && (
              <button
                className="ghost"
                title="Put this task back exactly as the config describes it, freshly placed around availability"
                onClick={() => confirm('Recreate this task from the config? Its edits, ticks and dates are replaced (undo is available).') && dispatch({ type: 'restore-from-config', id: task.id })}
              >
                Recreate from config
              </button>
            )}
            <span className="spacer" />
            <button
              className="danger"
              onClick={() => {
                dispatch({ type: 'delete-task', id: task.id })
                onClose()
              }}
              title="Moves it to the trash (Settings) — Ctrl+Z also brings it back"
            >
              Delete
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
