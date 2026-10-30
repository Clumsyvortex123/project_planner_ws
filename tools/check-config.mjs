// Validate planner.config.json (or the file given) without starting anything.
//   npm run check-config [-- path/to/config.json]
// Prints every problem, the warnings, and what the config produces; exits 1 on errors.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildModel } from '../src/lib/model.js'

const file = resolve(process.argv[2] || 'planner.config.json')
let raw
try {
  raw = JSON.parse(readFileSync(file, 'utf8'))
} catch (err) {
  console.error(`✗ ${file}: ${err.message}`)
  process.exit(1)
}

const { model, errors, warnings } = buildModel(raw)
for (const w of warnings) console.warn(`⚠ ${w}`)
if (!model) {
  for (const e of errors) console.error(`✗ ${e}`)
  console.error(`\n${errors.length} problem(s) in ${file}`)
  process.exit(1)
}

console.log(`✓ ${file}`)
console.log(`  ${model.PROJECT.title}`)
console.log(`  timeline  ${model.TIMELINE_START} → ${model.TIMELINE_END}, ${model.WEEKS.length} weeks, workdays ${[...model.WORKDAYS].sort().join(',')} (0=Sun)`)
console.log(`  people    ${model.OWNERS.map((o) => `${o.name}${o.hidden ? ' (hidden)' : ''}${o.leave.length ? ` ${o.leave.length}d off` : ''}`).join(', ')}`)
console.log(`  holidays  ${model.HOLIDAYS.length}`)
console.log(`  tasks     ${model.TASKS.length}`)
for (const p of model.PLANS) console.log(`  scenario  ${p.id} "${p.label}": ${p.tasks.length} tasks${p.marker ? `, marker ${p.marker.label}` : ''}`)
