#!/usr/bin/env bash
# Removes cbot from a machine that scripts/install.sh set up, with all its data:
#
#   curl -fsSL https://raw.githubusercontent.com/chriscorbell/cbot/main/scripts/uninstall.sh | bash
#
# It stops the service and everything it started (the bots' screens, Chromes and Hermes gateways),
# then deletes the releases, the database and the bots' homes, Chrome profiles and Library files,
# Hermes Agent, the speech service's containers and images and Docker's build cache, the settings,
# the logs, what the screens leave in root's home (window manager and GTK settings, Chrome's crash
# reports, the build caches), the Chrome policy, and the Tailscale Serve address for cbot. There is no
# undo. The programs provisioning installed for everyone (Google Chrome, Node.js, Docker and the
# desktop packages), Tailscale, and whatever the bots installed themselves stay on the machine.
#
# It asks before deleting anything; CBOT_YES=1 deletes without asking, for a machine nobody is at.
#
# Everything is in functions and main runs on the last line, so a download cut short runs nothing.

# ---------------------------------------------------------------- output

ui_init() {
  if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
    B=$'\e[1m' D=$'\e[2m' R=$'\e[0m' G=$'\e[32m' Y=$'\e[33m' E=$'\e[31m'
  else
    B='' D='' R='' G='' Y='' E=''
  fi
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8* | *utf8* | *UTF8* | *utf-8*) OK='✓' NO='✗' ;;
    *) OK='+' NO='x' ;;
  esac
}

