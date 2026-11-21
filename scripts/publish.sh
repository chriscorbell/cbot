#!/usr/bin/env bash
# Publishes a release of Dispatch:
#
#   scripts/publish.sh v1.2.0
#
#   1. Checks main as GitHub has it: `npm run check` on that exact commit, in a temporary worktree,
#      as scripts/deploy.sh checks one.
#   2. Signs a tag on it with whichever key in release_signers (scripts/install/install-release.sh)
#      ssh-agent holds, so no private key is named here. Before pushing it checks the tag the way the
#      installer will: with this commit's installer, which first installs use, and with the last
#      release's, which every machine updating from it runs. Then it pushes the tag.
#   3. GitHub Actions builds the release from the tag (.github/workflows/release.yml) and attaches it
#      to a draft release. This waits for it, downloads it, and checks it against SHA256SUMS.
#   4. Builds the same commit here with scripts/build-release.sh (in Docker unless this is Linux on
#      x86-64) and stops unless the result is the tarball's, file for file: what GitHub Actions
#      built is what the commit makes.
#   5. Signs SHA256SUMS with the same key, as dispatch-release, checks the files the way this commit's
#      installer will, attaches the signature, and publishes the release.
#
# Installs and updates take the newest vX.Y.Z tag, and only when its tag and its SHA256SUMS were
# signed with a key in release_signers. A new key goes in release_signers in a release that a key
# already listed signs. The tag's message lists the commits since the last release, and the GitHub
# release shows the same list.
set -euo pipefail

repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$repo"
version="${1:-}"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Usage: scripts/publish.sh vX.Y.Z" >&2; exit 1; }
command -v gh >/dev/null || { echo "This needs the GitHub CLI, gh." >&2; exit 1; }
die() { echo "$*" >&2; exit 1; }

work="$(mktemp -d)"
trap 'git -C "$repo" worktree remove --force "$work/tree" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

git fetch -q --tags origin main
commit="$(git rev-parse --verify 'origin/main^{commit}')"
if git rev-parse -q --verify "refs/tags/$version" >/dev/null; then die "$version exists already."; fi
last="$(git tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
if [ -n "$last" ] && [ "$(printf '%s\n%s\n' "$last" "$version" | sort -V | tail -n 1)" != "$version" ]; then
  die "$version doesn't come after $last, the last release."
fi

echo "Checking $(git log -1 --format='%h %s' "$commit")"
git worktree add --detach --quiet "$work/tree" "$commit"
(cd "$work/tree" && npm ci --no-audit --no-fund --loglevel=error && npm run check) || die "The checks failed; nothing was published."

# installer_of <commit> <file>: that commit's install.sh: committed, in releases before it was joined
# from its parts at build time, and otherwise joined here as its build joins it.
installer_of() {
  if git cat-file -e "$1:scripts/install.sh" 2>/dev/null; then
    git show "$1:scripts/install.sh" >"$2"
  else
    mkdir -p "$work/parts-$1"
    git archive "$1" scripts | tar -x -C "$work/parts-$1"
    bash "$work/parts-$1/scripts/bundle.sh" "$work/parts-$1/out"
    cp "$work/parts-$1/out/install.sh" "$2"
  fi
}
installer_of "$commit" "$work/install-new.sh"
[ -z "$last" ] || installer_of "$last" "$work/install-last.sh"
key=''
while read -r _ _ type blob; do
  if ssh-add -L 2>/dev/null | awk '{ print $1, $2 }' | grep -qxF "$type $blob"; then key="$type $blob"; break; fi
done < <(sed -n '/^release_signers() {$/,/^}$/{/^dispatch /p}' "$work/install-new.sh")
[ -n "$key" ] || die "ssh-agent holds none of the keys in release_signers (scripts/install/install-release.sh). Add yours to the agent with ssh-add."

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

# ---------------------------------------------------------------- the tag

