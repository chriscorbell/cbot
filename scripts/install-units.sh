#!/usr/bin/env bash
# Installs the systemd units that run each bot's screen and agent (deploy/dispatch-*@.service and
# dispatch-display@.target; server/src/units.ts says what each one is) into /etc/systemd/system, and
# takes away the ones a release no longer has. None of them starts at boot: the server starts them.
# Safe to run again. scripts/provision.sh and scripts/release.sh run it on a host, the dev image
# (Dockerfile) while it is built.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
here="$(cd "$(dirname "$0")/.." && pwd)"
dest=/etc/systemd/system
changed=false
for f in "$here"/deploy/dispatch-*@.service "$here"/deploy/dispatch-*@.target; do
  t="$dest/$(basename "$f")"
  if ! cmp -s "$f" "$t"; then
    install -m 0644 "$f" "$t"
    changed=true
  fi
done
for t in "$dest"/dispatch-*@.service "$dest"/dispatch-*@.target; do
  [ -e "$t" ] || continue
  if [ ! -e "$here/deploy/$(basename "$t")" ]; then
    rm -f "$t"
    changed=true
  fi
done
# The dev image is built without systemd running; it reads the files when it boots.
if $changed && [ -d /run/systemd/system ]; then systemctl daemon-reload; fi
