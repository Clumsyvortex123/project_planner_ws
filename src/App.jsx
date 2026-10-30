import { useEffect, useMemo, useState } from 'react'
import { ACTIVE_OWNERS as OWNERS, LEAVE, NOTE_AUTHORS, PLANS, PLAN_BY_ID, PROJECT, SETTINGS, WEEKS } from './lib/model.js'
import { ConfigProvider, useConfig } from './lib/config.jsx'
import { PlanProvider, newTaskId, usePlan } from './lib/store.jsx'
import { Board } from './views/Board.jsx'
import { Calendar } from './views/Calendar.jsx'
import { Gantt } from './views/Gantt.jsx'
import { LeaveFirst } from './views/LeaveFirst.jsx'
import { Notes } from './views/Notes.jsx'
import { Settings } from './views/Settings.jsx'
import { TaskDrawer } from './components/TaskDrawer.jsx'
import { FloatingNotes } from './components/FloatingNotes.jsx'
import { Reschedule } from './components/Reschedule.jsx'
import { NotesProvider, readAuthor, readFloating, useNotes, writeFloating } from './lib/notes.jsx'
import { durationOf, effortDaysOf, progressOf } from './lib/schedule.js'

const VIEWS = [
  { id: 'board', name: 'Board' },
  { id: 'calendar', name: 'Calendar' },
  { id: 'gantt', name: 'Gantt' },
  { id: 'leavefirst', name: 'Availability' },
  { id: 'notes', name: 'Notes' },
  { id: 'settings', name: 'Settings' },
]

const ACTION_NAMES = {
  patch: 'edit',
  'move-to-week': 'move to week',
  'move-to-owner': 'hand over',
  'set-dates': 'date change',
  shift: 'move',
  place: 'place',
  'set-effort': 'effort change',
  reschedule: 'bulk reschedule',
  autofill: 'redraw',
  'clear-dates': 'clear dates',
  'add-task': 'new task',
  'delete-task': 'delete',
  'restore-task': 'restore',
  'restore-from-config': 'recreate from config',
  'sync-config': 'config sync',
  'set-checkpoint': 'week note',
}

