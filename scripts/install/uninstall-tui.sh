# ---------------------------------------------------------------- the full screen

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
