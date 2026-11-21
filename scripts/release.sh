#!/usr/bin/env bash
# The host side of scripts/deploy.sh and scripts/install.sh, run as root from a release under
# /srv/dispatch/releases: either <commit>.new, freshly unpacked, or <commit>, built by an earlier deploy
# (a rollback). It
#
#   1. runs scripts/provision.sh when that script or the service unit changed since its last run,
#   2. builds a fresh release and renames it to <commit>,
#   3. builds the speech image when speech/ changed, and starts it (and stops anything the compose
#      file no longer lists, such as the ZONOS3 container),
#   4. points /srv/dispatch/current at the release and restarts Dispatch, whose bots keep running,
#   5. keeps the running release, the one before it and four more, and each image in use and one more.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }

rel="$(cd "$(dirname "$0")/.." && pwd)"
commit="$(basename "$rel" .new)"
releases=/srv/dispatch/releases
final="$releases/$commit"
say() { echo "[release] $*"; }
export NPM_CONFIG_UPDATE_NOTIFIER=false

want="$(cat "$rel/scripts/provision.sh" "$rel/deploy/dispatch.service" | sha256sum | cut -c1-16)"
if [ "$(cat /etc/dispatch/provisioned 2>/dev/null)" != "$want" ]; then
  say "provisioning the host"
  bash "$rel/scripts/provision.sh"
  echo "$want" > /etc/dispatch/provisioned
fi

if [ "$rel" != "$final" ]; then
  say "building $commit"
  cd "$rel"
  npm ci --no-audit --no-fund --loglevel=error
  npm run build --silent >/dev/null
  npm prune --omit=dev --no-audit --no-fund --loglevel=error
  cd /
  rm -rf "$final"
  mv "$rel" "$final"
  rel="$final"
fi

image_for() { echo "dispatch-$1:$(cd "$rel" && find "$1" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12)"; }
speech="$(image_for speech)"
if ! docker image inspect "$speech" >/dev/null 2>&1; then
  say "building $speech (the first build takes about ten minutes)"
  docker build -q -t "$speech" "$rel/speech" >/dev/null
fi
SPEECH_IMAGE="$speech" docker compose -f "$rel/deploy/speech.compose.yaml" up -d --quiet-pull --remove-orphans 2>&1 | grep -v '^ *Container .* Running$' || true

say "starting $commit"
before="$(readlink /srv/dispatch/current 2>/dev/null || true)"
ln -sfn "releases/$commit" /srv/dispatch/current.new
mv -T /srv/dispatch/current.new /srv/dispatch/current
systemctl restart dispatch
up=false
for _ in $(seq 60); do
  if curl -fs -o /dev/null --max-time 2 http://127.0.0.1:8787/api/health; then up=true; break; fi
  sleep 1
done
if ! $up; then
  journalctl -u dispatch -n 40 --no-pager >&2
  echo "Dispatch did not answer within a minute on $commit.${before:+ The release before was ${before#releases/}.}" >&2
  exit 1
fi

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
# The speech image in use and the newest one besides it stay (docker lists the newest first). ZONOS3's
# images are left for turning it back on.
spare=
for image in $(docker image ls "${speech%%:*}" --format '{{.Repository}}:{{.Tag}}'); do
  [ "$image" = "$speech" ] && continue
  if [ -z "$spare" ]; then spare="$image"; continue; fi
  docker image rm -f "$image" >/dev/null
done
say "Dispatch runs $commit"
