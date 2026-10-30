/* Availability view.
 *
 * Plots exactly two things on a calendar: company holidays and each person's
 * non-availability. Tasks are listed, never dated: no start, no due, no
 * placement on any day. window.PLAN is built by loader.js from the live config
 * and the live plans on the server, so this page always agrees with the board.
 */
;(function () {
  var PLAN = window.PLAN
  var PLAN_SETS = PLAN.plans
  var OWNERS = PLAN.owners
  var OWNER_BY_ID = {}
  OWNERS.forEach(function (o) { OWNER_BY_ID[o.id] = o })

  // Only these owners are people who can be away (scheduling: "availability" in the config);
  var PEOPLE = PLAN.people

  var HOLIDAYS = {}
  PLAN.holidays.forEach(function (d) { HOLIDAYS[d] = true })

  var LEAVE = {}
  Object.keys(PLAN.leave).forEach(function (id) {
    LEAVE[id] = {}
    PLAN.leave[id].forEach(function (d) { LEAVE[id][d] = true })
  })

  var RANGE_START = PLAN.range.start
  var RANGE_END = PLAN.range.end
  var MONTHS = PLAN.months
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  var DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  /* ---------- dates (plain YYYY-MM-DD keys, UTC only) ---------- */

  function pad(n) { return n < 10 ? '0' + n : '' + n }
  function iso(y, m, d) { return y + '-' + pad(m) + '-' + pad(d) }
  function parse(key) {
    var p = key.split('-')
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]))
  }
  function fmt(dt) { return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()) }
  function addDays(key, n) {
    var d = parse(key)
    d.setUTCDate(d.getUTCDate() + n)
    return fmt(d)
  }
  function dow(key) { return parse(key).getUTCDay() }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate() }
  function label(key) {
    var d = parse(key)
    return d.getUTCDate() + ' ' + MONTH_NAMES[d.getUTCMonth()]
  }
  function rangeDays(from, to) {
    var out = []
    for (var k = from; k <= to; k = addDays(k, 1)) out.push(k)
    return out
  }

  var ALL_DAYS = rangeDays(RANGE_START, RANGE_END)

  function isHoliday(key) { return !!HOLIDAYS[key] }
  function isAway(id, key) { return !!(LEAVE[id] && LEAVE[id][key]) }
  function awayOn(key, ids) {
    return ids.filter(function (id) { return isAway(id, key) })
  }

  /* ---------- state ---------- */

  var KEY = PLAN.storageKey
  var state = {
    view: 'calendar',
    filter: OWNERS.map(function (o) { return o.id }),
    query: '',
    groupBy: 'owner',
    plan: PLAN_SETS[0].id,
    open: [],
  }
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (saved) {
      if (saved.view) state.view = saved.view
      if (saved.filter) state.filter = saved.filter
      if (saved.groupBy) state.groupBy = saved.groupBy
      if (saved.plan) state.plan = saved.plan
    }
  } catch (e) { /* private mode, blocked storage - defaults are fine */ }

  var VIEWS = ['calendar', 'people', 'tasks']
  if (VIEWS.indexOf(location.hash.slice(1)) !== -1) state.view = location.hash.slice(1)

  function persist() {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ view: state.view, filter: state.filter, groupBy: state.groupBy, plan: state.plan })
      )
    } catch (e) { /* ignore */ }
  }

  function on(id) { return state.filter.indexOf(id) !== -1 }
  function activePeople() { return PEOPLE.filter(on) }

  /* ---------- html helpers ---------- */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }

  /* ---------- top bar ---------- */

  function currentPlan() {
    for (var i = 0; i < PLAN_SETS.length; i++) if (PLAN_SETS[i].id === state.plan) return PLAN_SETS[i]
    return PLAN_SETS[0]
  }

  function topbar() {
    var tabs = [['calendar', 'Calendar'], ['people', 'People'], ['tasks', 'Tasks']]
    return (
      '<div class="topbar">' +
        '<div class="row">' +
          '<h1>' + esc(PLAN.title) + ' — availability</h1>' +
          '<span class="muted small">holidays and leave only' +
            (currentPlan().doc
              ? ' · <a href="' + currentPlan().doc + '" target="_blank" rel="noreferrer">' + esc('doc (' + currentPlan().name + ')') + '</a>'
              : '') +
            ' · <a href="../">open the board</a>' +
          '</span>' +
          '<span class="spacer"></span>' +
          '<div class="seg">' +
            tabs.map(function (t) {
              return '<button data-view="' + t[0] + '" class="' + (state.view === t[0] ? 'on' : '') + '">' + t[1] + '</button>'
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="people">' +
            OWNERS.map(function (o) {
              return (
                '<button class="person ' + (on(o.id) ? 'on' : '') + '" data-owner="' + o.id + '" ' +
                  'title="' + (PEOPLE.indexOf(o.id) === -1 ? 'bucket, not a person — no leave recorded' : 'toggle') + '">' +
                  '<i class="dot" style="background:' + o.color + '"></i>' + esc(o.name) +
                '</button>'
              )
            }).join('') +
          '</div>' +
          '<span class="spacer"></span>' +
          (state.view === 'tasks'
            ? '<div class="seg">' +
                PLAN_SETS.map(function (p) {
                  return '<button data-plan="' + p.id + '" class="' + (state.plan === p.id ? 'on' : '') + '" ' +
                    'title="' + esc(p.blurb) + '">' + esc(p.name) + '</button>'
                }).join('') +
              '</div>' +
              '<input id="q" class="search" placeholder="Filter tasks…" value="' + esc(state.query) + '" />' +
              '<div class="seg">' +
                [['owner', 'By owner'], ['week', 'By week'], ['doc', 'Doc order']].map(function (g) {
                  return '<button data-group="' + g[0] + '" class="' + (state.groupBy === g[0] ? 'on' : '') + '">' + g[1] + '</button>'
                }).join('') +
              '</div>'
            : '<span class="legend"><i class="swatch holiday-sw"></i> holiday</span>' +
              '<span class="legend"><i class="swatch leave-sw"></i> non-availability</span>') +
        '</div>' +
      '</div>'
    )
  }

  /* ---------- calendar ---------- */

  function monthCard(y, m) {
    var people = activePeople()
    var first = iso(y, m, 1)
    var lead = dow(first)
    var total = daysInMonth(y, m)
    var cells = []

    for (var i = 0; i < lead; i++) cells.push('<div class="cal-cell blank"></div>')

    var working = 0
    var clear = 0
    for (var d = 1; d <= total; d++) {
      var key = iso(y, m, d)
      var hol = isHoliday(key)
      var away = awayOn(key, people)
      if (!hol) {
        working++
        if (away.length === 0) clear++
      }
      var cls = 'cal-cell' + (hol ? ' holiday' : '') + (away.length > 1 ? ' overlap' : '')
      var tip = label(key) + (hol ? ' · holiday' : '')
      if (away.length) tip += ' · away: ' + away.map(function (id) { return OWNER_BY_ID[id].name }).join(', ')
      cells.push(
        '<div class="' + cls + '" title="' + esc(tip) + '">' +
          '<span class="num">' + d + '</span>' +
          (away.length
            ? '<div class="away">' + away.map(function (id) {
                var o = OWNER_BY_ID[id]
                return '<span class="away-chip" style="background:' + o.color + ';color:' + o.fg + '">' + esc(o.name.slice(0, 1)) + '</span>'
              }).join('') + '</div>'
            : '') +
        '</div>'
      )
    }
    while (cells.length % 7 !== 0) cells.push('<div class="cal-cell blank"></div>')

    return (
      '<section class="month">' +
        '<h3>' + MONTH_NAMES[m - 1] + ' ' + y + '</h3>' +
        '<div class="month-sub muted tiny">' + (total - working) + ' holidays · ' + working + ' working days</div>' +
        '<div class="cal-grid">' +
          DOW_NAMES.map(function (n) { return '<div class="cal-dow">' + n + '</div>' }).join('') +
          cells.join('') +
        '</div>' +
        '<div class="month-foot tiny muted">' +
          '<span><b style="color:var(--ok)">' + clear + '</b> days with everyone selected available</span>' +
          '<span><b>' + (working - clear) + '</b> working days with someone away</span>' +
        '</div>' +
      '</section>'
    )
  }

  function calendarView() {
    var people = activePeople()
    if (!people.length) return '<p class="empty">No people selected — pick Clay, Hari or Gideon above.</p>'
    return '<div class="months">' + MONTHS.map(function (mm) { return monthCard(mm.y, mm.m) }).join('') + '</div>'
  }

  /* ---------- people ---------- */

  function awayBlocks(id) {
    var days = (PLAN.leave[id] || []).slice().sort()
    var blocks = []
    days.forEach(function (d) {
      var last = blocks[blocks.length - 1]
      if (last && addDays(last.to, 1) === d) last.to = d
      else blocks.push({ from: d, to: d })
    })
    return blocks
  }

  function personStats(id) {
    var working = 0, leaveOnWorking = 0, leaveTotal = 0
    ALL_DAYS.forEach(function (k) {
      var hol = isHoliday(k)
      var away = isAway(id, k)
      if (away) leaveTotal++
      if (!hol) {
        working++
        if (away) leaveOnWorking++
      }
    })
    return { working: working, leaveTotal: leaveTotal, leaveOnWorking: leaveOnWorking, available: working - leaveOnWorking }
  }

  function personStrip(id) {
    return MONTHS.map(function (mm) {
      var total = daysInMonth(mm.y, mm.m)
      var cells = []
      for (var d = 1; d <= total; d++) {
        var key = iso(mm.y, mm.m, d)
        var hol = isHoliday(key)
        var away = isAway(id, key)
        var style = away ? ' style="background:' + OWNER_BY_ID[id].color + '"' : ''
        cells.push(
          '<i class="cellx' + (hol && !away ? ' holiday' : '') + (away ? ' leave' : '') + '"' + style +
            ' title="' + esc(label(key) + (away ? ' · away' : hol ? ' · holiday' : ' · available')) + '"></i>'
        )
      }
      return (
        '<div class="strip-row">' +
          '<span class="strip-label">' + MONTH_NAMES[mm.m - 1] + '</span>' +
          '<div class="strip">' + cells.join('') + '</div>' +
        '</div>'
      )
    }).join('')
  }

  function teamCard() {
    var people = activePeople()
    var working = 0, allClear = 0, oneAway = 0, twoAway = 0
    ALL_DAYS.forEach(function (k) {
      if (isHoliday(k)) return
      working++
      var n = awayOn(k, people).length
      if (n === 0) allClear++
      else if (n === 1) oneAway++
      else twoAway++
    })
    return (
      '<div class="team-card">' +
        '<h3>Team, ' + esc(PLAN.rangeLabel) + '</h3>' +
        '<div class="stats">' +
          stat(PLAN.holidayCount, 'holidays') +
          stat(working, 'working days in range') +
          stat(allClear, 'days everyone available') +
          stat(oneAway, 'days one person away') +
          stat(twoAway, 'days two or more away') +
        '</div>' +
        '<div class="muted tiny">A working day is a configured workday that is not a holiday.</div>' +
      '</div>'
    )
  }

  function stat(v, k) {
    return '<div class="stat"><div class="v">' + v + '</div><div class="k">' + esc(k) + '</div></div>'
  }

  function peopleView() {
    var people = activePeople()
    if (!people.length) return '<p class="empty">No people selected — pick Clay, Hari or Gideon above.</p>'
    return (
      teamCard() +
      people.map(function (id) {
        var o = OWNER_BY_ID[id]
        var s = personStats(id)
        var blocks = awayBlocks(id)
        return (
          '<div class="person-card">' +
            '<div class="person-head">' +
              '<i class="dot" style="background:' + o.color + '"></i>' +
              '<h3>' + esc(o.name) + '</h3>' +
              '<span class="muted small">' + (blocks.length ? blocks.length + ' away block' + (blocks.length > 1 ? 's' : '') : 'no non-availability recorded') + '</span>' +
            '</div>' +
            '<div class="stats">' +
              stat(s.available, 'days available') +
              stat(s.leaveOnWorking, 'leave days lost') +
              stat(s.leaveTotal, 'leave days marked') +
              stat(s.working, 'working days in range') +
            '</div>' +
            personStrip(id) +
            (blocks.length
              ? '<div class="blocks">' + blocks.map(function (b) {
                  var n = Math.round((parse(b.to) - parse(b.from)) / 86400000) + 1
                  var text = b.from === b.to ? label(b.from) : label(b.from) + ' – ' + label(b.to)
                  return '<span class="block-pill">' + esc(text) + ' <span class="muted">· ' + n + 'd</span></span>'
                }).join('') + '</div>'
              : '') +
          '</div>'
        )
      }).join('')
    )
  }

  /* ---------- tasks (listed, never dated) ---------- */

  function matches(t) {
    if (!on(t.owner)) return false
    var q = state.query.trim().toLowerCase()
    if (!q) return true
    if (t.title.toLowerCase().indexOf(q) !== -1) return true
    return (t.subtasks || []).some(function (s) { return s.title.toLowerCase().indexOf(q) !== -1 })
  }

  function taskRow(t) {
    var o = OWNER_BY_ID[t.owner]
    var subs = t.subtasks || []
    var isOpen = state.open.indexOf(t.id) !== -1
    var head = subs.length
      ? '<div class="task-head clickable" data-task="' + t.id + '">'
      : '<div class="task-head">'
    return (
      '<div class="task">' +
        head +
          '<span class="caret">' + (subs.length ? (isOpen ? '▾' : '▸') : '') + '</span>' +
          '<span class="task-title">' + esc(t.title) + (t.milestone ? ' 🏁' : '') + '</span>' +
          (state.groupBy === 'owner'
            ? '<span class="tag">' + esc(weekName(t.week)) + '</span>'
            : '<span class="tag owner" style="background:' + o.color + ';color:' + o.fg + '">' + esc(o.name) + '</span>') +
          (t.tag ? '<span class="tag">' + esc(t.tag) + '</span>' : '') +
          (subs.length ? '<span class="tag">' + subs.length + '</span>' : '') +
        '</div>' +
        (subs.length && isOpen
          ? '<ul class="subs">' + subs.map(function (s) { return '<li>' + esc(s.title) + '</li>' }).join('') + '</ul>'
          : '') +
      '</div>'
    )
  }

  function weekName(id) {
    for (var i = 0; i < PLAN.weeks.length; i++) if (PLAN.weeks[i].id === id) return PLAN.weeks[i].name
    return id
  }

  function group(title, dotColor, tasks) {
    if (!tasks.length) return ''
    return (
      '<section class="group">' +
        '<h3>' + (dotColor ? '<i class="dot" style="background:' + dotColor + '"></i>' : '') +
          esc(title) + '<span class="count">' + tasks.length + '</span></h3>' +
        tasks.map(taskRow).join('') +
      '</section>'
    )
  }

  function tasksView() {
    var visible = currentPlan().tasks.filter(matches)
    var notice =
      '<div class="notice small">' +
        '<b>Not a schedule.</b> These tasks carry no start date, no due date and no calendar placement — ' +
        'the week tag is the bucket <i>' + esc(currentPlan().name) + '</i> lists them under, nothing more. ' +
        'Dates live only in the holiday and non-availability views.' +
      '</div>'

    if (!visible.length) return notice + '<p class="empty">Nothing matches that filter.</p>'

    var body
    if (state.groupBy === 'owner') {
      body = OWNERS.map(function (o) {
        return group(o.name, o.color, visible.filter(function (t) { return t.owner === o.id }))
      }).join('')
    } else if (state.groupBy === 'week') {
      body = PLAN.weeks.map(function (w) {
        return group(w.name, null, visible.filter(function (t) { return t.week === w.id }))
      }).join('')
    } else {
      body = group('All tasks, document order', null, visible)
    }
    return notice + '<div class="groups">' + body + '</div>'
  }

  /* ---------- render ---------- */

  var root = document.getElementById('app')

  function render() {
    var body =
      state.view === 'calendar' ? calendarView() :
      state.view === 'people' ? peopleView() :
      tasksView()
    var focused = document.activeElement && document.activeElement.id === 'q'
    root.innerHTML = topbar() + '<main>' + body + '</main>'
    if (focused) {
      var q = document.getElementById('q')
      if (q) {
        q.focus()
        q.setSelectionRange(q.value.length, q.value.length)
      }
    }
  }

  root.addEventListener('click', function (e) {
    var el = e.target.closest('[data-view], [data-owner], [data-group], [data-plan], [data-task]')
    if (!el) return
    if (el.dataset.view) {
      state.view = el.dataset.view
      if (location.hash.slice(1) !== state.view) location.hash = state.view
    } else if (el.dataset.owner) {
      var id = el.dataset.owner
      var i = state.filter.indexOf(id)
      if (i === -1) state.filter.push(id)
      else state.filter.splice(i, 1)
    } else if (el.dataset.group) {
      state.groupBy = el.dataset.group
    } else if (el.dataset.plan) {
      state.plan = el.dataset.plan
    } else if (el.dataset.task) {
      var t = el.dataset.task
      var j = state.open.indexOf(t)
      if (j === -1) state.open.push(t)
      else state.open.splice(j, 1)
    }
    persist()
    render()
  })

  window.addEventListener('hashchange', function () {
    var v = location.hash.slice(1)
    if (VIEWS.indexOf(v) !== -1 && v !== state.view) {
      state.view = v
      persist()
      render()
    }
  })

  root.addEventListener('input', function (e) {
    if (e.target.id !== 'q') return
    state.query = e.target.value
    render()
  })

  render()
})()
