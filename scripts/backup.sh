#!/usr/bin/env bash
# Writes what Dispatch keeps on this machine into one archive, while it runs:
#
#   sudo /srv/dispatch/current/scripts/backup.sh [<file>]   # default /var/backups/dispatch-<time>.tar.gz
#
# The archive holds
#   data/   DATA_DIR (/var/lib/dispatch): the database, the secret that signs the bots' tokens, the
#           sign-in fingerprint and the HTTPS certificate,
#   bots/   the bots' folder in their account's home (~/dispatch): each bot's Hermes home (its keys,
#           sign-ins, memory and sessions), Library and Chrome profile, without Chrome's caches,
#   BACKUP  when it was made, from which release, and the account the bots ran as.
# Every SQLite database among them (Dispatch's, and each Hermes home's) is copied with SQLite's own
# backup (server/dist/backup-db.js), whole even while it is written to; other files are copied as they
# are. It holds the provider keys and sign-ins, so only root can read it. scripts/restore.sh puts one
# back. The settings in /etc/dispatch stay out: the installer writes them for the machine it runs on.
#
# DISPATCH_ROOT puts / under another folder and DISPATCH_HOME stands in for the account's home, for
# scripts/test_backup.py.
set -euo pipefail
root="${DISPATCH_ROOT:-}"
[ -n "$root" ] || [ "$(id -u)" -eq 0 ] || { echo "Run it as root: sudo $0" >&2; exit 1; }
here="$(cd "$(dirname "$0")/.." && pwd)"
etc="$root/etc/dispatch"
say() { echo "[backup] $*"; }

# setting <name> <default>: the last <name>= line of /etc/dispatch/env, unquoted.
setting() {
  local v
  v="$(sed -nE "s/^[[:space:]]*$1=[\"']?([^\"']*)[\"']?[[:space:]]*\$/\\1/p" "$etc/env" 2>/dev/null | tail -n 1)"
  echo "${v:-$2}"
}
data="$root$(setting DATA_DIR /var/lib/dispatch)"
account="$(setting DISPATCH_USER '')"
[ -n "$account" ] || { echo "$etc/env names no DISPATCH_USER, the account the bots run as." >&2; exit 1; }
home="${DISPATCH_HOME:-$(getent passwd "$account" | cut -d: -f6)}"
[ -n "$home" ] || { echo "This machine has no account $account." >&2; exit 1; }
bots="$home/$(jq -r .botsDir "$here/server/box/machine.json")"
[ -f "$data/dispatch.db" ] || { echo "$data has no dispatch.db: is Dispatch installed here?" >&2; exit 1; }

out="${1:-$root/var/backups/dispatch-$(date -u +%Y%m%d-%H%M%S).tar.gz}"
umask 077
mkdir -p "$(dirname "$out")"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"; rm -f "$out.partial"' EXIT
mkdir -p "$stage/data" "$stage/bots"
skip="$stage/skip"
: >"$skip"

# copy_db <file> <under> <as>: <file>, a database, copied whole to the stage as <as>/<its path under
# <under>>, and left out of what tar copies as it is. One that isn't SQLite is copied as it is instead.
copy_db() {
  local rel="${1#"$2"/}" why
  mkdir -p "$stage/$3/$(dirname "$rel")"
  if why="$("$here/node/bin/node" "$here/server/dist/backup-db.js" "$1" "$stage/$3/$rel" 2>&1)"; then
    printf '%s\n' "${1#/}" "${1#/}-wal" "${1#/}-shm" "${1#/}-journal" >>"$skip"
  else
    rm -f "$stage/$3/$rel"
    say "copied $1 as it is, since SQLite couldn't: $why"
  fi
}
copy_db "$data/dispatch.db" "$data" data
if [ -d "$bots/engines" ]; then
  while IFS= read -r -d '' f; do copy_db "$f" "$bots" bots; done \
    < <(find "$bots/engines" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print0)
fi

{
  echo "created=$(date -u +%FT%TZ)"
  echo "version=$(cat "$here/VERSION" 2>/dev/null || true)"
  echo "commit=$(basename "$(readlink -f "$here")")"
  echo "account=$account"
} >"$stage/BACKUP"

# The live folders go in by their paths from /, renamed data/ and bots/ as they go. Chrome's caches,
# its lock files, the database copy release.sh keeps for a rollback, and the databases copied above
# stay out.
rx() { sed 's/[][\.*^$|]/\\&/g' <<<"${1#/}"; }
names=()
[ -d "$bots" ] && names+=("${bots#/}")
p="${bots#/}/profiles/*"
say "writing $out"
# Chrome writes to its profile all the time: a file that changed or went while it was read is
# copied as it was (tar's status 1), which a profile copes with as it does after a crash.
rc=0
tar -czf "$out.partial" \
  --warning=no-file-changed --warning=no-file-removed --warning=no-file-shrank \
  --exclude-from="$skip" \
  --exclude="${data#/}/dispatch.db.before-update*" \
  --exclude="$p/Cache" --exclude="$p/Code Cache" --exclude="$p/GPUCache" --exclude="$p/GrShaderCache" \
  --exclude="$p/ShaderCache" --exclude="$p/DawnCache" --exclude="$p/Singleton*" \
  --transform="s|^$(rx "$data")|data|S" --transform="s|^$(rx "$bots")|bots|S" \
  -C "$stage" BACKUP data bots \
  -C / "${data#/}" "${names[@]}" || rc=$?
[ "$rc" -le 1 ] || { echo "tar failed ($rc); no backup was written." >&2; exit 1; }
mv "$out.partial" "$out"
say "done: $(du -h "$out" | cut -f1) in $out"
