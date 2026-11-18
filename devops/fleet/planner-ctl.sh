#!/usr/bin/env bash
# Adds, lists and removes the planners on this box. Runs on the HOST.
#
# Everything a new planner needs, in order:
#   1. check the hostname resolves to this box (the DNS record is made by hand)
#   2. pick a free loopback port and a folder, copy the template checkout there
#   3. start it with the default config (examples/minimal.config.json)
#   4. register it, regenerate PLAN_SITES in the edge checkout, recreate the edge
#   5. issue its certificate over the webroot, restart the edge
#   6. check https://<host>/api/health
#
# The registry, $FLEET_HOME/planners.tsv, is the source of truth: one line per
# planner, "name<TAB>dir<TAB>port<TAB>hostname<TAB>owner". PLAN_SITES (the edge) and the
# updater's checkout list are generated from it; nothing else is edited by hand.
#
# Usage:
#   planner-ctl.sh add <subdomain> [--name <name>] [--owner <user>] [--dry-run]
#   planner-ctl.sh list [--json]
#   planner-ctl.sh remove <name>            stops it, drops its site; keeps folder + volume
#   planner-ctl.sh sync-sites               rewrite PLAN_SITES, recreate the edge
#   planner-ctl.sh cert <hostname>          issue/renew a certificate, restart the edge
#   planner-ctl.sh admin-site               sync-sites + cert for the admin page's host
#   planner-ctl.sh run-queue                handle $FLEET_HOME/requests/*.json (systemd)
#
# Settings come from the environment (/etc/planner-fleet.env under systemd):
#   FLEET_DOMAIN FLEET_HOME FLEET_TEMPLATE FLEET_EDGE_CHECKOUT PUBLIC_IP
#   ADMIN_SITE (host=port, optional) FLEET_BASE_DIR PLAN_UPDATE_DIR
set -Eeuo pipefail

FLEET_DOMAIN="${FLEET_DOMAIN:?set FLEET_DOMAIN, e.g. example.com}"
FLEET_HOME="${FLEET_HOME:-$HOME/planner-fleet}"
FLEET_TEMPLATE="${FLEET_TEMPLATE:?set FLEET_TEMPLATE to a checkout to copy new planners from}"
FLEET_EDGE_CHECKOUT="${FLEET_EDGE_CHECKOUT:?set FLEET_EDGE_CHECKOUT to the checkout that runs compose.edge.yml}"
FLEET_BASE_DIR="${FLEET_BASE_DIR:-$HOME}"          # new planners go to $FLEET_BASE_DIR/<name>_planner_ws
PUBLIC_IP="${PUBLIC_IP:?set PUBLIC_IP to the public address of this box}"
ADMIN_SITE="${ADMIN_SITE:-}"                         # e.g. plans.example.com=8090
PLAN_UPDATE_DIR="${PLAN_UPDATE_DIR:-}"               # written into each new planner's .env
FIRST_PORT="${FIRST_PORT:-8080}"
LAST_PORT="${LAST_PORT:-8199}"

REGISTRY="$FLEET_HOME/planners.tsv"
REQUESTS="$FLEET_HOME/requests"
STATUS_DIR="$FLEET_HOME/status"
LOGS="$FLEET_HOME/logs"
mkdir -p "$FLEET_HOME" "$REQUESTS" "$STATUS_DIR" "$LOGS"
touch "$REGISTRY"

# The same files the updater never overwrites, plus the source's own plan data.
SYNC_EXCLUDES=(--exclude=.git --exclude=node_modules --exclude=dist --exclude=.data
               --exclude=/planner.config.json --exclude=.env --exclude=devops/docker/.env
               --exclude=devops/fleet/.env)

die()  { echo "planner-ctl: $*" >&2; exit 1; }
step() { echo "== $*"; [ -n "${JOB_ID:-}" ] && job_status running "$*" || true; }

# ---- registry -------------------------------------------------------------
# Lines: name dir port host owner (tab-separated; owner is the admin-page user
# who added it, "admin" when absent). Blank lines and # comments ignored.
reg_rows() { grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$REGISTRY" || true; }
reg_field() { # <column 1-4> <match column> <value>
  reg_rows | awk -F'\t' -v c="$1" -v m="$2" -v v="$3" '$m == v { print $c; exit }'
}
reg_write() { # replaces the registry with stdin, atomically
  local tmp="$REGISTRY.tmp.$$"; cat > "$tmp"; chmod 644 "$tmp"; mv "$tmp" "$REGISTRY"
}

valid_label() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; }
valid_user() { [[ "$1" =~ ^[a-z0-9][a-z0-9._-]{1,31}$ ]]; }

