# Deploying the plan board

Same shape as `fleet_manager/devops/docker/compose.fleet.yml` — an nginx edge
holding TLS and the hostname, application containers behind it on a compose
network, and a certbot sidecar renewing over the webroot — minus the database and
the cache. **The plan is shared**: `plan-api` holds one JSON document per plan on
a volume, and every browser reads and writes it.

```
devops/
  docker/
    Dockerfile            node builder -> nginx static-runner, plus api-runner
    static-site.conf      nginx INSIDE plan-ui: serves the bundles
    compose.plan.yml      plan-api + plan-ui + edge nginx + certbot
    .env.plan.example     copy to .env
  nginx/
    templates/
      plan.conf.template  the edge: :80 redirect + ACME, :443 -> /api/ + the app
```

## First deploy

```bash
cd devops/docker
cp .env.plan.example .env      # then set PLAN_SERVER_NAME
```

`PLAN_SERVER_NAME` must resolve to this box. nginx renders it into both server
blocks **and** into the certificate paths, so a blank value produces a config
that matches no request.

Issue the certificate before the first `up` — the edge will not start without
one, since `ssl_certificate` is checked at load:

```bash
sudo mkdir -p /var/www/certbot
sudo docker run --rm -p 80:80 \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /var/www/certbot:/var/www/certbot \
  certbot/certbot certonly --standalone -d "$PLAN_SERVER_NAME"
```

Then bring the stack up:

```bash
docker compose -f compose.plan.yml up -d --build
```

Renewals need no further attention: the certbot service wakes twice a day and
renews over `/var/www/certbot`, which the edge serves on port 80, so nginx never
has to stop.

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
as Swagger UI at `https://$PLAN_SERVER_NAME/api/docs`.

One file per document on the `plan_data` volume — one `<scenario-id>.json` per
scenario, the sticky-note wall in `notes.json`, and `config.json` if the config
was edited in the app —, written to a temp file and renamed
so a reader never sees a half-written plan. Writes for the same plan are
serialised, and the version check is what stops two people's saves from
overwriting one another.

The volume is the whole of this deployment's state:

```bash
docker run --rm -v plan_data:/data -v "$PWD":/out alpine tar czf /out/plans.tgz -C /data .
docker exec plan-api cat /data/lf3.json          # or just read one
```

## Updating

```bash
docker compose -f compose.plan.yml up -d --build plan-ui plan-api
```

The edge keeps serving while those rebuild, and answers 502 for the seconds a
container is down. Rebuilding `plan-api` does not touch the plans: they are on
the volume, not in the image. `.env` is read at container **creation**, so after editing it
use `up -d --force-recreate` — a plain `restart` keeps the old values and nothing
says so.

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

## Notes carried over from the fleet setup

- **The backend is resolved per request.** `resolver 127.0.0.11` plus a variable
  in `proxy_pass`, rather than an `upstream` block. An `upstream` resolves its
  members when nginx boots and aborts if one is missing, so a slow `plan-ui`
  would take the edge down with it and the visible symptom would be nginx
  crash-looping rather than the thing that actually failed. Verified: with
  `plan-ui` stopped, `/` returns 502 and `/healthz` still returns 200.
- **`NGINX_ENVSUBST_FILTER: "^PLAN_"` is not optional.** Without it envsubst also
  replaces nginx's own `$host`, `$remote_addr` and `$scheme` with empty strings
  and every proxied request arrives with blank headers. It is an allowlist of
  names: a variable the template uses but the pattern misses survives as the
  literal `${NAME}`, which nginx then refuses to parse.
- **`plan-ui` publishes on loopback only** (`127.0.0.1:8080`). Nothing off-box
  reaches it except through the edge; the publish is there for `curl` from the
  host, and for running the board on a box that has no certificate yet.

## Without TLS

On an internal box with no public name, run the bundle container on its own and
skip the edge entirely:

```bash
docker compose -f devops/docker/compose.plan.yml up -d --build plan-api plan-ui
```

That gives the store on `127.0.0.1:3001` and the app on `127.0.0.1:8080` with no
edge and no certificate — but the app calls `/api` on its own origin, so put
something in front that routes both, or run the edge with a self-signed
certificate.
