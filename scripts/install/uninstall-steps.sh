# ---------------------------------------------------------------- what goes

installed() {
  local f
  [ -e "$UNIT" ] && return 0
  for f in "${FOLDERS[@]}" /opt/hermes; do [ -e "$f" ] && return 0; done
  return 1
}

# The service, then whatever it started. Its screens, Chromes and gateways outlive the server on
# purpose (KillMode=process in deploy/dispatch.service), but they stay in the service's control group,
# which holds every process started from it, the bots' own included.
stop_everything() {
  local group pids _
  group="$(systemctl show -p ControlGroup --value dispatch.service 2>/dev/null || true)"
  group="/sys/fs/cgroup${group:-/system.slice/dispatch.service}"
  if [ -e "$UNIT" ]; then
    systemctl disable --now dispatch.service >/dev/null 2>&1 || true
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
  systemctl reset-failed dispatch.service >/dev/null 2>&1 || true
  done_ "Stopped Dispatch, the bots' screens and their agents"
}

speech_here() { command -v docker >/dev/null && docker info >/dev/null 2>&1; }

# The speech service: its Compose project's containers and network, and every image built for it.
remove_speech() {
  local ids images
  speech_here || return 0
  ids="$(docker ps -aq --filter label=com.docker.compose.project=dispatch-speech)"
  # shellcheck disable=SC2086 # one container id per word
  [ -z "$ids" ] || docker rm -f $ids >/dev/null
  ids="$(docker network ls -q --filter label=com.docker.compose.project=dispatch-speech)"
  # shellcheck disable=SC2086 # one network id per word
  [ -z "$ids" ] || docker network rm $ids >/dev/null
  images="$(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^dispatch-speech:' || true)"
  # shellcheck disable=SC2086 # one image per word
  [ -z "$images" ] || docker image rm -f $images >/dev/null
  # Building the speech image leaves gigabytes of build cache; any other project's is only a cache.
  docker builder prune -af >/dev/null 2>&1 || true
  done_ "Removed the speech service"
}

# The ports Tailscale Serve serves Dispatch on (install.sh serves it on 443, provision.sh on 8787).
serve_ports() {
  command -v tailscale >/dev/null || return 0
  tailscale serve status 2>/dev/null | awk '
    /^https:\/\// { port = 443; if (match($1, /:[0-9]+$/)) port = substr($1, RSTART + 1) }
    /127\.0\.0\.1:8787/ { print port }' | sort -u
}

# Tailscale Serve's address for Dispatch. Tailscale itself stays: it may do more than reach Dispatch.
remove_tailscale_serve() {
  local ports port
  ports="$(serve_ports)"
  [ -n "$ports" ] || return 0
  for port in $ports; do
    tailscale serve --https="$port" off >/dev/null 2>&1 || warn "Couldn't turn off Tailscale Serve on port $port: tailscale serve --https=$port off"
  done
  done_ "Turned off Dispatch's Tailscale address"
}

remove_files() {
  local gtk=/root/.config/gtk-3.0/settings.ini f
  rm -rf "${FOLDERS[@]}" /opt/hermes /opt/hermes.[0-9]* /run/dispatch-install.lock
  # Hermes' launchers: provision.sh's copy, and the ones its installer puts in root's ~/.local/bin.
  [ "$(readlink /usr/local/bin/hermes 2>/dev/null)" != /opt/hermes/launcher/hermes ] || rm -f /usr/local/bin/hermes
  for f in /root/.local/bin/hermes*; do
    ! grep -qs /opt/hermes/ "$f" || rm -f "$f"
  done
  # What the screens and builds leave in root's home: the window manager's settings, Chrome's crash
  # reports, and caches (npm, node-gyp, uv, shaders), which are safe to delete by definition.
  rm -rf /root/.config/xfce4 "/root/.config/google-chrome/Crash Reports" /root/.cache /root/.npm
  rmdir /root/.config/google-chrome 2>/dev/null || true
  # The policy that gave each bot's Chrome its home screen (server/box/dispatch-screen.py).
  rm -f /etc/opt/chrome/policies/managed/dispatch.json /etc/chromium/policies/managed/dispatch.json
  # The light theme the screens set for root's GTK apps, put back as it was.
  if [ -e "$gtk.before-dispatch" ]; then mv -f "$gtk.before-dispatch" "$gtk"; else rm -f "$gtk"; fi
  rmdir "$(dirname "$gtk")" /root/.local/bin 2>/dev/null || true
  done_ "Deleted the bots, chats, files, settings and Hermes Agent"
}
