import {
  BLOCKS,
  HOLIDAY_SET,
  LEAVE_SETS,
  PEOPLE,
  TIMELINE_DAYS,
  TIMELINE_END,
  TIMELINE_START,
  WEEKS,
  WEEK_BY_ID,
  WEEK_EFFORT,
  WORKDAYS,
  blockOf,
} from './model.js'
import { addDays, diffDays, dow, range } from './dates.js'

// Re-exported so views have one place to import the timeline from. These are
// live bindings: they follow the model when the config changes.
export { BLOCKS, TIMELINE_DAYS, TIMELINE_END, TIMELINE_START, blockOf }

/** A day nobody works: a listed holiday, or a weekday outside calendar.workdays. */
export function isHoliday(key) {
  return HOLIDAY_SET.has(key) || !WORKDAYS.has(dow(key))
}

export function isLeave(ownerId, key) {
  const set = LEAVE_SETS[ownerId]
  return !!set && set.has(key)
}

export function workdaysOf(week) {
  return range(week.start, week.end).filter((d) => !isHoliday(d))
}

/**
 * Spread each owner's tasks across the working days of the week they sit in.
 * Days the owner is on leave are skipped where possible. Used for owners whose
 * scheduling is "fixed" (a vendor, a bucket), and as the first pass for everyone.
 */
export function autoSchedule(tasks) {
  const out = tasks.map((t) => ({ ...t }))
  for (const week of WEEKS) {
    const days = workdaysOf(week)
    if (!days.length) continue
    const byOwner = new Map()
    for (const t of out) {
      if (t.week !== week.id) continue
      if (!byOwner.has(t.owner)) byOwner.set(t.owner, [])
      byOwner.get(t.owner).push(t)
    }
    for (const [owner, list] of byOwner) {
      const free = days.filter((d) => !isLeave(owner, d))
      const pool = free.length ? free : days
      const n = list.length
      list.forEach((t, i) => {
        const a = Math.floor((i * pool.length) / n)
        const b = Math.max(a, Math.floor(((i + 1) * pool.length) / n) - 1)
        t.start = t.start || pool[a]
        t.end = t.end || pool[b]
      })
    }
  }
  for (const t of out) {
    const w = WEEK_BY_ID[t.week] || WEEKS[0]
    if (!t.start) t.start = w.start
    if (!t.end) t.end = w.end
  }
  return out
}

/* ---------------------------------------------------------------------------
 * Availability
 * ------------------------------------------------------------------------- */

/** Can this owner work on this day at all? */
export function isAvailable(ownerId, key) {
  return !isHoliday(key) && !isLeave(ownerId, key)
}

/** The next day on or after `from` that the owner can work. */
export function nextAvailable(ownerId, from, limit = addDays(TIMELINE_END, 366)) {
  let d = from
  while (d <= limit && !isAvailable(ownerId, d)) d = addDays(d, 1)
  return d
}

/** The last day on or before `from` that the owner can work. */
export function prevAvailable(ownerId, from, limit = addDays(TIMELINE_START, -366)) {
  let d = from
  while (d >= limit && !isAvailable(ownerId, d)) d = addDays(d, -1)
  return d
}

/** Working days the owner has in [a, b], inclusive. */
export function workdaysIn(ownerId, a, b) {
  if (!a || !b || b < a) return 0
  return range(a, b).filter((d) => isAvailable(ownerId, d)).length
}

/** Signed number of the owner's working days from `a` to `b` (0 if the same day). */
export function workdaysBetween(ownerId, a, b) {
  if (a === b) return 0
  return b > a ? workdaysIn(ownerId, addDays(a, 1), b) : -workdaysIn(ownerId, addDays(b, 1), a)
}

/** Move `n` of the owner's working days from `day` (negative goes back). */
export function shiftWorkdays(ownerId, day, n) {
  let d = n >= 0 ? nextAvailable(ownerId, day) : prevAvailable(ownerId, day)
  const step = n >= 0 ? 1 : -1
  for (let left = Math.abs(n); left > 0; ) {
    d = addDays(d, step)
    if (isAvailable(ownerId, d)) left -= 1
  }
  return d
}

