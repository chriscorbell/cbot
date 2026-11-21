#!/usr/bin/env bash
# Removes Dispatch from a machine that scripts/install.sh set up, with all its data:
#
#   curl -fsSL https://raw.githubusercontent.com/chriscorbell/dispatch/main/scripts/uninstall.sh | bash
#
# It stops the service and everything it started (the bots' screens, Chromes and Hermes gateways),
# then deletes the releases, the database and the bots' homes, Chrome profiles and Library files,
# Hermes Agent, the speech service's containers and images and Docker's build cache, the settings,
# the logs, what the screens leave in root's home (window manager and GTK settings, Chrome's crash
# reports, the build caches), the Chrome policy, and the Tailscale Serve address for Dispatch. There is no
# undo. The programs provisioning installed for everyone (Google Chrome, Node.js, Docker and the
# desktop packages), Tailscale, and whatever the bots installed themselves stay on the machine.
#
# It asks before deleting anything; DISPATCH_YES=1 deletes without asking, for a machine nobody is at.
# At a terminal it takes the whole screen, as install.sh does: the question with two buttons, then
# each step with a spinner and its time. When it ends, the terminal gets its screen back with the
# steps printed there. On a terminal smaller than 64 by 20 it prints its steps line by line instead.
#
# Everything is in functions and main runs on the last line, so a download cut short runs nothing.

# ---------------------------------------------------------------- output

ui_init() {
  if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
    B=$'\e[1m' D=$'\e[2m' R=$'\e[0m' G=$'\e[32m' Y=$'\e[33m' E=$'\e[31m' A=$'\e[38;5;69m' fancy=true
  else
    B='' D='' R='' G='' Y='' E='' A='' fancy=false
  fi
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8* | *utf8* | *UTF8* | *utf-8*) OK='✓' NO='✗' NOW='●' LATER='○' LINE='─' SPIN=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏) ;;
    *) OK='+' NO='x' NOW='*' LATER='o' LINE='-' SPIN=('|' '/' '-' "\\") ;;
  esac
  tui=false removing=false reported=false step_pid='' LOG='' machine=''
}

info() { printf '   %s\n' "$*"; }
done_() { printf '   %s%s%s %s\n' "$G" "$OK" "$R" "$*"; }
warn() { printf '   %s!%s %s\n' "$Y" "$R" "$*"; }
die() {
  stop_step
  tui_end
  printf '\n%s%s%s %s\n' "$E" "$NO" "$R" "$*" >&2
  reported=true
  exit 1
}

# The full screen and a step still running stop, and the terminal is put back, whatever ends it.
on_exit() {
  local status=$?
  stop_step
  tui_end
  if [ "$status" -ne 0 ] && ! $reported; then
    if $removing; then
      printf '\n%s%s%s Stopped part way. Run the uninstaller again to remove the rest.\n' "$E" "$NO" "$R" >&2
    else
      printf '\nStopped; nothing was removed.\n' >&2
    fi
  fi
  [ -z "$LOG" ] || rm -f "$LOG"
}

stop_step() {
  [ -n "${step_pid:-}" ] || return 0
  kill "$step_pid" 2>/dev/null || true
  wait "$step_pid" 2>/dev/null || true
  step_pid=''
}

# ---------------------------------------------------------------- the full screen

