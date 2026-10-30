import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { CONFIG_VERSION, DEFAULT_PLAN, PLAN_BY_ID, PLANS, SETTINGS, storageKey } from './model.js'
import { planEdit, seedDoc } from './planReducer.js'
import { Conflict, fetchPlan, savePlan } from './api.js'
import { mergePlans } from './merge.js'

// The plan lives on the server; localStorage is only a mirror, so the app still
// shows the last known board when the network is down instead of a blank page.
const mirrorKey = (planId) => storageKey(`plan-${planId}-v3`)
const ACTIVE_KEY = () => storageKey('active-plan')
const RIPPLE_KEY = () => storageKey('ripple')

const docOf = (s) => ({ tasks: s.tasks, checkpoints: s.checkpoints, trash: s.trash, meta: s.meta })

function readLocal(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage blocked — the server copy is the real one anyway */
  }
}

function startingPoint(planId, ripple) {
  const local = readLocal(mirrorKey(planId))
  const usable = local && Array.isArray(local.tasks) && local.tasks.length
  const doc = usable
    ? { tasks: local.tasks, checkpoints: local.checkpoints || {}, trash: local.trash || [], meta: local.meta || null }
    : seedDoc(planId)
  return {
    planId,
    ...doc,
    // Version 0 means "never synced with the server", which is also what a
    // brand new plan looks like — so the first save creates it.
    version: usable ? local.version ?? 0 : 0,
    base: doc,
    // Only edits made offline make a browser save on load.
    dirty: usable ? !!local.dirty : false,
    rev: 0,
    past: [],
    future: [],
    ripple,
    sync: { state: 'loading' },
  }
}

function initialPlan() {
  const fromHash = location.hash.replace('#', '').split('/')[0]
  if (PLAN_BY_ID[fromHash]) return fromHash
  const saved = readLocal(ACTIVE_KEY())
  if (saved && PLAN_BY_ID[saved]) return saved
  return DEFAULT_PLAN
}

function reducer(state, action) {
  // Anything answering a request carries the plan it was made for; a reply that
  // lands after the user switched plans must not be applied to the other one.
  if (action.planId && action.type !== 'switch-plan' && action.planId !== state.planId) return state

  switch (action.type) {
    case 'switch-plan':
      if (action.planId === state.planId || !PLAN_BY_ID[action.planId]) return state
      return startingPoint(action.planId, state.ripple)

    case 'set-ripple':
      writeLocal(RIPPLE_KEY(), action.on)
      return { ...state, ripple: action.on }

    // The server's copy, adopted wholesale: nothing local was in flight.
    case 'hydrate': {
      const doc = {
        tasks: action.doc.tasks,
        checkpoints: action.doc.checkpoints || {},
        trash: action.doc.trash || [],
        meta: action.doc.meta || null,
      }
      return { ...state, ...doc, version: action.doc.version, base: doc, dirty: false, sync: action.sync || { state: 'synced' } }
    }

    // A merge of the server's copy with local edits — still unsaved.
    case 'merged':
      return {
        ...state,
        ...action.merged,
        version: action.version,
        base: action.server,
        dirty: true,
        rev: state.rev + 1,
        sync: action.sync,
      }

    case 'saved':
      return {
        ...state,
        version: action.version,
        base: action.snapshot,
        // An edit made while the request was in flight keeps the plan dirty.
        dirty: state.rev !== action.rev,
        sync: state.rev !== action.rev ? state.sync : { state: 'synced' },
      }

    case 'sync':
      return { ...state, sync: action.sync }

    default:
      return planEdit(state, action)
  }
}

const Ctx = createContext(null)

