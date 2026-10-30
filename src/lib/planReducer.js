// Every change to a plan, as a pure function of (state, action).
//
// Kept apart from the React provider (store.jsx) so it can be exercised from
// node, and so every page goes through exactly the same rules: a task dragged
// on the Gantt, dropped on the Calendar, placed on an Availability lane or
// re-dated in the drawer is re-dated here, the same way, with the same ripple.

import { PLAN_BY_ID, WEEK_BY_ID, CONFIG_VERSION } from './model.js'
import {
  autoSchedule,
  effortDaysOf,
  leaveFirstSchedule,
  placeAt,
  shiftWorkdays,
  weekOfDate,
  workdaysBetween,
  workdaysIn,
} from './schedule.js'

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const HISTORY = 100

/* ---- seeding from the config -------------------------------------------- */

// The fields the config owns. A sync applies a config change to one of these
// only when the config itself changed it, so edits made in the app survive.
export const CONFIG_FIELDS = ['title', 'owner', 'week', 'tag', 'milestone', 'area', 'outcome', 'flags', 'start', 'end', 'extendUntil', 'configEffort', 'pinned', 'subtasks']

function fromConfig(t, i) {
  const { effortDays, notes, ...rest } = t
  return {
    done: false,
    tag: '',
    order: i,
    ...rest,
    notes: notes || '',
    ...(effortDays ? { configEffort: effortDays } : {}),
    subtasks: (t.subtasks || []).map((title) => ({ title, done: false })),
  }
}

/** What the config says about each task, remembered so the next sync can tell what changed. */
function snapshotOf(planId) {
  const out = {}
  for (const t of PLAN_BY_ID[planId].tasks) {
    const c = fromConfig(t, 0)
    out[t.id] = Object.fromEntries(CONFIG_FIELDS.map((f) => [f, f === 'subtasks' ? t.subtasks : c[f]]))
  }
  return out
}

/** A plan built fresh from the config: every task placed around availability. */
export function seedTasks(planId) {
  const base = PLAN_BY_ID[planId].tasks.map(fromConfig)
  return leaveFirstSchedule(autoSchedule(base))
}

export function seedDoc(planId) {
  return {
    tasks: seedTasks(planId),
    checkpoints: {},
    trash: [],
    meta: { configVersion: CONFIG_VERSION, snapshot: snapshotOf(planId) },
  }
}

/**
 * Bring a plan in line with a changed config, three-way: for each field the
 * config owns, the config's value wins only if it differs from what the config
 * said last time. New config tasks are added (placed as a fresh seed would place
 * them), tasks dropped from the config go to the trash, and tasks created in the
 * app are left alone.
 */
export function syncWithConfig(doc, planId) {
  const prev = doc.meta?.snapshot
  const snapshot = snapshotOf(planId)
  const meta = { ...(doc.meta || {}), configVersion: CONFIG_VERSION, snapshot }
  // A plan from before snapshots were kept: adopt the config as its baseline.
  if (!prev) return { ...doc, meta }

  const fresh = new Map(seedTasks(planId).map((t) => [t.id, t]))
  const now = new Date().toISOString()
  const trash = [...(doc.trash || [])]
  const tasks = []

  for (const t of doc.tasks) {
    const c = snapshot[t.id]
    if (!c) {
      if (prev[t.id]) trash.push({ ...t, deletedAt: now, reason: 'removed from config' })
      else tasks.push(t)
      continue
    }
    const was = prev[t.id] || {}
    const u = { ...t }
    let replace = false
    let touched = false
    for (const f of CONFIG_FIELDS) {
      if (same(c[f], was[f])) continue
      touched = true
      if (f === 'subtasks') {
        const done = new Map((t.subtasks || []).map((s) => [s.title, s.done]))
        u.subtasks = (c.subtasks || []).map((title) => ({ title, done: !!done.get(title) }))
      } else if (c[f] === undefined) delete u[f]
      else u[f] = c[f]
      if (['owner', 'week', 'start', 'end', 'extendUntil', 'configEffort'].includes(f)) replace = true
    }
    // The config moved it: take the dates a fresh redraw would give it.
    if (replace && fresh.has(t.id)) {
      const f = fresh.get(t.id)
      Object.assign(u, { start: f.start, end: f.end, effortDays: f.effortDays })
    }
    // Untouched tasks keep their identity, so the sync is not an edit to them.
    tasks.push(touched ? u : t)
  }

  const have = new Set(doc.tasks.map((t) => t.id))
  for (const [id, f] of fresh) {
    if (have.has(id) || prev[id]) continue // present, or deliberately deleted in the app
    tasks.push({ ...f, order: tasks.length })
  }
  return { ...doc, tasks, trash, meta }
}

