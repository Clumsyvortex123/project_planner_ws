// The whole planner is driven by one document: planner.config.json.
//
// This module turns that document into the shapes every page reads — people,
// weeks, holidays, leave, scenarios and their task lists — and nothing else in
// the app holds plan content. The exports are live bindings (`export let`), so
// `applyConfig()` swaps the model in place and every importer sees the new
// values; the app remounts its tree after a swap so React re-reads them.
//
// It is plain JS with no React and no DOM, so the server-side validator
// (tools/check-config.mjs) and the standalone availability page use it too.

import { addDays, parse, range } from './dates.js'

/* ---- the live model ------------------------------------------------------ */

export let CONFIG = null
export let CONFIG_VERSION = ''
export let PROJECT = {}
export let SETTINGS = {}

export let OWNERS = [] // every person or bucket in the config, hidden ones included
export let OWNER_BY_ID = {}
export let ACTIVE_OWNERS = [] // the ones the UI shows
export let PEOPLE = [] // ids whose dates are redrawn around availability

export let WEEKS = []
export let WEEK_BY_ID = {}
export let WORKDAYS = new Set()
export let WEEK_EFFORT = 6
export let BLOCKS = [] // multi-week checkpoints ("Weeks 1–2"), sized by calendar.blockWeeks

export let HOLIDAYS = []
export let HOLIDAY_SET = new Set()
export let HOLIDAY_NAMES = {}
export let LEAVE = {}
export let LEAVE_SETS = {}

export let AREAS = []
export let FLAGS = {}
export let TASKS = [] // the base task list, normalised
export let TASK_BY_ID = {}

export let PLANS = []
export let PLAN_BY_ID = {}
export let DEFAULT_PLAN = ''

export let TIMELINE_START = ''
export let TIMELINE_END = ''
export let TIMELINE_DAYS = []
export let MONTHS = [] // [{ y, m }] covering the timeline, for month grids

export const ALL_AUTHOR = { id: 'all', name: 'All', color: '#2f81f7', fg: '#ffffff' }
export let NOTE_AUTHORS = []

/* ---- defaults ------------------------------------------------------------ */

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const PALETTE = ['#FDEA9B', '#FA551E', '#C8AFF0', '#3CBEFC', '#7EE787', '#FF9BCE', '#FFA657', '#A5D6FF']
const DEFAULT_SETTINGS = { defaultView: 'board', saveDebounceMs: 700, pollMs: 8000 }
// Plan ids become filenames on the server, so they follow its rule.
const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const ISO = /^\d{4}-\d{2}-\d{2}$/

const validDate = (s) => typeof s === 'string' && ISO.test(s) && !Number.isNaN(parse(s).getTime())

