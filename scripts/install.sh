#!/usr/bin/env bash
# Installs cbot on a machine of its own, or updates it:
#
#   curl -fsSL https://raw.githubusercontent.com/chriscorbell/cbot/main/scripts/install.sh | bash
#
# It checks the machine (Ubuntu or Debian on x86-64, with systemd), asks three things (the bots' time
# zone, how many bots at most, and whether to set up Tailscale too), then downloads a commit from
# GitHub into /srv/cbot/releases and runs that commit's scripts/release.sh, the same step
# scripts/deploy.sh runs: it provisions the machine, builds the release and the speech image, and
# starts the cbot service. cbot serves HTTPS on the local network with a certificate of its own
# (server/src/https.ts), which browsers warn about once per device; Tailscale adds an address with a
# certificate they trust. The answers go to /etc/cbot/env. Run it again to update to the newest
# commit; the settings stay as they are.
#
# Unattended, the answers come from the environment, CBOT_TZ, CBOT_MAX_BOTS and CBOT_TAILSCALE (1 or
# 0), with the defaults for any left out. CBOT_YES=1 takes them without asking even at a terminal.
# CBOT_REF installs a branch, tag or commit other than main, CBOT_REPO a fork, and GITHUB_TOKEN reads
# a private one.
#
# Everything is in functions and main runs on the last line, so a download cut short runs nothing.

# ---------------------------------------------------------------- output

ui_init() {
  if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
    B=$'\e[1m' D=$'\e[2m' R=$'\e[0m' G=$'\e[32m' Y=$'\e[33m' E=$'\e[31m' fancy=true
  else
    B='' D='' R='' G='' Y='' E='' fancy=false
  fi
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8* | *utf8* | *UTF8* | *utf-8*) OK='✓' NO='✗' SPIN=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏) ;;
    *) OK='+' NO='x' SPIN=('|' '/' '-' "\\") ;;
  esac
  steps=0
}

step() { steps=$((steps + 1)); printf '\n%s%s. %s%s\n' "$B" "$steps" "$1" "$R"; }
info() { printf '   %s\n' "$*"; }
note() { printf '   %s%s%s\n' "$D" "$*" "$R"; }
warn() { printf '   %s!%s %s\n' "$Y" "$R" "$*"; }
die() { printf '\n%s%s%s %s\n' "$E" "$NO" "$R" "$*" >&2; exit 1; }

# ask <question> <default> [<preset>]: the preset (from the environment) or, with nobody at a
# terminal, the default, shown as the answer; otherwise what the person types, Enter taking the
# default. The answer goes to stdout, so the prompt goes to the terminal.
ask() {
  local reply="${3:-}"
  if [ -z "$reply" ] && $interactive; then
    printf '   %s %s[%s]%s ' "$1" "$D" "$2" "$R" >/dev/tty
    IFS= read -r reply </dev/tty || true
    reply="$(printf '%s' "$reply" | tr -d '[:space:]')"
    reply="${reply:-$2}"
  else
    reply="${reply:-$2}"
    printf '   %s %s\n' "$1" "$reply" >&2
  fi
  printf '%s' "$reply"
}

# confirm <question>: yes only when the person types y, and always yes unattended.
confirm() {
  $interactive || return 0
  local reply=''
  printf '   %s %s[y/N]%s ' "$1" "$D" "$R" >/dev/tty
  IFS= read -r reply </dev/tty || true
  [[ "$reply" == [yY]* ]]
}

clock() { printf '%d:%02d' $(($1 / 60)) $(($1 % 60)); }

# ---------------------------------------------------------------- root

