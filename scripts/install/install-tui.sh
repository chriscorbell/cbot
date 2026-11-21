# ---------------------------------------------------------------- the full screen

# gum, for the questions: a pinned release, checked against its checksum, in a temporary folder that
# on_exit removes.
gum_fetch() {
  local version=0.17.0 sum=69ee169bd6387331928864e94d47ed01ef649fbfe875baed1bbf27b5377a6fdb
  local name="gum_${version}_Linux_x86_64"
  gum_dir="$(mktemp -d)"
  curl -fsL --max-time 60 -o "$gum_dir/gum.tar.gz" "https://github.com/charmbracelet/gum/releases/download/v$version/$name.tar.gz" &&
    echo "$sum  $gum_dir/gum.tar.gz" | sha256sum -c --status - &&
    tar -xzf "$gum_dir/gum.tar.gz" -C "$gum_dir" --strip-components=1 "$name/gum" &&
    [ -x "$gum_dir/gum" ]
}

# Full screen when someone is at a terminal big enough and gum downloads; otherwise line by line.
# Drawing goes to fd 3, the terminal, so it stays on screen while steps write to the log.
tui_start() {
  { $interactive && $fancy && tui_size && [ "$rows" -ge 20 ] && [ "$cols" -ge 64 ]; } || return 0
  if ! gum_fetch 2>/dev/null; then
    note "The full-screen installer didn't download, so this one asks line by line."
    return 0
  fi
  GUM="$gum_dir/gum"
  gum_filter=(--indicator '›' --indicator.foreground 69 --match.foreground 69 --prompt '› ' --prompt.foreground 69 --placeholder.foreground 244 --header '' --padding '0 2')
  gum_choose=(--cursor '› ' --cursor.foreground 69 --selected.foreground 69 --header '' --padding '0 2')
  gum_confirm=(--prompt.foreground '' --selected.foreground 255 --selected.background 69 --unselected.foreground 244 --unselected.background '' --padding '0 1')
  exec 3>/dev/tty
  tty3=true tui=true
  printf '\e[?1049h\e[?25l' >&3
  stty -echo </dev/tty 2>/dev/null || true
}

tui_end() {
  $tui || return 0
  tui=false
  printf '\e[?25h\e[?1049l' >&3
  stty echo </dev/tty 2>/dev/null || true
  if [ -s "$gum_dir/steps" ]; then
    { echo; cat "$gum_dir/steps"; } >&3
    rm -f "$gum_dir/steps"
  fi
}

# tui_screen <title> [<line>...]: a fresh screen for a question: its title, then lines about it,
# wrapped to the screen. "" is a blank line, and one starting with ! a warning. Sets avail, the rows
# left below for gum.
tui_screen() {
  local title=$1 line l text='' w n=0 warning first
  shift
  tui_size || true
  tui_head
  w=$((cols - 8))
  [ "$w" -le 76 ] || w=76
  for line in "$@"; do
    if [ -z "$line" ]; then text+=$'\e[K\n' n=$((n + 1)); continue; fi
    warning=false first=true
    if [ "${line:0:1}" = '!' ]; then warning=true line=${line:1}; fi
    while IFS= read -r l; do
      if $warning && $first; then text+="  $Y!$R $l"; elif $warning; then text+="    $l"; else text+="  $l"; fi
      text+=$'\e[K\n' first=false n=$((n + 1))
    done < <(printf '%s\n' "$line" | fold -s -w "$w")
  done
  printf '\e[?25l\e[H\e[2J%s  %s%s%s\e[K\n%s\e[K\n' "$head" "$B" "$title" "$R" "$text" >&3
  avail=$((rows - 6 - 1 - n - 1 - 1))
}

# Someone left at a question (Ctrl+C, or Esc twice): nothing is installed yet.
quit() {
  tui_end
  printf '\nStopped. Nothing was installed.\n' >&3
  reported=true
  exit 130
}

# gum_ask <question> <yes> <no> <default true|false>: 0 for yes, 1 for no; anything else quits.
gum_ask() {
  local status=0
  "$GUM" confirm "$1" --affirmative "$2" --negative "$3" --default="$4" "${gum_confirm[@]}" </dev/tty 2>&3 || status=$?
  [ "$status" -le 1 ] || quit
  return "$status"
}

