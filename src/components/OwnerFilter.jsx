import { ACTIVE_OWNERS } from '../lib/model.js'

/**
 * Owner checkboxes over the shared filter set, so the Gantt and the Availability
 * view stay in step with the chips in the toolbar.
 *
 * An empty set means "everyone", which is what the app starts with; the first
 * click has to expand that into a real set before it can take anyone out of it.
 */
export function OwnerFilter({ filter, setFilter, label = 'Filter' }) {
  const on = (id) => filter.size === 0 || filter.has(id)

  const toggle = (id) => {
    const next = filter.size === 0 ? new Set(ACTIVE_OWNERS.map((o) => o.id)) : new Set(filter)
    next.has(id) ? next.delete(id) : next.add(id)
    setFilter(next.size === ACTIVE_OWNERS.length ? new Set() : next)
  }

  return (
    <>
      <span className="muted small">{label}</span>
      {ACTIVE_OWNERS.map((o) => (
        <label key={o.id} className="checkbox">
          <input type="checkbox" checked={on(o.id)} onChange={() => toggle(o.id)} />
          <span className="dot" style={{ background: o.color }} />
          {o.name}
        </label>
      ))}
      {filter.size > 0 && (
        <button className="link" onClick={() => setFilter(new Set())}>all</button>
      )}
    </>
  )
}