# Everything here installs system-wide, so it runs as root. Run as someone else, it starts again
# under sudo. Piped from curl, the script is gone from stdin by now, so it writes itself to a private
# file from `declare -f` (the same code, not a second download), with the settings from the
# environment, which stay out of the process list that way. sudo gets the terminal as stdin: given
# curl's pipe, Ubuntu's sudo-rs stops the questions' reads from the terminal.
become_root() {
  command -v sudo >/dev/null || die "Run this as root."
  local self v status=0
  self="$(mktemp)"
  {
    for v in CBOT_YES CBOT_TZ CBOT_MAX_BOTS CBOT_TAILSCALE CBOT_REF CBOT_REPO GITHUB_TOKEN; do
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

# ---------------------------------------------------------------- the machine

check_machine() {
  local id='' like='' version='' name='' problems=() p
  # The releases the installer has been run on end to end: a bot's screen, Chrome, agent and voice.
  # Ubuntu 26.04 is the main one. provision.sh needs apt and the Ubuntu or Debian repositories of
  # Chrome, Node.js and Docker, so their derivatives may work too, with a warning. (Inside the
  # function: become_root carries functions only.)
  local tested='ubuntu 26.04|ubuntu 24.04|ubuntu 22.04|debian 13|debian 12'
  [ "$(uname -s)" = Linux ] || die "cbot installs on Ubuntu or Debian."
  [ "$(uname -m)" = x86_64 ] || die "cbot needs an x86-64 (amd64) machine; this one is $(uname -m)."
  # shellcheck disable=SC1091
  [ -r /etc/os-release ] && { id="$(. /etc/os-release && echo "${ID:-}")"; like="$(. /etc/os-release && echo "${ID_LIKE:-}")"; version="$(. /etc/os-release && echo "${VERSION_ID:-}")"; name="$(. /etc/os-release && echo "${PRETTY_NAME:-}")"; }
  case " $id $like " in *" ubuntu "* | *" debian "*) ;; *) die "cbot installs on Ubuntu or Debian, and this is ${name:-another system}." ;; esac
  [ -d /run/systemd/system ] || die "cbot runs as a systemd service, and systemd isn't running here. Install it on a machine or VM of its own, not in a container."
  local tool
  for tool in curl tar gzip; do
    command -v "$tool" >/dev/null || die "This needs $tool: apt-get install $tool"
  done

  ram_gb="$(awk '/^MemTotal:/ { printf "%d", $2 / 1048576 + 0.5 }' /proc/meminfo)"
  local disk_gb cpus
  disk_gb="$(df -BG --output=avail / | awk 'NR == 2 { print $1 + 0 }')"
  cpus="$(nproc)"
  info "$name, $cpus CPUs, $ram_gb GB of memory, $disk_gb GB free"

  case "|$tested|" in *"|$id $version|"*) ;; *) problems+=("cbot is made for Ubuntu 26.04 and tested on Ubuntu 22.04 and 24.04 and Debian 12 and 13. ${name:-This system} may work, but isn't tested.") ;; esac
  [ "$ram_gb" -ge 4 ] || problems+=("cbot wants about 2 GB of memory for voice and 1 GB per bot, and this machine has $ram_gb GB.")
  [ "$disk_gb" -ge 25 ] || problems+=("cbot needs about 25 GB of disk for Chrome, Hermes Agent and the speech service, and $disk_gb GB is free.")
  if ! $installed && ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q .; then
    die "Something else is using port $PORT, which cbot needs: $(ss -Hltnp "sport = :$PORT" | grep -o 'users:.*' | head -1)"
  fi
  for p in "${problems[@]}"; do warn "$p"; done
  [ ${#problems[@]} -eq 0 ] || confirm "Continue anyway?" || die "Stopped."
}

valid_tz() {
  [[ "$1" =~ ^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$ ]] || return 1
  [ ! -d /usr/share/zoneinfo ] || [ -f "/usr/share/zoneinfo/$1" ]
}

ask_settings() {
  local tz_default suggested
  tz_default="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  case "$tz_default" in '' | Etc/UTC | Etc/Universal) tz_default=UTC ;; esac
  tz="$(ask "Time zone for the bots' clocks and routines" "$tz_default" "${CBOT_TZ:-}")"
  while ! valid_tz "$tz"; do
    { $interactive && [ -z "${CBOT_TZ:-}" ]; } || die "$tz is not a time zone. Use a name like Europe/London or America/New_York."
    warn "$tz is not a time zone. Use a name like Europe/London or America/New_York."
    tz="$(ask "Time zone" "$tz_default")"
  done

  # About 1 GB each, after 2 GB for voice; the app's own default is 4.
  suggested=$((ram_gb - 2))
  [ "$suggested" -ge 1 ] || suggested=1
  [ "$suggested" -le 4 ] || suggested=4
  max_bots="$(ask "How many bots at most (about 1 GB of memory each)" "$suggested" "${CBOT_MAX_BOTS:-}")"
  while ! [[ "$max_bots" =~ ^[1-9][0-9]?$ ]]; do
    { $interactive && [ -z "${CBOT_MAX_BOTS:-}" ]; } || die "The number of bots has to be a number from 1 to 99."
    warn "Type a number from 1 to 99."
    max_bots="$(ask "How many bots at most" "$suggested")"
  done

  if [ -n "${CBOT_TAILSCALE:-}" ]; then
    tailscale_too="$CBOT_TAILSCALE"
    info "Set up Tailscale too: $([ "$tailscale_too" = 1 ] && echo yes || echo no)"
  elif $interactive; then
    info "cbot uses HTTPS with a certificate of its own, which browsers warn about once per device."
    info "Tailscale adds an address that has no warning and works from anywhere (free account)."
    if confirm "Set up Tailscale too?"; then tailscale_too=1; else tailscale_too=0; fi
  else
    tailscale_too=0
  fi
}

write_settings() {
  install -d -m 0700 /etc/cbot
  (
    umask 077
    cat >/etc/cbot/env.new <<EOF
# cbot's settings, read by its systemd service. After changing one: systemctl restart cbot
# .env.example in cbot's source lists the others.
MAX_BOTS=$max_bots
TZ=$tz
# Every address, so cbot is on the local network. 127.0.0.1 keeps it to this machine (and to
# Tailscale Serve, if that is set up).
HOST=0.0.0.0
# HTTPS with cbot's own certificate, on the same port, for voice calls: browsers allow the
# microphone only over HTTPS.
HTTPS=1
EOF
  )
  mv /etc/cbot/env.new /etc/cbot/env
}

# ---------------------------------------------------------------- Tailscale

tailscale_up() { tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; }

setup_tailscale() {
  if ! command -v tailscale >/dev/null; then
    info "Installing Tailscale"
    curl -fsSL https://tailscale.com/install.sh | sh >>"$LOG" 2>&1 || die "Tailscale didn't install. The log is $LOG."
  fi
  if ! tailscale_up; then
    info "Sign this machine in to your tailnet with the link below."
    tailscale up 2>&1 | sed -u 's/^/   /' || die "Tailscale didn't sign in."
  fi
  # HTTPS on the machine's tailnet name. Serve needs HTTPS turned on for the tailnet; when it isn't,
  # tailscale prints a link to turn it on and waits.
  if [ -z "$(tailscale_url)" ]; then
    tailscale serve --bg --https=443 "http://127.0.0.1:$PORT" 2>&1 | sed -u 's/^/   /' || die "Tailscale Serve didn't start."
  fi
  info "$G$OK$R cbot will also be at $(tailscale_url)"
}

# ---------------------------------------------------------------- the release

# Sets commit and script (the release.sh to run), or up_to_date when that commit already runs.
fetch_release() {
  local api="https://api.github.com/repos/$repo" auth=() sha releases=/srv/cbot/releases
  [ -z "${GITHUB_TOKEN:-}" ] || auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  sha="$(curl -fsSL "${auth[@]}" -H 'Accept: application/vnd.github.sha' "$api/commits/$ref")" ||
    die "Couldn't find $ref in github.com/$repo."
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "GitHub didn't name a commit for $ref."
  # Twelve characters, as scripts/deploy.sh names releases, so both reuse the same ones.
  commit="${sha:0:12}"
  up_to_date=false
  if [ "$(readlink /srv/cbot/current 2>/dev/null)" = "releases/$commit" ] && systemctl is-active --quiet cbot; then
    up_to_date=true
    info "$ref is $commit, which is running already"
    return
  fi
  if [ -d "$releases/$commit" ]; then
    info "$ref is $commit, built before"
    script="$releases/$commit/scripts/release.sh"
    return
  fi
  rm -rf "$releases/$commit.new"
  mkdir -p "$releases/$commit.new"
  curl -fsSL "${auth[@]}" "$api/tarball/$sha" | tar -xz -C "$releases/$commit.new" --strip-components=1 ||
    die "The download of $commit failed."
  info "$ref is $commit"
  script="$releases/$commit.new/scripts/release.sh"
}

# progress <offset>: release.sh's steps as they reach the log after <offset>. At a terminal the
# current one has a spinner and its time, and TERM marks it done, USR1 failed; otherwise each step is
# a line as it starts. Until release.sh names its first step, the spinner says Starting.
progress() {
  local offset=$1 shown=0 tick=0 since=$SECONDS current='Starting' started=false line lines=()
  ended() {
    if $fancy; then printf '\r\e[K   %s %s %s%s%s\n' "$1" "$current" "$D" "$(clock $((SECONDS - since)))" "$R"; fi
  }
  trap 'ended "$G$OK$R"; exit 0' TERM
  trap 'ended "$E$NO$R"; exit 0' USR1
  while :; do
    if [ $((tick % 4)) -eq 0 ]; then
      mapfile -t lines < <(tail -c "+$((offset + 1))" "$LOG" | sed -nE 's/^\[(provision|release)\] //p')
      while [ "$shown" -lt "${#lines[@]}" ]; do
        line="$(describe "${lines[shown]}")"
        shown=$((shown + 1))
        [ -n "$line" ] || continue
        if $started; then ended "$G$OK$R"; fi
        current="$line" since=$SECONDS started=true
        if ! $fancy; then info "$current"; fi
      done
    fi
    if $fancy; then
      printf '\r\e[K   %s %s %s%s%s' "${SPIN[tick % ${#SPIN[@]}]}" "$current" "$D" "$(clock $((SECONDS - since)))" "$R"
    fi
    tick=$((tick + 1))
    sleep 0.25
  done
}

# What release.sh and provision.sh say, in words for someone installing. Empty skips a line.
describe() {
  case "$1" in
    'provisioning the host') echo 'Setting up the machine' ;;
    packages) echo 'Installing Chrome, Node, Docker and the desktop packages' ;;
    'Hermes Agent '*) echo "Installing $1" ;;
    done | 'cbot runs '*) ;;
    'building cbot-speech'*) echo 'Building the speech service (about ten minutes)' ;;
    'building '*) echo 'Building cbot' ;;
    *) echo "$1" ;;
  esac
}