/** Dark or light text, whichever reads on a background colour. */
function contrastFg(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return '#111111'
  const n = parseInt(m[1], 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1b1b1b' : '#ffffff'
}

/** A stable short hash of the document, used to notice that it changed. */
export function hashConfig(raw) {
  const s = JSON.stringify(raw)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/* ---- normalising --------------------------------------------------------- */

/**
 * Dates can be written as "2026-10-05", a range "2026-10-05..2026-10-10", or
 * { date, name } / { from, to, name }. Returns [{ day, name }].
 */
function expandDates(list, path, errors) {
  const out = []
  ;(list || []).forEach((item, i) => {
    const at = `${path}[${i}]`
    let from
    let to
    let name = ''
    if (typeof item === 'string') {
      ;[from, to] = item.includes('..') ? item.split('..').map((s) => s.trim()) : [item, item]
    } else if (item && typeof item === 'object') {
      from = item.date || item.from
      to = item.to || from
      name = item.name || ''
    }
    if (!validDate(from) || !validDate(to)) {
      errors.push(`${at}: "${JSON.stringify(item)}" is not a date, a "from..to" range, or { date | from, to }`)
      return
    }
    if (to < from) {
      errors.push(`${at}: range ends before it starts`)
      return
    }
    for (const day of range(from, to)) out.push({ day, name })
  })
  return out
}

function normaliseWeeks(raw, errors) {
  // Either an explicit list, or a generator: { start, count, length?, prefix?, notes? }.
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    const { start, count, length = 7, prefix = 'Week', notes = {} } = raw
    if (!validDate(start)) errors.push('weeks.start must be a YYYY-MM-DD date')
    if (!Number.isInteger(count) || count < 1) errors.push('weeks.count must be a positive integer')
    if (errors.length) return []
    return Array.from({ length: count }, (_, i) => {
      const s = addDays(start, i * 7)
      const id = `w${i + 1}`
      return { id, name: `${prefix} ${i + 1}`, start: s, end: addDays(s, length - 1), note: notes[id] || '' }
    })
  }
  if (!Array.isArray(raw) || !raw.length) {
    errors.push('weeks must be a non-empty list, or { start, count } to generate them')
    return []
  }
  const seen = new Set()
  return raw.map((w, i) => {
    const at = `weeks[${i}]`
    const id = w.id || `w${i + 1}`
    if (seen.has(id)) errors.push(`${at}: duplicate week id "${id}"`)
    seen.add(id)
    if (!validDate(w.start)) errors.push(`${at}: start must be a YYYY-MM-DD date`)
    const end = w.end || (validDate(w.start) ? addDays(w.start, 6) : w.start)
    if (!validDate(end)) errors.push(`${at}: end must be a YYYY-MM-DD date`)
    else if (validDate(w.start) && end < w.start) errors.push(`${at}: ends before it starts`)
    return { id, name: w.name || `Week ${i + 1}`, start: w.start, end, note: w.note || '' }
  })
}

const TASK_FIELDS = ['title', 'owner', 'week', 'tag', 'milestone', 'area', 'outcome', 'flags', 'effortDays', 'start', 'end', 'extendUntil', 'notes']

function normaliseTask(t, at, ctx) {
  const { errors, ownerIds, weekIds, firstWeek } = ctx
  if (!t || typeof t !== 'object') {
    errors.push(`${at}: must be an object`)
    return null
  }
  if (!t.id || typeof t.id !== 'string') errors.push(`${at}: needs a string "id"`)
  if (!t.title) errors.push(`${at} (${t.id}): needs a "title"`)
  if (!ownerIds.has(t.owner)) errors.push(`${at} (${t.id}): owner "${t.owner}" is not in people`)
  if (t.week && !weekIds.has(t.week)) errors.push(`${at} (${t.id}): week "${t.week}" is not in weeks`)
  for (const f of ['start', 'end', 'extendUntil']) {
    if (t[f] != null && !validDate(t[f])) errors.push(`${at} (${t.id}): ${f} must be a YYYY-MM-DD date`)
  }
  if (t.effortDays != null && !(t.effortDays > 0)) errors.push(`${at} (${t.id}): effortDays must be a positive number`)

  const out = { id: t.id }
  for (const f of TASK_FIELDS) if (t[f] !== undefined) out[f] = t[f]
  out.title = String(t.title || t.id || '')
  out.week = t.week || firstWeek
  out.subtasks = (t.subtasks || []).map((s) => (typeof s === 'string' ? s : s?.title || '')).filter(Boolean)
  if (out.flags && !Array.isArray(out.flags)) out.flags = [out.flags]
  // A task whose dates are written in the config is pinned: redraws leave it be.
  if (t.start) {
    out.pinned = true
    if (!t.end) out.end = t.start
  }
  return out
}

/**
 * Check a config and build the model it describes, without installing it.
 * @returns {{ model, errors: string[], warnings: string[] }}
 */
export function buildModel(raw) {
  const errors = []
  const warnings = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { model: null, errors: ['the config must be a JSON object'], warnings }
  }

  const project = { id: 'planner', title: 'Project planner', ...(raw.project || {}) }
  if (!VALID_ID.test(project.id)) errors.push('project.id must be lowercase letters, digits, - or _ (it prefixes storage keys)')
  const settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) }

  /* calendar */
  const cal = raw.calendar || {}
  const workdayList = (cal.workdays || ['mon', 'tue', 'wed', 'thu', 'fri']).map((d) =>
    typeof d === 'number' ? d : DAY_NAMES.indexOf(String(d).slice(0, 3).toLowerCase())
  )
  if (workdayList.some((d) => d < 0 || d > 6)) errors.push('calendar.workdays: use mon..sun or 0..6 (0 = Sunday)')
  const workdays = new Set(workdayList)
  if (!workdays.size) errors.push('calendar.workdays: at least one working day is needed')
  const weekEffort = cal.weekEffortDays || workdays.size
  const blockWeeks = cal.blockWeeks || 2

  const holidayItems = expandDates(cal.holidays, 'calendar.holidays', errors)
  const holidayNames = {}
  for (const h of holidayItems) holidayNames[h.day] = h.name || holidayNames[h.day] || ''

  /* weeks */
  const weeks = normaliseWeeks(raw.weeks, errors)
  const weekIds = new Set(weeks.map((w) => w.id))

  /* people */
  const people = Array.isArray(raw.people) ? raw.people : []
  if (!people.length) errors.push('people must list at least one owner')
  const seenPeople = new Set()
  const owners = people.map((p, i) => {
    const at = `people[${i}]`
    if (!p.id) errors.push(`${at}: needs an "id"`)
    if (seenPeople.has(p.id)) errors.push(`${at}: duplicate id "${p.id}"`)
    seenPeople.add(p.id)
    const color = p.color || PALETTE[i % PALETTE.length]
    return {
      id: p.id,
      name: p.name || p.id,
      color,
      fg: p.fg || contrastFg(color),
      hidden: !!p.hidden,
      scheduling: p.scheduling === 'fixed' ? 'fixed' : 'availability',
      leave: [...new Set(expandDates(p.leave, `${at}.leave`, errors).map((x) => x.day))].sort(),
    }
  })
  const ownerIds = new Set(owners.map((o) => o.id))
  const hidden = new Set(owners.filter((o) => o.hidden).map((o) => o.id))

  /* tasks */
  const ctx = { errors, ownerIds, weekIds, firstWeek: weeks[0]?.id }
  if (!Array.isArray(raw.tasks)) errors.push('tasks must be a list')
  const seenTasks = new Set()
  const tasks = []
  ;(raw.tasks || []).forEach((t, i) => {
    const n = normaliseTask(t, `tasks[${i}]`, ctx)
    if (!n) return
    if (seenTasks.has(n.id)) errors.push(`tasks[${i}]: duplicate id "${n.id}"`)
    seenTasks.add(n.id)
    tasks.push(n)
  })
  const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]))

  const areas = Array.isArray(raw.areas) ? raw.areas : [...new Set(tasks.map((t) => t.area).filter(Boolean))]
  for (const t of tasks) {
    if (t.area && !areas.includes(t.area)) warnings.push(`task ${t.id}: area "${t.area}" is not in areas, so it sorts last`)
  }
  const flags = raw.flags || {}
  for (const t of tasks) for (const f of t.flags || []) if (!flags[f]) warnings.push(`task ${t.id}: flag "${f}" has no entry in flags`)

  /* scenarios */
  const rawScenarios = Array.isArray(raw.scenarios) && raw.scenarios.length ? raw.scenarios : [{ id: 'main', name: 'Plan' }]
  const seenPlans = new Set()
  const plans = rawScenarios.map((s, i) => {
    const at = `scenarios[${i}]`
    if (!VALID_ID.test(s.id || '')) errors.push(`${at}: id must be lowercase letters, digits, - or _ (max 32)`)
    if (seenPlans.has(s.id)) errors.push(`${at}: duplicate id "${s.id}"`)
    seenPlans.add(s.id)

    // Tasks this scenario adds of its own, then the order it lays everything out in.
    const extra = {}
    ;(s.add || []).forEach((t, j) => {
      const n = normaliseTask(t, `${at}.add[${j}]`, ctx)
      if (n) extra[n.id] = n
    })
    const lookup = (id) => extra[id] || taskById[id]

    let list
    if (Array.isArray(s.layout)) {
      list = []
      s.layout.forEach((entry, j) => {
        const [id, week] = Array.isArray(entry) ? entry : typeof entry === 'string' ? [entry] : [entry?.id, entry?.week]
        const base = lookup(id)
        // A task deleted from the list but still named here is skipped, so
        // removing one does not mean editing every layout first.
        if (!base) return warnings.push(`${at}.layout[${j}]: no task "${id}" — skipped`)
        if (week && !weekIds.has(week)) return errors.push(`${at}.layout[${j}]: no week "${week}"`)
        list.push({ ...base, week: week || base.week })
      })
    } else {
      const exclude = new Set(s.exclude || [])
      for (const id of exclude) if (!lookup(id)) warnings.push(`${at}.exclude: no task "${id}"`)
      list = [...tasks, ...Object.values(extra)].filter((t) => !exclude.has(t.id))
    }

    for (const [id, patch] of Object.entries(s.overrides || {})) {
      const k = list.findIndex((t) => t.id === id)
      if (k < 0) {
        warnings.push(`${at}.overrides: "${id}" is not in this scenario`)
        continue
      }
      if (patch.week && !weekIds.has(patch.week)) errors.push(`${at}.overrides.${id}: no week "${patch.week}"`)
      if (patch.owner && !ownerIds.has(patch.owner)) errors.push(`${at}.overrides.${id}: no owner "${patch.owner}"`)
      list[k] = { ...list[k], ...patch, pinned: list[k].pinned || !!patch.start }
    }

    const notes = s.weekNotes || {}
    const marker = s.marker && (s.marker.week || s.marker.date) ? { label: 'Marker', ...s.marker } : null
    if (marker?.week && !weekIds.has(marker.week)) errors.push(`${at}.marker: no week "${marker.week}"`)
    if (marker?.date && !validDate(marker.date)) errors.push(`${at}.marker.date must be a YYYY-MM-DD date`)

    return {
      id: s.id,
      name: s.name || s.id,
      group: s.group || 'Scenario',
      label: s.label || s.name || s.id,
      blurb: s.blurb || '',
      doc: s.docUrl || project.docUrl || '',
      marker,
      tasks: list.filter((t) => !hidden.has(t.owner)),
      weeks: weeks.map((w) => (notes[w.id] === undefined ? w : { ...w, note: notes[w.id] })),
    }
  })

  if (errors.length) return { model: null, errors, warnings }

  /* timeline: the weeks, stretched by calendar.timeline if given */
  let start = weeks.reduce((a, w) => (w.start < a ? w.start : a), weeks[0].start)
  let end = weeks.reduce((a, w) => (w.end > a ? w.end : a), weeks[0].end)
  if (validDate(cal.timeline?.start) && cal.timeline.start < start) start = cal.timeline.start
  if (validDate(cal.timeline?.end) && cal.timeline.end > end) end = cal.timeline.end
  const months = []
  for (let k = `${start.slice(0, 7)}-01`; k <= end; ) {
    const [y, m] = k.split('-').map(Number)
    months.push({ y, m })
    k = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  }

  const blocks = weeks.reduce((out, w, i) => {
    if (i % blockWeeks === 0) {
      const last = Math.min(i + blockWeeks, weeks.length)
      out.push({ id: `f${out.length + 1}`, name: blockWeeks === 1 ? w.name : `Weeks ${i + 1}–${last}`, start: w.start, end: w.end, weeks: [w] })
    } else {
      const b = out[out.length - 1]
      b.end = w.end
      b.weeks.push(w)
    }
    return out
  }, [])

  const active = owners.filter((o) => !o.hidden)
  const defaultPlan = plans.some((p) => p.id === raw.defaultScenario) ? raw.defaultScenario : plans[0].id
  if (raw.defaultScenario && defaultPlan !== raw.defaultScenario) warnings.push(`defaultScenario "${raw.defaultScenario}" is not a scenario`)

  return {
    errors,
    warnings,
    model: {
      CONFIG: raw,
      CONFIG_VERSION: hashConfig(raw),
      PROJECT: project,
      SETTINGS: settings,
      OWNERS: owners,
      OWNER_BY_ID: Object.fromEntries(owners.map((o) => [o.id, o])),
      ACTIVE_OWNERS: active,
      PEOPLE: owners.filter((o) => o.scheduling === 'availability').map((o) => o.id),
      WEEKS: weeks,
      WEEK_BY_ID: Object.fromEntries(weeks.map((w) => [w.id, w])),
      WORKDAYS: workdays,
      WEEK_EFFORT: weekEffort,
      BLOCKS: blocks,
      HOLIDAYS: Object.keys(holidayNames).sort(),
      HOLIDAY_SET: new Set(Object.keys(holidayNames)),
      HOLIDAY_NAMES: holidayNames,
      LEAVE: Object.fromEntries(owners.map((o) => [o.id, o.leave])),
      LEAVE_SETS: Object.fromEntries(owners.map((o) => [o.id, new Set(o.leave)])),
      AREAS: areas,
      FLAGS: flags,
      TASKS: tasks,
      TASK_BY_ID: taskById,
      PLANS: plans,
      PLAN_BY_ID: Object.fromEntries(plans.map((p) => [p.id, p])),
      DEFAULT_PLAN: defaultPlan,
      TIMELINE_START: start,
      TIMELINE_END: end,
      TIMELINE_DAYS: range(start, end),
      MONTHS: months,
      NOTE_AUTHORS: [ALL_AUTHOR, ...active],
    },
  }
}

