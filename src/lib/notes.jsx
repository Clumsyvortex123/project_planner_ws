import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { Conflict, fetchNotes, saveNotes } from './api.js'
import { mergeNotes } from './merge.js'
import { SETTINGS, storageKey } from './model.js'

// The wall is one document for the whole project, not one per plan — a note
// about the wifi card is not about a scenario. It syncs exactly like a plan:
// debounce a save after the last edit, poll for everyone else's, merge on 409.
const MIRROR = () => storageKey('notes-v1')
const AUTHOR_KEY = () => storageKey('note-author')

const now = () => new Date().toISOString()

function readMirror() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MIRROR()) || 'null')
    if (!parsed || !Array.isArray(parsed.notes)) return null
    return { notes: parsed.notes, version: parsed.version ?? 0, dirty: !!parsed.dirty }
  } catch {
    return null
  }
}

function writeMirror(doc) {
  try {
    localStorage.setItem(MIRROR(), JSON.stringify(doc))
  } catch {
    /* storage blocked — the server copy is the real one anyway */
  }
}

/** Who you are writing as. A choice, not a login: there is no auth here. */
export function readAuthor(fallback) {
  try {
    return localStorage.getItem(AUTHOR_KEY()) || fallback
  } catch {
    return fallback
  }
}

export function writeAuthor(id) {
  try {
    localStorage.setItem(AUTHOR_KEY(), id)
  } catch {
    /* ignore */
  }
}

function start() {
  const local = readMirror()
  const notes = local ? local.notes : []
  return {
    notes,
    version: local ? local.version : 0,
    base: notes,
    dirty: local ? local.dirty : false,
    rev: 0,
    sync: { state: 'loading' },
  }
}

function reducer(state, action) {
  const touch = (notes) => ({ ...state, notes, dirty: true, rev: state.rev + 1 })

  switch (action.type) {
    case 'add':
      return touch([
        { id: action.id, author: action.author, body: action.body || '', createdAt: now(), updatedAt: now() },
        ...state.notes,
      ])

    case 'patch':
      return touch(
        state.notes.map((n) => (n.id === action.id ? { ...n, ...action.patch, updatedAt: now() } : n))
      )

    case 'remove':
      return touch(state.notes.filter((n) => n.id !== action.id))

    // Where an "all" note floats belongs to the note, not to the viewer — so it
    // is stored and shared like the text. Moving one is not editing it, so
    // updatedAt deliberately does not move.
    case 'float':
      return touch(state.notes.map((n) => (n.id === action.id ? { ...n, float: action.at } : n)))

    case 'unfloat':
      return touch(
        state.notes.map((n) => {
          if (n.id !== action.id) return n
          const { float, ...rest } = n
          return rest
        })
      )

    case 'hydrate':
      return {
        ...state,
        notes: action.doc.notes || [],
        version: action.doc.version,
        base: action.doc.notes || [],
        dirty: false,
        sync: action.sync || { state: 'synced' },
      }

    case 'merged':
      return {
        ...state,
        notes: action.notes,
        version: action.version,
        base: action.serverNotes,
        dirty: true,
        rev: state.rev + 1,
        sync: action.sync,
      }

    case 'saved':
      return {
        ...state,
        version: action.version,
        base: action.snapshot,
        dirty: state.rev !== action.rev,
        sync: state.rev !== action.rev ? state.sync : { state: 'synced' },
      }

    case 'sync':
      return { ...state, sync: action.sync }

    default:
      return state
  }
}

const Ctx = createContext(null)

export function NotesProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, null, start)
  const ref = useRef(state)
  ref.current = state
  const inFlight = useRef(false)

  useEffect(() => {
    writeMirror({ notes: state.notes, version: state.version, dirty: state.dirty })
  }, [state.notes, state.version, state.dirty])

  const save = useCallback(async () => {
    const live = ref.current
    if (inFlight.current || !live.dirty) return
    inFlight.current = true
    const snapshot = live.notes
    const rev = live.rev

    dispatch({ type: 'sync', sync: { state: 'saving' } })
    try {
      const res = await saveNotes({ baseVersion: live.version, notes: snapshot })
      dispatch({ type: 'saved', version: res.version, rev, snapshot })
    } catch (err) {
      if (err instanceof Conflict) {
        const cur = ref.current
        const merged = mergeNotes(cur.base, cur.notes, err.current.notes || [])
        dispatch({
          type: 'merged',
          notes: merged.items,
          version: err.current.version,
          serverNotes: err.current.notes || [],
          sync: {
            state: 'merged',
            message: merged.conflicts.length
              ? `merged — yours kept on ${merged.conflicts.length} note(s)`
              : 'merged with a change from someone else',
          },
        })
      } else {
        dispatch({ type: 'sync', sync: { state: 'offline', message: err.message } })
      }
    } finally {
      inFlight.current = false
    }
  }, [])

  const pull = useCallback(async () => {
    const live = ref.current
    if (inFlight.current || live.dirty) return
    try {
      const doc = await fetchNotes()
      if (doc.version !== ref.current.version) dispatch({ type: 'hydrate', doc })
      else dispatch({ type: 'sync', sync: { state: 'synced' } })
    } catch (err) {
      dispatch({ type: 'sync', sync: { state: 'offline', message: err.message } })
    }
  }, [])

  useEffect(() => {
    pull()
  }, [pull])

  useEffect(() => {
    if (!state.dirty) return undefined
    const id = setTimeout(save, SETTINGS.saveDebounceMs)
    return () => clearTimeout(id)
  }, [state.dirty, state.rev, save])

  useEffect(() => {
    const id = setInterval(() => {
      if (ref.current.dirty) save()
      else pull()
    }, SETTINGS.pollMs)
    return () => clearInterval(id)
  }, [save, pull])

  const value = useMemo(
    () => ({
      notes: state.notes,
      sync: state.sync,
      addNote: (author, body = '') => {
        const id = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
        dispatch({ type: 'add', id, author, body })
        return id
      },
      patchNote: (id, patch) => dispatch({ type: 'patch', id, patch }),
      removeNote: (id) => dispatch({ type: 'remove', id }),
      floatNote: (id, at) => dispatch({ type: 'float', id, at }),
      unfloatNote: (id) => dispatch({ type: 'unfloat', id }),
    }),
    [state.notes, state.sync]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useNotes() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useNotes must be used inside <NotesProvider>')
  return ctx
}

/* ---- floating windows -------------------------------------------------- */
//
// Where a personal note floats is yours alone: the note is shared, but somebody
// else's drag should not move your window, so it lives here rather than on the
// server. An "all" note is the opposite by design — its position is on the note
// (see the `float` action above) and therefore the same for everybody.

const FLOAT_KEY = () => storageKey('notes-floating')

export function readFloating() {
  try {
    return JSON.parse(localStorage.getItem(FLOAT_KEY()) || '{}') || {}
  } catch {
    return {}
  }
}

export function writeFloating(map) {
  try {
    localStorage.setItem(FLOAT_KEY(), JSON.stringify(map))
  } catch {
    /* ignore */
  }
}
