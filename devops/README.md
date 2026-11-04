# Deploying the plan board

Several planners can share one box, each on its own hostname. **The plan is
shared**: each planner's `plan-api` holds one JSON document per plan on a volume,
and every browser reads and writes it.

```
                         ┌─ 127.0.0.1:8080  plan-ui ─ /api/ ─ plan-api    (ubr checkout)
:80/:443  nginx-plan ────┤
  PLAN_SITES maps        └─ 127.0.0.1:8081  osmos-ui ─ /api/ ─ osmos-api  (osmos checkout)
  hostname -> port
```

- **A planner** is `compose.plan.yml`: `plan-api` and `plan-ui` on their own
  compose network, published as **one** loopback port, `PLAN_PORT`. `plan-ui`
  serves the bundles and proxies `/api/` to its own `plan-api`, so that one port
  is the whole planner. Run it once per planner, each from its own checkout (each
  has its own untracked `planner.config.json` and its own `.env`).
- **The edge** is `compose.edge.yml`: `nginx-plan` on 80/443 and `certbot-plan`.
  Run it **once per box**, from any one checkout. `PLAN_SITES` in that checkout's
  `.env` maps each hostname to a planner's port.

```
devops/
  docker/
    Dockerfile            node builder -> nginx static-runner, plus api-runner
    static-site.conf      nginx INSIDE plan-ui: the bundles, and /api/ -> plan-api
    compose.plan.yml      one planner: plan-api + plan-ui on PLAN_PORT
    compose.edge.yml      the box's edge: nginx (host network) + certbot
    .env.plan.example     copy to .env
  nginx/
    plan-sites.sh         writes the edge config from PLAN_SITES at every start
```

## What keeps two planners apart

| | first planner (ubr) | another planner (osmos) |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | unset → project `docker` | `osmos` |
| containers | `plan-api`, `plan-ui` | `osmos-api`, `osmos-ui` |
| images | `plan-api:local`, `plan-ui:local` | `osmos-api:local`, `osmos-ui:local` |
| volume | `docker_plan_data` | `osmos_plan_data` |
| `PLAN_PORT` | `8080` (default) | `8081` |
| hostname (`PLAN_SITES`) | `ubr.neuralpilot-dev.com=8080` | `osmos.neuralpilot-dev.com=8081` |

`COMPOSE_PROJECT_NAME` is not optional for a second planner. Every checkout's
compose file sits in a directory called `docker`, so without it both would be
the one project `docker`, and `up` in one checkout would **recreate the other's
containers** with its own config. Only the box's original planner leaves it
unset, so it keeps the names it already has.

## Adding a planner to a box that already runs one

On the osmos checkout:

```bash
test -f planner.config.json || cp planner.config.example.json planner.config.json
cd devops/docker
cp .env.plan.example .env      # COMPOSE_PROJECT_NAME=osmos, PLAN_PORT=8081
docker compose -f compose.plan.yml up -d --build
curl -s 127.0.0.1:8081/api/health
```

On the checkout that runs the edge, add the hostname to `PLAN_SITES` and
recreate the edge. The new hostname has no certificate yet, so it is served on
:80 only (ACME challenges, 503 otherwise); the other sites are not affected:

```bash
cd devops/docker
# .env: PLAN_SITES="ubr.neuralpilot-dev.com=8080 osmos.neuralpilot-dev.com=8081"
docker compose -f compose.edge.yml up -d --force-recreate nginx
```

The hostname must resolve to this box. Issue its certificate over the webroot
the edge is already serving, then restart the edge so it picks the certificate
up and adds the :443 block:

```bash
sudo docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /var/www/certbot:/var/www/certbot \
  certbot/certbot certonly --webroot -w /var/www/certbot -d osmos.neuralpilot-dev.com
docker restart nginx-plan
```

Renewals need no further attention: `certbot-plan` wakes twice a day and renews
every certificate over `/var/www/certbot`, which the edge serves on port 80 for
every site.

## Moving the original box onto this layout

A box deployed before this change runs the edge inside the planner's own
project (`nginx-plan` and `certbot-plan` belong to project `docker`). On that
checkout, after pulling:

```bash
cd devops/docker
# .env: add PLAN_SITES="ubr.neuralpilot-dev.com=8080"; the old PLAN_SERVER_NAME,
#       PLAN_*_UPSTREAM and PLAN_*_HOST_PORT lines are no longer read
docker compose -f compose.plan.yml up -d --build --remove-orphans   # rebuilds plan-ui with /api/; removes the old nginx-plan + certbot-plan
docker compose -f compose.edge.yml up -d                            # the edge again, now for every site
```

