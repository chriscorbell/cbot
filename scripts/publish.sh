#!/usr/bin/env bash
# Publishes a release of Dispatch: a signed tag on main as GitHub has it, and a GitHub release.
#
#   scripts/publish.sh v1.2.0
#
# Installs and updates take the newest vX.Y.Z tag, and only when a key in release_signers in
# scripts/install.sh signed it (fetch_signed there). This signs with whichever of those keys ssh-agent
# holds, so no private key is named here. Before it pushes anything it checks the tag the way the
# installer will: with this commit's install.sh, which first installs use, and with the last
# release's, which every machine updating from it runs. A new key goes in release_signers in a
# release that a key already listed signs.
#
# The commit must pass `npm run check`, run on that exact commit in a temporary worktree, as
# scripts/deploy.sh checks one. The tag's message lists the commits since the last release, and the
# GitHub release shows the same list.
set -euo pipefail

repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$repo"
version="${1:-}"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Usage: scripts/publish.sh vX.Y.Z" >&2; exit 1; }
command -v gh >/dev/null || { echo "This needs the GitHub CLI, gh." >&2; exit 1; }

work="$(mktemp -d)"
trap 'git -C "$repo" worktree remove --force "$work/tree" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

git fetch -q --tags origin main
commit="$(git rev-parse --verify 'origin/main^{commit}')"
if git rev-parse -q --verify "refs/tags/$version" >/dev/null; then echo "$version exists already." >&2; exit 1; fi
last="$(git tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
if [ -n "$last" ] && [ "$(printf '%s\n%s\n' "$last" "$version" | sort -V | tail -n 1)" != "$version" ]; then
  echo "$version doesn't come after $last, the last release." >&2
  exit 1
fi

# The installers that will check the tag, and the key to sign it with.
git show "$commit:scripts/install.sh" >"$work/install-new.sh"
[ -z "$last" ] || git show "$last:scripts/install.sh" >"$work/install-last.sh"
key=''
while read -r _ _ type blob; do
  if ssh-add -L 2>/dev/null | awk '{ print $1, $2 }' | grep -qxF "$type $blob"; then key="$type $blob"; break; fi
done < <(sed -n '/^release_signers() {$/,/^}$/{/^dispatch /p}' "$work/install-new.sh")
[ -n "$key" ] || { echo "ssh-agent holds none of the keys in release_signers in scripts/install.sh. Add yours to the agent with ssh-add." >&2; exit 1; }

echo "Checking $(git log -1 --format='%h %s' "$commit")"
git worktree add --detach --quiet "$work/tree" "$commit"
(cd "$work/tree" && npm ci --no-audit --no-fund --loglevel=error && npm run check) || { echo "The checks failed; nothing was published." >&2; exit 1; }

{
  echo "Dispatch $version"
  echo
  if [ -n "$last" ]; then git log --no-merges --format='- %s' "$last..$commit"; else echo "The first release."; fi
} >"$work/message"
echo
cat "$work/message"
echo
if [ -t 0 ]; then
  read -r -p "Publish this as $version, at $(git rev-parse --short=12 "$commit")? [y/N] " answer
  case "$answer" in y | Y | yes) ;; *) echo "Nothing was published."; exit 1 ;; esac
fi

git -c gpg.format=ssh -c user.signingKey="key::$key" tag -s -F "$work/message" "$version" "$commit"
# accepts <install.sh> <whose>: stops, deleting the tag, unless that installer's fetch_signed takes it.
accepts() {
  bash -c 'set -euo pipefail; source <(sed "\$d" "$1"); die() { echo "$*" >&2; exit 1; }; fetch_signed "$2" "$3" "$4"' \
    _ "$1" "$repo" "$version" "$(mktemp -d -p "$work")" && return
  git tag -d "$version" >/dev/null
  echo "$2 installer wouldn't take the new tag, so it was deleted and nothing was published." >&2
  exit 1
}
accepts "$work/install-new.sh" "This commit's"
[ -z "$last" ] || accepts "$work/install-last.sh" "$last's"

git push -q origin "refs/tags/$version"
tail -n +3 "$work/message" >"$work/notes"
gh release create "$version" --verify-tag --title "Dispatch $version" --notes-file "$work/notes"
echo "Published $version. Machines on the releases offer it within six hours."
