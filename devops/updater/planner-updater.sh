#!/usr/bin/env bash
# Deploys the latest GitHub release of the planner to every checkout on this box.
#
# Runs on the HOST (systemd: planner-updater.path starts it whenever a board
# asks for an update by writing $UPDATE_DIR/request.json). It never trusts the
# request beyond "go and look": the code it deploys is whatever GitHub reports
# as the latest published release of $RELEASE_REPO, and only if that is newer
# than what a checkout runs.
#
# For each checkout that is behind:
#   1. back up its code (not node_modules) to $BACKUP_DIR
#   2. copy the release over it, keeping planner.config.json, .env files and data
#   3. docker compose -f compose.plan.yml up -d --build
#   4. if that fails, put the backup back and rebuild the old version
# Progress goes to $UPDATE_DIR/status.json, which every board reads.
#
# Usage: planner-updater.sh            handle a pending request (systemd does this)
#        planner-updater.sh --status   just (re)write status.json, e.g. after install
#        planner-updater.sh --force    deploy the latest release without a request
set -euo pipefail

RELEASE_REPO="${RELEASE_REPO:-Clumsyvortex123/project_planner_ws}"
UPDATE_DIR="${UPDATE_DIR:-$HOME/planner-updates}"
CHECKOUTS="${CHECKOUTS:-}"            # space-separated absolute paths
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"    # per checkout

STATUS="$UPDATE_DIR/status.json"
REQUEST="$UPDATE_DIR/request.json"
LOG="$UPDATE_DIR/last-update.log"

die() { echo "planner-updater: $*" >&2; exit 1; }
[ -n "$CHECKOUTS" ] || die "CHECKOUTS is not set"
mkdir -p "$UPDATE_DIR" "$BACKUP_DIR"

# One run at a time; a second request while one is deploying is picked up after.
exec 9>"$UPDATE_DIR/.lock"
flock -n 9 || { echo "planner-updater: already running"; exit 0; }

json_get() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get(sys.argv[2]) or "")' "$1" "$2"; }

versions_json() {
  local out="{" first=1
  for c in $CHECKOUTS; do
    local v; v=$(json_get "$c/package.json" version 2>/dev/null || echo "")
    [ $first = 1 ] || out+=","
    out+="\"$(basename "$c")\":\"$v\""; first=0
  done
  echo "$out}"
}

# status <state> <target> <message>
status() {
  python3 - "$STATUS" "$1" "$2" "$3" "$(versions_json)" "$RELEASE_REPO" <<'PY'
import json, os, sys, datetime
path, state, target, message, versions, repo = sys.argv[1:7]
doc = {
  "state": state, "target": target or None, "message": message,
  "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
  "versions": json.loads(versions), "repo": repo,
}
tmp = path + ".tmp"
with open(tmp, "w") as f: json.dump(doc, f); f.write("\n")
os.chmod(tmp, 0o644); os.replace(tmp, path)
PY
}

if [ "${1:-}" = "--status" ]; then
  state=idle; [ -f "$STATUS" ] && state=$(json_get "$STATUS" state || echo idle)
  [ "$state" = updating ] && state=idle   # a run that died mid-way
  status "$state" "" "updater installed"
  echo "status written to $STATUS"; exit 0
fi
if [ "${1:-}" != "--force" ] && [ ! -f "$REQUEST" ]; then exit 0; fi
rm -f "$REQUEST"

# What does GitHub say is latest?
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
if ! curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: project-planner-updater" \
     "https://api.github.com/repos/$RELEASE_REPO/releases/latest" -o "$work/release.json"; then
  status failed "" "could not reach GitHub"; die "could not reach GitHub"
fi
tag=$(json_get "$work/release.json" tag_name)
[ -n "$tag" ] || { status failed "" "GitHub has no published release"; die "no release"; }
target="${tag#v}"

# Which checkouts are behind?
behind=()
for c in $CHECKOUTS; do
  cur=$(json_get "$c/package.json" version)
  newer=$(python3 -c 'import sys
p=lambda v:[int(x) if x.isdigit() else 0 for x in v.replace("-",".").split(".")]+[0,0,0]
print(1 if p(sys.argv[1])[:3] > p(sys.argv[2])[:3] else 0)' "$target" "$cur")
  [ "$newer" = 1 ] && behind+=("$c")
done
if [ ${#behind[@]} -eq 0 ]; then status idle "" "already on $target"; echo "nothing to do ($target)"; exit 0; fi

status updating "$target" "downloading $tag"
exec > >(tee "$LOG") 2>&1
echo "== $(date -Is) deploying $tag to: ${behind[*]}"

# The release's source, exactly as tagged.
curl -fsSL -H "User-Agent: project-planner-updater" \
  "https://codeload.github.com/$RELEASE_REPO/tar.gz/refs/tags/$tag" -o "$work/src.tgz" \
  || { status failed "$target" "download failed"; die "download failed"; }
mkdir "$work/src" && tar xzf "$work/src.tgz" -C "$work/src" --strip-components=1
src_version=$(json_get "$work/src/package.json" version)
[ "$src_version" = "$target" ] || { status failed "$target" "release $tag contains version $src_version"; die "tag/version mismatch"; }

SYNC_EXCLUDES=(--exclude=.git --exclude=node_modules --exclude=dist --exclude=.data
               --exclude=/planner.config.json --exclude=.env --exclude=devops/docker/.env)

failed=()
for c in "${behind[@]}"; do
  name=$(basename "$c"); ts=$(date +%Y%m%d-%H%M%S)
  backup="$BACKUP_DIR/$name-before-$tag-$ts.tgz"
  status updating "$target" "deploying to $name"
  echo "-- $name: backup to $backup"
  tar czf "$backup" --exclude=node_modules -C "$(dirname "$c")" "$name"
  rsync -rlpt "${SYNC_EXCLUDES[@]}" "$work/src/" "$c/"
  echo "-- $name: building"
  if (cd "$c/devops/docker" && docker compose -f compose.plan.yml up -d --build); then
    echo "-- $name: now on $target"
  else
    echo "-- $name: build FAILED, restoring the previous version"
    rm -rf "$work/restore" && mkdir "$work/restore" && tar xzf "$backup" -C "$work/restore"
    rsync -rlpt "${SYNC_EXCLUDES[@]}" "$work/restore/$name/" "$c/"
    (cd "$c/devops/docker" && docker compose -f compose.plan.yml up -d --build) || true
    failed+=("$name")
  fi
  # Prune old backups of this checkout made by the updater.
  ls -1t "$BACKUP_DIR/$name-before-"*.tgz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
done

if [ ${#failed[@]} -gt 0 ]; then
  status failed "$target" "build failed for ${failed[*]}; kept the previous version (see last-update.log)"
  exit 1
fi
status done "$target" "deployed $tag"
echo "== done"
