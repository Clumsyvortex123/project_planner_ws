// Editing holidays and leave from the Availability tab.
//
// A draft is the set of day-level changes someone has painted but not saved:
//   { holidays: Map<day, name | null>, leave: { [personId]: Map<day, boolean> } }
// (a null holiday name / false leave value means "no longer off").
// applyDaysOff folds a draft into the raw config. Only the lists it touches are
// rewritten, as sorted, compact entries: runs of consecutive days become
// "a..b" ranges, and holiday names are kept.

import { addDays, dow } from './dates.js'

export function emptyDraft() {
  return { holidays: new Map(), leave: {} }
}

export function draftSize(draft) {
  return draft.holidays.size + Object.values(draft.leave).reduce((n, m) => n + m.size, 0)
}

/**
 * Sorted days → config entries, merging consecutive days that share a name.
 * With `workdays` (a Set of 0–6), a run also bridges days nobody works, so
 * Sat + Mon leave is one "Sat..Mon" range.
 */
export function compactDays(days, names = {}, workdays = null) {
  const after = (day) => {
    let d = addDays(day, 1)
    if (workdays && workdays.size) while (!workdays.has(dow(d))) d = addDays(d, 1)
    return d
  }
  const out = []
  let run = null
  const flush = () => {
    if (!run) return
    const one = run.from === run.to
    if (run.name) out.push(one ? { date: run.from, name: run.name } : { from: run.from, to: run.to, name: run.name })
    else out.push(one ? run.from : `${run.from}..${run.to}`)
  }
  for (const day of [...days].sort()) {
    const name = names[day] || ''
    if (run && after(run.to) === day && run.name === name) run.to = day
    else {
      flush()
      run = { from: day, to: day, name }
    }
  }
  flush()
  return out
}

/**
 * The raw config with the draft applied. `model` is the model built from
 * `raw` (it has every list already expanded to single days).
 */
export function applyDaysOff(raw, model, draft) {
  const next = structuredClone(raw)

  if (draft.holidays.size) {
    const names = { ...model.HOLIDAY_NAMES }
    for (const [day, name] of draft.holidays) {
      if (name === null) delete names[day]
      else names[day] = name || names[day] || ''
    }
    next.calendar = { ...(next.calendar || {}), holidays: compactDays(Object.keys(names), names) }
  }

  for (const [personId, changes] of Object.entries(draft.leave)) {
    if (!changes.size) continue
    const person = (next.people || []).find((p) => p.id === personId)
    if (!person) continue
    const days = new Set(model.LEAVE[personId] || [])
    for (const [day, off] of changes) off ? days.add(day) : days.delete(day)
    // Leave on a day nobody works changes nothing; ranges bridge those days.
    for (const day of days) if (!model.WORKDAYS.has(dow(day))) days.delete(day)
    if (days.size) person.leave = compactDays(days, {}, model.WORKDAYS)
    else delete person.leave
  }
  return next
}
