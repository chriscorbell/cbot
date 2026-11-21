#!/usr/bin/env bash
# Puts an archive scripts/backup.sh made back on this machine, in place of what Dispatch has now:
#
#   sudo /srv/dispatch/current/scripts/restore.sh <file>
#
# Dispatch has to be installed here already (the installer sets up the machine, the account and the
# settings in /etc/dispatch). This stops Dispatch and everything it runs for the bots, moves DATA_DIR
# and the bots' folder aside (<folder>.before-restore-<time>, kept until you delete them), unpacks the
# archive in their place, hands the bots' files to the account they run as here, and starts Dispatch,
# which brings back each bot's screen, Chrome and agent. A database from an older release is migrated
# as it starts; one from a newer release than this one isn't opened, so update first.
# DISPATCH_YES=1 skips the question.
#
# DISPATCH_ROOT puts / under another folder and DISPATCH_HOME stands in for the account's home, for
# scripts/test_backup.py.
set -euo pipefail
root="${DISPATCH_ROOT:-}"
[ -n "$root" ] || [ "$(id -u)" -eq 0 ] || { echo "Run it as root: sudo $0 <file>" >&2; exit 1; }
here="$(cd "$(dirname "$0")/.." && pwd)"
etc="$root/etc/dispatch"
say() { echo "[restore] $*"; }

archive="${1:-}"
[ -n "$archive" ] && [ -r "$archive" ] || { echo "Usage: $0 <file from scripts/backup.sh>" >&2; exit 1; }
about="$(tar -xzOf "$archive" BACKUP 2>/dev/null)" || { echo "$archive isn't a Dispatch backup (it has no BACKUP)." >&2; exit 1; }

setting() {
  local v
  v="$(sed -nE "s/^[[:space:]]*$1=[\"']?([^\"']*)[\"']?[[:space:]]*\$/\\1/p" "$etc/env" 2>/dev/null | tail -n 1)"
  echo "${v:-$2}"
}
data="$root$(setting DATA_DIR /var/lib/dispatch)"
account="$(setting DISPATCH_USER '')"
[ -n "$account" ] || { echo "$etc/env names no DISPATCH_USER: install Dispatch here first." >&2; exit 1; }
entry="$(getent passwd "$account")" || { echo "This machine has no account $account." >&2; exit 1; }
IFS=: read -r _ _ uid gid _ home _ <<<"$entry"
home="${DISPATCH_HOME:-$home}"
bots="$home/$(jq -r .botsDir "$here/server/box/machine.json")"
port="$(setting PORT 8787)"

made="$(sed -n 's/^created=//p' <<<"$about")"
from="$(sed -n 's/^version=//p' <<<"$about")"
say "$archive was made ${made:-at an unknown time}${from:+ on $from}."
say "It replaces $data and $bots; what they hold now is kept beside them."
if [ "${DISPATCH_YES:-}" != 1 ]; then
  [ -r /dev/tty ] || { echo "Set DISPATCH_YES=1 to restore without a terminal to ask at." >&2; exit 1; }
  read -r -p "Restore it? [y/N] " answer </dev/tty
  [[ "$answer" =~ ^[Yy] ]] || { echo "Nothing changed."; exit 1; }
fi

say "stopping Dispatch and the bots"
# The bots' screens, Chromes and agents run under dispatch.slice, outside the service (units.ts).
systemctl stop dispatch.service dispatch.slice

stamp="$(date -u +%Y%m%d-%H%M%S)"
for dir in "$data" "$bots"; do
  [ ! -e "$dir" ] || mv "$dir" "$dir.before-restore-$stamp"
done
install -d -m 0700 "$data"
install -d -m 0755 "$bots"

say "unpacking"
# GNU tar refuses members that climb out with .., and as root keeps the owners and modes they had.
tar -xzf "$archive" -C "$data" --strip-components=1 data
tar -xzf "$archive" -C "$bots" --strip-components=1 bots
# Dispatch's data is root's alone, and the bots' files their account's, which may have another number
# here than where the backup was made. (The tests run as one ordinary account, and own both anyway.)
if [ -z "$root" ]; then
  chown -R -h root:root "$data"
  chown -R -h "$uid:$gid" "$bots"
fi

say "starting Dispatch"
systemctl start dispatch.service
for _ in $(seq 60); do
  if curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$port/api/health"; then
    say "done. What was here before is in $data.before-restore-$stamp and $bots.before-restore-$stamp."
    exit 0
  fi
  sleep 1
done
journalctl -u dispatch -n 20 --no-pager >&2 || true
echo "Dispatch didn't answer within a minute of the restore. What was here before is in $data.before-restore-$stamp and $bots.before-restore-$stamp." >&2
exit 1