/** How many working days a task is worth: whatever is stamped on it, else a full week. */
export function effortDaysOf(task) {
  return task.effortDays || WEEK_EFFORT
}

/** Lay a task down from `day`, consuming `effortDays` of the owner's free days. */
export function placeAt(task, day) {
  const need = effortDaysOf(task)
  const start = nextAvailable(task.owner, day)
  let end = start
  let got = 0
  for (let d = start; got < need; d = addDays(d, 1)) {
    if (isAvailable(task.owner, d)) {
      got += 1
      end = d
    }
    if (d > addDays(start, 800)) break // guard against an owner who never works
  }
  return { start, end, effortDays: need }
}

/**
 * A task's span in unbroken runs of days its owner can actually work. Every
 * view draws these segments rather than one solid bar, so nothing is ever drawn
 * across a holiday or the owner's leave.
 */
export function segmentsOf(task) {
  if (!task.start || !task.end) return []
  const out = []
  let run = null
  for (const d of range(task.start, task.end)) {
    if (isAvailable(task.owner, d)) {
      if (run) run.end = d
      else run = { start: d, end: d }
    } else if (run) {
      out.push(run)
      run = null
    }
  }
  if (run) out.push(run)
  return out
}

/**
 * Redraw the plan on real calendar days, one person at a time.
 *
 * Each person works their weeks in the order the config lists them, and
 * everything inside one week runs alongside everything else in it. A week is
 * worth calendar.weekEffortDays of that person's working days (or the task's
 * own `effortDays` when the config gives one), starting on their first free day
 * on or after the week begins. If leave pushes it past the week, the weeks after
 * it are pushed too: the sequence stays intact and lands later. A task's
 * `extendUntil` runs it to that date and pushes the chain the same way.
 *
 * Pinned tasks (dates written in the config) and owners whose scheduling is
 * "fixed" keep the dates they already have.
 */
export function leaveFirstSchedule(tasks) {
  const placed = new Map()

  for (const owner of PEOPLE) {
    let cursor = TIMELINE_START
    for (const week of WEEKS) {
      const group = tasks.filter((t) => t.owner === owner && t.week === week.id && !t.pinned)
      if (!group.length) continue

      const from = week.start > cursor ? week.start : cursor
      let groupEnd = null
      for (const t of group) {
        const span = placeAt({ owner, effortDays: t.configEffort || WEEK_EFFORT }, from)
        if (t.extendUntil && t.extendUntil > span.end) {
          span.end = t.extendUntil
          span.effortDays = workdaysIn(owner, span.start, span.end)
        }
        placed.set(t.id, span)
        if (!groupEnd || span.end > groupEnd) groupEnd = span.end
      }
      cursor = addDays(groupEnd, 1)
    }
  }

  return tasks.map((t) => (placed.has(t.id) ? { ...t, ...placed.get(t.id) } : t))
}

export function durationOf(task) {
  if (!task.start || !task.end) return 0
  return diffDays(task.start, task.end) + 1
}

/** Which week a date belongs to (the nearest week, for days between or past them). */
export function weekOfDate(key) {
  for (const w of WEEKS) if (key >= w.start && key <= w.end) return w.id
  let best = WEEKS[0]
  let bestGap = Infinity
  for (const w of WEEKS) {
    const gap = key < w.start ? diffDays(key, w.start) : diffDays(w.end, key)
    if (gap < bestGap) {
      bestGap = gap
      best = w
    }
  }
  return best.id
}

export function conflictsFor(task) {
  const out = []
  if (!task.start || !task.end) return out
  for (const d of range(task.start, task.end)) {
    if (HOLIDAY_SET.has(d)) out.push({ day: d, kind: 'holiday' })
    else if (!isHoliday(d) && isLeave(task.owner, d)) out.push({ day: d, kind: 'leave' })
  }
  return out
}

/** Finished: every subtask ticked, or the task itself marked complete. */
export function isComplete(task) {
  return progressOf(task) === 1
}

export function progressOf(task) {
  if (task.done) return 1
  if (!task.subtasks || !task.subtasks.length) return 0
  return task.subtasks.filter((s) => s.done).length / task.subtasks.length
}