plan_sites() { # PLAN_SITES generated from the registry (+ the admin page)
  local s; s=$(reg_rows | awk -F'\t' '{ printf "%s%s=%s", (NR>1?" ":""), $4, $3 }')
  if [ -n "$ADMIN_SITE" ]; then s="${s:+$s }$ADMIN_SITE"; fi
  echo "$s"
}

# ---- edge -----------------------------------------------------------------
sync_sites() {
  local env="$FLEET_EDGE_CHECKOUT/devops/docker/.env" sites; sites=$(plan_sites)
  [ -f "$env" ] || die "no $env (FLEET_EDGE_CHECKOUT must be the checkout running the edge)"
  [ -n "$sites" ] || die "refusing to write an empty PLAN_SITES"
  local line="PLAN_SITES=\"$sites\""
  if grep -qxF "$line" "$env"; then
    echo "PLAN_SITES unchanged"
  else
    python3 - "$env" "$line" <<'PY'
import os, sys
path, line = sys.argv[1:3]
lines = open(path).read().splitlines()
out, done = [], False
for l in lines:
    if l.startswith("PLAN_SITES="):
        if not done: out.append(line); done = True
    else:
        out.append(l)
if not done: out.append(line)
tmp = path + ".tmp"
with open(tmp, "w") as f: f.write("\n".join(out) + "\n")
os.replace(tmp, path)
PY
    echo "PLAN_SITES=\"$sites\""
  fi
  # Recreate it under the project the running edge already belongs to. The
  # edge checkout's .env sets COMPOSE_PROJECT_NAME for its own planner, which
  # overrides compose.edge.yml's `name:`, so on a box like ours the edge lives
  # in that planner's project; guessing differently would collide on nginx-plan.
  local project
  project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' nginx-plan 2>/dev/null || true)
  docker compose -p "${project:-plan-edge}" -f "$FLEET_EDGE_CHECKOUT/devops/docker/compose.edge.yml" up -d --force-recreate nginx
}

issue_cert() { # <hostname>; a no-op for a certificate that is not near expiry
  local host="$1"
  docker run --rm \
    -v /etc/letsencrypt:/etc/letsencrypt -v /var/www/certbot:/var/www/certbot \
    certbot/certbot certonly --webroot -w /var/www/certbot -d "$host" \
    --non-interactive --agree-tos --keep-until-expiring \
    ${CERT_EMAIL:+--email "$CERT_EMAIL"} ${CERT_EMAIL:---register-unsafely-without-email}
  docker restart nginx-plan >/dev/null
  sleep 2
}

# ---- checks ---------------------------------------------------------------
resolves_here() { # <hostname>: does public DNS point it at this box?
  local ips
  if command -v dig >/dev/null; then ips=$(dig +short A "$1" @1.1.1.1 2>/dev/null || true)
  else ips=$(getent ahostsv4 "$1" | awk '{print $1}' | sort -u); fi
  grep -qxF "$PUBLIC_IP" <<<"$ips"
}

wait_health() { # <url> [tries]
  local i
  for ((i = 0; i < ${2:-30}; i++)); do
    curl -fsS --max-time 3 "$1" 2>/dev/null | grep -q '"ok":true' && return 0
    sleep 2
  done
  return 1
}

free_port() {
  local used p
  used=$( { reg_rows | cut -f3; ss -Htln | awk '{print $4}' | sed 's/.*://'; \
            if [ -n "$ADMIN_SITE" ]; then echo "${ADMIN_SITE#*=}"; fi; } | sort -un)
  for ((p = FIRST_PORT; p <= LAST_PORT; p++)); do
    grep -qxF "$p" <<<"$used" || { echo "$p"; return; }
  done
  die "no free port in $FIRST_PORT-$LAST_PORT"
}

