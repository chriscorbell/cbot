# ---------------------------------------------------------------- shared by install.sh and uninstall.sh

# Colors and glyphs, plain on a terminal without colors or a locale without UTF-8. Each script keeps
# its own state, set in its main.
ui_init() {
  if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
    B=$'\e[1m' D=$'\e[2m' R=$'\e[0m' G=$'\e[32m' Y=$'\e[33m' E=$'\e[31m' A=$'\e[38;5;69m' fancy=true
  else
    B='' D='' R='' G='' Y='' E='' A='' fancy=false
  fi
  # shellcheck disable=SC2034 # the uninstaller draws no bars or dots
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8* | *utf8* | *UTF8* | *utf-8*) OK='✓' NO='✗' NOW='●' LATER='○' LINE='─' BAR='│' DOT='·' SPIN=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏) ;;
    *) OK='+' NO='x' NOW='*' LATER='o' LINE='-' BAR='|' DOT='-' SPIN=('|' '/' '-' "\\") ;;
  esac
}

# The account the bots run as, as /etc/dispatch/env (or the file named) has it: its last DISPATCH_USER
# line, the value maybe quoted. Nothing when it names none. scripts/install-units.sh reads it the same way.
env_account() {
  [ -r "${1:-/etc/dispatch/env}" ] || return 0
  sed -nE "s/^[[:space:]]*DISPATCH_USER=[\"']?([^\"']*)[\"']?[[:space:]]*\$/\\1/p" "${1:-/etc/dispatch/env}" | tail -n 1
}

info() { printf '   %s\n' "$*"; }
warn() { printf '   %s!%s %s\n' "$Y" "$R" "$*"; }

tui_size() {
  local size
  size="$(stty size </dev/tty 2>/dev/null)" || return 1
  rows=${size% *} cols=${size#* }
}

# The top of every screen, into $head (six rows): Dispatch, what it's doing and where, and the stages.
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

# become_root <variable>...: both scripts change the whole machine, so they run as root. Run as
# someone else, the script starts again under sudo. Piped from curl, it is gone from stdin by now, so
# it writes itself to a private file from `declare -f` (the same code, not a second download), with
# the named variables from the environment, which stay out of the process list that way, and the
# locale, which decides whether the screen draws with Unicode. sudo gets the terminal as stdin: given
# curl's pipe, Ubuntu's sudo-rs stops the questions' reads from the terminal.
become_root() {
  command -v sudo >/dev/null || die "Run this as root."
  local self v status=0
  self="$(mktemp)"
  {
    for v in "$@" LANG LC_ALL LC_CTYPE; do
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