/* ---- undo ---------------------------------------------------------------- */
//
// A step records only what changed, per task and per week note, so undoing it
// restores those items and nothing else — someone else's edits that arrived in
// between are left standing.

function diffList(before, after) {
  const a = new Map(before.map((t) => [t.id, t]))
  const b = new Map(after.map((t) => [t.id, t]))
  const out = []
  for (const [id, t] of a) if (b.get(id) !== t) out.push([id, t, b.get(id) || null])
  for (const [id, t] of b) if (!a.has(id)) out.push([id, null, t])
  return out
}

function diffMap(before, after) {
  const out = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] !== after[k]) out.push([k, before[k] ?? null, after[k] ?? null])
  }
  return out
}

function applyList(list, entries, back) {
  const out = list.slice()
  for (const [id, prev, next] of entries) {
    const want = back ? prev : next
    const i = out.findIndex((t) => t.id === id)
    if (!want) {
      if (i >= 0) out.splice(i, 1)
    } else if (i >= 0) out[i] = want
    else out.push(want)
  }
  return out
}

function applyMap(map, entries, back) {
  const out = { ...map }
  for (const [k, prev, next] of entries) {
    const want = back ? prev : next
    if (want == null) delete out[k]
    else out[k] = want
  }
  return out
}

function replay(state, step, back) {
  return {
    tasks: applyList(state.tasks, step.tasks, back),
    trash: applyList(state.trash, step.trash, back),
    checkpoints: applyMap(state.checkpoints, step.checkpoints, back),
  }
}

/* ---- re-dating ----------------------------------------------------------- */

/**
 * After `moved` changed from `before`, push (or pull) the owner's later work by
 * the same number of their working days. "Later" is anything that started after
 * the moved task used to end, so work running alongside it stays put.
 */
function ripple(tasks, before, moved) {
  if (!before.start || !before.end || !moved.end || before.owner !== moved.owner) return tasks
  const delta = workdaysBetween(moved.owner, before.end, moved.end)
  if (!delta) return tasks
  return tasks.map((t) => {
    if (t.id === moved.id || t.owner !== moved.owner || !t.start || t.start <= before.end || t.done) return t
    const effortDays = t.effortDays || workdaysIn(t.owner, t.start, t.end) || effortDaysOf(t)
    const next = placeAt({ ...t, effortDays }, shiftWorkdays(t.owner, t.start, delta))
    return { ...t, ...next }
  })
}

/** Apply `fn` to one task, then ripple the owner's later work if asked. */
function redate(tasks, id, fn, withRipple) {
  let before = null
  let after = null
  const next = tasks.map((t) => {
    if (t.id !== id) return t
    before = t
    after = fn(t)
    return after
  })
  if (!after) return tasks
  return withRipple ? ripple(next, before, after) : next
}

/** The task's own length in its owner's working days, so moving it never resizes it. */
const lengthOf = (t) => (t.start ? workdaysIn(t.owner, t.start, t.end) || effortDaysOf(t) : effortDaysOf(t))

/* ---- the edits ----------------------------------------------------------- */