export function PlanProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, null, () => startingPoint(initialPlan(), readLocal(RIPPLE_KEY()) ?? true))

  // The sync loop reads the latest state without being re-created for every
  // keystroke, which would restart its timers.
  const ref = useRef(state)
  ref.current = state
  const inFlight = useRef(false)

  useEffect(() => {
    writeLocal(mirrorKey(state.planId), { ...docOf(state), version: state.version, dirty: state.dirty })
    writeLocal(ACTIVE_KEY(), state.planId)
  }, [state.planId, state.tasks, state.checkpoints, state.trash, state.meta, state.version, state.dirty])

  const save = useCallback(async () => {
    const now = ref.current
    if (inFlight.current || !now.dirty) return
    inFlight.current = true
    const { planId, rev } = now
    const snapshot = docOf(now)

    dispatch({ type: 'sync', sync: { state: 'saving' } })
    try {
      const res = await savePlan(planId, { baseVersion: now.version, ...snapshot })
      dispatch({ type: 'saved', planId, version: res.version, rev, snapshot })
    } catch (err) {
      if (err instanceof Conflict) {
        // Somebody saved first. Replay both sides against the version we
        // started from; the merge is saved by the next tick.
        const live = ref.current
        if (live.planId !== planId) return
        const server = {
          tasks: err.current.tasks,
          checkpoints: err.current.checkpoints || {},
          trash: err.current.trash || [],
          meta: err.current.meta || null,
        }
        const merged = mergePlans(live.base, docOf(live), server)
        dispatch({
          type: 'merged',
          planId,
          merged: { tasks: merged.tasks, checkpoints: merged.checkpoints, trash: merged.trash, meta: merged.meta },
          version: err.current.version,
          server,
          sync: {
            state: 'merged',
            message: merged.conflicts.length
              ? `merged with a change from someone else — yours kept on ${merged.conflicts.length} item(s)`
              : 'merged with a change from someone else',
          },
        })
      } else {
        dispatch({ type: 'sync', planId, sync: { state: 'offline', message: err.message } })
      }
    } finally {
      inFlight.current = false
    }
  }, [])

  const pull = useCallback(async () => {
    const now = ref.current
    if (inFlight.current || now.dirty) return
    const { planId } = now
    try {
      const doc = await fetchPlan(planId)
      // Re-check after the wait: an edit made while the request was out must
      // not be overwritten by what the server had before it.
      const live = ref.current
      if (live.planId !== planId || live.dirty || inFlight.current) return
      if (!doc) {
        // Never stored: this browser's copy becomes the first version.
        inFlight.current = true
        dispatch({ type: 'sync', sync: { state: 'saving' } })
        try {
          const snapshot = docOf(live)
          const res = await savePlan(planId, { baseVersion: 0, ...snapshot })
          dispatch({ type: 'saved', planId, version: res.version, rev: live.rev, snapshot })
        } finally {
          inFlight.current = false
        }
        return
      }
      if (doc.version !== live.version) dispatch({ type: 'hydrate', planId, doc })
      else dispatch({ type: 'sync', planId, sync: { state: 'synced' } })
    } catch (err) {
      dispatch({ type: 'sync', planId, sync: { state: 'offline', message: err.message } })
    }
  }, [])

  useEffect(() => {
    pull()
  }, [state.planId, pull])

  // Save shortly after the last edit, rather than on every keystroke.
  useEffect(() => {
    if (!state.dirty) return undefined
    const id = setTimeout(save, SETTINGS.saveDebounceMs)
    return () => clearTimeout(id)
  }, [state.dirty, state.rev, save])

  // Keep in step with everyone else: pick up their saves, retry ours.
  useEffect(() => {
    const id = setInterval(() => {
      if (ref.current.dirty) save()
      else pull()
    }, SETTINGS.pollMs)
    return () => clearInterval(id)
  }, [save, pull])

  // The config changed since this plan last looked at it: bring the plan in
  // line (new tasks in, removed ones to the trash, changed fields applied).
  // Only on a clean, synced plan, so it lands on top of the latest server copy.
  useEffect(() => {
    if (state.dirty || state.sync.state !== 'synced') return
    if (state.meta?.configVersion !== CONFIG_VERSION) dispatch({ type: 'sync-config' })
  }, [state.dirty, state.sync.state, state.meta])

  const value = useMemo(
    () => ({
      planId: state.planId,
      plan: PLAN_BY_ID[state.planId],
      plans: PLANS,
      tasks: state.tasks,
      trash: state.trash,
      checkpoints: state.checkpoints,
      sync: state.sync,
      ripple: state.ripple,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
      undoLabel: state.past[state.past.length - 1]?.label,
      redoLabel: state.future[state.future.length - 1]?.label,
      dispatch,
    }),
    [state]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePlan() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePlan must be used inside <PlanProvider>')
  return ctx
}

export function sortTasks(list) {
  return [...list].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.start).localeCompare(String(b.start))
  )
}

/** A fresh id for a task made in the app; never collides with config ids. */
export const newTaskId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