# release.sh's output goes to the log, and progress shows its steps. The watcher is global so the
# EXIT trap still finds it when the installer stops early.
run_release() {
  progress "$(stat -c %s "$LOG")" &
  watcher=$!
  trap '[ -z "${watcher:-}" ] || kill "$watcher" 2>/dev/null' EXIT
  if bash "$script" >>"$LOG" 2>&1 </dev/null; then
    kill -TERM "$watcher"
    wait "$watcher" 2>/dev/null || true
    watcher=''
  else
    kill -USR1 "$watcher"
    wait "$watcher" 2>/dev/null || true
    watcher=''
    printf '\n%sThe last lines of %s:%s\n' "$D" "$LOG" "$R" >&2
    tail -n 30 "$LOG" | sed 's/^/   /' >&2
    die "cbot didn't install. Fix what the log says and run the installer again; it picks up where it stopped."
  fi
}

# ---------------------------------------------------------------- done

# The address this machine reaches the network from: its LAN address, or a server's public one.
lan_address() {
  local ip
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | cut -d' ' -f2)"
  [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{ print $1 }')"
  echo "${ip:-$(hostname)}"
}

private_address() {
  case "$1" in
    10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | 100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) return 0 ;;
    *) return 1 ;;
  esac
}

# The HTTPS address Tailscale Serve gives cbot, once someone has set that up.
tailscale_url() {
  local status
  command -v tailscale >/dev/null || return 0
  status="$(tailscale serve status 2>/dev/null)" || return 0
  case "$status" in *"127.0.0.1:$PORT"*) grep -o 'https://[^ ]*' <<<"$status" | head -1 ;; esac
}