function edit(state, action) {
  const { tasks, checkpoints, trash, planId, ripple: rip } = state
  const map = (fn) => tasks.map((t) => (t.id === action.id ? fn(t) : t))
  const now = () => new Date().toISOString()

  switch (action.type) {
    case 'patch':
      return { tasks: map((t) => ({ ...t, ...action.patch })) }

    case 'move-to-week': {
      // Into another week: placed from that week's start on the owner's free
      // days, keeping its length. The week is remembered as its planned week.
      const week = WEEK_BY_ID[action.week]
      if (!week) return null
      return {
        tasks: redate(
          tasks,
          action.id,
          (t) => ({ ...t, ...placeAt({ ...t, effortDays: lengthOf(t) }, week.start), week: week.id, order: action.order ?? t.order }),
          rip
        ),
      }
    }

    case 'move-to-owner':
      // Handing work over keeps its start and length, on the new owner's calendar.
      return {
        tasks: map((t) => {
          const next = { ...t, owner: action.owner, order: action.order ?? t.order }
          return t.start ? { ...next, ...placeAt({ ...next, effortDays: lengthOf(t) }, t.start) } : next
        }),
      }

    case 'reorder': {
      const rank = new Map(action.ids.map((id, i) => [id, i]))
      return { tasks: tasks.map((t) => (rank.has(t.id) ? { ...t, order: rank.get(t.id) } : t)) }
    }

    case 'set-dates':
      // Exact dates, as typed or as an edge was dragged.
      return {
        tasks: redate(
          tasks,
          action.id,
          (t) => {
            const start = action.start ?? t.start ?? action.end
            let end = action.end ?? t.end ?? start
            if (end < start) end = start
            return { ...t, start, end, week: weekOfDate(start), effortDays: workdaysIn(t.owner, start, end) || 1 }
          },
          rip
        ),
      }

    case 'shift':
      // Moved to start on a day, keeping its length in working days.
      return {
        tasks: redate(
          tasks,
          action.id,
          (t) => {
            const next = placeAt({ ...t, effortDays: lengthOf(t) }, action.start)
            return { ...t, ...next, week: weekOfDate(next.start) }
          },
          rip
        ),
      }

    case 'place':
      // Dropped on a lane: lands on the owner's next free day; another person's
      // lane hands it over.
      return {
        tasks: redate(
          tasks,
          action.id,
          (t) => {
            const owner = action.owner ?? t.owner
            const next = placeAt({ ...t, owner, effortDays: lengthOf(t) }, action.day)
            return { ...t, owner, ...next, week: weekOfDate(next.start) }
          },
          rip && !action.owner
        ),
      }

    case 'set-effort':
      // Change how many working days a task is worth; it keeps its start.
      return {
        tasks: redate(
          tasks,
          action.id,
          (t) => {
            const effortDays = Math.max(1, Math.round(action.days))
            return t.start ? { ...t, ...placeAt({ ...t, effortDays }, t.start) } : { ...t, effortDays }
          },
          rip
        ),
      }

    case 'reschedule': {
      // Bulk: move every matching task by N working days of its owner.
      const owners = action.owners?.length ? new Set(action.owners) : null
      return {
        tasks: tasks.map((t) => {
          if (!t.start || (owners && !owners.has(t.owner)) || t.start < action.from || (action.skipDone && t.done)) return t
          const next = placeAt({ ...t, effortDays: lengthOf(t) }, shiftWorkdays(t.owner, t.start, action.days))
          return { ...t, ...next, week: action.keepWeeks ? t.week : weekOfDate(next.start) }
        }),
      }
    }

    case 'unschedule':
      return { tasks: map((t) => ({ ...t, effortDays: lengthOf(t), start: null, end: null })) }

    case 'clear-dates':
      return { tasks: tasks.map((t) => ({ ...t, effortDays: lengthOf(t), start: null, end: null })) }

    case 'autofill':
      // Redraw everyone from their planned weeks; unscheduled tasks get dates too.
      return { tasks: leaveFirstSchedule(autoSchedule(tasks)) }

    /* ---- subtasks ---- */

    case 'toggle-sub':
      return { tasks: map((t) => ({ ...t, subtasks: t.subtasks.map((s, i) => (i === action.index ? { ...s, done: !s.done } : s)) })) }

    case 'add-sub':
      return { tasks: map((t) => ({ ...t, subtasks: [...t.subtasks, { title: action.title, done: false }] })) }

    case 'rename-sub':
      return { tasks: map((t) => ({ ...t, subtasks: t.subtasks.map((s, i) => (i === action.index ? { ...s, title: action.title } : s)) })) }

    case 'remove-sub':
      return { tasks: map((t) => ({ ...t, subtasks: t.subtasks.filter((_, i) => i !== action.index) })) }

    /* ---- creating, copying, deleting, recreating ---- */

    case 'add-task': {
      const week = WEEK_BY_ID[action.week]
      const t = {
        id: action.id,
        title: action.title || 'New task',
        owner: action.owner,
        week: action.week,
        done: false,
        notes: '',
        tag: '',
        subtasks: [],
        order: tasks.length,
        effortDays: action.effortDays || 1,
      }
      const at = action.start || week?.start
      return { tasks: [...tasks, at ? { ...t, ...placeAt(t, at), week: weekOfDate(placeAt(t, at).start) } : t] }
    }

    case 'duplicate': {
      const src = tasks.find((t) => t.id === action.id)
      if (!src) return null
      const copy = {
        ...src,
        id: action.newId,
        title: `${src.title} (copy)`,
        done: false,
        pinned: false,
        subtasks: src.subtasks.map((s) => ({ ...s, done: false })),
        order: (src.order ?? 0) + 0.5,
      }
      return { tasks: [...tasks, copy] }
    }

    case 'delete-task': {
      const t = tasks.find((x) => x.id === action.id)
      if (!t) return null
      return { tasks: tasks.filter((x) => x.id !== action.id), trash: [...trash.filter((x) => x.id !== t.id), { ...t, deletedAt: now() }] }
    }

    case 'restore-task': {
      const t = trash.find((x) => x.id === action.id)
      if (!t || tasks.some((x) => x.id === t.id)) return null
      const { deletedAt, reason, ...rest } = t
      return { tasks: [...tasks, rest], trash: trash.filter((x) => x.id !== t.id) }
    }

    case 'purge-trash':
      return { trash: action.id ? trash.filter((x) => x.id !== action.id) : [] }

    case 'restore-from-config': {
      // Recreate a task exactly as the config describes it, placed as a fresh
      // redraw would place it. Works for a task that was deleted, too.
      const fresh = seedTasks(planId).find((t) => t.id === action.id)
      if (!fresh) return null
      const exists = tasks.some((t) => t.id === action.id)
      return {
        tasks: exists ? tasks.map((t) => (t.id === action.id ? { ...fresh, order: t.order } : t)) : [...tasks, fresh],
        trash: trash.filter((x) => x.id !== action.id),
      }
    }

    case 'replace':
      return {
        tasks: action.tasks,
        ...(action.checkpoints ? { checkpoints: action.checkpoints } : {}),
        ...(action.trash ? { trash: action.trash } : {}),
      }

    case 'reset': {
      const seeded = seedDoc(planId)
      return { tasks: seeded.tasks, checkpoints: {}, trash: [], meta: seeded.meta }
    }

    case 'sync-config': {
      const synced = syncWithConfig({ tasks, checkpoints, trash, meta: state.meta }, planId)
      return { tasks: synced.tasks, trash: synced.trash, meta: synced.meta }
    }

    // Week and block notes live beside the tasks: a note on a window of time
    // survives re-dating and re-planning.
    case 'set-checkpoint':
      return { checkpoints: { ...checkpoints, [action.id]: { ...(checkpoints[action.id] || {}), ...action.patch } } }

    default:
      return null
  }
}

