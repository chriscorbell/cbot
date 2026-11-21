#!/usr/bin/env bash
# The host side of scripts/deploy.sh and scripts/install.sh, run as root from a release under
# /srv/dispatch/releases: either <commit>.new, freshly unpacked, or <commit>, from an earlier install
# or deploy (a rollback). A release is built already when it came from a release's tarball (it has
# node/), or a source tree: what deploy.sh sends, and what an install with DISPATCH_REF downloads. It
#
#   1. runs scripts/provision.sh when that script or the service unit changed since its last run,
#   2. builds a source tree with scripts/build-release.sh, and renames the release to <commit>,
#   3. starts the speech image the release names: the one its manifest.json names, pulled by digest,
#      or else one built here from its speech/, named for what is in it. The image goes in the
#      release's SPEECH_IMAGE, for a rollback to start it again. Compose stops anything its file no
#      longer lists,
#   4. points /srv/dispatch/current at the release and restarts Dispatch, whose bots keep running.
#      When it doesn't answer within a minute, it goes back to the release before it and that
#      release's speech image, writes /etc/dispatch/last-update for the app to say so, and fails.
#      Provisioning stays: it only adds to the machine, and the release before runs on it too,
#   5. keeps the running release, the one before it and four more, and each image in use and one more.
#
# DISPATCH_ROOT puts /srv/dispatch and /etc/dispatch under another folder, for scripts/test_release.py.
set -euo pipefail
root="${DISPATCH_ROOT:-}"
[ -n "$root" ] || [ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }

rel="$(cd "$(dirname "$0")/.." && pwd)"
commit="$(basename "$rel" .new)"
srv="$root/srv/dispatch"
etc="$root/etc/dispatch"
releases="$srv/releases"
final="$releases/$commit"
say() { echo "[release] $*"; }
export NPM_CONFIG_UPDATE_NOTIFIER=false

want="$(cat "$rel/scripts/provision.sh" "$rel/deploy/dispatch.service" | sha256sum | cut -c1-16)"
if [ "$(cat "$etc/provisioned" 2>/dev/null)" != "$want" ]; then
  say "provisioning the host"
  bash "$rel/scripts/provision.sh"
  echo "$want" > "$etc/provisioned"
fi
# The units each bot's screen and agent run as, from this release.
[ -n "$root" ] || bash "$rel/scripts/install-units.sh"   # not with DISPATCH_ROOT: the tests have no systemd

if [ "$rel" != "$final" ]; then
  rm -rf "$final" "$final.build"
  if [ -x "$rel/node/bin/node" ]; then
    mv "$rel" "$final"
  else
    say "building $commit"
    bash "$rel/scripts/build-release.sh" --commit "$commit" "$final.build"
    mv "$final.build" "$final"
    cd /
    rm -rf "$rel"
  fi
  rel="$final"
fi

# speech_up <release> <image>
speech_up() {
  SPEECH_IMAGE="$2" docker compose --env-file "$1/deploy/speech.env" -f "$1/deploy/speech.compose.yaml" up -d --quiet-pull --remove-orphans 2>&1 | grep -v '^ *Container .* Running$' || true
}
# start <link>: point current at releases/<commit> and restart Dispatch on it. Fails when it doesn't
# answer within a minute.
start() {
  ln -sfn "$1" "$srv/current.new"
  mv -T "$srv/current.new" "$srv/current"
  systemctl restart dispatch
  for _ in $(seq 60); do
    if curl -fs -o /dev/null --max-time 2 http://127.0.0.1:8787/api/health; then return 0; fi
    sleep 1
  done
  return 1
}

if [ -s "$rel/SPEECH_IMAGE" ]; then
  speech="$(cat "$rel/SPEECH_IMAGE")"
elif [ -s "$rel/manifest.json" ]; then
  # Pulled by digest: the image is exactly the one the signed checksums of this release name.
  speech="$(jq -r '.speechImage // empty' "$rel/manifest.json")"
  [[ "$speech" =~ ^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]] || { echo "$rel/manifest.json names no speech image." >&2; exit 1; }
  if ! docker image inspect "$speech" >/dev/null 2>&1; then
    say "pulling the speech service"
    docker pull -q "$speech" >/dev/null
  fi
else
  [ -d "$rel/speech" ] || { echo "$rel has neither a manifest.json nor speech/, so it has no speech image." >&2; exit 1; }
  speech="dispatch-speech:$(cd "$rel" && find speech -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12)"
  if ! docker image inspect "$speech" >/dev/null 2>&1; then
    say "building $speech (the first build takes about ten minutes)"
    docker build -q -t "$speech" "$rel/speech" >/dev/null
  fi
fi
echo "$speech" >"$rel/SPEECH_IMAGE"
before="$(readlink "$srv/current" 2>/dev/null || true)"
speech_up "$rel" "$speech"

say "starting $commit"
if ! start "releases/$commit"; then
  journalctl -u dispatch -n 40 --no-pager >&2 || true
  if [ -z "$before" ] || [ "$before" = "releases/$commit" ]; then
    echo "Dispatch did not answer within a minute on $commit." >&2
    exit 1
  fi
  old="${before#releases/}"
  say "going back to $old"
  speech_up "$srv/$before" "$(cat "$srv/$before/SPEECH_IMAGE")"
  # The app reads this when it starts (server/src/updates.ts), so it is there before the old release is.
  version="$(cat "$final/VERSION" 2>/dev/null || true)"
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || version=''
  printf '{"result":"rolled-back","from":"%s","to":"%s","version":"%s","at":"%s"}\n' "$old" "$commit" "$version" "$(date -u +%FT%TZ)" >"$etc/last-update"
  if start "$before"; then
    echo "Dispatch did not answer within a minute on $commit, so it went back to $old." >&2
  else
    journalctl -u dispatch -n 40 --no-pager >&2 || true
    echo "Dispatch did not answer within a minute on $commit, and not on $old either after going back to it." >&2
  fi
  exit 1
fi
rm -f "$etc/last-update"

# Housekeeping: the running release, the one before it and the four newest others stay; failed
# unpacks (<commit>.new) go.
keep="$commit ${before#releases/}"
n=0
# Newest first, which a glob can't sort by; release names are commits and never hold spaces.
# shellcheck disable=SC2045
for r in $(ls -1t "$releases"); do
  case "$r" in *.new) rm -rf "${releases:?}/$r"; continue ;; esac
  case " $keep " in *" $r "*) continue ;; esac
  n=$((n + 1))
  [ "$n" -le 4 ] || rm -rf "${releases:?}/$r"
done
# The speech images the kept releases name stay, so any of them can run again; other speech images
# go, both those built here (dispatch-speech:<hash>) and those pulled by digest.
in_use="$(cat "$releases"/*/SPEECH_IMAGE 2>/dev/null | sort -u)"
for repository in dispatch-speech $(sed -n 's/@sha256:.*//p' <<<"$in_use" | sort -u); do
  for image in $(docker image ls "$repository" --format '{{.Repository}}:{{.Tag}} {{.Repository}}@{{.Digest}}'); do
    case "$image" in *:'<none>' | *@'<none>') continue ;; esac
    grep -qxF "$image" <<<"$in_use" || docker image rm -f "$image" >/dev/null 2>&1 || true
  done
done
say "Dispatch runs $commit"
