# Project planner

A configurable version of the unbox plan board. **One document,
`planner.config.json`, describes the whole project**:
people and their leave, workdays, holidays, weeks, every task, and any number of
scenarios. The board, calendar, Gantt, availability lanes, week summaries and
the standalone `/availability/` page are all built from it at runtime.

`planner.config.json` is **not tracked by git** (it is in `.gitignore`): each
deployment keeps its own plan. The repo ships
[`planner.config.example.json`](planner.config.example.json), the unbox hardware
plan (both the week-3 and week-8 robot arrival docs), as a starting point. Copy
it, then replace its content with your project.

```bash
cp planner.config.example.json planner.config.json   # once, then edit it
npm install
npm run check-config   # validate planner.config.json
npm run api            # the shared store + config, on :3000, writing to .data/
npm run dev            # the app, on :5173, proxying /api to it
npm run build          # dist/ (the board and /availability/)
```

- **[CONFIG.md](CONFIG.md)** documents every field of the config.
- **API docs:** Swagger UI at **`/api/docs`** (e.g. http://localhost:5173/api/docs
  in dev). The spec is [`server/openapi.yaml`](server/openapi.yaml), also served at
  `/api/openapi.yaml`.
- **[examples/minimal.config.json](examples/minimal.config.json)** is a small,
  complete config to start a new project from.

## Changing the plan

| To… | Do this |
| --- | --- |
| Add, rename or remove tasks; change people, leave, holidays, weeks or scenarios | Edit `planner.config.json`, or use **Settings** in the app (validated as you type, then **Save for everyone**). Open boards rebuild within a few seconds. |
| Move one task | Drag it on any page: a Board card to another week column, a Gantt bar (drag its edges to resize), a Calendar chip to a day, or an Availability bar to a lane (another person's lane hands it over). You can also nudge it from the drawer with **−5 / −1 / +1 / +5 working days**. |
| Move a person's later work along with it | Keep **push later work** ticked in the toolbar. When a task moves or grows, that owner's later tasks shift by the same number of *their* working days, on every page. |
| Move many tasks at once | Use **Reschedule…**: pick a start date, a number of working days and which people. It previews every task it will move, and the whole move is one undo. |
| Change how long a task is | Edit **Working days** in the drawer. The due date is recomputed around leave and holidays. |
| Make a new task | Use **+ Task** in the toolbar or **+ Add item** in a board column. |
| Copy a task | Use **Duplicate** in the drawer. |
| Recreate a task | Use **Delete** to send it to the trash (Settings), then **Restore** it, or **Recreate from config** to rebuild it fresh from the document. |
| Take back an edit | Use **↶ / ↷**, or Ctrl+Z / Ctrl+Shift+Z. |
| Start over | **Redraw** re-places everything from its planned week around availability. **Reset** rebuilds the scenario from the config. Both can be undone. |

## Dates mean the same thing on every page

There is one copy of each task's dates, and every page reads and writes it
through the same rules (`src/lib/planReducer.js`):

- **Columns follow dates.** A Board week column holds the tasks that *start*
  that week, matching how the Gantt groups them. If leave pushed a task out of
  its planned week, its card says "planned Week 4".
- **Lengths are in working days.** A move keeps the task's working-day length,
  so dropping a 6-day task across a holiday makes it end a day later. It never
  silently shrinks.
- **Nothing is drawn on a day its owner doesn't work.** Bars are cut into
  segments around holidays, non-workdays and leave, and the calendar shows a
  task only on worked days.
- **The scenario marker** (e.g. *Robot arrives*) is the same gold line on the
  Calendar, Gantt and Availability pages.

## Shared, not local

Every edit is stored on the server, so everyone sees the same plan:

- **One document per scenario.** `server/index.mjs` stores each scenario as its
  own JSON document. Boards save about 700 ms after an edit and poll every 8 s.
- **Concurrent edits merge.** A save made against a stale version is rejected
  with the current document attached, and the browser merges the two task by
  task (`src/lib/merge.js`). Two people editing different things both keep
  their edits.
- **The config is shared too.** It is one more document on the server
  (`GET/PUT/DELETE /api/config`). It is read from `planner.config.json` unless
  someone saved an edit from Settings.
- **Offline is covered.** `localStorage` only mirrors the last known board, so
  the app still renders and keeps offline edits while the server is
  unreachable.

## New releases

Publish a GitHub release and every open board offers it. The page blurs and shows
**"v0.3.0 is available"** with the release notes. **Update now** has the server pull
that release and redeploy itself, keeping its config and data. When the new build
is live, every board offers **Reload now**. Nothing shows when there is nothing new.

- **Releasing:** bump `package.json` (`npm version X.Y.Z --no-git-tag-version`),
  commit, tag `vX.Y.Z`, push, then publish the GitHub release. Its notes are shown
  in the prompt.
- **Deploying it** is done by a small host updater
  ([`devops/updater/`](devops/updater/README.md)), installed once per server. Without
  it, boards still notice a newly deployed build and offer a reload, but can't start
  an update themselves.

## Layout

```
planner.config.json      the project — the only place plan content lives (untracked)
planner.config.example.json  a complete example (the unbox plan) to copy from
CONFIG.md                every config field
examples/                a minimal config to start from
server/index.mjs         plan + notes + config store (node, no dependencies)
server/openapi.yaml      OpenAPI 3 spec of that store, rendered at /api/docs
src/lib/model.js         config → model: validation, people, weeks, scenarios (live bindings)
src/lib/config.jsx       loads/polls/saves the config; remounts the app when it changes
src/lib/schedule.js      availability, working-day maths, placement, redraw
src/lib/planReducer.js   every edit: moves, ripple, bulk reschedule, trash, config sync, undo
src/lib/store.jsx        plan sync loop (debounced save, poll, merge on conflict)
src/views/               Board, Calendar, Gantt, Availability, Notes, Settings
availability/            standalone holidays-and-leave page, fed by the same model
tools/check-config.mjs   validate a config from the command line
devops/                  docker: nginx edge + TLS, static bundles, plan-api; updater/ self-update
```

## Deploying

```bash
test -f planner.config.json || cp planner.config.example.json planner.config.json
cd devops/docker
cp .env.plan.example .env      # COMPOSE_PROJECT_NAME, PLAN_PORT, PLAN_SITES
docker compose -f compose.plan.yml up -d --build   # this planner, on 127.0.0.1:$PLAN_PORT
docker compose -f compose.edge.yml up -d           # once per box: hostname -> port, TLS
```

Several planners can share a box: one checkout each, each with its own
`COMPOSE_PROJECT_NAME` and `PLAN_PORT`, and one edge nginx whose `PLAN_SITES`
maps every hostname to its planner's port. Compose bind-mounts
`planner.config.json` into `plan-api`, so editing it on the host needs no
rebuild. See `devops/README.md`.