finish() {
  local url address listening lan=false scheme=http
  printf '\n%s%s cbot is running%s %s(%s)%s\n\n' "$G$B" "$OK" "$R" "$D" "$commit" "$R"
  # An install can keep the server to 127.0.0.1 (HOST in /etc/cbot/env), or to plain HTTP (HTTPS).
  listening="$(ss -Hltn "sport = :$PORT" | awk '{ print $4 }')"
  case "$listening" in '' | 127.0.0.1:*) ;; *) lan=true ;; esac
  curl -fsk --max-time 5 -o /dev/null "https://127.0.0.1:$PORT/api/health" && scheme=https
  url="$(tailscale_url || true)"
  address="$(lan_address)"
  if $lan; then
    info "Open $B$scheme://$address:$PORT$R"
    [ -z "$url" ] || info "or $B$url$R from anywhere on your tailnet"
    if [ "$scheme" = https ]; then
      info "The browser warns that the connection isn't private, because cbot signs its own certificate."
      info "Continue past it once per device, or install the certificate from Settings > General."
    fi
  elif [ -n "$url" ]; then
    info "Open $B$url$R"
  else
    info "cbot listens on this machine only (HOST in /etc/cbot/env). Reach it with"
    info "  $B""ssh -N -L $PORT:127.0.0.1:$PORT ${SUDO_USER:-root}@$address$R"
    info "then open $B""http://127.0.0.1:$PORT$R"
  fi
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/auth/me" 2>/dev/null | grep -q '"needsAccount":true'; then
    info "Make your account there now: until one exists, anyone who can reach cbot can make it."
  fi
  if $lan && ! private_address "$address"; then
    warn "$address is a public address, so cbot is open to the internet. Block port $PORT in a firewall and reach cbot through Tailscale instead."
  elif $lan && command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    warn "The firewall (ufw) is on. Let the local network reach cbot with: ufw allow $PORT/tcp"
  fi
  echo
  if [ -z "$url" ] && [ "$scheme" = http ]; then
    note "Voice calls need HTTPS, since browsers allow the microphone only there. Set HTTPS=1 in"
    note "/etc/cbot/env, or put Tailscale on this machine and run:"
    note "  tailscale serve --bg --https=443 http://127.0.0.1:$PORT"
    echo
  fi
  note "Logs: journalctl -u cbot -f"
  note "Settings: /etc/cbot/env, then systemctl restart cbot"
  note "Update: run the installer again"
}

