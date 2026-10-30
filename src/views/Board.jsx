import { useState } from 'react'
import { ACTIVE_OWNERS as OWNERS, FLAGS, OWNER_BY_ID, WEEKS, WEEK_BY_ID } from '../lib/model.js'
import { newTaskId, usePlan, sortTasks } from '../lib/store.jsx'
import { conflictsFor, isComplete, progressOf, weekOfDate, workdaysOf } from '../lib/schedule.js'
import { label } from '../lib/dates.js'
import { OwnerChip } from '../components/OwnerChip.jsx'

function TaskCard({ task, onOpen, onDragStart, onDrop, column }) {
  const owner = OWNER_BY_ID[task.owner]
  const pct = Math.round(progressOf(task) * 100)
  const conflicts = conflictsFor(task)
  const done = isComplete(task)
  const [over, setOver] = useState(false)
  // Shown when the card sits in a week column other than its planned week.
  const planned = column && column !== 'none' && task.week !== column && WEEK_BY_ID[task.week]

  return (
    <article
      className={`card${over ? ' drop-before' : ''}${done ? ' card-done' : ''}`}
      style={{ '--owner': owner?.color }}
      draggable
      onDragStart={(e) => onDragStart(e, task)}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        onDrop(e, task)
      }}
      onClick={() => onOpen(task.id)}
    >
      <div className="card-top">
        <OwnerChip id={task.owner} />
        {task.milestone && <span className="pill">milestone</span>}
        {(task.flags || []).map((f) => <span key={f} className="pill">{FLAGS[f]?.label || f}</span>)}
        {planned && <span className="pill muted-pill" title="The week the plan puts it in; leave or a manual move started it elsewhere">planned {WEEK_BY_ID[task.week]?.name}</span>}
        {conflicts.length > 0 && (
          <span className="pill warn-pill" title={conflicts.map((c) => `${label(c.day)} · ${c.kind}`).join('\n')}>
            ⚠ {conflicts.length}
          </span>
        )}
      </div>
      <h4>{done && <span className="tick">✓</span>}{task.title}</h4>
      {task.tag && <p className="muted tiny">{task.tag}</p>}
      <p className="dates">
        {task.start ? `${label(task.start)} → ${label(task.end)}` : 'not scheduled'}
      </p>
      {task.subtasks.length > 0 && (
        <div className="progress" title={`${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length} subtasks`}>
          <div className="progress-bar" style={{ width: `${pct}%` }} />
          <span className="progress-label">
            {/* A task marked complete is complete, however many subtasks were
                left unticked — saying "0/6" under a full bar reads as a bug. */}
            {done ? 'done' : `${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length}`}
          </span>
        </div>
      )}
    </article>
  )
}

function Column({ column, tasks, groupBy, onOpen }) {
  const { dispatch } = usePlan()
  const [over, setOver] = useState(false)

  const moveInto = (taskId, beforeId) => {
    const ids = tasks.map((t) => t.id).filter((id) => id !== taskId)
    const at = beforeId ? ids.indexOf(beforeId) : ids.length
    ids.splice(at < 0 ? ids.length : at, 0, taskId)
    if (column.id === 'none') dispatch({ type: 'unschedule', id: taskId })
    else if (groupBy === 'week') dispatch({ type: 'move-to-week', id: taskId, week: column.id })
    else dispatch({ type: 'move-to-owner', id: taskId, owner: column.id })
    dispatch({ type: 'reorder', ids })
  }

  const onDragStart = (e, task) => {
    e.dataTransfer.setData('text/plain', task.id)
    e.dataTransfer.effectAllowed = 'move'
  }

  return (
    <section
      className={`column${over ? ' over' : ''}`}
      style={{ '--accent': column.color || '#30363d' }}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const id = e.dataTransfer.getData('text/plain')
        if (id) moveInto(id, null)
      }}
    >
      <header className="column-head">
        <div>
          <h3>{column.name}</h3>
          <p className="muted tiny">{column.sub}</p>
        </div>
        <span className="count">{tasks.length}</span>
      </header>
      {column.note && <p className="column-note">{column.note}</p>}
      <div className="column-body">
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            onOpen={onOpen}
            column={groupBy === 'week' ? column.id : null}
            onDragStart={onDragStart}
            onDrop={(e, target) => {
              const id = e.dataTransfer.getData('text/plain')
              if (id && id !== target.id) moveInto(id, target.id)
            }}
          />
        ))}
        {column.id !== 'none' && (
          <button
            className="add-card"
            onClick={() => {
              const title = prompt('New task')
              if (!title) return
              const id = newTaskId()
              dispatch({
                type: 'add-task',
                id,
                title,
                week: groupBy === 'week' ? column.id : WEEKS[0].id,
                owner: groupBy === 'owner' ? column.id : OWNERS[0].id,
              })
              onOpen(id)
            }}
          >
            + Add item
          </button>
        )}
      </div>
    </section>
  )
}

export function Board({ filter, query, onOpen }) {
  const { tasks, plan } = usePlan()
  const [groupBy, setGroupBy] = useState('week')

  const visible = tasks.filter(
    (t) =>
      (filter.size === 0 || filter.has(t.owner)) &&
      (!query || t.title.toLowerCase().includes(query.toLowerCase()))
  )

  // Week columns follow the dates, the same as the Gantt and the Calendar: a
  // card sits in the week it actually starts in. Its planned week shows on the
  // card when the two differ.
  const columnOf = (t) => (groupBy === 'week' ? (t.start ? weekOfDate(t.start) : 'none') : t.owner)
  const columns =
    groupBy === 'week'
      ? [
          ...plan.weeks.map((w) => ({
            id: w.id,
            name: w.name,
            sub: `${label(w.start)} – ${label(w.end)} · ${workdaysOf(w).length} working days`,
            note: w.note,
          })),
          ...(visible.some((t) => !t.start) ? [{ id: 'none', name: 'Not scheduled', sub: 'drop here to take dates off' }] : []),
        ]
      : OWNERS.map((o) => ({ id: o.id, name: o.name, sub: `${o.id}`, color: o.color }))

  return (
    <div className="board-wrap">
      <div className="subbar">
        <span className="muted small">Group by</span>
        <div className="seg">
          <button className={groupBy === 'week' ? 'on' : ''} onClick={() => setGroupBy('week')}>Week</button>
          <button className={groupBy === 'owner' ? 'on' : ''} onClick={() => setGroupBy('owner')}>Owner</button>
        </div>
        <span className="muted small">Columns follow the dates. Drag a card to another week to re-plan it there (around leave), onto a card to reorder.</span>
      </div>
      <div className="board">
        {columns.map((c) => (
          <Column
            key={c.id}
            column={c}
            groupBy={groupBy}
            onOpen={onOpen}
            tasks={sortTasks(visible.filter((t) => columnOf(t) === c.id))}
          />
        ))}
      </div>
    </div>
  )
}
