# Planner fleet: add a plan from a web page

Every planner on the box is listed in one registry. A new one is added from the
admin page (or the CLI), which does all of [devops/README.md](../README.md)'s
"adding a planner" by itself:

1. check `<subdomain>.FLEET_DOMAIN` resolves to this box (**make the DNS A record
   first**; nothing here touches DNS)
2. pick a free loopback port and the folder `~/<name>_planner_ws`, copy the
   template checkout there (no data, config or `.env`)
3. start it with the default config (`examples/minimal.config.json`)
4. register it, regenerate `PLAN_SITES` in the edge checkout, recreate the edge
5. issue its certificate over the webroot, restart the edge
6. check `https://<host>/api/health`

If the build or health check fails, the half-made planner is taken down and its
folder removed. Steps 4–6 are safe to repeat.

```
browser ─▶ plans.<domain> ─▶ nginx-plan ─▶ 127.0.0.1:8090 fleet-admin (node, no deps, basic auth)
                                               │ writes ~/planner-fleet/requests/<id>.json
                                               ▼ systemd planner-fleet.path
                             planner-ctl.sh run-queue on the HOST
                               → ~/planner-fleet/status/<id>.json + logs/<id>.log
browser polls /api/jobs/<id> ◀── fleet-admin reads them
```

## Users and roles

People sign in on the page (cookie session, 12 h; passwords are scrypt hashes
in `~/planner-fleet/users.json`).

| Role | Can |
| --- | --- |
| **viewer** | see the plans and open them |
| **user** | + add plans, delete the plans **they** added |
| **admin** | + delete any plan, add/remove users, change roles, reset passwords, read the activity log |

`admin` is the root user: it can't be deleted or demoted. It is created on the
page's first start with `FLEET_ADMIN_PASSWORD` from `devops/fleet/.env`; after
that its password is changed from the page. (Lost it? Stop `fleet-admin`, delete
the `admin` entry from `users.json`, set `FLEET_ADMIN_PASSWORD`, start it again.)

Each plan's owner is the 5th column of `planners.tsv` (`admin` for the plans
that existed before). The plan that runs the edge / is the template can't be
deleted from the page. Deleting a plan takes it offline and drops its site; its
folder and data volume stay on the box (so the same name can't be re-added until
an admin clears them).

Every sign-in (and failed one), plan request, plan outcome and user change is
appended to `~/planner-fleet/activity.jsonl`, shown to admins on the page.

Note the roles guard this admin page only: the plan sites themselves stay open
to anyone with their link, as before.

Like the updater, the page never gets the Docker socket: it can only queue
"add `<subdomain>`", and the host re-validates that before doing anything.

## Files

```
devops/fleet/
  planner-ctl.sh            the host side: add, list, remove, sync-sites, cert, run-queue
  admin/server.mjs          the admin page's API (dependency-free node)
  admin/index.html          the admin page
  compose.fleet.yml         runs admin/ in node:22-alpine on 127.0.0.1:8090
  planner-fleet.{path,service}  systemd: run planner-ctl.sh when a request appears
  fleet.env.example         settings for both (/etc/planner-fleet.env and .env here)
```

State, in `~/planner-fleet/`:

| | |
| --- | --- |
| `planners.tsv` | **the registry**: `name<TAB>dir<TAB>port<TAB>hostname` per planner. `PLAN_SITES` and the updater's checkout list are generated from it. |
| `requests/` | pending requests from the page |
| `status/`, `logs/` | one status and one log per job (newest 50 kept) |
| `bin/planner-ctl.sh` | the installed script, outside every checkout so a release can't replace it mid-run |

## Install (once per box)

On the box, from the checkout that runs the edge (`FLEET_EDGE_CHECKOUT`):

```bash
mkdir -p ~/planner-fleet/{bin,requests,status,logs}
cp devops/fleet/planner-ctl.sh ~/planner-fleet/bin/

# The registry: every planner already on the box (tab-separated).
printf '%s\t%s\t%s\t%s\n' \
  foo   /home/ubuntu/foo_planner_ws     8080 foo.example.com \
  bar /home/ubuntu/project_planner_ws 8081 bar.example.com \
  > ~/planner-fleet/planners.tsv

sudo cp devops/fleet/fleet.env.example /etc/planner-fleet.env      # check every value
sudo cp devops/fleet/planner-fleet.service devops/fleet/planner-fleet.path /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now planner-fleet.path

# The admin page.
cp devops/fleet/fleet.env.example devops/fleet/.env                 # set FLEET_ADMIN_PASSWORD (root's first password)
docker compose -f devops/fleet/compose.fleet.yml up -d

# Its hostname: make the DNS record (ADMIN_SITE's host -> this box), then
set -a; . /etc/planner-fleet.env; set +a
~/planner-fleet/bin/planner-ctl.sh admin-site                       # edge + certificate
```

Then let the updater follow the registry: in `/etc/planner-updater.env` delete
`CHECKOUTS` and add `FLEET_REGISTRY=/home/ubuntu/planner-fleet/planners.tsv`.

## Operating it

| To… | Do this |
| --- | --- |
| Add a plan | Make the DNS A record, then the admin page: type the subdomain, **Add plan**, watch the log. Or `planner-ctl.sh add <subdomain>` (`--name` for a shorter project name, `--dry-run` to see the port and folder). |
| See what's there | The admin page, or `planner-ctl.sh list` |
| Fix a planner whose https failed | `planner-ctl.sh cert <host>` (after fixing DNS) |
| Remove one | `planner-ctl.sh remove <name>`: stops it and drops its site. Its folder and `<name>_plan_data` volume are **kept**; delete them by hand when sure. |
| Follow a job | `~/planner-fleet/logs/<id>.log`, or `journalctl -u planner-fleet` |

Running the CLI by hand needs the same settings systemd gives it:
`set -a; . /etc/planner-fleet.env; set +a` first.

After a release changes `devops/fleet/`: re-copy `planner-ctl.sh` to
`~/planner-fleet/bin/` and `docker restart fleet-admin` (it serves `admin/` from
the edge checkout, which the updater already refreshed).
