# ---------------------------------------------------------------- output

step() { steps=$((steps + 1)); printf '\n%s%s. %s%s\n' "$B" "$steps" "$1" "$R"; }
note() { printf '   %s%s%s\n' "$D" "$*" "$R"; }

# The message goes to the terminal even while a step's output goes to the log (quietly), after the
# full screen has given the terminal back.
die() {
  local fd=2
  if $tty3; then fd=3; fi
  stop_watcher USR1
  tui_end
  printf '\n%s%s%s %s\n' "$E" "$NO" "$R" "$*" >&"$fd"
  reported=true
  exit 1
}

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

# At full screen, what a step prints goes to the log, and the screen shows the step.
quietly() { if $tui; then "$@" >>"$LOG" 2>&1; else "$@"; fi; }

# mark <key> <words>: one of the installer's own steps. A numbered heading, or at full screen a line
# in the log, where the screen finds it as it finds release.sh's (describe).
mark() { if $tui; then echo "[install] $1" >>"$LOG"; else step "$2"; fi; }

# The full screen or the spinner stops and the terminal is put back, whatever ends the installer.
on_exit() {
  local status=$? fd=2
  if $tty3; then fd=3; fi
  stop_watcher USR1
  tui_end
  if [ "$status" -ne 0 ] && ! $reported; then
    printf '\n%s%s%s Stopped. Run the installer again to pick up where it stopped.%s\n' "$E" "$NO" "$R" "${LOG:+ The log is $LOG.}" >&"$fd"
  fi
  [ -z "$gum_dir" ] || rm -rf "$gum_dir"
  [ -z "$fetch_dir" ] || rm -rf "$fetch_dir"
}
