#!/usr/bin/env bash
# Installs the systemd units that run each bot's screen and agent (deploy/dispatch-*@.service and
# dispatch-display@.target; server/src/units.ts says what each one is) into /etc/systemd/system, takes
# away the ones a release no longer has, and readies the account the bots run as. None of the units
# starts at boot: the server starts them. Safe to run again. scripts/provision.sh and scripts/release.sh
# run it on a host, the dev image (Dockerfile) while it is built.
#
# The bots' account (server/src/account.ts) is DISPATCH_USER, from the environment or /etc/dispatch/env
# (the installer writes it there: the account that ran the installer), and root when neither names one.
# Every bot's units run as it, by a drop-in beside each unit (account.conf). For an account that isn't
# root it also
#   - lets the account sudo without a password (/etc/sudoers.d/dispatch): a bot no longer has a root
#     shell, but it can still install what it needs, the way a person at the machine would, and
#   - gives it the Hermes install every bot's home links to (/opt/hermes), since Hermes writes there as
#     it runs (its environments' leases, Python's bytecode).
#
# The bots' folders in the account's home are the server's to make (server/src/account.ts).
#
# DISPATCH_ROOT puts /etc and /opt under another folder and skips systemd, for scripts/test_units.py.
set -euo pipefail
root="${DISPATCH_ROOT:-}"
[ -n "$root" ] || [ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/etc/systemd/system"
changed=false

# The account: DISPATCH_USER from the environment, else the last DISPATCH_USER line of /etc/dispatch/env
# (KEY=value, the value maybe quoted). Root only when it says root: a missing one stops here, since
# root's bots run Chrome without its sandbox (server/src/account.ts).
name="${DISPATCH_USER:-}"
if [ -z "$name" ] && [ -r "$root/etc/dispatch/env" ]; then
  name="$(sed -nE 's/^[[:space:]]*DISPATCH_USER=["'\'']?([^"'\'']*)["'\'']?[[:space:]]*$/\1/p' "$root/etc/dispatch/env" | tail -n 1)"
fi
[ -n "$name" ] || { echo "DISPATCH_USER isn't set. It names the account the bots run as, in /etc/dispatch/env; set DISPATCH_USER=root there to run them as root." >&2; exit 1; }
entry="$(getent passwd "$name")" || { echo "DISPATCH_USER is $name, and this machine has no account by that name." >&2; exit 1; }
IFS=: read -r _ _ uid gid _ home _ <<<"$entry"
group="$(getent group "$gid" | cut -d: -f1)"
group="${group:-$gid}"

mkdir -p "$dest"
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
    rm -rf "$t.d"
    changed=true
  fi
done

# Each service runs as the account, with its home. A target has no process of its own.
for f in "$here"/deploy/dispatch-*@.service; do
  d="$dest/$(basename "$f").d"
  text="# Written by scripts/install-units.sh: the account every bot's screen and agent run as.
[Service]
User=$name
Group=$group
Environment=HOME=$home USER=$name"
  if [ "$(cat "$d/account.conf" 2>/dev/null)" != "$text" ]; then
    mkdir -p "$d"
    printf '%s\n' "$text" >"$d/account.conf.new"
    chmod 0644 "$d/account.conf.new"
    mv "$d/account.conf.new" "$d/account.conf"
    changed=true
  fi
done

sudoers="$root/etc/sudoers.d/dispatch"
if [ "$uid" -ne 0 ]; then
  rule="# Written by scripts/install-units.sh: the account Dispatch's bots run as may run anything as root.
$name ALL=(ALL:ALL) NOPASSWD: ALL"
  if [ "$(cat "$sudoers" 2>/dev/null)" != "$rule" ]; then
    mkdir -p "$(dirname "$sudoers")"
    tmp="$(mktemp "$sudoers.XXXXXX")"
    printf '%s\n' "$rule" >"$tmp"
    chmod 0440 "$tmp"
    # A sudoers file sudo can't read would lock everyone out of sudo, so it goes in only once visudo
    # has read it.
    visudo -cqf "$tmp" || { rm -f "$tmp"; echo "visudo refused the sudoers rule for $name." >&2; exit 1; }
    mv "$tmp" "$sudoers"
  fi
  if [ -d "$root/opt/hermes" ]; then
    find "$root/opt/hermes" \( ! -user "$uid" -o ! -group "$gid" \) -exec chown -h "$uid:$gid" {} +
  fi
else
  rm -f "$sudoers"
fi

# The dev image is built without systemd running; it reads the files when it boots.
if [ -z "$root" ] && $changed && [ -d /run/systemd/system ]; then systemctl daemon-reload; fi
