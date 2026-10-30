import { useEffect, useRef, useState } from 'react'
import { NOTE_AUTHORS, authorOf } from '../lib/model.js'
import { Markdown, toggleCheckbox } from '../lib/markdown.jsx'
import { useNotes } from '../lib/notes.jsx'
import { label } from '../lib/dates.js'

/** "20m ago" up to a day, then the date — a note's age is what matters. */
export function when(iso) {
  if (!iso) return ''
  const then = new Date(iso)
  const mins = Math.round((Date.now() - then.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`
  return label(iso.slice(0, 10))
}

/**
 * One sticky note, on the wall or floating. The body is markdown: read mode
 * renders it with live checkboxes, edit mode is the raw text, because a note
 * you cannot see the source of is a note you cannot fix.
 */
export function NoteCard({ note, floating, onFloat, onClose, onAuthorChange, dragHandle }) {
  const { patchNote, removeNote } = useNotes()
  const [editing, setEditing] = useState(!note.body)
  const [draft, setDraft] = useState(note.body)
  const area = useRef(null)
  const owner = authorOf(note.author)
  const everyones = note.author === 'all'

  useEffect(() => {
    if (!editing) setDraft(note.body)
  }, [note.body, editing])

  useEffect(() => {
    if (editing && area.current) {
      area.current.focus()
      area.current.setSelectionRange(draft.length, draft.length)
    }
    // Only when edit mode opens; re-running on every keystroke would fight the
    // cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  const commit = () => {
    setEditing(false)
    if (draft !== note.body) patchNote(note.id, { body: draft })
  }

  return (
    <article
      className={`note${floating ? ' floating' : ''}${everyones ? ' everyones' : ''}`}
      style={{ '--note': owner?.color || 'var(--muted)' }}
    >
      <header className={dragHandle ? 'note-head grip' : 'note-head'} onPointerDown={dragHandle}>
        {dragHandle && <span className="dots">⠿</span>}
        <select
          className="note-author"
          value={note.author}
          title="Who wrote this"
          onChange={(e) =>
            onAuthorChange
              ? onAuthorChange(note, e.target.value)
              : patchNote(note.id, { author: e.target.value })
          }
          onPointerDown={(e) => e.stopPropagation()}
        >
          {NOTE_AUTHORS.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
        <span className="muted tiny" title={`created ${note.createdAt}`}>{label(note.createdAt.slice(0, 10))}</span>
        <span className="spacer" />
        <div className="note-acts" onPointerDown={(e) => e.stopPropagation()}>
          {!floating && (
            <button className="ico" title="Float this note over the app" onClick={() => onFloat(note)}>⧉</button>
          )}
          {floating && (
            <button className="ico" title="Send it back to the wall" onClick={() => onClose(note)}>✕</button>
          )}
          <button
            className="ico danger"
            title="Delete this note"
            onClick={() => confirm('Delete this note for everyone?') && removeNote(note.id)}
          >
            🗑
          </button>
        </div>
      </header>

      {editing ? (
        <textarea
          ref={area}
          className="note-edit"
          rows={Math.max(4, draft.split('\n').length + 1)}
          value={draft}
          placeholder={'Markdown.\n- [ ] a task\n**bold**, `code`, [link](https://…)'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setDraft(note.body)
              setEditing(false)
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit()
          }}
        />
      ) : (
        <div className="note-body" onClick={() => setEditing(true)} title="Click to edit">
          <Markdown body={note.body} onToggle={(i) => patchNote(note.id, { body: toggleCheckbox(note.body, i) })} />
        </div>
      )}

      <footer className="note-foot">
        <span className="muted tiny">
          {everyones ? 'everyone · stays put for all' : owner?.name}
        </span>
        <span className="spacer" />
        <span className="muted tiny">edited {when(note.updatedAt)}</span>
      </footer>
    </article>
  )
}