# One line for each time zone, to pick from: the name with spaces for underscores (so typing "new
# york" finds it), the time there now and its offset from UTC. The given zone comes first.
zone_line() {
  local now off abbr h m sign
  TZ=$1 printf -v now '%(%-I:%M %p)T' -1
  TZ=$1 printf -v off '%(%z)T' -1
  TZ=$1 printf -v abbr '%(%Z)T' -1
  sign=${off:0:1} h=$((10#${off:1:2})) m=${off:3:2}
  if [ "$h$m" = 000 ]; then off=UTC; else off="UTC$sign$h"; [ "$m" = 00 ] || off+=":$m"; fi
  case "$abbr" in "$off" | *[!A-Za-z]*) abbr='' ;; esac
  printf '%-33s %8s   %s\n' "${1//_/ }" "$now" "${abbr:+$abbr $DOT }$off"
}

zone_lines() {
  local z
  zone_line "$1"
  for z in $(timedatectl list-timezones 2>/dev/null); do
    case "$z" in "$1" | Etc/*) ;; *) zone_line "$z" ;; esac
  done
}

pick_tz() {
  local line
  tui_screen "Time zone" "The bots' clocks, routines and check-ins run on it. Type a city or region to find yours."
  line="$(zone_lines "$tz" | "$GUM" filter --height "$avail" --placeholder 'Chicago, Berlin, Tokyo…' "${gum_filter[@]}" 2>&3)" || quit
  line=${line%%  *}
  tz=${line// /_}
}

pick_bots() {
  local most i label current='' pick opts=()
  # About 1 GB each, after 2 GB for voice; at least the four the app defaults to, and at most twelve.
  most=$((ram_gb - 2))
  [ "$most" -le 12 ] || most=12
  [ "$most" -ge 4 ] || most=4
  for ((i = 1; i <= most; i++)); do
    printf -v label '%-9s about %d GB of memory' "$i bot$([ "$i" -eq 1 ] || echo s)" $((i + 2))
    opts+=("$label")
    [ "$i" -ne "$max_bots" ] || current=$label
  done
  tui_screen "How many bots at most" "Each bot has a desktop, Chrome and an agent of its own, and takes about 1 GB of memory. Voice calls take 2 GB more. This machine has $ram_gb GB."
  pick="$("$GUM" choose "${opts[@]}" --selected "$current" --height "$((avail - 1))" "${gum_choose[@]}" </dev/tty 2>&3)" || quit
  max_bots=${pick%% *}
}

pick_tailscale() {
  tui_screen "Tailscale" \
    "Dispatch serves HTTPS with a certificate of its own, which browsers warn about once on each device." "" \
    "Tailscale adds an address with no warning that works from anywhere on your tailnet. It needs a free Tailscale account."
  if gum_ask "Set up Tailscale too?" "Set it up" "Skip" "$([ "$tailscale_too" = 1 ] && echo true || echo false)"; then
    tailscale_too=1
  else
    tailscale_too=0
  fi
}

# The answers on one screen before anything is installed. Change asks every question again.
review() {
  local now
  TZ=$tz printf -v now '%(%-I:%M %p)T' -1
  tui_screen "Ready to install" \
    "${D}Time zone$R   ${tz//_/ } ($now there now)" \
    "${D}Bots$R        up to $max_bots" \
    "${D}Tailscale$R   $([ "$tailscale_too" = 1 ] && echo yes || echo no)" "" \
    "This installs Chrome, Node.js, Docker, Hermes Agent and Dispatch's speech service, and runs Dispatch as a service. It takes 15 to 30 minutes, and can be left to finish."
  gum_ask "Install Dispatch now?" Install Change true
}

# tui_progress <offset> <note> <key>...: the install screen, from the log after <offset>, until TERM
# (it finished) or USR1 (it stopped). The keys are the steps expected, shown ahead and dimmed; other
# steps are added where they come, and expected ones that never come are dropped.
tui_progress() {
  local offset=$1 note=$2
  shift 2
  local keys=("$@") words=() states=() began=() took=() k d cur=-1 tick=0 shown=0 begun=$SECONDS size='' url='' marks=() tail=()
  for k in "${keys[@]}"; do
    d="$(describe "$k")"
    words+=("${d#*|}") states+=(later) began+=(0) took+=(0)
  done
  trap 'end_steps "done"; stage=${#stages[@]}; draw_progress; record_steps; exit 0' TERM
  trap 'end_steps failed; draw_progress; record_steps; exit 0' USR1
  while :; do
    [ $((tick % 6)) -ne 0 ] || read_progress
    draw_progress
    tick=$((tick + 1))
    sleep 0.15
  done
}

# The steps so far, the newest lines after the last one (a ring of 40 in awk), and a link Tailscale
# is waiting on. Called inside tui_progress, whose locals it fills.
read_progress() {
  local got=() line d
  mapfile -t got < <(tail -c "+$((offset + 1))" "$LOG" 2>/dev/null | awk -v n=40 '
    /^\[(install|provision|release)\] / { print "M" substr($0, index($0, "] ") + 2); c = 0; url = ""; next }
    {
      gsub(/\033\[[0-9;?]*[ -\/]*[@-~]/, ""); sub(/.*\r/, ""); gsub(/[[:cntrl:]]/, ""); sub(/^ +/, "")
      if (match($0, /https:\/\/login\.tailscale\.com\/[^ ]+/)) url = substr($0, RSTART, RLENGTH)
      if ($0 != "") buf[c++ % n] = $0
    }
    END { if (url != "") print "U" url; for (i = (c > n ? c - n : 0); i < c; i++) print "L" buf[i % n] }')
  marks=() tail=() url=''
  for line in "${got[@]}"; do
    case "$line" in M*) marks+=("${line:1}") ;; U*) url=${line:1} ;; L*) tail+=("${line:1}") ;; esac
  done
  while [ "$shown" -lt "${#marks[@]}" ]; do
    d="$(describe "${marks[shown]}")"
    shown=$((shown + 1))
    [ -z "$d" ] || begin_step "${d%%|*}" "${d#*|}"
  done
}

# begin_step <key> <words>: the current step is done, and this one runs: the next expected one with
# its key (any expected before it never came), or a new one after the current.
begin_step() {
  local key=$1 j=-1 i
  if [ "$cur" -ge 0 ]; then states[cur]='done' took[cur]=$((SECONDS - began[cur])); fi
  for ((i = cur + 1; i < ${#keys[@]}; i++)); do
    if [ "${keys[i]}" = "$key" ]; then j=$i; break; fi
  done
  if [ "$j" -ge 0 ]; then
    for ((i = cur + 1; i < j; i++)); do states[i]=skipped; done
  else
    j=$((cur + 1))
    keys=("${keys[@]:0:j}" "$key" "${keys[@]:j}") words=("${words[@]:0:j}" '' "${words[@]:j}")
    states=("${states[@]:0:j}" '' "${states[@]:j}") began=("${began[@]:0:j}" 0 "${began[@]:j}") took=("${took[@]:0:j}" 0 "${took[@]:j}")
  fi
  words[j]=$2 states[j]=running began[j]=$SECONDS cur=$j
}

# end_steps done|failed: the current step ends so; at done, expected steps that never came go.
end_steps() {
  local i
  if [ "$cur" -ge 0 ]; then states[cur]=$1 took[cur]=$((SECONDS - began[cur])); fi
  if [ "$1" = "done" ]; then
    for i in "${!states[@]}"; do [ "${states[i]}" != later ] || states[i]=skipped; done
  fi
}

# The steps as lines for the terminal's own screen, which tui_end prints there, so they outlast the
# full screen.
record_steps() {
  local i t icon
  for i in "${!keys[@]}"; do
    case "${states[i]}" in "done") icon="$G$OK$R" ;; failed) icon="$E$NO$R" ;; *) continue ;; esac
    t=${took[i]}
    printf '   %s %s %s%d:%02d%s\n' "$icon" "${words[i]}" "$D" $((t / 60)) $((t % 60)) "$R"
  done >"$gum_dir/steps"
}

draw_progress() {
  local s out i icon text time t w pad room n=0 total
  s="$(stty size </dev/tty 2>/dev/null)" || s="$rows $cols"
  rows=${s% *} cols=${s#* }
  out=$'\e[?25l\e[H'
  if [ "$s" != "$size" ]; then out+=$'\e[2J'; size=$s; fi
  tui_head
  out+=$head
  w=$((cols - 4))
  [ "$w" -le 80 ] || w=80
  if [ -n "$note" ] && [ "$stage" -lt "${#stages[@]}" ]; then out+="  $D${note:0:w}$R"$'\e[K\n\e[K\n' n=2; fi
  for i in "${!keys[@]}"; do
    case "${states[i]}" in
      done) icon="$G$OK$R" t=${took[i]} ;;
      failed) icon="$E$NO$R" t=${took[i]} ;;
      running) icon="$A${SPIN[tick % ${#SPIN[@]}]}$R" t=$((SECONDS - began[i])) ;;
      later) icon=' ' t=-1 ;;
      *) continue ;;
    esac
    time=''
    [ "$t" -lt 0 ] || printf -v time '%d:%02d' $((t / 60)) $((t % 60))
    text=${words[i]}
    [ "${#text}" -le $((w - 12)) ] || text="${text:0:w-13}…"
    pad=$((w - 4 - ${#text} - ${#time}))
    case "${states[i]}" in later) text="$D$text$R" ;; running) text="$B$text$R" ;; esac
    printf -v text '  %s %s%*s%s%s%s' "$icon" "$text" "$pad" '' "$D" "$time" "$R"
    out+="$text"$'\e[K\n'
    n=$((n + 1))
  done
  out+=$'\e[K\n'
  # What the running step is doing: the link Tailscale waits on, or the newest lines of the log.
  room=$((rows - 6 - n - 1 - 3))
  if [ "$cur" -ge 0 ] && [ "${states[cur]}" = running ]; then
    if [ "${keys[cur]}" = tailscale ] && [ -n "$url" ]; then
      out+="    Tailscale is waiting for you. Open this link:"$'\e[K\n'"    $A$url$R"$'\e[K\n'
    elif [ "$room" -gt 0 ]; then
      for ((i = ${#tail[@]} > room ? ${#tail[@]} - room : 0; i < ${#tail[@]}; i++)); do
        out+="    $D$BAR ${tail[i]:0:w-6}$R"$'\e[K\n'
      done
    fi
  fi
  out+=$'\e[J'
  # The foot: how long it has taken, and where the whole log is.
  total=$((SECONDS - begun))
  printf -v time '%d:%02d' $((total / 60)) $((total % 60))
  if [ "$stage" -ge "${#stages[@]}" ]; then time="Done in $time"; else time="$time so far"; fi
  pad=$((cols - 4 - ${#time} - ${#LOG} - 5))
  [ "$pad" -ge 2 ] || pad=2
  printf -v s '\e[%d;1H  %s%s%*sLog: %s%s\e[K' "$rows" "$D" "$time" "$pad" '' "$LOG" "$R"
  printf '%s%s' "$out" "$s" >&3
}

# The install screen starts with the steps a fresh install or an update has ahead of it.
work_begin() {
  $tui || return 0
  local keys=() note offset
  stage=$((${#stages[@]} - 2))
  if [ "${tailscale_too:-0}" = 1 ]; then keys+=(tailscale); fi
  # A release comes built; a branch (DISPATCH_REF) is built here.
  local build=()
  [ -z "$ref" ] || build=(build)
  if $installed; then
    keys+=(download "${build[@]}" start)
    note="Dispatch keeps running until the new version is ready."
  else
    keys+=(download provision packages hermes "${build[@]}" speech start)
    note="This takes 10 to 30 minutes, and can be left to finish."
  fi
  # Measured here, not in the background job, which could start after the first step is written.
  offset="$(stat -c %s "$LOG")"
  tui_progress "$offset" "$note" "${keys[@]}" &
  watcher=$!
}

# Every step done: a moment on the finished screen, then the terminal's own again.
work_end() {
  $tui || return 0
  stop_watcher TERM
  sleep 1
  tui_end
}

# stop_watcher TERM|USR1: the progress display, finished or failed.
stop_watcher() {
  [ -n "${watcher:-}" ] || return 0
  kill "-$1" "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  watcher=''
}