The site is down between those two commands (seconds). `plan-api`, `plan-ui`
and the `docker_plan_data` volume keep their names, so no plan data moves.
`plan-api` is no longer published on `127.0.0.1:3001`; reach it through the
planner's port, e.g. `curl 127.0.0.1:8080/api/health`.

## First deploy on an empty box

```bash
test -f planner.config.json || cp planner.config.example.json planner.config.json
cd devops/docker
cp .env.plan.example .env      # COMPOSE_PROJECT_NAME, PLAN_PORT, PLAN_SITES
docker compose -f compose.plan.yml up -d --build
docker compose -f compose.edge.yml up -d          # :80 only until the certificate exists
```

Then issue the certificate over the webroot and `docker restart nginx-plan`, as
above.

## The plan store

`plan-api` (`server/index.mjs`) is a dependency-free node service:

```
GET  /api/health
GET  /api/config        -> { version, source: file|app, updatedAt, config }
PUT  /api/config        -> { baseVersion, config }     (Settings → Save)
DELETE /api/config      -> back to planner.config.json (Settings → Revert)
GET  /api/plans/:id     -> { version, updatedAt, tasks, checkpoints, trash, meta }
PUT  /api/plans/:id     -> { baseVersion, tasks, checkpoints, trash, meta }
GET  /api/notes         -> { version, updatedAt, notes }
PUT  /api/notes         -> { baseVersion, notes }
                           200 with the new version, or 409 carrying the CURRENT
                           document so the browser can merge instead of guess
```

The full contract, with request/response schemas, is `server/openapi.yaml`, browsable
as Swagger UI at `https://<hostname>/api/docs`.

One file per document on the planner's `<project>_plan_data` volume — one `<scenario-id>.json` per
scenario, the sticky-note wall in `notes.json`, and `config.json` if the config
was edited in the app —, written to a temp file and renamed
so a reader never sees a half-written plan. Writes for the same plan are
serialised, and the version check is what stops two people's saves from
overwriting one another.

The volume is the whole of that planner's state:

```bash
docker run --rm -v osmos_plan_data:/data -v "$PWD":/out alpine tar czf /out/plans.tgz -C /data .
docker exec osmos-api cat /data/main.json        # or just read one
```

(The box's original planner is `docker_plan_data` / `plan-api`.)

## Updating a planner

```bash
docker compose -f compose.plan.yml up -d --build
```

The edge keeps serving while a planner rebuilds, and answers 502 for that
hostname alone for the seconds its container is down. Rebuilding `plan-api` does
not touch the plans: they are on the volume, not in the image. `.env` is read at
container **creation**, so after editing it use `up -d --force-recreate` — a
plain `restart` keeps the old values and nothing says so. The one exception is
the certificate check in `plan-sites.sh`, which runs at every edge start, so a
new certificate needs only `docker restart nginx-plan`.

## What is in the image

`Dockerfile` validates the config (`npm run check-config` — a broken config
fails the build, not everyone's browser), builds both pages in one Vite build
and copies `dist/` into nginx:

- `/` — the board, hash-routed (`#lf8/gantt`), so the server only ever sees
  `/`; a stray deep link falls back to `index.html`.
- `/availability/` — the standalone availability page, built from the same
  model code.

Neither page has plan content baked in: both fetch `/api/config` and the plans
at runtime, so **changing the config never needs a rebuild**. `plan-api` reads
`planner.config.json` from `/app`, which compose bind-mounts from the repo, so
editing the file on the host is picked up within one poll (8 s). An edit saved
from the app's **Settings** page is stored on the volume as `config.json` and
wins until someone presses **Revert to file**.

Caching follows what each file actually is: `/assets/` is content-hashed and
immutable for a year, and the two `index.html` files are revalidated because
they are the only files naming the current hashes.

## Notes

- **Nothing is resolved at boot.** The edge proxies to literal
  `127.0.0.1:<port>` addresses, and `plan-ui` resolves `plan-api` per request
  (`resolver 127.0.0.11` plus a variable in `proxy_pass`). So a planner that is
  down or slow to start is a 502 for its own hostname, never an nginx that will
  not boot. Verified: with one planner's `plan-ui` stopped, its hostname returns
  502 and the other's 200.
- **A missing certificate only affects its own site.** `plan-sites.sh` writes the
  :443 block only when `/etc/letsencrypt/live/<hostname>/` has the files, because
  one `ssl_certificate` that does not exist fails the whole nginx config.
- **The edge is on the host network** so it reaches each planner on the same
  loopback address you would `curl`. Planner ports are published on `127.0.0.1`
  only, so nothing off-box reaches a planner except through the edge.

## Without TLS

On an internal box with no public name, skip the edge: `compose.plan.yml` alone
gives the whole planner, `/api/` included, on `127.0.0.1:$PLAN_PORT`.
