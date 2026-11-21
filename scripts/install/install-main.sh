# ---------------------------------------------------------------- main

main() {
  set -euo pipefail
  PORT=8787
  ui_init
  steps=0 tui=false tty3=false watcher='' reported=false machine='' gum_dir='' fetch_dir='' LOG=''
  [ "$(id -u)" -eq 0 ] || become_root DISPATCH_YES DISPATCH_TZ DISPATCH_MAX_BOTS DISPATCH_TAILSCALE DISPATCH_REF DISPATCH_REPO GITHUB_TOKEN DISPATCH_USER

  repo="${DISPATCH_REPO:-chriscorbell/dispatch}" ref="${DISPATCH_REF:-}" tag=''
  interactive=false
  if [ -z "${DISPATCH_YES:-}" ] && (exec </dev/tty) 2>/dev/null; then interactive=true; fi
  installed=false
  [ -e /srv/dispatch/current ] && installed=true

  # One install at a time.
  exec 9>/run/dispatch-install.lock
  flock -n 9 || die "The installer is running already."
  install -d -m 0755 /var/log/dispatch
  LOG=/var/log/dispatch/install.log
  : >"$LOG"
  trap on_exit EXIT
  # Ctrl+C and hang-ups end it through on_exit too, with their status: untrapped, on_exit would see 0.
  trap 'exit 130' INT
  trap 'exit 129' HUP
  trap 'exit 143' TERM

  local host
  host="$(hostname)"
  if $installed; then
    doing="Updating on $host" stages=(Machine Update Done)
    printf '%sUpdating Dispatch%s on %s\n' "$B" "$R" "$host"
  else
    doing="Installing on $host" stages=(Machine Settings Install Done)
    printf '%sInstalling Dispatch%s on %s\n' "$B" "$R" "$host"
  fi
  tui_start

  stage=0
  $tui || step "Checking this machine"
  check_machine
  choose_account

  if ! $installed; then
    stage=1
    $tui || step "Settings"
    ask_settings
  fi

  work_begin
  if [ "${tailscale_too:-0}" = 1 ]; then
    mark tailscale "Tailscale"
    quietly setup_tailscale
  fi
  mark download "Downloading Dispatch"
  quietly fetch_release
  write_source
  if $up_to_date; then
    work_end
    finish
    return
  fi
  if ! $installed || [ ! -s /etc/dispatch/env ]; then
    : "${tz:=UTC}" "${max_bots:=4}"
    write_settings
  fi
  record_account
  run_release
  work_end
  finish
}
