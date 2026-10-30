import { useMemo } from 'react'
import { NOTE_AUTHORS } from '../lib/model.js'
import { useNotes, writeAuthor } from '../lib/notes.jsx'
import { NoteCard } from '../components/NoteCard.jsx'

const SORTS = [
  { id: 'edited', name: 'Last edited', key: (n) => n.updatedAt },
  { id: 'created', name: 'Created', key: (n) => n.createdAt },
]

/** The wall: every note, newest first, in a masonry of columns. */
export function Notes({ query, author, setAuthor, sort, setSort, floating, onFloat, onAuthorChange }) {
  const { notes, addNote } = useNotes()

  const visible = useMemo(() => {
    const by = SORTS.find((s) => s.id === sort) || SORTS[0]
    return notes
      .filter((n) => !query || n.body.toLowerCase().includes(query.toLowerCase()))
      .slice()
      .sort((a, b) => String(by.key(b)).localeCompare(String(by.key(a))))
  }, [notes, query, sort])

  return (
    <div className="notes-wrap">
      <div className="subbar">
        <button className="ghost primary" onClick={() => addNote(author)}>+ New note</button>
        <span className="muted small">as</span>
        <div className="seg">
          {NOTE_AUTHORS.map((o) => (
            <button
              key={o.id}
              className={author === o.id ? 'on' : ''}
              onClick={() => {
                setAuthor(o.id)
                writeAuthor(o.id)
              }}
            >
              <span className="dot" style={{ background: o.color }} /> {o.name}
            </button>
          ))}
        </div>
        <span className="muted small">Sort</span>
        <div className="seg">
          {SORTS.map((s) => (
            <button key={s.id} className={sort === s.id ? 'on' : ''} onClick={() => setSort(s.id)}>
              {s.name}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <span className="muted small">
          Markdown, checkboxes included. ⧉ floats a note over any view — an <b>All</b> note floats
          in the same place for everyone, on every machine.
        </span>
      </div>

      <div className="wall">
        {visible.map((n) => (
          <div className="wall-item" key={n.id}>
            <NoteCard note={n} onFloat={onFloat} onAuthorChange={onAuthorChange} />
            {(n.author === 'all' ? n.float : floating[n.id]) && (
              <span className="muted tiny floating-hint">
                {n.author === 'all' ? 'floating for everyone' : 'floating'}
              </span>
            )}
          </div>
        ))}

        <button className="wall-item note new-note" onClick={() => addNote(author)}>
          <span className="muted small">+ write a note…</span>
          <span className="muted tiny">markdown · <code>- [ ] task</code> makes a checkbox</span>
        </button>
      </div>

      {notes.length === 0 && (
        <p className="muted small empty-wall">
          Nothing on the wall yet. Notes are shared with everyone on this server, like the plan.
        </p>
      )}
    </div>
  )
}