info() { printf '   %s\n' "$*"; }
done_() { printf '   %s%s%s %s\n' "$G" "$OK" "$R" "$*"; }
warn() { printf '   %s!%s %s\n' "$Y" "$R" "$*"; }
die() { printf '\n%s%s%s %s\n' "$E" "$NO" "$R" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- root

# As in install.sh: run as someone else, it starts again under sudo from a private copy of its own
# functions, with the terminal as stdin so the question still reaches the person.
become_root() {
  command -v sudo >/dev/null || die "Run this as root."
  local self status=0
  self="$(mktemp)"
  {
    [ -z "${CBOT_YES:-}" ] || printf 'export CBOT_YES=%q\n' "$CBOT_YES"
    declare -f
    echo main
  } >"$self"
  if (exec </dev/tty) 2>/dev/null; then
    # shellcheck disable=SC2024 # the redirect is meant to be the caller's
    sudo bash "$self" </dev/tty || status=$?
  else
    sudo bash "$self" || status=$?
  fi
  rm -f "$self"
  exit "$status"
}

# ---------------------------------------------------------------- what goes

installed() {
  local f
  [ -e "$UNIT" ] && return 0
  for f in "${FOLDERS[@]}" /opt/hermes; do [ -e "$f" ] && return 0; done
  return 1
}

# The service, then whatever it started. Its screens, Chromes and gateways outlive the server on
# purpose (KillMode=process in deploy/cbot.service), but they stay in the service's control group,
# which holds every process started from it, the bots' own included.
stop_everything() {
  local group pids _
  group="$(systemctl show -p ControlGroup --value cbot.service 2>/dev/null || true)"
  group="/sys/fs/cgroup${group:-/system.slice/cbot.service}"
  if [ -e "$UNIT" ]; then
    systemctl disable --now cbot.service >/dev/null 2>&1 || true
  fi
  if [ -r "$group/cgroup.procs" ]; then
    pids="$(cat "$group/cgroup.procs")"
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086 # one process id per word
      kill -TERM $pids 2>/dev/null || true
      for _ in $(seq 10); do
        [ -n "$(cat "$group/cgroup.procs" 2>/dev/null)" ] || break
        sleep 1
      done
      # shellcheck disable=SC2046 # one process id per word
      kill -KILL $(cat "$group/cgroup.procs" 2>/dev/null) 2>/dev/null || true
    fi
  fi
  rm -f "$UNIT"
  systemctl daemon-reload
  systemctl reset-failed cbot.service >/dev/null 2>&1 || true
  done_ "Stopped cbot, the bots' screens and their agents"
}

# The speech service: its Compose project's containers and network, and every image built for it.
remove_speech() {
  local ids images
  command -v docker >/dev/null && docker info >/dev/null 2>&1 || return 0
  ids="$(docker ps -aq --filter label=com.docker.compose.project=cbot-speech)"
  # shellcheck disable=SC2086 # one container id per word
  [ -z "$ids" ] || docker rm -f $ids >/dev/null
  ids="$(docker network ls -q --filter label=com.docker.compose.project=cbot-speech)"
  # shellcheck disable=SC2086 # one network id per word
  [ -z "$ids" ] || docker network rm $ids >/dev/null
  images="$(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^cbot-(speech|zonos3):' || true)"
  # shellcheck disable=SC2086 # one image per word
  [ -z "$images" ] || docker image rm -f $images >/dev/null
  # Building the speech image leaves gigabytes of build cache; any other project's is only a cache.
  docker builder prune -af >/dev/null 2>&1 || true
  done_ "Removed the speech service"
}

# Tailscale Serve's address for cbot (install.sh serves it on 443, provision.sh on 8787). Tailscale
# itself stays: it may do more than reach cbot.
remove_tailscale_serve() {
  local ports port
  command -v tailscale >/dev/null || return 0
  ports="$(tailscale serve status 2>/dev/null | awk '
    /^https:\/\// { port = 443; if (match($1, /:[0-9]+$/)) port = substr($1, RSTART + 1) }
    /127\.0\.0\.1:8787/ { print port }' | sort -u)"
  [ -n "$ports" ] || return 0
  for port in $ports; do
    tailscale serve --https="$port" off >/dev/null 2>&1 || warn "Couldn't turn off Tailscale Serve on port $port: tailscale serve --https=$port off"
  done
  done_ "Turned off cbot's Tailscale address"
}

remove_files() {
  local gtk=/root/.config/gtk-3.0/settings.ini f
  rm -rf "${FOLDERS[@]}" /opt/hermes /opt/hermes.[0-9]* /run/cbot-install.lock
  # Hermes' launchers: provision.sh's copy, and the ones its installer puts in root's ~/.local/bin.
  [ "$(readlink /usr/local/bin/hermes 2>/dev/null)" != /opt/hermes/launcher/hermes ] || rm -f /usr/local/bin/hermes
  for f in /root/.local/bin/hermes*; do
    ! grep -qs /opt/hermes/ "$f" || rm -f "$f"
  done
  # What the screens and builds leave in root's home: the window manager's settings, Chrome's crash
  # reports, and caches (npm, node-gyp, uv, shaders), which are safe to delete by definition.
  rm -rf /root/.config/xfce4 "/root/.config/google-chrome/Crash Reports" /root/.cache /root/.npm
  rmdir /root/.config/google-chrome 2>/dev/null || true
  # The policy that gave each bot's Chrome its home screen (server/box/cbot-screen.py).
  rm -f /etc/opt/chrome/policies/managed/cbot.json /etc/chromium/policies/managed/cbot.json
  # The light theme the screens set for root's GTK apps, put back as it was.
  if [ -e "$gtk.before-cbot" ]; then mv -f "$gtk.before-cbot" "$gtk"; else rm -f "$gtk"; fi
  rmdir "$(dirname "$gtk")" /root/.local/bin 2>/dev/null || true
  done_ "Deleted the bots, chats, files, settings and Hermes Agent"
}

# ---------------------------------------------------------------- main

main() {
  set -euo pipefail
  ui_init
  [ "$(id -u)" -eq 0 ] || become_root
  # Set here, not at the top: become_root carries functions only. The folders cbot keeps are in
  # server/src/machine.ts, scripts/provision.sh and scripts/release.sh.
  FOLDERS=(/srv/cbot /var/lib/cbot /root/cbot /opt/cbot /etc/cbot /var/log/cbot)
  UNIT=/etc/systemd/system/cbot.service
  local interactive=false reply=''
  if [ -z "${CBOT_YES:-}" ] && (exec </dev/tty) 2>/dev/null; then interactive=true; fi

  printf '%sRemoving cbot%s from %s\n\n' "$B" "$R" "$(hostname)"
  installed || { info "cbot isn't installed here."; return; }
  info "This deletes every bot, chat and file, the account, the provider keys and settings, Hermes"
  info "Agent and the speech service. It can't be undone. Google Chrome, Node.js, Docker, the desktop"
  info "packages and whatever the bots installed stay."
  echo
  if $interactive; then
    printf '   Remove cbot and all its data? %s[y/N]%s ' "$D" "$R" >/dev/tty
    IFS= read -r reply </dev/tty || true
    [[ "$reply" == [yY]* ]] || die "Stopped; nothing was removed."
  elif [ -z "${CBOT_YES:-}" ]; then
    die "Nobody is at a terminal to confirm. Run it with CBOT_YES=1 to remove cbot and all its data."
  fi
  echo

  stop_everything
  remove_speech
  remove_tailscale_serve
  remove_files
  printf '\n%s%s cbot is gone.%s\n' "$G$B" "$OK" "$R"
}

main
