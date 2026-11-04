# Self-update from GitHub releases

Publish a release on GitHub and every open board offers it: the page blurs and
shows **"v0.3.0 is available"** with the release notes. **Update now** makes the
server pull that release and redeploy itself. When the new build is live, every
board offers **Reload now**.

```
 board ──GET /api/release──▶ plan-api ──(cached 10 min)──▶ GitHub "latest release"
 board ──POST /api/release/update──▶ plan-api writes  ~/planner-updates/request.json
                                                              │  (systemd .path)
                                     planner-updater.sh  ◀────┘  on the HOST
                                       · reads GitHub's latest release itself
                                       · for each checkout that is behind:
                                           backup → copy release (keeps config, .env, data)
                                           → docker compose up -d --build
                                           → on failure: restore backup, rebuild
                                       · writes ~/planner-updates/status.json
 board ◀──GET /api/release (state: updating → done) ── then /version.json changes ── "Reload now"
```

Building runs on the host, not in a container: plan-api never gets the Docker
socket. The request carries no code and no version the updater trusts. It only
says "go and look", and the updater deploys whatever GitHub says is latest for
`RELEASE_REPO`, and only if it is newer.

## Releasing

1. Bump `version` in `package.json` (and `package-lock.json`: `npm version 0.3.0 --no-git-tag-version`).
2. Commit, tag `v0.3.0`, push both.
3. Publish a GitHub release for the tag. Its notes are what the boards show.

The tag must match `package.json`, or the updater refuses the release. Drafts
and prereleases are ignored.

## Installing on a server (once)

From any checkout on the box (paths assume user `ubuntu`):

```bash
mkdir -p ~/planner-updater ~/planner-updates ~/backups
cp devops/updater/planner-updater.sh ~/planner-updater/
sudo cp devops/updater/planner-updater.env.example /etc/planner-updater.env   # edit CHECKOUTS
sudo cp devops/updater/planner-updater.service devops/updater/planner-updater.path /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now planner-updater.path
~/planner-updater/planner-updater.sh --status        # needs the same env; or:
sudo systemctl start planner-updater.service           # with no request, it only exits
```

Then, in **each** checkout's `devops/docker/.env`:

```bash
PLAN_UPDATE_DIR=/home/ubuntu/planner-updates
```

and `docker compose -f compose.plan.yml up -d --force-recreate plan-api`.

The script is installed **outside** the checkouts on purpose, so a release
can't replace the updater while it runs. Re-copy it by hand when it changes.

## Operating it

| | |
| --- | --- |
| Status | `cat ~/planner-updates/status.json` |
| Last deploy's output | `cat ~/planner-updates/last-update.log` or `journalctl -u planner-updater` |
| Deploy without a board | `sudo systemctl start planner-updater.service` after `touch ~/planner-updates/request.json`, or run the script with `--force` |
| Roll back by hand | each deploy leaves `~/backups/<checkout>-before-<tag>-<time>.tgz` (newest 10 kept) |
| Turn it off | `sudo systemctl disable --now planner-updater.path`, and unset `PLAN_UPDATE_DIR` |

**Who can update:** anyone who can open a board, the same as editing the plan.
They can only install the latest release of this repository, never other code.
