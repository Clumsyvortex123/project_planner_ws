import { OWNER_BY_ID } from '../lib/model.js'

export function OwnerChip({ id, size = 'sm' }) {
  const o = OWNER_BY_ID[id]
  if (!o) return null
  return (
    <span className={`chip chip-${size}`} style={{ background: o.color, color: o.fg }}>
      {o.name}
    </span>
  )
}

export function OwnerDot({ id }) {
  const o = OWNER_BY_ID[id]
  if (!o) return null
  return <span className="dot" style={{ background: o.color }} title={o.name} />
}