git -c gpg.format=ssh -c user.signingKey="key::$key" tag -s -F "$work/message" "$version" "$commit"
# accepts <install.sh> <whose>: stops, deleting the tag, unless that installer's fetch_signed takes it.
accepts() {
  bash -c 'set -euo pipefail; source <(sed "\$d" "$1"); die() { echo "$*" >&2; exit 1; }; fetch_signed "$2" "$3" "$4"' \
    _ "$1" "$repo" "$version" "$(mktemp -d -p "$work")" && return
  git tag -d "$version" >/dev/null
  die "$2 installer wouldn't take the new tag, so it was deleted and nothing was published."
}
accepts "$work/install-new.sh" "This commit's"
[ -z "$last" ] || accepts "$work/install-last.sh" "$last's"
git push -q origin "refs/tags/$version"

# ---------------------------------------------------------------- GitHub Actions' build

echo "Waiting for GitHub Actions to build $version"
run=''
for _ in $(seq 60); do
  run="$(gh run list --workflow release.yml --event push --branch "$version" --json databaseId,headSha \
    --jq ".[] | select(.headSha == \"$commit\") | .databaseId" | head -n 1)"
  [ -z "$run" ] || break
  sleep 5
done
[ -n "$run" ] || die "GitHub Actions didn't start building $version. The tag is pushed; once it has built, run the rest by hand (see docs/RUNNING.md)."
gh run watch "$run" --exit-status >/dev/null || die "GitHub Actions couldn't build $version: gh run view $run --log-failed"

tarball="dispatch-$version-linux-amd64.tar.gz"
mkdir -p "$work/assets"
gh release download "$version" --dir "$work/assets" \
  --pattern SHA256SUMS --pattern manifest.json --pattern "$tarball" --pattern install.sh --pattern uninstall.sh
(cd "$work/assets" && sha256sum -c --quiet --strict SHA256SUMS) || die "The draft release's files don't match its SHA256SUMS."

# ---------------------------------------------------------------- the same build here

echo "Building $version here to compare"
if [ "$(uname -sm)" = 'Linux x86_64' ]; then
  bash "$work/tree/scripts/build-release.sh" "$work/local" --version "$version" --commit "$commit" >"$work/build.log" 2>&1 ||
    { tail -n 30 "$work/build.log" >&2; die "The build here failed."; }
else
  command -v docker >/dev/null || die "Building here needs Linux on x86-64, or Docker."
  base="$(sed -nE 's/^FROM (ubuntu:[^ ]+) AS computer$/\1/p' "$work/tree/Dockerfile")"
  docker run --rm --platform linux/amd64 -v "$work/tree:/src" -v "$work:/work" "$base" bash -c '
    apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils git python3 make g++ >/dev/null &&
    git config --global --add safe.directory "*" && bash /src/scripts/build-release.sh /work/local --version "$1" --commit "$2"' \
    _ "$version" "$commit" >"$work/build.log" 2>&1 || { tail -n 30 "$work/build.log" >&2; die "The build here failed."; }
fi
mkdir -p "$work/theirs"
tar -xzf "$work/assets/$tarball" -C "$work/theirs"
if ! diff -r "$work/local" "$work/theirs" >"$work/differences" 2>&1; then
  head -n 40 "$work/differences" >&2
  die "GitHub Actions' build of $version isn't what this commit builds here, so it wasn't signed. The tag and the draft release stay for a look."
fi

# ---------------------------------------------------------------- sign and publish

printf '%s\n' "$key" >"$work/signing.pub"
ssh-keygen -q -Y sign -U -n dispatch-release -f "$work/signing.pub" "$work/assets/SHA256SUMS"
bash -c 'set -euo pipefail; source <(sed "\$d" "$1"); die() { echo "$*" >&2; exit 1; }; fetch_assets "file://$2" "$3" "$4" "$(mktemp -d -p "$5")"' \
  _ "$work/install-new.sh" "$work/assets" "$version" "$commit" "$work" ||
  die "This commit's installer wouldn't take the signed build, so the release stays a draft."
gh release upload "$version" "$work/assets/SHA256SUMS.sig" --clobber
tail -n +3 "$work/message" >"$work/notes"
gh release edit "$version" --draft=false --latest --title "Dispatch $version" --notes-file "$work/notes" >/dev/null
echo "Published $version. Machines on the releases offer it within six hours."
