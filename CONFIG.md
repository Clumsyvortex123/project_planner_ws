# planner.config.json — reference

One JSON document describes the whole project: who works on it, when they work,
the weeks, the tasks, and the scenarios. Every page — Board, Calendar, Gantt,
Availability, Notes, Settings and the standalone `/availability/` page — is
built from it at runtime. Nothing else holds plan content.

Check a config without starting anything:

```bash
npm run check-config                                  # planner.config.json
npm run check-config -- examples/minimal.config.json  # any other file
```

`examples/minimal.config.json` is a small complete config to start a new
project from; `planner.config.json` is the unbox hardware plan, which exercises
every field.

## Where the document lives, and how changes reach the boards

| Edit it… | What happens |
| --- | --- |
| in the file `planner.config.json` | `plan-api` serves the file. Open boards notice the change within one poll (8 s by default) and rebuild. |
| in the app, **Settings → Save for everyone** | Validated in the browser, stored on the server as `config.json` in the data dir, and it **wins over the file** until **Revert to file**. **Download** gives you the edited document to commit back to the file. |

When the config changes, each plan is brought in line **three-way**: for every
field the config owns (title, owner, week, subtasks, dates, flags…) the config's
value replaces the plan's only if *the config itself changed it* since the plan
last synced. Dates dragged, titles edited and boxes ticked on the boards survive
unrelated config edits.

- A task **added** to the config appears on the boards, placed around
  availability like a fresh plan would place it.
- A task **removed** from the config goes to the trash (Settings), from where it
  can still be restored.
- A task whose **owner or week** changes in the config is re-placed.
- Calendar changes (holidays, leave, workdays) take effect in every view at
  once — bars and day counts re-segment around the new days off — but don't move
  any task. Press **Redraw** to re-place everything around them.

## Top level

```jsonc
{
  "project":   { ... },
  "calendar":  { ... },
  "weeks":     [ ... ] or { ... },
  "people":    [ ... ],
  "areas":     [ ... ],          // optional
  "flags":     { ... },          // optional
  "tasks":     [ ... ],
  "scenarios": [ ... ],          // optional: one plan called "Plan" if omitted
  "defaultScenario": "lf3",      // optional: first scenario if omitted
  "settings":  { ... }           // optional
}
```

## project

| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits, `-`, `_`. Prefixes browser storage keys, so two projects on one host don't collide. |
| `title` | Shown in the header and the browser tab. |
| `docUrl` | Optional. The **Doc ↗** link, unless a scenario has its own. |

## calendar

| Field | Default | Meaning |
| --- | --- | --- |
| `workdays` | mon–fri | Days of the week anyone works: `"mon"`…`"sun"` or `0`…`6` (0 = Sunday). |
| `holidays` | `[]` | Days nobody works. Each entry is a date `"2026-10-20"`, a range `"2026-12-24..2026-12-31"`, or `{ "date": …, "name": "Diwali" }` / `{ "from": …, "to": …, "name": … }`. Names show on the Calendar. |
| `weekEffortDays` | number of workdays | How many working days one week of planned work is worth. |
| `blockWeeks` | `2` | Size of the checkpoint blocks on the Gantt ("Weeks 1–2"). |
| `timeline` | the weeks' span | `{ "start"?, "end"? }` stretches the visible range past the weeks. |

## weeks

Either an explicit list (when weeks are irregular, e.g. one that starts late
because of a holiday):

```json
"weeks": [
  {"id": "w1", "name": "Week 1", "start": "2026-08-31", "end": "2026-09-05", "note": "ETC 5/9/26"},
  {"id": "w2", "name": "Week 2", "start": "2026-09-07", "end": "2026-09-12"}
]
```

…or a generator:

```json
"weeks": {"start": "2026-11-02", "count": 10, "length": 5, "prefix": "Week", "notes": {"w4": "Design sign-off"}}
```

Generated weeks are `w1…wN`, 7 days apart, each `length` days long (default 7).
`id` defaults to `w<n>`, `name` to `Week <n>`, `end` to start + 6 days.

## people

