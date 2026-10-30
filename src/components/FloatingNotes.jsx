import { useRef } from 'react'
import { useNotes } from '../lib/notes.jsx'
import { NoteCard } from './NoteCard.jsx'

/**
 * Notes lifted off the wall, floating over whatever view is open.
 *
 * Rendered above the views rather than inside one, so switching Board → Gantt
 * leaves them exactly where they are. Two kinds sit here together:
 *
 *   a person's note — floats for you alone, position in localStorage
 *   an "all" note   — floats for everyone, position stored on the note itself,
 *                     so it is in the same corner on every machine until
 *                     somebody moves or dismisses it
 */
export function FloatingNotes({ floating, setFloating, onAuthorChange }) {
  const { notes, floatNote, unfloatNote } = useNotes()
  const drag = useRef(null)

  // A position saved on a wide screen must not put a note off a narrow one, so
  // it is clamped when drawn. The stored value is left alone.
  const onScreen = (at) => ({
    x: Math.max(8, Math.min(at.x, Math.max(8, window.innerWidth - 120))),
    y: Math.max(8, Math.min(at.y, Math.max(8, window.innerHeight - 60))),
  })

  const shared = notes.filter((n) => n.author === 'all' && n.float)
  const mine = notes.filter((n) => n.author !== 'all' && floating[n.id])
  const open = [
    ...shared.map((n) => ({ note: n, at: n.float, everyones: true })),
    ...mine.map((n) => ({ note: n, at: floating[n.id], everyones: false })),
  ]

  const move = (note, everyones, at) => {
    if (everyones) floatNote(note.id, at)
    else setFloating((f) => ({ ...f, [note.id]: at }))
  }

  const close = (note) => {
    if (note.author === 'all') {
      unfloatNote(note.id)
      return
    }
    setFloating((f) => {
      const next = { ...f }
      delete next[note.id]
      return next
    })
  }

  const startDrag = (note, everyones, at) => (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const from = onScreen(at)
    drag.current = { dx: e.clientX - from.x, dy: e.clientY - from.y }

    const onMove = (ev) => {
      const d = drag.current
      if (!d) return
      move(note, everyones, onScreen({ x: ev.clientX - d.dx, y: ev.clientY - d.dy }))
    }
    const up = () => {
      drag.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', up)
  }

  return (
    <>
      {open.map(({ note, at, everyones }) => {
        const pos = onScreen(at)
        return (
          <div className="float-note" key={note.id} style={{ left: pos.x, top: pos.y }}>
            <NoteCard
              note={note}
              floating
              onClose={close}
              onAuthorChange={onAuthorChange}
              dragHandle={startDrag(note, everyones, at)}
            />
          </div>
        )
      })}
    </>
  )
}
