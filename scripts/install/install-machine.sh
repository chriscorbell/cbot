# ---------------------------------------------------------------- the machine

check_machine() {
  local id='' like='' version='' name='' problems=() p
  # The releases the installer has been run on end to end: a bot's screen, Chrome, agent and voice.
  # Ubuntu 26.04 is the main one. provision.sh needs apt and the Ubuntu or Debian repositories of
  # Chrome, Node.js and Docker, so their derivatives may work too, with a warning. (Inside the
  # function: become_root carries functions only.)
  local tested='ubuntu 26.04|ubuntu 24.04|ubuntu 22.04|debian 13|debian 12'
  [ "$(uname -s)" = Linux ] || die "Dispatch installs on Ubuntu or Debian."
  [ "$(uname -m)" = x86_64 ] || die "Dispatch needs an x86-64 (amd64) machine; this one is $(uname -m)."
  # shellcheck disable=SC1091
  [ -r /etc/os-release ] && { id="$(. /etc/os-release && echo "${ID:-}")"; like="$(. /etc/os-release && echo "${ID_LIKE:-}")"; version="$(. /etc/os-release && echo "${VERSION_ID:-}")"; name="$(. /etc/os-release && echo "${PRETTY_NAME:-}")"; }
  case " $id $like " in *" ubuntu "* | *" debian "*) ;; *) die "Dispatch installs on Ubuntu or Debian, and this is ${name:-another system}." ;; esac
  [ -d /run/systemd/system ] || die "Dispatch runs as a systemd service, and systemd isn't running here. Install it on a machine or VM of its own, not in a container."
  local tool
  for tool in curl tar gzip; do
    command -v "$tool" >/dev/null || die "This needs $tool: apt-get install $tool"
  done

  ram_gb="$(awk '/^MemTotal:/ { printf "%d", $2 / 1048576 + 0.5 }' /proc/meminfo)"
  local disk_gb cpus
  disk_gb="$(df -BG --output=avail / | awk 'NR == 2 { print $1 + 0 }')"
  cpus="$(nproc)"
  machine="$name $DOT $cpus CPUs $DOT $ram_gb GB"
  $tui || info "$name, $cpus CPUs, $ram_gb GB of memory, $disk_gb GB free"

  case "|$tested|" in *"|$id $version|"*) ;; *) problems+=("Dispatch is made for Ubuntu 26.04 and tested on Ubuntu 22.04 and 24.04 and Debian 12 and 13. ${name:-This system} may work, but isn't tested.") ;; esac
  [ "$ram_gb" -ge 4 ] || problems+=("Dispatch wants about 2 GB of memory for voice and 1 GB per bot, and this machine has $ram_gb GB.")
  [ "$disk_gb" -ge 25 ] || problems+=("Dispatch needs about 25 GB of disk for Chrome, Hermes Agent and the speech service, and $disk_gb GB is free.")
  if ! $installed && ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q .; then
    die "Something else is using port $PORT, which Dispatch needs: $(ss -Hltnp "sport = :$PORT" | grep -o 'users:.*' | head -1)"
  fi
  [ ${#problems[@]} -gt 0 ] || return 0
  if $tui; then
    local lines=()
    for p in "${problems[@]}"; do lines+=("!$p"); done
    tui_screen "This machine" "$name, $cpus CPUs, $ram_gb GB of memory and $disk_gb GB free." "" "${lines[@]}"
    gum_ask "Continue anyway?" Continue Quit false || quit
  else
    for p in "${problems[@]}"; do warn "$p"; done
    confirm "Continue anyway?" || die "Stopped."
  fi
}

valid_tz() {
  [[ "$1" =~ ^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$ ]] || return 1
  [ ! -d /usr/share/zoneinfo ] || [ -f "/usr/share/zoneinfo/$1" ]
}

ask_settings() {
  local tz_default suggested
  tz_default="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  case "$tz_default" in '' | Etc/UTC | Etc/Universal) tz_default=UTC ;; esac
  # About 1 GB each, after 2 GB for voice; the app's own default is 4.
  suggested=$((ram_gb - 2))
  [ "$suggested" -ge 1 ] || suggested=1
  [ "$suggested" -le 4 ] || suggested=4
  if $tui; then
    ask_settings_tui "$tz_default" "$suggested"
    return
  fi

  tz="$(ask "Time zone for the bots' clocks and routines, like America/New_York" "$tz_default" "${DISPATCH_TZ:-}")"
  while ! valid_tz "$tz"; do
    { $interactive && [ -z "${DISPATCH_TZ:-}" ]; } || die "$tz is not a time zone. Use a name like Europe/London or America/New_York."
    warn "$tz is not a time zone. Use a name like Europe/London or America/New_York."
    tz="$(ask "Time zone" "$tz_default")"
  done

  max_bots="$(ask "How many bots at most (about 1 GB of memory each)" "$suggested" "${DISPATCH_MAX_BOTS:-}")"
  while ! [[ "$max_bots" =~ ^[1-9][0-9]?$ ]]; do
    { $interactive && [ -z "${DISPATCH_MAX_BOTS:-}" ]; } || die "The number of bots has to be a number from 1 to 99."
    warn "Type a number from 1 to 99."
    max_bots="$(ask "How many bots at most" "$suggested")"
  done

  if [ -n "${DISPATCH_TAILSCALE:-}" ]; then
    tailscale_too="$DISPATCH_TAILSCALE"
    info "Set up Tailscale too: $([ "$tailscale_too" = 1 ] && echo yes || echo no)"
  elif $interactive; then
    info "Dispatch uses HTTPS with a certificate of its own, which browsers warn about once per device."
    info "Tailscale adds an address that has no warning and works from anywhere (free account)."
    if confirm "Set up Tailscale too?"; then tailscale_too=1; else tailscale_too=0; fi
  else
    tailscale_too=0
  fi
}

# At full screen: a screen per question, skipping those the environment answers, then the review.
ask_settings_tui() {
  tz=${DISPATCH_TZ:-$1} max_bots=${DISPATCH_MAX_BOTS:-$2} tailscale_too=${DISPATCH_TAILSCALE:-0}
  valid_tz "$tz" || die "$tz is not a time zone. Use a name like Europe/London or America/New_York."
  [[ "$max_bots" =~ ^[1-9][0-9]?$ ]] || die "The number of bots has to be a number from 1 to 99."
  while :; do
    [ -n "${DISPATCH_TZ:-}" ] || pick_tz
    [ -n "${DISPATCH_MAX_BOTS:-}" ] || pick_bots
    [ -n "${DISPATCH_TAILSCALE:-}" ] || pick_tailscale
    review && break
    # Change: every question again, the environment's answers too.
    DISPATCH_TZ='' DISPATCH_MAX_BOTS='' DISPATCH_TAILSCALE=''
  done
}

write_settings() {
  install -d -m 0700 /etc/dispatch
  (
    umask 077
    cat >/etc/dispatch/env.new <<EOF
# Dispatch's settings, read by its systemd service. After changing one: systemctl restart dispatch
# .env.example in Dispatch's source lists the others.
MAX_BOTS=$max_bots
TZ=$tz
# Every address, so Dispatch is on the local network. 127.0.0.1 keeps it to this machine (and to
# Tailscale Serve, if that is set up).
HOST=0.0.0.0
# HTTPS with Dispatch's own certificate, on the same port, for voice calls: browsers allow the
# microphone only over HTTPS.
HTTPS=1
EOF
  )
  mv /etc/dispatch/env.new /etc/dispatch/env
}

# Where this install comes from, which the app checks for updates (server/src/updates.ts): the
# repository, and the branch it follows if it follows one. Written on every run, so updates follow
# what was installed last. The version a machine runs is the running release's VERSION file
# (fetch_release), so a release that fails and is rolled back never counts as installed.
write_source() {
  install -d -m 0700 /etc/dispatch
  {
    echo '# Where scripts/install.sh installed Dispatch from. The app checks it for updates: the newest'
    echo '# signed release, or with DISPATCH_REF the newest commit of that branch.'
    printf 'DISPATCH_REPO=%s\nDISPATCH_REF=%s\n' "$repo" "$ref"
  } >/etc/dispatch/source.new
  mv /etc/dispatch/source.new /etc/dispatch/source
}

# The release this machine runs, from its VERSION file, or nothing (none yet, or a branch's commit).
installed_version() {
  sed -nE '1s/^(v[0-9]+\.[0-9]+\.[0-9]+)$/\1/p' /srv/dispatch/current/VERSION 2>/dev/null || true
}

# ---------------------------------------------------------------- Tailscale

tailscale_up() { tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; }

# At full screen its output goes to the log, and the screen shows the link Tailscale waits on.
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
  info "$G$OK$R Dispatch will also be at $(tailscale_url)"
}