function PlanToggle() {
  const { planId, dispatch } = usePlan()
  if (PLANS.length < 2) return null
  const groups = [...new Set(PLANS.map((p) => p.group))]
  return (
    <div className="plan-toggle">
      {groups.map((g) => (
        <div key={g} className="plan-group">
          <span className="muted tiny">{g}</span>
          <div className="seg">
            {PLANS.filter((p) => p.group === g).map((p) => (
              <button
                key={p.id}
                className={planId === p.id ? 'on' : ''}
                title={p.blurb}
                onClick={() => dispatch({ type: 'switch-plan', planId: p.id })}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

const SYNC_TEXT = {
  loading: 'loading…',
  saving: 'saving…',
  synced: 'saved for everyone',
  merged: 'merged',
  offline: 'offline — retrying',
}

function SyncBadge() {
  const { sync } = usePlan()
  return (
    <span className={`sync sync-${sync.state}`} title={sync.message || 'Shared with everyone on this server'}>
      <i className="sync-dot" />
      {SYNC_TEXT[sync.state] || sync.state}
    </span>
  )
}

/** Config problems and "the config changed" notices, above everything. */
function ConfigBanner({ onSettings }) {
  const { errors, notice, dismiss } = useConfig()
  if (errors.length) {
    return (
      <div className="banner banner-error">
        The configuration on the server has {errors.length} problem(s) and was not applied: {errors[0]}
        {errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}.{' '}
        <button className="link" onClick={onSettings}>Open Settings</button>
      </div>
    )
  }
  if (!notice) return null
  return (
    <div className="banner">
      {notice} <button className="link" onClick={dismiss}>dismiss</button>
    </div>
  )
}

function Toolbar({ view, setView, filter, setFilter, query, setQuery, onOpen, onReschedule }) {
  const { tasks, trash, plan, checkpoints, dispatch, canUndo, canRedo, undoLabel, redoLabel, ripple } = usePlan()

  const stats = useMemo(() => {
    const by = {}
    for (const o of OWNERS) by[o.id] = { tasks: 0, days: 0, done: 0 }
    for (const t of tasks) {
      const s = by[t.owner]
      if (!s) continue
      s.tasks += 1
      s.days += t.start ? durationOf(t) : effortDaysOf(t)
      s.done += progressOf(t)
    }
    return by
  }, [tasks])

  const toggle = (id) => {
    const next = new Set(filter)
    next.has(id) ? next.delete(id) : next.add(id)
    setFilter(next)
  }

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ plan: plan.id, tasks, checkpoints, trash }, null, 2)], {
      type: 'application/json',
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${PROJECT.id}-plan-${plan.id}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const importJson = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    file.text().then((txt) => {
      try {
        const parsed = JSON.parse(txt)
        if (!Array.isArray(parsed.tasks)) throw new Error()
        dispatch({ type: 'replace', tasks: parsed.tasks, checkpoints: parsed.checkpoints || {}, trash: parsed.trash || [] })
      } catch {
        alert('That file is not a plan export.')
      }
    })
    e.target.value = ''
  }

  const addTask = () => {
    const today = new Date().toISOString().slice(0, 10)
    const week = WEEKS.find((w) => today >= w.start && today <= w.end) || WEEKS[0]
    const owner = filter.size === 1 ? [...filter][0] : OWNERS[0].id
    const id = newTaskId()
    dispatch({ type: 'add-task', id, title: 'New task', owner, week: week.id, start: today >= WEEKS[0].start ? today : week.start })
    onOpen(id)
  }

  return (
    <header className="topbar">
      <div className="row">
        <h1>{PROJECT.title}</h1>
        <PlanToggle />
        <span className="muted small plan-blurb">{plan.blurb}</span>
        <SyncBadge />
        <div className="spacer" />
        <div className="seg big">
          {VIEWS.map((v) => (
            <button key={v.id} className={view === v.id ? 'on' : ''} onClick={() => setView(v.id)}>
              {v.name}
            </button>
          ))}
        </div>
      </div>

      <div className="row">
        <input
          className="search"
          placeholder={view === 'notes' ? 'Filter notes…' : 'Filter tasks…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="people">
          {OWNERS.map((o) => {
            const s = stats[o.id]
            const on = filter.size === 0 || filter.has(o.id)
            return (
              <button
                key={o.id}
                className={`person${on ? '' : ' off'}`}
                onClick={() => toggle(o.id)}
                title={`${s.tasks} tasks · ${s.days} planned days${LEAVE[o.id]?.length ? ` · ${LEAVE[o.id].length} days unavailable` : ''}`}
              >
                <span className="dot" style={{ background: o.color }} />
                <span>{o.name}</span>
                <span className="muted tiny">{s.tasks}</span>
              </button>
            )
          })}
          {filter.size > 0 && (
            <button className="link" onClick={() => setFilter(new Set())}>clear</button>
          )}
        </div>
        <div className="spacer" />
        <button className="ghost primary" onClick={addTask} title="Create a task and open it">+ Task</button>
        <div className="seg">
          <button disabled={!canUndo} onClick={() => dispatch({ type: 'undo' })} title={`Undo ${ACTION_NAMES[undoLabel] || undoLabel || ''} (Ctrl+Z)`}>↶</button>
          <button disabled={!canRedo} onClick={() => dispatch({ type: 'redo' })} title={`Redo ${ACTION_NAMES[redoLabel] || redoLabel || ''} (Ctrl+Shift+Z)`}>↷</button>
        </div>
        <label
          className="checkbox ripple"
          title="When a task moves or grows, push that person's later tasks by the same number of their working days — on every page"
        >
          <input type="checkbox" checked={ripple} onChange={() => dispatch({ type: 'set-ripple', on: !ripple })} />
          push later work
        </label>
        <button className="ghost" onClick={onReschedule} title="Move many tasks at once by N working days">Reschedule…</button>
        <button
          className="ghost"
          onClick={() => confirm('Redraw every task from its planned week around holidays and leave? Manual dates are replaced (undo is available).') && dispatch({ type: 'autofill' })}
          title="Re-place every task from its planned week, around availability"
        >
          Redraw
        </button>
        {plan.doc && <a className="ghost" href={plan.doc} target="_blank" rel="noreferrer">Doc ↗</a>}
        <button className="ghost" onClick={exportJson}>Export</button>
        <label className="ghost file">
          Import<input type="file" accept="application/json" onChange={importJson} />
        </label>
        <button
          className="ghost"
          onClick={() => confirm(`Reset "${plan.label}" to what the config generates? (undo is available)`) && dispatch({ type: 'reset' })}
        >
          Reset
        </button>
      </div>
    </header>
  )
}

const viewFromHash = () => {
  const parts = location.hash.replace('#', '').split('/')
  const v = parts.length > 1 ? parts[1] : parts[0]
  return VIEWS.some((x) => x.id === v) ? v : null
}

function Shell() {
  const { planId, dispatch } = usePlan()
  const { floatNote, patchNote } = useNotes()

  // The hash carries plan and view, so a particular board can be linked to.
  const [view, setView] = useState(() => viewFromHash() || SETTINGS.defaultView || 'board')

  useEffect(() => {
    location.hash = `${planId}/${view}`
  }, [planId, view])

  useEffect(() => {
    const onHash = () => {
      const [p] = location.hash.replace('#', '').split('/')
      if (PLAN_BY_ID[p] && p !== planId) dispatch({ type: 'switch-plan', planId: p })
      const v = viewFromHash()
      if (v) setView(v)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [planId, dispatch])

  // Undo / redo from anywhere, except while typing in a field.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) dispatch({ type: 'undo' })
      else if ((k === 'z' && e.shiftKey) || k === 'y') dispatch({ type: 'redo' })
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch])

  const [filter, setFilter] = useState(new Set())
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(null)
  const [rescheduling, setRescheduling] = useState(false)

  // Sticky notes: who you write as, how the wall is sorted, and which of your
  // own notes are floating. An "all" note keeps its position on the note itself.
  const [author, setAuthor] = useState(() => readAuthor(NOTE_AUTHORS[1]?.id || 'all'))
  const [sort, setSort] = useState('edited')
  const [floating, setFloating] = useState(readFloating)
  useEffect(() => writeFloating(floating), [floating])

  const corner = () => ({ x: Math.max(8, window.innerWidth - 340), y: 120 })

  const float = (note) => {
    if (note.author === 'all') floatNote(note.id, note.float || corner())
    else setFloating((f) => (f[note.id] ? f : { ...f, [note.id]: corner() }))
  }

  const changeAuthor = (note, next) => {
    if (next === 'all') {
      const at = floating[note.id]
      patchNote(note.id, { author: next, ...(at || note.float ? { float: at || note.float } : {}) })
      if (at) setFloating((f) => { const m = { ...f }; delete m[note.id]; return m })
      return
    }
    const at = note.float
    patchNote(note.id, { author: next, float: undefined })
    if (at) setFloating((f) => ({ ...f, [note.id]: at }))
  }

  return (
    <div className="app">
      <ConfigBanner onSettings={() => setView('settings')} />
      <Toolbar
        view={view}
        setView={setView}
        filter={filter}
        setFilter={setFilter}
        query={query}
        setQuery={setQuery}
        onOpen={setOpen}
        onReschedule={() => setRescheduling(true)}
      />
      <main>
        {view === 'board' && <Board filter={filter} query={query} onOpen={setOpen} />}
        {view === 'calendar' && <Calendar filter={filter} query={query} onOpen={setOpen} />}
        {view === 'gantt' && <Gantt filter={filter} setFilter={setFilter} query={query} onOpen={setOpen} />}
        {view === 'leavefirst' && <LeaveFirst filter={filter} setFilter={setFilter} query={query} onOpen={setOpen} />}
        {view === 'notes' && (
          <Notes
            query={query}
            author={author}
            setAuthor={setAuthor}
            sort={sort}
            setSort={setSort}
            floating={floating}
            onFloat={float}
            onAuthorChange={changeAuthor}
          />
        )}
        {view === 'settings' && <Settings onOpen={setOpen} />}
      </main>
      <FloatingNotes floating={floating} setFloating={setFloating} onAuthorChange={changeAuthor} />
      {open && <TaskDrawer taskId={open} onClose={() => setOpen(null)} onOpen={setOpen} />}
      {rescheduling && <Reschedule filter={filter} onClose={() => setRescheduling(false)} />}
    </div>
  )
}

/** Everything below is rebuilt when the config changes, so it always reads the current model. */
function Planner() {
  const { rev } = useConfig()
  useEffect(() => {
    document.title = PROJECT.title
  }, [rev])
  return (
    <PlanProvider key={rev}>
      <NotesProvider>
        <Shell />
      </NotesProvider>
    </PlanProvider>
  )
}

export default function App() {
  return (
    <ConfigProvider>
      <Planner />
    </ConfigProvider>
  )
}