```json
{"id": "clay", "name": "Clay", "color": "#FDEA9B", "leave": ["2026-09-15..2026-09-18", "2026-10-01"]}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `id`, `name` | — / id | `id` is what tasks reference as `owner`. |
| `color`, `fg` | palette / auto | Bar colour, and the text colour on it (worked out for contrast if omitted). |
| `leave` | `[]` | Days this person is away; same date forms as `holidays`. |
| `scheduling` | `"availability"` | `"fixed"` for a vendor or bucket: its tasks keep their planned week's dates instead of being redrawn around availability. |
| `hidden` | `false` | Keep the owner and their tasks in the document but off every page. |

## tasks

```json
{
  "id": "t11", "title": "Cartographer integration with mapping server",
  "owner": "hari", "week": "w3",
  "subtasks": ["cartographer core implementation", "data feeding"],
  "area": "Mapping", "outcome": "cartographer builds, exports, annotates and layers maps",
  "extendUntil": "2026-09-26"
}
```

| Field | Meaning |
| --- | --- |
| `id` | Unique, stable. Keep it when renaming a task: it is how edits on the boards stay attached. |
| `title`, `owner`, `week` | `week` is the **planned** week; it defaults to the first week. |
| `subtasks` | List of strings. Ticks made on the boards survive renaming other subtasks. |
| `effortDays` | Working days the task is worth. Default: one full week (`weekEffortDays`). |
| `start`, `end` | Pin the task to exact dates. Pinned tasks are never moved by **Redraw**. |
| `extendUntil` | The task runs to this date, and pushes the owner's later weeks along with it. |
| `area`, `outcome` | Used by the week summaries: "By 26 Sep the system: – Mapping: *outcome*". Falls back to the title. |
| `flags` | List of keys from `flags`, shown as pills (e.g. `"needs-robot"`). |
| `tag`, `milestone`, `notes` | Free text; milestone shows a pill; notes pre-fill the drawer. |

### How dates are placed

Each person works their weeks in the order the config lists them, and every
task inside one week runs alongside the others in it. A week's work starts on
the person's first free day on or after the week begins, and takes
`weekEffortDays` of their working days (or the task's `effortDays`). Leave and
holidays are stepped over. If that pushes the work past its week, **the
person's later weeks are pushed too**, so the sequence is kept and simply lands
later.

## areas and flags

```json
"areas": ["Platform", "Sim", "Hardware"],
"flags": {"needs-robot": {"label": "needs the robot"}}
```

`areas` sets the order of the summary lines (unlisted areas sort last). `flags`
gives each flag key its label.

## scenarios

Different versions of the same plan, switched in the header. Each one is a
separate document on the server, so edits in one never disturb another.

```json
{
  "id": "lf8", "name": "wk8", "group": "Robot arrival", "label": "Robot arrival — wk8",
  "blurb": "Robot only lands in week 8…", "docUrl": "https://…",
  "marker": {"week": "w8", "label": "Robot arrives"},
  "weekNotes": {"w8": "Robot arrives"},
  "layout": [["t1", "w1"], ["t2", "w1"], "t3"],
  "exclude": ["t46"],
  "overrides": {"t12": {"week": "w5", "owner": "clay"}},
  "add": [{"id": "s1", "title": "Only in this scenario", "owner": "hari", "week": "w2"}]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits, `-`, `_`; becomes the server filename and the URL hash (`#lf8/gantt`). |
| `name`, `group`, `label`, `blurb` | Toggle button text, toggle group heading, long name, hover text. |
| `marker` | A gold line on every timeline: `{ "week" \| "date", "label" }`. |
| `weekNotes` | Replaces the base week notes for this scenario. |
| `layout` | The scenario's own order and weeks: `[id, week]`, `"id"` (keeps its week) or `{ "id", "week" }`. Only listed tasks are included. An id that no longer exists is skipped with a warning. |
| `exclude` | Without `layout`: base tasks to leave out. |
| `overrides` | Per-task field changes for this scenario only. |
| `add` | Tasks that exist only in this scenario. |

## settings

| Field | Default | Meaning |
| --- | --- | --- |
| `defaultView` | `"board"` | `board`, `calendar`, `gantt`, `leavefirst`, `notes` or `settings`. |
| `saveDebounceMs` | `700` | How long after the last edit a board saves. |
| `pollMs` | `8000` | How often boards check for other people's edits and for config changes. |
