#!/usr/bin/env bash
# Deploy Dispatch from this repo to its production host.
#
#   scripts/deploy.sh               # deploy the committed main branch
#   scripts/deploy.sh <commit>      # deploy that commit, or roll back to it
#
# The host (DISPATCH_HOST, an SSH host name, from the environment or .env.prod) gets `git archive` of the commit in
# /srv/dispatch/releases/<commit>.new, and scripts/release.sh there provisions the host when needed,
# builds the release, points /srv/dispatch/current at it and restarts the service. A release still on
# the host is reused as it is, so a rollback takes seconds. Uncommitted work never reaches
# production. The settings are .env.prod here; every deploy copies it to /etc/dispatch/env.
#
# A commit that is not on the host yet must pass `npm run check` first, run on that exact commit in
# a temporary worktree. DISPATCH_SKIP_CHECK=1 skips it (for an emergency only).
set -euo pipefail

repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$repo"
[ -f .env.prod ] || { echo "Missing $repo/.env.prod (copy .env.example and fill it in)." >&2; exit 1; }
host="${DISPATCH_HOST:-$(sed -n 's/^DISPATCH_HOST=//p' .env.prod | tail -n 1)}"
[ -n "$host" ] || { echo "Set DISPATCH_HOST in $repo/.env.prod to the production host's SSH name." >&2; exit 1; }
commit="$(git rev-parse --short=12 --verify "${1:-main}^{commit}")"
rel="/srv/dispatch/releases/$commit"
echo "Deploying $commit ($(git log -1 --format=%s "$commit")) to $host"

if [ "${DISPATCH_SKIP_CHECK:-}" != 1 ] && ! ssh "$host" "test -d $rel"; then
  tmp="$(mktemp -d)"
  trap 'git -C "$repo" worktree remove --force "$tmp" >/dev/null 2>&1 || rm -rf "$tmp"' EXIT
  git worktree add --detach --quiet "$tmp" "$commit"
  echo "Checking $commit"
  (cd "$tmp" && npm ci --no-audit --no-fund --loglevel=error && npm run check) || { echo "The checks failed; $commit was not deployed." >&2; exit 1; }
fi

ssh "$host" 'sudo sh -c "umask 077 && mkdir -p /etc/dispatch && cat > /etc/dispatch/env.new && mv /etc/dispatch/env.new /etc/dispatch/env"' < .env.prod

if ssh "$host" "test -d $rel"; then
  script="$rel/scripts/release.sh"
else
  git archive "$commit" | ssh "$host" "sudo rm -rf $rel.new && sudo mkdir -p $rel.new && sudo tar -x -C $rel.new"
  script="$rel.new/scripts/release.sh"
fi
ssh "$host" "sudo bash $script"