tui_size() {
  local size
  size="$(stty size </dev/tty 2>/dev/null)" || return 1
  rows=${size% *} cols=${size#* }
}

tui_start() {
  { $interactive && $fancy && tui_size && [ "$rows" -ge 20 ] && [ "$cols" -ge 64 ]; } || return 0
  tui=true
  printf '\e[?1049h\e[?25l'
  stty -echo </dev/tty 2>/dev/null || true
}

tui_end() {
  $tui || return 0
  tui=false
  printf '\e[?25h\e[?1049l'
  stty echo </dev/tty 2>/dev/null || true
}

# The top of every screen, into $head (six rows), as install.sh draws it.
tui_head() {
  local i plain="  Dispatch  $doing" right=$machine gap stepper='' rule
  gap=$((cols - ${#plain} - ${#right} - 2))
  if [ "$gap" -lt 4 ]; then right='' gap=0; fi
  for i in "${!stages[@]}"; do
    [ "$i" -eq 0 ] || stepper+="  $D$LINE$LINE$R  "
    if [ "$i" -lt "$stage" ]; then stepper+="$G$OK$R ${stages[i]}"
    elif [ "$i" -eq "$stage" ]; then stepper+="$A$NOW$R $B${stages[i]}$R"
    else stepper+="$D$LATER ${stages[i]}$R"; fi
  done
  printf -v rule '%*s' $((cols - 4)) ''
  printf -v head '\e[K\n  %s%sDispatch%s  %s%*s%s%s%s\e[K\n\e[K\n  %s\e[K\n  %s%s%s\e[K\n\e[K\n' \
    "$A" "$B" "$R" "$doing" "$gap" '' "$D" "$right" "$R" "$stepper" "$D" "${rule// /$LINE}" "$R"
}

# tui_screen <title> [<line>...]: a fresh screen, its title, then lines wrapped to it ("" is blank).
tui_screen() {
  local title=$1 line l text='' w
  shift
  tui_size || true
  tui_head
  w=$((cols - 8))
  [ "$w" -le 76 ] || w=76
  for line in "$@"; do
    if [ -z "$line" ]; then text+=$'\e[K\n'; continue; fi
    while IFS= read -r l; do text+="  $l"$'\e[K\n'; done < <(printf '%s\n' "$line" | fold -s -w "$w")
  done
  printf '\e[?25l\e[H\e[2J%s  %s%s%s\e[K\n%s\e[K\n' "$head" "$B" "$title" "$R" "$text"
}

# tui_confirm <question> <yes> <no>: two buttons, starting on <no>. Left and right (or Tab) move, Enter
# chooses, y and n choose at once, Esc is no. 0 for yes. (The installer has gum for this; one
# question isn't worth a download.)
tui_confirm() {
  local choice=1 key rest yes no
  printf '  %s%s%s\e[K\n\e[K\n' "$B" "$1" "$R"
  while :; do
    yes="  $2  " no="  $3  "
    if [ "$choice" -eq 0 ]; then yes=$'\e[48;5;69;38;5;255m'"$yes$R" no="$D$no$R"; else yes="$D$yes$R" no=$'\e[48;5;69;38;5;255m'"$no$R"; fi
    printf '\r  %s   %s\e[K\n\e[K\n  %s←→ choose %s enter submit %s y %s %s n %s%s\e[K\e[2A\r' \
      "$yes" "$no" "$D" '•' '•' "$2" '•' "$3" "$R"
    IFS= read -rsn1 key </dev/tty || key=n
    case "$key" in
      '') break ;;
      y | Y) choice=0; break ;;
      n | N | q) choice=1; break ;;
      $'\t' | h | l) choice=$((1 - choice)) ;;
      $'\e')
        rest=''
        IFS= read -rsn2 -t 0.05 rest </dev/tty || true
        case "$rest" in '[C' | '[D') choice=$((1 - choice)) ;; '') choice=1; break ;; esac
        ;;
    esac
  done
  printf '\e[3B\r'
  return "$choice"
}

# The steps as they go: a spinner on the running one, ticks and times on those done.
draw_steps() {
  local out i icon text time t w pad
  tui_size || true
  tui_head
  out=$'\e[?25l\e[H'"$head"
  w=$((cols - 4))
  [ "$w" -le 80 ] || w=80
  for i in "${!words[@]}"; do
    case "${states[i]}" in
      done) icon="$G$OK$R" t=${took[i]} ;;
      failed) icon="$E$NO$R" t=${took[i]} ;;
      running) icon="$A${SPIN[tick % ${#SPIN[@]}]}$R" t=$((SECONDS - began[i])) ;;
      *) icon=' ' t=-1 ;;
    esac
    time=''
    [ "$t" -lt 0 ] || printf -v time '%d:%02d' $((t / 60)) $((t % 60))
    text=${words[i]}
    [ "${#text}" -le $((w - 12)) ] || text="${text:0:w-13}…"
    pad=$((w - 4 - ${#text} - ${#time}))
    case "${states[i]}" in later) text="$D$text$R" ;; running) text="$B$text$R" ;; esac
    printf -v text '  %s %s%*s%s%s%s' "$icon" "$text" "$pad" '' "$D" "$time" "$R"
    out+="$text"$'\e[K\n'
  done
  printf '%s\e[J' "$out"
}

# The steps as lines for the terminal's own screen, once the full screen is gone.
record_steps() {
  local i t
  echo
  for i in "${!words[@]}"; do
    t=${took[i]}
    case "${states[i]}" in
      done) printf '   %s%s%s %s %s%d:%02d%s\n' "$G" "$OK" "$R" "${words[i]}" "$D" $((t / 60)) $((t % 60)) "$R" ;;
      failed) printf '   %s%s%s %s %s%d:%02d%s\n' "$E" "$NO" "$R" "${words[i]}" "$D" $((t / 60)) $((t % 60)) "$R" ;;
    esac
  done
}

# A step in the background job: a die there must leave the screen, which the job doesn't own, alone.
in_background() {
  tui=false
  "$1"
}

