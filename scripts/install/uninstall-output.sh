# ---------------------------------------------------------------- output

done_() { printf '   %s%s%s %s\n' "$G" "$OK" "$R" "$*"; }
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
