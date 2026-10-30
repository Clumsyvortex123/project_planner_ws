// Merging a plan that two people changed at once.
//
// The server rejects a save made against a stale version and hands back the
// current document. Taking either side wholesale would throw away somebody's
// afternoon, so both are replayed against the version they started from: for
// each task and each week note, whoever actually changed it wins, and only a
// genuine both-touched-the-same-thing lands on the local edit.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const byId = (list) => {
  const out = new Map()
  for (const t of list || []) out.set(t.id, t)
  return out
}

/**
 * Merge three versions of a list of things with ids — tasks, notes, anything
 * where each entry is owned by whoever last changed it.
 *
 * @returns {{items: object[], conflicts: string[]}}
 */
export function mergeById(base, mine, theirs, name = (x) => x.id) {
  const b = byId(base)
  const m = byId(mine)
  const t = byId(theirs)
  const conflicts = []

  // Their order is the spine — anything added locally is appended after it.
  const ids = [...t.keys()]
  for (const id of m.keys()) if (!t.has(id)) ids.push(id)

  const items = []
  for (const id of ids) {
    const mineT = m.get(id)
    const theirsT = t.get(id)
    const baseT = b.get(id)

    if (!mineT) {
      // Deleted here. Keep their copy only if they also changed it, so a delete
      // is not silently undone by a peer who merely still had the item.
      if (baseT && same(baseT, theirsT)) continue
      items.push(theirsT)
      continue
    }
    if (!theirsT) {
      // Deleted there. Same rule the other way round.
      if (baseT && same(baseT, mineT)) continue
      items.push(mineT)
      continue
    }

    const iChanged = !baseT || !same(baseT, mineT)
    const theyChanged = !baseT || !same(baseT, theirsT)
    if (iChanged && theyChanged && !same(mineT, theirsT)) conflicts.push(name(mineT))
    items.push(iChanged ? mineT : theirsT)
  }

  return { items, conflicts }
}

/**
 * @param base   the document both sides started from (last loaded or saved)
 * @param mine   local state now
 * @param theirs what the server holds now
 * @returns {{tasks, checkpoints, trash, meta, conflicts: string[]}}
 */
export function mergePlans(base, mine, theirs) {
  const merged = mergeById(base.tasks, mine.tasks, theirs.tasks, (t) => t.title || t.id)
  const tasks = merged.items
  const conflicts = merged.conflicts

  // Week and fortnight notes, by key, same rule.
  const checkpoints = { ...(theirs.checkpoints || {}) }
  const baseCp = base.checkpoints || {}
  const mineCp = mine.checkpoints || {}
  for (const key of Object.keys(mineCp)) {
    const iChanged = !same(baseCp[key], mineCp[key])
    if (!iChanged) continue
    const theyChanged = !same(baseCp[key], checkpoints[key])
    if (theyChanged && !same(mineCp[key], checkpoints[key])) conflicts.push(key)
    checkpoints[key] = mineCp[key]
  }
  for (const key of Object.keys(baseCp)) {
    // Cleared here and untouched there: let the clear stand.
    if (!(key in mineCp) && same(baseCp[key], checkpoints[key])) delete checkpoints[key]
  }

  // The trash merges like the task list; the config-sync bookkeeping is taken
  // from whichever side moved it on.
  const trash = mergeById(base.trash || [], mine.trash || [], theirs.trash || []).items
  const meta = same(base.meta, mine.meta) ? theirs.meta ?? mine.meta : mine.meta

  return { tasks, checkpoints, trash, meta, conflicts }
}

/** The note wall merges the same way: by id, newest edit per note wins. */
export function mergeNotes(base, mine, theirs) {
  return mergeById(base, mine, theirs, (n) => (n.body || '').split('\n')[0].slice(0, 40) || n.id)
}