/** Validate and install a config. Throws with every problem listed if it is not usable. */
export function applyConfig(raw) {
  const { model, errors, warnings } = buildModel(raw)
  if (!model) {
    const err = new Error(`config has ${errors.length} problem(s)`)
    err.errors = errors
    throw err
  }
  ;({
    CONFIG, CONFIG_VERSION, PROJECT, SETTINGS, OWNERS, OWNER_BY_ID, ACTIVE_OWNERS, PEOPLE, WEEKS, WEEK_BY_ID,
    WORKDAYS, WEEK_EFFORT, BLOCKS, HOLIDAYS, HOLIDAY_SET, HOLIDAY_NAMES, LEAVE, LEAVE_SETS, AREAS, FLAGS, TASKS,
    TASK_BY_ID, PLANS, PLAN_BY_ID, DEFAULT_PLAN, TIMELINE_START, TIMELINE_END, TIMELINE_DAYS, MONTHS, NOTE_AUTHORS,
  } = model)
  return { warnings }
}

/**
 * The config as text for people to edit: indented, but with short lists and
 * small objects kept on one line, so a task or a week reads as one row.
 */
export function formatConfig(v, ind = '') {
  const flat = JSON.stringify(v)
  if (v === null || typeof v !== 'object') return flat
  const hasObjects = Array.isArray(v) && v.some((x) => x && typeof x === 'object' && !Array.isArray(x))
  if (flat.length + ind.length <= 110 && !hasObjects) {
    return flat.replace(/,"/g, ', "').replace(/":/g, '": ').replace(/,(\d|\[)/g, ', $1')
  }
  const next = ind + '  '
  if (Array.isArray(v)) return '[\n' + v.map((x) => next + formatConfig(x, next)).join(',\n') + '\n' + ind + ']'
  return '{\n' + Object.entries(v).map(([k, x]) => next + JSON.stringify(k) + ': ' + formatConfig(x, next)).join(',\n') + '\n' + ind + '}'
}

/* ---- lookups ------------------------------------------------------------- */

export function authorOf(id) {
  return NOTE_AUTHORS.find((a) => a.id === id) || ACTIVE_OWNERS[0]
}

/** The scenario's marker day (e.g. when the robot arrives), or null. */
export function markerDay(plan) {
  const m = plan?.marker
  if (!m) return null
  if (m.date) return m.date
  return WEEK_BY_ID[m.week]?.start || null
}

/** The base config's version of a task inside a given scenario. */
export function configTask(planId, id) {
  return PLAN_BY_ID[planId]?.tasks.find((t) => t.id === id) || null
}

/** Which checkpoint block a date falls in; the last one catches anything past the end. */
export function blockOf(key) {
  if (!key || !BLOCKS.length) return null
  const hit = BLOCKS.find((f) => key >= f.start && key <= f.end)
  if (hit) return hit
  return key < BLOCKS[0].start ? BLOCKS[0] : BLOCKS[BLOCKS.length - 1]
}

/** [area, phrase] for a task: its outcome if the config gives one, else its title. */
export function stateOf(task) {
  if (task.outcome) return [task.area || 'Other', task.outcome]
  return [task.area || 'Other', String(task.title || '').toLowerCase()]
}

export const storageKey = (name) => `${PROJECT.id}-${name}`

