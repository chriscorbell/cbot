# ---------------------------------------------------------------- main

main() {
  set -euo pipefail
  ui_init
  tui=false removing=false reported=false step_pid='' LOG='' machine=''
  [ "$(id -u)" -eq 0 ] || become_root DISPATCH_YES
  # Set here, not at the top: become_root carries functions only. The folders Dispatch keeps are in
  # server/src/machine.ts, scripts/provision.sh and scripts/release.sh; the bots' own are in the home
  # of their account (DISPATCH_USER), which stays.
  account="$(env_account /etc/dispatch/env)" bots_home=''
  if [ -n "$account" ] && [ "$account" != root ]; then bots_home="$(getent passwd "$account" | cut -d: -f6)"; fi
  FOLDERS=(/srv/dispatch /var/lib/dispatch /opt/dispatch /etc/dispatch /var/log/dispatch)
  if [ -n "$bots_home" ]; then FOLDERS+=("$bots_home/dispatch"); fi
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
