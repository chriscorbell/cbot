# ---------------------------------------------------------------- the release

# The keys that sign Dispatch's releases, in ssh-keygen's allowed signers format. The installer installs
# a release only when one of them signed both its tag (as git) and the checksums of what GitHub
# Actions built from it (as dispatch-release, so neither signature can stand in for the other). An
# update runs the installer of the release it updates from, so a release can change this list only if
# a key already on it signed that release. scripts/publish.sh signs with one of them.
release_signers() {
  cat <<'EOF'
dispatch namespaces="git,dispatch-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBMSc9gHrkDHjyiDVKCPOIm1aJlbAGswe01RpgEsWdFV
EOF
}

# git for GitHub: GITHUB_TOKEN reads a private fork, from the environment rather than the command
# line, where other users could see it, and git never stops to ask for a password.
github_git() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraHeader \
      GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)" git "$@"
  else
    GIT_TERMINAL_PROMPT=0 git "$@"
  fi
}

# git fetches a release and ssh-keygen checks its signature. Most servers have both.
release_tools() {
  local missing=()
  command -v git >/dev/null || missing+=(git)
  command -v ssh-keygen >/dev/null || missing+=(openssh-client)
  [ ${#missing[@]} -gt 0 ] || return 0
  info "Installing ${missing[*]}"
  { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}"; } >>"$LOG" 2>&1 ||
    die "${missing[*]} didn't install. The log is $LOG."
}

# newest_release <repository url>: the highest vX.Y.Z tag there, or nothing when it has none. Other
# tags, such as v2.0.0-rc1, aren't releases.
newest_release() {
  local refs
  refs="$(github_git ls-remote --tags --refs "$1")" || return 1
  sed -nE 's#^[0-9a-f]{40}\trefs/tags/(v[0-9]+\.[0-9]+\.[0-9]+)$#\1#p' <<<"$refs" | sort -V | tail -n 1
}

# older <a> <b>: whether version a comes before version b.
older() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]; }

# fetch_signed <repository url> <tag> <folder>: fetches the tag and its commit into a repository in the
# folder, and sets sha to the commit once one of release_signers' keys is found to have signed the
# tag. git checks every object it fetches against its hash, so the files are the ones the signature
# covers. The signature is checked as git verify-tag checks one, with ssh-keygen (OpenSSH 8.2 and
# later), over the tag's text before the signature. That text names the commit and the tag itself, so
# the signed tag of one release can't be passed off as another.
fetch_signed() {
  local url=$1 tag=$2 dir=$3 git=$3/repo.git
  git init -q --bare "$git" || die "Couldn't make a folder to download $tag into."
  github_git -C "$git" fetch -q --depth 1 --no-tags "$url" "refs/tags/$tag:refs/tags/$tag" ||
    die "The download of $tag from $url failed."
  [ "$(git -C "$git" cat-file -t "refs/tags/$tag")" = tag ] ||
    die "$tag in $url isn't signed (it's a plain tag), so the installer won't install it."
  git -C "$git" cat-file tag "refs/tags/$tag" >"$dir/tag"
  sed '/^-----BEGIN SSH SIGNATURE-----$/,$d' "$dir/tag" >"$dir/signed"
  sed -n '/^-----BEGIN SSH SIGNATURE-----$/,$p' "$dir/tag" >"$dir/signature"
  release_signers >"$dir/signers"
  if [ ! -s "$dir/signature" ] ||
    ! ssh-keygen -Y verify -f "$dir/signers" -I dispatch -n git -s "$dir/signature" <"$dir/signed" >/dev/null 2>&1; then
    die "$tag in $url isn't signed with a Dispatch release key, so the installer won't install it."
  fi
  # The header of what was signed: object <commit>, type commit, tag <name>, then the tagger.
  local object type name
  object="$(awk '$0 == "" { exit } $1 == "object" { print $2 }' "$dir/signed")"
  type="$(awk '$0 == "" { exit } $1 == "type" { print $2 }' "$dir/signed")"
  name="$(awk '$0 == "" { exit } $1 == "tag" { print $2 }' "$dir/signed")"
  [ "$name" = "$tag" ] || die "The tag $tag in $url is the signed tag of ${name:-another release}, so the installer won't install it."
  [ "$type" = commit ] && [[ "$object" =~ ^[0-9a-f]{40}$ ]] || die "$tag in $url doesn't name a commit."
  sha=$object
}

