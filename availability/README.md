# availability

A standalone page next to the board, served at `/availability/`. It plots **only
holidays and per-person leave** on month grids, gives per-person totals, and
lists tasks by owner or planned week without dates.

It has no data of its own. `loader.js` reads the same config (`/api/config`, or
the bundled `planner.config.json` without a server) and the same live plans
(`/api/plans/<scenario>`) as the board, through the same `src/lib/model.js`. So
it always agrees with the board, and a config change shows up on reload. The
page itself (`app.js`) is the original plain-JS view, fed `window.PLAN`.

The months shown are those the plan's timeline mostly covers. People are the
owners with `scheduling: "availability"`.
