import { useEffect } from 'react'
import { AREAS, stateOf } from '../lib/model.js'
import { usePlan } from '../lib/store.jsx'
import { label } from '../lib/dates.js'

const STATES = [
  { id: '', name: 'not set' },
  { id: 'on-track', name: 'on track' },
  { id: 'at-risk', name: 'at risk' },
  { id: 'slipped', name: 'slipped' },
  { id: 'done', name: 'closed out' },
]

/**
 * Where the system as a whole should be at the end of a window — a week or a
 * two-week block. Written in capabilities rather than task names, grouped by the
 * area of the system they belong to, and saying nothing about who did what.
 */
export function compileWindow(win, tasks) {
  const finishing = tasks.filter((t) => t.end && t.end >= win.start && t.end <= win.end)
  const running = tasks.filter((t) => t.start && t.start <= win.end && t.end > win.end)

  const byArea = new Map()
  for (const t of finishing) {
    const [area, phrase] = stateOf(t)
    if (!byArea.has(area)) byArea.set(area, [])
    if (!byArea.get(area).includes(phrase)) byArea.get(area).push(phrase)
  }

  const order = [...AREAS, 'Other']
  const lines = [`By ${label(win.end)}, end of ${win.name.toLowerCase()}, the system:`]

  if (byArea.size === 0) {
    lines.push('- nothing new lands in this window')
  } else {
    for (const area of order) {
      if (byArea.has(area)) lines.push(`- ${area}: ${byArea.get(area).join('; ')}`)
    }
  }

  if (running.length) {
    const areas = [...new Set(running.map((t) => stateOf(t)[0]))]
    lines.push('', `Still in flight: ${areas.join(', ').toLowerCase()}.`)
  }

  // Where the whole project stands by the end of this window, and how much of
  // it this window is responsible for. Planned completion, by task count.
  const total = tasks.length
  if (total) {
    const byNow = tasks.filter((t) => t.end && t.end <= win.end).length
    const share = (n) => Math.round((n / total) * 100)
    lines.push(
      '',
      `Project ${share(byNow)}% complete by then — ${byNow} of ${total} tasks; this window closes ` +
        `${finishing.length} of them (${share(finishing.length)}% of the project).`
    )
  }
  const notes = win.notes || []
  if (notes.length === 1) lines.push('', `From the plan: ${notes[0]}`)
  else if (notes.length > 1) {
    lines.push('', 'From the plan:')
    for (const n of notes) lines.push(`- ${n}`)
  }

  return lines.join('\n')
}

/** The saved text for a window, falling back to the compiled version. */
export function summaryText(win, tasks, checkpoints) {
  const saved = checkpoints[win.id] || {}
  return saved.expected != null ? saved.expected : compileWindow(win, tasks)
}

export function hasNote(win, checkpoints) {
  const saved = checkpoints[win.id]
  return !!saved && (saved.expected != null || !!saved.note || !!saved.status)
}

/** Read-only bubble shown while the pointer is over a week header. */
export function SummaryTooltip({ win, text, style }) {
  return (
    <div className="week-pop tip" style={style}>
      <h5>{win.name} — expected state</h5>
      <pre>{text}</pre>
      <p className="muted tiny">Click the week to edit</p>
    </div>
  )
}

/** The editable version, opened by clicking a week header. */
export function SummaryEditor({ win, tasks, style, onClose }) {
  const { checkpoints, dispatch } = usePlan()
  const saved = checkpoints[win.id] || {}
  const edited = saved.expected != null
  const text = edited ? saved.expected : compileWindow(win, tasks)
  const set = (patch) => dispatch({ type: 'set-checkpoint', id: win.id, patch })

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows = Math.min(
    18,
    text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 52)), 1)
  )

  return (
    <>
      <div className="week-scrim" onClick={onClose} />
      <div className="week-pop edit" style={style}>
        <header>
          <div>
            <h5>{win.name} — expected state</h5>
            <p className="muted tiny">{label(win.start)} – {label(win.end)}</p>
          </div>
          {edited && (
            <button
              className="link tiny"
              title="Throw away the edit and rebuild this from the plan"
              onClick={() => set({ expected: null })}
            >
              recompile
            </button>
          )}
          <button className="icon-btn tiny" onClick={onClose} title="Close">✕</button>
        </header>

        <textarea
          className="cp-expected"
          rows={rows}
          value={text}
          onChange={(e) => set({ expected: e.target.value })}
        />

        <div className="cp-state">
          <label className="field">
            <span>Current state</span>
            <select value={saved.status || ''} onChange={(e) => set({ status: e.target.value })}>
              {STATES.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <textarea
            rows={3}
            placeholder="Where the project actually is at the end of this window…"
            value={saved.note || ''}
            onChange={(e) => set({ note: e.target.value })}
          />
        </div>
      </div>
    </>
  )
}