# Each step in the background with its output in $LOG, while the screen shows it. A step's own
# warnings are printed once the screen is gone.
remove_tui() {
  local i
  stage=1 tick=0
  for i in "${!words[@]}"; do states[i]=later took[i]=0 began[i]=0; done
  for i in "${!words[@]}"; do
    states[i]=running began[i]=$SECONDS
    in_background "${steps[i]}" >>"$LOG" 2>&1 </dev/null &
    step_pid=$!
    while kill -0 "$step_pid" 2>/dev/null; do
      draw_steps
      tick=$((tick + 1))
      sleep 0.1
    done
    if wait "$step_pid"; then states[i]='done'; else states[i]=failed; fi
    step_pid='' took[i]=$((SECONDS - began[i]))
    if [ "${states[i]}" = failed ]; then
      draw_steps
      tui_end
      record_steps
      printf '\n%sWhat it said:%s\n' "$D" "$R" >&2
      tail -n 20 "$LOG" | sed 's/^/   /' >&2
      die "${words[i]} didn't finish. Run the uninstaller again to remove the rest."
    fi
  done
  stage=2
  draw_steps
  sleep 0.8
  tui_end
  record_steps
  grep -aF "   $Y!$R" "$LOG" || true
}

# ---------------------------------------------------------------- root

# As in install.sh: run as someone else, it starts again under sudo from a private copy of its own
# functions, with the terminal as stdin so the question still reaches the person, and the locale,
# which decides whether the screen draws with Unicode.
become_root() {
  command -v sudo >/dev/null || die "Run this as root."
  local self v status=0
  self="$(mktemp)"
  {
    for v in DISPATCH_YES LANG LC_ALL LC_CTYPE; do
      [ -z "${!v:-}" ] || printf 'export %s=%q\n' "$v" "${!v}"
    done
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
  images="$(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^dispatch-(speech|zonos3):' || true)"
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

# ---------------------------------------------------------------- main

main() {
  set -euo pipefail
  ui_init
  [ "$(id -u)" -eq 0 ] || become_root
  # Set here, not at the top: become_root carries functions only. The folders Dispatch keeps are in
  # server/src/machine.ts, scripts/provision.sh and scripts/release.sh.
  FOLDERS=(/srv/dispatch /var/lib/dispatch /root/dispatch /opt/dispatch /etc/dispatch /var/log/dispatch)
  UNIT=/etc/systemd/system/dispatch.service
  local reply='' host
  interactive=false
  if [ -z "${DISPATCH_YES:-}" ] && (exec </dev/tty) 2>/dev/null; then interactive=true; fi
  host="$(hostname)"

  printf '%sRemoving Dispatch%s from %s\n' "$B" "$R" "$host"
  installed || { printf '\n'; info "Dispatch isn't installed here."; return; }
  if ! $interactive && [ -z "${DISPATCH_YES:-}" ]; then
    die "Nobody is at a terminal to confirm. Run it with DISPATCH_YES=1 to remove Dispatch and all its data."
  fi
  trap on_exit EXIT
  # Ctrl+C and hang-ups end it through on_exit too, with their status: untrapped, on_exit would see 0.
  trap 'exit 130' INT
  trap 'exit 129' HUP
  trap 'exit 143' TERM

  # The steps, in order; the full screen lists them before they run, so only those with work to do.
  words=("Stopping Dispatch, the bots' screens and their agents") steps=(stop_everything)
  if speech_here; then words+=("Removing the speech service") steps+=(remove_speech); fi
  if [ -n "$(serve_ports)" ]; then words+=("Turning off Dispatch's Tailscale address") steps+=(remove_tailscale_serve); fi
  words+=("Deleting the bots, chats, files, settings and Hermes Agent") steps+=(remove_files)

  # shellcheck disable=SC1091
  machine="$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-}")" || machine=''
  doing="Removing from $host" stages=(Confirm Remove Done) stage=0
  tui_start
  if $tui; then
    tui_screen "Remove Dispatch?" \
      "This deletes every bot, chat and file, the account, the provider keys and settings, Hermes Agent and the speech service. It can't be undone." "" \
      "Google Chrome, Node.js, Docker, the desktop packages, Tailscale and whatever the bots installed stay on the machine."
    tui_confirm "Remove Dispatch and all its data?" Remove "Keep Dispatch" || { tui_end; printf '\nStopped; nothing was removed.\n'; reported=true; exit 1; }
    removing=true
    LOG="$(mktemp)"
    remove_tui
  else
    echo
    info "This deletes every bot, chat and file, the account, the provider keys and settings, Hermes"
    info "Agent and the speech service. It can't be undone. Google Chrome, Node.js, Docker, the desktop"
    info "packages and whatever the bots installed stay."
    echo
    if $interactive; then
      printf '   Remove Dispatch and all its data? %s[y/N]%s ' "$D" "$R" >/dev/tty
      IFS= read -r reply </dev/tty || true
      [[ "$reply" == [yY]* ]] || die "Stopped; nothing was removed."
    fi
    echo
    removing=true
    stop_everything
    remove_speech
    remove_tailscale_serve
    remove_files
  fi
  removing=false
  printf '\n%s%s Dispatch is gone.%s\n' "$G$B" "$OK" "$R"
}

main