# ---- commands -------------------------------------------------------------
cmd_add() {
  local sub="" name="" dry="" owner="${REQUESTED_BY:-admin}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) name="${2:-}"; shift 2 ;;
      --owner) owner="${2:-}"; shift 2 ;;
      --dry-run) dry=1; shift ;;
      -*) die "unknown option $1" ;;
      *) [ -z "$sub" ] || die "one subdomain at a time"; sub="$1"; shift ;;
    esac
  done
  sub="${sub%.$FLEET_DOMAIN}"
  valid_label "$sub" || die "'$sub' is not a valid subdomain (a-z, 0-9 and -, up to 63, no leading/trailing -)"
  name="${name:-$sub}"
  valid_label "$name" || die "'$name' is not a valid name"
  valid_user "$owner" || die "'$owner' is not a valid owner"
  local host="$sub.$FLEET_DOMAIN" dir="$FLEET_BASE_DIR/${name}_planner_ws"

  [ -z "$(reg_field 1 1 "$name")" ] || die "a planner called '$name' already exists"
  [ -z "$(reg_field 1 4 "$host")" ] || die "$host is already served by '$(reg_field 1 4 "$host")'"
  [ -n "$ADMIN_SITE" ] && [ "$host" = "${ADMIN_SITE%%=*}" ] && die "$host is the admin page"
  [ ! -e "$dir" ] || die "$dir already exists"
  docker ps -a --format '{{.Names}}' | grep -qxE "$name-(api|ui)" && die "containers named $name-api/$name-ui already exist"
  docker volume inspect "${name}_plan_data" >/dev/null 2>&1 && die "volume ${name}_plan_data already exists (a removed planner's data?); pick another --name"
  [ -f "$FLEET_TEMPLATE/package.json" ] || die "template $FLEET_TEMPLATE is not a planner checkout"

  step "checking DNS for $host"
  resolves_here "$host" || die "$host does not resolve to $PUBLIC_IP yet; create the DNS A record first"
  local port; port=$(free_port)
  echo "name=$name host=$host port=$port dir=$dir template=$FLEET_TEMPLATE"
  [ -z "$dry" ] || { echo "dry run: nothing changed"; return 0; }

  # Until the planner is registered, a failure takes everything back down.
  local started=""
  rollback() {
    trap - ERR
    echo "!! failed, rolling back $name"
    if [ -n "$started" ]; then docker compose -f "$dir/devops/docker/compose.plan.yml" down -v || true; fi
    rm -rf "$dir"
  }
  trap rollback ERR

  step "copying $FLEET_TEMPLATE to $dir"
  rsync -a "${SYNC_EXCLUDES[@]}" "$FLEET_TEMPLATE/" "$dir/"
  cp "$dir/examples/minimal.config.json" "$dir/planner.config.json"
  {
    echo "# Written by planner-ctl.sh add $sub. Unique per planner on this box."
    echo "COMPOSE_PROJECT_NAME=$name"
    echo "PLAN_PORT=$port"
    if [ -n "$PLAN_UPDATE_DIR" ]; then echo "PLAN_UPDATE_DIR=$PLAN_UPDATE_DIR"; fi
  } > "$dir/devops/docker/.env"

  step "building and starting $name on 127.0.0.1:$port"
  started=1
  docker compose -f "$dir/devops/docker/compose.plan.yml" up -d --build
  wait_health "http://127.0.0.1:$port/api/health" || { echo "no health on :$port"; false; }
  trap - ERR

  step "registering $name and updating the edge"
  { cat "$REGISTRY"; printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$dir" "$port" "$host" "$owner"; } | reg_write
  sync_sites

  step "issuing the certificate for $host"
  issue_cert "$host"

  step "checking https://$host"
  wait_health "https://$host/api/health" 10 || die "$name runs on :$port but https://$host is not answering yet (re-run: planner-ctl.sh cert $host)"
  echo "== done: https://$host"
}

cmd_list() {
  if [ "${1:-}" = "--json" ]; then
    reg_rows | python3 -c 'import json,sys
rows = [dict(zip(("name","dir","port","host","owner"), l.rstrip("\n").split("\t"))) for l in sys.stdin]
for r in rows: r.setdefault("owner", "admin")
print(json.dumps(rows))'
    return
  fi
  printf '%-24s %-6s %-8s %-12s %s\n' NAME PORT HEALTH OWNER HOST
  reg_rows | while IFS=$'\t' read -r name dir port host owner; do
    h=down; curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" 2>/dev/null | grep -q '"ok":true' && h=ok
    printf '%-24s %-6s %-8s %-12s https://%s\n' "$name" "$port" "$h" "${owner:-admin}" "$host"
  done
}

cmd_remove() {
  local name="${1:?usage: remove <name>}" dir
  dir=$(reg_field 2 1 "$name"); [ -n "$dir" ] || die "no planner called '$name'"
  [ "$dir" != "$FLEET_EDGE_CHECKOUT" ] || die "$name's checkout runs the edge; move the edge first"
  [ "$dir" != "$FLEET_TEMPLATE" ] || die "$name's checkout is FLEET_TEMPLATE; point it elsewhere first"
  step "stopping $name (folder and volume ${name}_plan_data are kept)"
  docker compose -f "$dir/devops/docker/compose.plan.yml" down
  reg_rows | awk -F'\t' -v n="$name" '$1 != n' | reg_write
  sync_sites
  echo "== removed $name. Its data: $dir and volume ${name}_plan_data"
}

