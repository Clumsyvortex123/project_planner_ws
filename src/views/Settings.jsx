import { useMemo, useState } from 'react'
import { ACTIVE_OWNERS, OWNER_BY_ID, PLANS, PROJECT, WEEKS, HOLIDAYS, TIMELINE_START, TIMELINE_END, formatConfig } from '../lib/model.js'
import { useConfig } from '../lib/config.jsx'
import { usePlan } from '../lib/store.jsx'
import { label } from '../lib/dates.js'
import { when } from '../components/NoteCard.jsx'

const SOURCE_TEXT = {
  file: 'planner.config.json on the server',
  app: 'edited in the app (overrides planner.config.json)',
  bundled: 'the copy bundled into this build (no server reachable)',
}

/** The one document everything is built from, editable in place. */
function ConfigEditor() {
  const cfg = useConfig()
  const pretty = useMemo(() => formatConfig(cfg.raw), [cfg.raw])
  const [text, setText] = useState(pretty)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const dirty = text !== pretty

  const check = useMemo(() => {
    try {
      const raw = JSON.parse(text)
      const { errors, warnings, model } = cfg.validate(raw)
      return { raw, errors, warnings, model }
    } catch (err) {
      return { errors: [`not valid JSON: ${err.message}`], warnings: [] }
    }
  }, [text, cfg])

  const save = async () => {
    setBusy(true)
    setMessage('')
    try {
      await cfg.save(check.raw)
      setMessage('Saved. Every open board picks it up within a few seconds.')
    } catch (err) {
      setMessage(err.errors ? err.errors.join('\n') : err.message)
    } finally {
      setBusy(false)
    }
  }

  const download = () => {
    const blob = new Blob([text + '\n'], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'planner.config.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const upload = (e) => {
    const file = e.target.files?.[0]
    if (file) file.text().then(setText)
    e.target.value = ''
  }

  return (
    <section className="panel config-panel">
      <header className="panel-head">
        <div>
          <h3>Configuration</h3>
          <p className="muted small">
            Source: {SOURCE_TEXT[cfg.source] || cfg.source}
            {cfg.updatedAt ? ` · updated ${when(cfg.updatedAt)}` : ''}. People, weeks, holidays, leave, tasks and
            scenarios all come from this document — see <code>CONFIG.md</code> for every field.
          </p>
        </div>
      </header>

      <textarea className="config-text" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />

      <div className={`config-check${check.errors.length ? ' bad' : ' good'}`}>
        {check.errors.length ? (
          <>
            <b>{check.errors.length} problem(s) — fix these before saving:</b>
            <ul>{check.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul>
          </>
        ) : (
          <span>
            ✓ Valid — {check.model.ACTIVE_OWNERS.length} people, {check.model.WEEKS.length} weeks,{' '}
            {check.model.TASKS.length} tasks, {check.model.PLANS.length} scenario(s).
          </span>
        )}
        {check.warnings.length > 0 && (
          <ul className="warnings">{check.warnings.slice(0, 10).map((w, i) => <li key={i}>⚠ {w}</li>)}</ul>
        )}
      </div>

      <div className="row wrap">
        <button className="ghost primary" disabled={!dirty || busy || check.errors.length > 0 || cfg.source === 'bundled'} onClick={save}>
          Save for everyone
        </button>
        <button className="ghost" disabled={!dirty} onClick={() => setText(pretty)}>Discard edits</button>
        <button className="ghost" onClick={download}>Download</button>
        <label className="ghost file">
          Load file<input type="file" accept="application/json" onChange={upload} />
        </label>
        {cfg.source === 'app' && (
          <button
            className="ghost"
            onClick={() => confirm('Drop the in-app edits and go back to planner.config.json on the server?') && cfg.revert()}
          >
            Revert to file
          </button>
        )}
        {message && <pre className="muted small config-msg">{message}</pre>}
      </div>
      <p className="muted tiny">
        Saving rebuilds every board. Changes are applied to the plans three-way: a field you change here replaces the
        plan's value only if this document changed it, so dates and edits made on the boards survive. New tasks are
        placed around availability; tasks removed here go to the trash below.
      </p>
    </section>
  )
}

function Trash({ onOpen }) {
  const { trash, tasks, plan, dispatch } = usePlan()
  const present = new Set(tasks.map((t) => t.id))
  const trashed = new Set(trash.map((t) => t.id))
  // Config tasks for this scenario that are on neither the board nor the trash.
  const missing = plan.tasks.filter((t) => !present.has(t.id) && !trashed.has(t.id))

  return (
    <section className="panel">
      <header className="panel-head">
        <h3>Deleted tasks <span className="count">{trash.length}</span></h3>
        {trash.length > 0 && (
          <button className="link" onClick={() => confirm('Empty the trash for everyone?') && dispatch({ type: 'purge-trash' })}>
            empty trash
          </button>
        )}
      </header>
      {trash.length === 0 && missing.length === 0 && <p className="muted small">Nothing deleted in “{plan.label}”.</p>}
      <ul className="trash-list">
        {[...trash].reverse().map((t) => {
          const inConfig = plan.tasks.some((c) => c.id === t.id)
          return (
            <li key={t.id}>
              <span className="dot" style={{ background: OWNER_BY_ID[t.owner]?.color }} />
              <span className="task-name">{t.title}</span>
              <span className="muted tiny">
                {t.reason || 'deleted'} {when(t.deletedAt)}
              </span>
              <span className="spacer" />
              <button
                className="ghost"
                onClick={() => {
                  dispatch({ type: 'restore-task', id: t.id })
                  onOpen(t.id)
                }}
              >
                Restore
              </button>
              {inConfig && (
                <button className="ghost" title="Recreate it as the config describes it, freshly placed" onClick={() => dispatch({ type: 'restore-from-config', id: t.id })}>
                  Recreate from config
                </button>
              )}
              <button className="icon-btn tiny" title="Delete for good" onClick={() => dispatch({ type: 'purge-trash', id: t.id })}>✕</button>
            </li>
          )
        })}
        {missing.map((t) => (
          <li key={t.id}>
            <span className="dot" style={{ background: OWNER_BY_ID[t.owner]?.color }} />
            <span className="task-name">{t.title}</span>
            <span className="muted tiny">in the config, not on the board</span>
            <span className="spacer" />
            <button className="ghost" onClick={() => dispatch({ type: 'restore-from-config', id: t.id })}>Recreate from config</button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Overview() {
  return (
    <section className="panel">
      <header className="panel-head"><h3>{PROJECT.title}</h3></header>
      <dl className="overview">
        <dt>Timeline</dt><dd>{label(TIMELINE_START)} {TIMELINE_START.slice(0, 4)} – {label(TIMELINE_END)} {TIMELINE_END.slice(0, 4)}, {WEEKS.length} weeks</dd>
        <dt>People</dt>
        <dd>
          {ACTIVE_OWNERS.map((o) => (
            <span key={o.id} className="chip chip-sm" style={{ background: o.color, color: o.fg }} title={o.scheduling === 'fixed' ? 'dates are not redrawn around availability' : ''}>
              {o.name}{o.leave.length ? ` · ${o.leave.length}d off` : ''}
            </span>
          ))}
        </dd>
        <dt>Holidays</dt><dd>{HOLIDAYS.length ? HOLIDAYS.map(label).join(', ') : 'none'}</dd>
        <dt>Scenarios</dt><dd>{PLANS.map((p) => `${p.label} (${p.tasks.length} tasks)`).join(' · ')}</dd>
      </dl>
    </section>
  )
}

export function Settings({ onOpen }) {
  return (
    <div className="settings-wrap">
      <div className="settings-col">
        <Overview />
        <Trash onOpen={onOpen} />
      </div>
      <ConfigEditor />
    </div>
  )
}
