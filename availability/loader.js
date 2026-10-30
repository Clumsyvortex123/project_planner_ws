// Builds window.PLAN for app.js from the same config and the same server plans
// the board uses, then starts the page. Nothing here is generated or copied, so
// this page cannot drift from the board.
import bundled from '../planner.config.json'
import {
  ACTIVE_OWNERS, HOLIDAYS, LEAVE, MONTHS, PEOPLE, PLANS, PROJECT, TIMELINE_END, TIMELINE_START, WEEKS,
  applyConfig, storageKey,
} from '../src/lib/model.js'
import { isHoliday } from '../src/lib/schedule.js'
import { label, range } from '../src/lib/dates.js'
import './styles.css'

async function json(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json()
}

async function boot() {
  try {
    applyConfig((await json('/api/config')).config)
  } catch {
    applyConfig(bundled)
  }

  // The live plans, so the week each task sits in is today's, not the config's.
  const plans = await Promise.all(
    PLANS.map(async (p) => {
      const live = await json(`/api/plans/${p.id}`).catch(() => null)
      const tasks = (live?.tasks || p.tasks).map((t) => ({
        ...t,
        subtasks: (t.subtasks || []).map((s) => (typeof s === 'string' ? { title: s, done: false } : s)),
      }))
      return { id: p.id, name: p.name, doc: p.doc, blurb: p.blurb, tasks }
    })
  )

  // Whole months, but only those the plan mostly covers (a plan starting on
  // 31 Aug should not show an empty August of "available" days).
  const monthKey = ({ y, m }) => `${y}-${String(m).padStart(2, '0')}`
  const lastDay = ({ y, m }) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  const months = MONTHS.filter((mm) => {
    const all = range(`${monthKey(mm)}-01`, lastDay(mm))
    return all.filter((d) => d >= TIMELINE_START && d <= TIMELINE_END).length * 2 >= all.length
  })
  const first = months[0] || MONTHS[0]
  const last = months[months.length - 1] || MONTHS[MONTHS.length - 1]
  const start = `${monthKey(first)}-01` > TIMELINE_START ? `${monthKey(first)}-01` : TIMELINE_START
  const days = range(`${monthKey(first)}-01`, lastDay(last))
  window.PLAN = {
    title: PROJECT.title,
    storageKey: storageKey('availability-v1'),
    owners: ACTIVE_OWNERS,
    people: PEOPLE.filter((id) => ACTIVE_OWNERS.some((o) => o.id === id)),
    weeks: WEEKS,
    // Every day off for everyone: listed holidays plus non-workdays.
    holidays: days.filter(isHoliday),
    holidayCount: HOLIDAYS.length,
    leave: LEAVE,
    range: { start, end: lastDay(last) },
    rangeLabel: `${label(start)} – ${label(lastDay(last))} ${last.y}`,
    months,
    plans,
  }
  document.title = `${PROJECT.title} — availability`
  await import('./app.js')
}

boot()