/** The plan-editing part of the store's state transition. Returns state unchanged for unknown actions. */
export function planEdit(state, action) {
  if (action.type === 'undo' || action.type === 'redo') {
    const back = action.type === 'undo'
    const from = back ? state.past : state.future
    if (!from.length) return state
    const step = from[from.length - 1]
    return {
      ...state,
      ...replay(state, step, back),
      past: back ? state.past.slice(0, -1) : [...state.past, step],
      future: back ? [...state.future, step] : state.future.slice(0, -1),
      dirty: true,
      rev: state.rev + 1,
    }
  }

  const out = edit(state, action)
  if (!out) return state
  const next = {
    tasks: out.tasks ?? state.tasks,
    checkpoints: out.checkpoints ?? state.checkpoints,
    trash: out.trash ?? state.trash,
  }
  const step = {
    label: action.type,
    tasks: diffList(state.tasks, next.tasks),
    trash: diffList(state.trash, next.trash),
    checkpoints: diffMap(state.checkpoints, next.checkpoints),
  }
  const metaChanged = out.meta && !same(out.meta, state.meta)
  if (!step.tasks.length && !step.trash.length && !step.checkpoints.length && !metaChanged) return state

  // Typing into one field is one undo step, not one per keystroke.
  const last = state.past[state.past.length - 1]
  const coalesce =
    action.type === 'patch' &&
    last?.label === 'patch' &&
    last.key === `${action.id}:${Object.keys(action.patch).join()}` &&
    Date.now() - last.at < 1500
  const keyed = { ...step, key: action.type === 'patch' ? `${action.id}:${Object.keys(action.patch).join()}` : '', at: Date.now() }
  let past
  if (coalesce) {
    const merged = { ...keyed, tasks: keyed.tasks.map(([id, , n]) => [id, last.tasks.find((e) => e[0] === id)?.[1] ?? null, n]) }
    past = [...state.past.slice(0, -1), merged]
  } else past = [...state.past, keyed].slice(-HISTORY)

  return {
    ...state,
    ...next,
    meta: out.meta ?? state.meta,
    past: step.tasks.length || step.trash.length || step.checkpoints.length ? past : state.past,
    future: [],
    dirty: true,
    rev: state.rev + 1,
  }
}