# ---- queue (the admin page writes requests; systemd runs this) -------------
job_status() { # <state> <message>
  python3 - "$STATUS_DIR/$JOB_ID.json" "$JOB_ID" "$1" "$2" "${JOB_ACTION:-}" "${JOB_TARGET:-}" "${REQUESTED_BY:-}" <<'PY'
import json, os, sys, datetime
path, jid, state, message, action, target, by = sys.argv[1:8]
doc = {}
try: doc = json.load(open(path))
except Exception: pass
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
doc.update({"id": jid, "action": action, "target": target, "requestedBy": by,
            "state": state, "message": message, "at": now})
doc.setdefault("startedAt", now)
tmp = path + ".tmp"
with open(tmp, "w") as f: json.dump(doc, f); f.write("\n")
os.chmod(tmp, 0o644); os.replace(tmp, path)
PY
}

activity() { # <action> <target> <result> <detail>: one line in activity.jsonl
  python3 - "$FLEET_HOME/activity.jsonl" "${REQUESTED_BY:-host}" "$@" <<'PY'
import json, os, sys, datetime
path, user, action, target, result, detail = sys.argv[1:7]
line = json.dumps({"at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                   "user": user, "action": action, "target": target, "result": result,
                   "detail": detail, "source": "host"})
fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
os.write(fd, (line + "\n").encode()); os.close(fd)
PY
}

cmd_run_queue() {
  exec 9>"$FLEET_HOME/.lock"
  flock -n 9 || { echo "planner-ctl: queue already running"; exit 0; }
  local req
  while :; do
    req=$(ls -1 "$REQUESTS"/*.json 2>/dev/null | sort | head -1 || true)
    [ -n "$req" ] || break
    JOB_ID=$(basename "$req" .json)
    # A request is an action, its target and who asked. The page checked the
    # permissions; this re-checks that the values are sane.
    read -r JOB_ACTION JOB_TARGET REQUESTED_BY < <(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
print(d.get("action") or "-", d.get("subdomain") or d.get("name") or "-", d.get("requestedBy") or "-")' "$req" 2>/dev/null || echo "- - -")
    export REQUESTED_BY
    # Status first, then drop the request, so the page never sees neither.
    [[ "$JOB_ID" =~ ^[A-Za-z0-9-]{1,64}$ ]] || { echo "skipping request with a bad id"; rm -f "$req"; continue; }
    if ! valid_user "$REQUESTED_BY" || ! valid_label "$JOB_TARGET"; then
      job_status failed "bad request"; rm -f "$req"; continue
    fi
    local ok_msg
    case "$JOB_ACTION" in
      add)    ok_msg="https://$JOB_TARGET.$FLEET_DOMAIN is live" ;;
      remove) ok_msg="$JOB_TARGET removed (folder and data kept)" ;;
      *) job_status failed "unknown action '$JOB_ACTION'"; rm -f "$req"; continue ;;
    esac
    job_status running "starting"
    rm -f "$req"
    if ( "cmd_$JOB_ACTION" "$JOB_TARGET" ) > "$LOGS/$JOB_ID.log" 2>&1; then
      job_status done "$ok_msg"
      activity "plan.$JOB_ACTION" "$JOB_TARGET" done "$ok_msg"
    else
      local why; why=$(grep -E '^planner-ctl:' "$LOGS/$JOB_ID.log" | tail -1 | sed 's/^planner-ctl: //' || true)
      job_status failed "$why"
      activity "plan.$JOB_ACTION" "$JOB_TARGET" failed "$why"
    fi
    chmod 644 "$LOGS/$JOB_ID.log"
  done
  # Keep the newest 50 jobs.
  ls -1t "$STATUS_DIR"/*.json 2>/dev/null | tail -n +51 | while read -r f; do
    rm -f "$f" "$LOGS/$(basename "$f" .json).log"; done
}

case "${1:-}" in
  add) shift; cmd_add "$@" ;;
  list) shift; cmd_list "$@" ;;
  remove) shift; cmd_remove "$@" ;;
  sync-sites) sync_sites ;;
  cert) issue_cert "${2:?usage: cert <hostname>}" ;;
  admin-site)
    [ -n "$ADMIN_SITE" ] || die "ADMIN_SITE is not set"
    sync_sites; issue_cert "${ADMIN_SITE%%=*}" ;;
  run-queue) cmd_run_queue ;;
  *) sed -n '2,/^set -E/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 2 ;;
esac
