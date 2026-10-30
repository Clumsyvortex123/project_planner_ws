// A small markdown renderer for sticky notes.
//
// Rendered to React elements, never to an HTML string: a note is written by one
// person and read by everyone, and `dangerouslySetInnerHTML` on shared text is
// how a note becomes a script. It also keeps the app dependency-free.
//
// What it understands, which is what a note needs:
//
//   # ## ###      headings
//   - [ ] / - [x] task list, ticked in place
//   - or *        bullets            1.  numbered
//   > quote       quote              ---  rule
//   **b** *i* `c` ~~s~~ [text](url)  inline
//
// Checkbox lines carry the index of the source line they came from, so ticking
// one rewrites that line in the note's own markdown rather than keeping parallel
// state that could drift from the text.

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/g

function inline(text, keyPrefix = 'i') {
  const out = []
  let i = 0
  for (const piece of String(text).split(INLINE)) {
    if (!piece) continue
    const key = `${keyPrefix}${i++}`
    if ((piece.startsWith('**') && piece.endsWith('**')) || (piece.startsWith('__') && piece.endsWith('__'))) {
      out.push(<strong key={key}>{piece.slice(2, -2)}</strong>)
    } else if ((piece.startsWith('*') && piece.endsWith('*')) || (piece.startsWith('_') && piece.endsWith('_'))) {
      out.push(<em key={key}>{piece.slice(1, -1)}</em>)
    } else if (piece.startsWith('`') && piece.endsWith('`')) {
      out.push(<code key={key}>{piece.slice(1, -1)}</code>)
    } else if (piece.startsWith('~~') && piece.endsWith('~~')) {
      out.push(<s key={key}>{piece.slice(2, -2)}</s>)
    } else if (piece.startsWith('[')) {
      const [, label, href] = piece.match(/^\[([^\]]+)\]\(([^)]+)\)$/) || []
      // Only http(s): a note is shared text, and `javascript:` in a link is the
      // one thing a renderer must not hand straight to the browser.
      const safe = href && /^https?:\/\//i.test(href) ? href : null
      out.push(
        safe ? (
          <a key={key} href={safe} target="_blank" rel="noreferrer noopener">{label}</a>
        ) : (
          <span key={key}>{label || piece}</span>
        )
      )
    } else {
      out.push(piece)
    }
  }
  return out
}

/**
 * @param body     the note's markdown
 * @param onToggle called with the source line index of a checkbox that was clicked
 */
export function Markdown({ body, onToggle }) {
  const lines = String(body || '').split('\n')
  const blocks = []
  let list = null

  const flush = () => {
    if (!list) return
    const Tag = list.type === 'ol' ? 'ol' : 'ul'
    blocks.push(
      <Tag key={`l${blocks.length}`} className={list.task ? 'md-tasks' : 'md-list'}>
        {list.items}
      </Tag>
    )
    list = null
  }

  lines.forEach((raw, index) => {
    const line = raw.replace(/\s+$/, '')

    if (!line.trim()) {
      flush()
      return
    }

    const task = line.match(/^\s*[-*]\s+\[( |x|X)\]\s*(.*)$/)
    if (task) {
      const checked = task[1].toLowerCase() === 'x'
      if (!list || list.type !== 'ul' || !list.task) {
        flush()
        list = { type: 'ul', task: true, items: [] }
      }
      list.items.push(
        <li key={index} className={checked ? 'md-task done' : 'md-task'}>
          <button
            type="button"
            className={`md-box${checked ? ' on' : ''}`}
            aria-label={checked ? 'Untick' : 'Tick'}
            onClick={(e) => {
              e.stopPropagation()
              onToggle?.(index)
            }}
          >
            {checked ? '✓' : ''}
          </button>
          <span>{inline(task[2], `t${index}`)}</span>
        </li>
      )
      return
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    if (bullet) {
      if (!list || list.type !== 'ul' || list.task) {
        flush()
        list = { type: 'ul', task: false, items: [] }
      }
      list.items.push(<li key={index}>{inline(bullet[1], `b${index}`)}</li>)
      return
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (numbered) {
      if (!list || list.type !== 'ol') {
        flush()
        list = { type: 'ol', task: false, items: [] }
      }
      list.items.push(<li key={index}>{inline(numbered[1], `n${index}`)}</li>)
      return
    }

    flush()

    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      const Tag = `h${heading[1].length + 3}` // h4..h6, below the app's own headings
      blocks.push(<Tag key={index}>{inline(heading[2], `h${index}`)}</Tag>)
      return
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push(<hr key={index} />)
      return
    }

    const quote = line.match(/^\s*>\s?(.*)$/)
    if (quote) {
      blocks.push(<blockquote key={index}>{inline(quote[1], `q${index}`)}</blockquote>)
      return
    }

    blocks.push(<p key={index}>{inline(line, `p${index}`)}</p>)
  })

  flush()
  return <div className="md">{blocks}</div>
}

/** Flip the checkbox on one source line, returning the new markdown. */
export function toggleCheckbox(body, index) {
  const lines = String(body || '').split('\n')
  const line = lines[index]
  if (line === undefined) return body
  lines[index] = /\[\s\]/.test(line) ? line.replace('[ ]', '[x]') : line.replace(/\[[xX]\]/, '[ ]')
  return lines.join('\n')
}

/** The first meaningful line, used as a note's name in menus and messages. */
export function titleOf(body) {
  const line = String(body || '')
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length)
  return line || 'Empty note'
}