# fetch_assets <url> <tag> <commit> <folder>: downloads what GitHub Actions built for the release from
# <url> (its GitHub release): the tarball, its manifest.json and SHA256SUMS, which lists both. They
# are accepted only when one of release_signers' keys signed SHA256SUMS (SHA256SUMS.sig, as
# dispatch-release), both files match it, and the manifest names this tag and the commit that the
# signed tag names (fetch_signed). Leaves the tarball as <folder>/dispatch.tar.gz.
fetch_assets() {
  local url=$1 tag=$2 commit=$3 dir=$4 name="dispatch-$2-linux-amd64.tar.gz" f version built
  for f in SHA256SUMS SHA256SUMS.sig manifest.json "$name"; do
    curl -fsSL "$url/$f" -o "$dir/$f" || die "The download of $f for $tag from $url failed."
  done
  release_signers >"$dir/signers"
  ssh-keygen -Y verify -f "$dir/signers" -I dispatch -n dispatch-release -s "$dir/SHA256SUMS.sig" <"$dir/SHA256SUMS" >/dev/null 2>&1 ||
    die "The checksums of $tag aren't signed with a Dispatch release key, so the installer won't install it."
  # Both lines must be there: sha256sum would pass a list without them with --ignore-missing.
  awk -v n="$name" '$2 == n || $2 == "manifest.json"' "$dir/SHA256SUMS" >"$dir/wanted"
  [ "$(wc -l <"$dir/wanted")" -eq 2 ] || die "The checksums of $tag don't list its tarball and manifest."
  (cd "$dir" && sha256sum -c --quiet --strict wanted >/dev/null 2>&1) ||
    die "The download of $tag doesn't match its signed checksums, so the installer won't install it."
  # The manifest is written one key a line (.github/workflows/release.yml), and its checksum is signed.
  version="$(sed -nE 's/^ *"version": *"([^"]*)",?$/\1/p' "$dir/manifest.json")"
  built="$(sed -nE 's/^ *"commit": *"([0-9a-f]{40})",?$/\1/p' "$dir/manifest.json")"
  [ "$version" = "$tag" ] && [ "$built" = "$commit" ] ||
    die "The build attached to $tag is of ${version:-another release} at ${built:-another commit}, not of $tag at $commit, so the installer won't install it."
  mv "$dir/$name" "$dir/dispatch.tar.gz"
}

# Sets commit and script (the release.sh to run), or up_to_date when that commit already runs. With no
# DISPATCH_REF, the newest release (and tag, its version), checked as fetch_signed says, even when
# its commit runs already, so an unsigned tag can't be written down as the version this machine runs;
# what is unpacked is its built tarball, checked as fetch_assets says. DISPATCH_RELEASES_URL sets
# where the releases' files are (scripts/test_install.py). With DISPATCH_REF, the source of the newest
# commit of that branch, tag or commit, which only GitHub vouches for, and which release.sh builds.
fetch_release() {
  local api="https://api.github.com/repos/$repo" url="https://github.com/$repo.git" auth=() sha what had
  local releases=/srv/dispatch/releases
  [ -z "${GITHUB_TOKEN:-}" ] || auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  if [ -z "$ref" ]; then
    release_tools
    tag="$(newest_release "$url")" || die "Couldn't reach $url."
    [ -n "$tag" ] || die "$url has no release yet."
    had="$(installed_version)"
    if [ -n "$had" ] && older "$tag" "$had"; then
      die "The newest release in $url is $tag, older than $had, which this machine runs. The installer doesn't go back a version."
    fi
    fetch_dir="$(mktemp -d)"
    fetch_signed "$url" "$tag" "$fetch_dir"
    what="$tag (signed)"
  else
    sha="$(curl -fsSL "${auth[@]}" -H 'Accept: application/vnd.github.sha' "$api/commits/$ref")" ||
      die "Couldn't find $ref in github.com/$repo."
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "GitHub didn't name a commit for $ref."
    what=$ref
  fi
  # Twelve characters, as scripts/deploy.sh names releases, so both reuse the same ones.
  commit="${sha:0:12}"
  up_to_date=false
  if [ "$(readlink /srv/dispatch/current 2>/dev/null)" = "releases/$commit" ] && systemctl is-active --quiet dispatch; then
    up_to_date=true
    info "$what is $commit, which is running already"
  elif [ -d "$releases/$commit" ]; then
    info "$what is $commit, built before"
    script="$releases/$commit/scripts/release.sh"
  else
    rm -rf "$releases/$commit.new"
    mkdir -p "$releases/$commit.new"
    if [ -n "$fetch_dir" ]; then
      fetch_assets "${DISPATCH_RELEASES_URL:-https://github.com/$repo/releases/download}/$tag" "$tag" "$sha" "$fetch_dir"
      tar -xzf "$fetch_dir/dispatch.tar.gz" -C "$releases/$commit.new" && [ -x "$releases/$commit.new/node/bin/node" ] ||
        die "Unpacking $tag failed."
    else
      curl -fsSL "${auth[@]}" "$api/tarball/$sha" | tar -xz -C "$releases/$commit.new" --strip-components=1 ||
        die "The download of $commit failed."
    fi
    info "$what is $commit"
    script="$releases/$commit.new/scripts/release.sh"
  fi
  # A signed release says which version it is, for the app and installed_version. Only a checked tag
  # is written down; a branch's commit has no version.
  if [ -n "$tag" ]; then
    local dir="$releases/$commit"
    [ -d "$dir" ] || dir="$releases/$commit.new"
    echo "$tag" >"$dir/VERSION"
  fi
  [ -z "$fetch_dir" ] || { rm -rf "$fetch_dir"; fetch_dir=''; }
}

# progress <offset>: release.sh's steps as they reach the log after <offset>, line by line (the full
# screen has tui_progress). At a terminal the current one has a spinner and its time, and TERM marks
# it done, USR1 failed; otherwise each step is a line as it starts. Until release.sh names its first
# step, the spinner says Starting.
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
        line=${line#*|}
        shown=$((shown + 1))
        [ -n "$line" ] || continue
        if $started; then ended "$G$OK$R"; fi
        current="$line" since=$SECONDS started=true
        if ! $fancy; then info "$current"; fi
      done
    fi
    if $fancy; then
      # Cut to the terminal's width: a line that wraps can't be redrawn in place.
      tui_size || cols=80
      printf '\r\e[K   %s %s %s%s%s' "${SPIN[tick % ${#SPIN[@]}]}" "${current:0:cols-12}" "$D" "$(clock $((SECONDS - since)))" "$R"
    fi
    tick=$((tick + 1))
    sleep 0.25
  done
}

# What this script's steps (mark), release.sh and provision.sh say, as key|words for someone
# installing; empty skips the line. The key places a step among those the full screen expects
# (work_begin), whose words come from here too.
describe() {
  case "$1" in
    tailscale) echo 'tailscale|Setting up Tailscale' ;;
    download) echo 'download|Downloading Dispatch' ;;
    'provisioning the host' | provision) echo 'provision|Setting up the machine' ;;
    packages) echo 'packages|Installing Chrome, Node, Docker and the desktop packages' ;;
    'Hermes Agent '*) echo "hermes|Installing $1" ;;
    hermes) echo 'hermes|Installing Hermes Agent' ;;
    done | 'Dispatch runs '*) ;;
    'pulling the speech service') echo 'speech|Downloading the speech service' ;;
    'building dispatch-speech'*) echo 'speech|Building the speech service (about ten minutes)' ;;
    # A release's speech image is downloaded; a branch's is built.
    speech) if [ -z "$ref" ]; then echo 'speech|Downloading the speech service'; else echo 'speech|Building the speech service (about ten minutes)'; fi ;;
    'building '* | build) echo 'build|Building Dispatch' ;;
    'starting '* | start) echo 'start|Starting Dispatch' ;;
    *) echo "other|$1" ;;
  esac
}

# release.sh's output goes to the log, and the full screen or progress shows its steps.
run_release() {
  if ! $tui; then
    if $installed; then step "Updating"; else step "Installing"; fi
    $installed || note "The first install takes 15 to 30 minutes, and can be left to finish."
    note "The full log is $LOG"
    local offset
    offset="$(stat -c %s "$LOG")"
    progress "$offset" &
    watcher=$!
  fi
  if bash "$script" >>"$LOG" 2>&1 </dev/null; then
    $tui || stop_watcher TERM
  else
    stop_watcher USR1
    tui_end
    printf '\n%sThe last lines of %s:%s\n' "$D" "$LOG" "$R" >&2
    tail -n 30 "$LOG" | sed 's/^/   /' >&2
    die "Dispatch didn't install. Fix what the log says and run the installer again; it picks up where it stopped."
  fi
}