# ---------------------------------------------------------------- main

main() {
  set -euo pipefail
  PORT=8787
  ui_init
  [ "$(id -u)" -eq 0 ] || become_root

  repo="${CBOT_REPO:-chriscorbell/cbot}" ref="${CBOT_REF:-main}"
  interactive=false
  if [ -z "${CBOT_YES:-}" ] && (exec </dev/tty) 2>/dev/null; then interactive=true; fi
  installed=false
  [ -e /srv/cbot/current ] && installed=true

  # One install at a time.
  exec 9>/run/cbot-install.lock
  flock -n 9 || die "The installer is running already."
  install -d -m 0755 /var/log/cbot
  LOG=/var/log/cbot/install.log
  : >"$LOG"

  if $installed; then
    printf '%sUpdating cbot%s on %s\n' "$B" "$R" "$(hostname)"
  else
    printf '%sInstalling cbot%s on %s\n' "$B" "$R" "$(hostname)"
  fi

  step "Checking this machine"
  check_machine

  if ! $installed; then
    step "Settings"
    ask_settings
    if [ "$tailscale_too" = 1 ]; then
      step "Tailscale"
      setup_tailscale
    fi
  fi

  step "Downloading cbot"
  fetch_release
  if $up_to_date; then
    finish
    return
  fi
  if ! $installed || [ ! -s /etc/cbot/env ]; then
    : "${tz:=UTC}" "${max_bots:=4}"
    write_settings
  fi

  if $installed; then step "Updating"; else step "Installing"; fi
  $installed || note "The first install takes 15 to 30 minutes, and can be left to finish."
  note "The full log is $LOG"
  run_release
  finish
}

main
