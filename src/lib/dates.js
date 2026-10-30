// All planning happens in 2026. Dates are handled as plain "YYYY-MM-DD" keys so
// nothing ever shifts under a timezone.

export const YEAR = 2026

export function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function parse(key) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function fmt(date) {
  return date.toISOString().slice(0, 10)
}

export function addDays(key, n) {
  const d = parse(key)
  d.setUTCDate(d.getUTCDate() + n)
  return fmt(d)
}

export function diffDays(a, b) {
  return Math.round((parse(b) - parse(a)) / 86400000)
}

export function dow(key) {
  return parse(key).getUTCDay() // 0 = Sunday
}

export function range(from, to) {
  const out = []
  for (let k = from; k <= to; k = addDays(k, 1)) out.push(k)
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const MONTH_NAMES = MONTHS
export const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function label(key) {
  const d = parse(key)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

export function shortLabel(key) {
  const d = parse(key)
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`
}

export function monthOf(key) {
  return Number(key.slice(5, 7))
}

export function clamp(key, from, to) {
  if (key < from) return from
  if (key > to) return to
  return key
}
