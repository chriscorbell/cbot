#!/usr/bin/env bash
# Builds Dispatch into a folder that runs as it is, on a Node of its own:
#
#   scripts/build-release.sh <out> [--version vX.Y.Z] [--commit <sha>] [--tarball <file>]
#
# The one build, wherever Dispatch is built:
#   - .github/workflows/release.yml makes each release's tarball with it (--tarball), which the
#     installer downloads, checks and unpacks; scripts/publish.sh builds again with it to compare
#   - scripts/release.sh builds a source tree with it: what scripts/deploy.sh sends, and what an
#     install with DISPATCH_REF downloads
#   - the dev image (Dockerfile)
#
# It downloads the Node that .node-version names from nodejs.org, checked against scripts/node.sha256
# (update both together), and builds with that Node's npm in this source tree: npm ci and npm run build.
# <out> is emptied, then gets:
#
#   node/          Node itself, which deploy/dispatch.service runs the server with
#   server/        dist/ (the compiled server), box/ (the scripts for the bots' screens), package.json
#   node_modules/  the server's production dependencies, and nothing of the web app's
#   web/           dist/ (the web app), and src/avatar/shapes.gen.ts, which desk.ts draws avatars from
#   scripts/       install.sh, uninstall.sh, release.sh, provision.sh and this script, which the
#                  machine runs to update itself
#   deploy/        the systemd unit and the speech service's Compose file and address
#   speech/        the speech service's source, when the tree has it: release.sh builds the image from
#                  it when a release's manifest.json names no prebuilt one
#   BUILD          the version, commit and Node it was built from
#
# A tarball is made the same way each time from the same commit (sorted, owned by root, dated at the
# commit), and its native modules must load on the oldest system Dispatch supports (glibc 2.35, Ubuntu
# 22.04), which the build checks.
set -euo pipefail

src="$(cd "$(dirname "$0")/.." && pwd)"
say() { echo "[build] $*"; }
die() { echo "build-release.sh: $*" >&2; exit 1; }

out='' version=dev commit='' tarball=''
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:?}"; shift 2 ;;
    --commit) commit="${2:?}"; shift 2 ;;
    --tarball) tarball="${2:?}"; shift 2 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$out" ] || die "one output folder only"; out="$1"; shift ;;
  esac
done
[ -n "$out" ] || die "usage: scripts/build-release.sh <out> [--version vX.Y.Z] [--commit <sha>] [--tarball <file>]"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
case "$tarball" in '' | /*) ;; *) tarball="$PWD/$tarball" ;; esac
[ -n "$commit" ] || commit="$(git -C "$src" rev-parse HEAD 2>/dev/null || echo unknown)"

# ---------------------------------------------------------------- Node

node_version="$(tr -d '[:space:]' <"$src/.node-version")"
name="node-v$node_version-linux-x64"
want="$(awk -v f="$name.tar.xz" '$2 == f { print $1 }' "$src/scripts/node.sha256")"
[ -n "$want" ] || die ".node-version says $node_version, but scripts/node.sha256 has no checksum for $name.tar.xz"
cache="${DISPATCH_BUILD_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/dispatch-build}"
mkdir -p "$cache"
archive="$cache/$name.tar.xz"
if ! echo "$want  $archive" | sha256sum -c --status 2>/dev/null; then
  say "downloading Node $node_version"
  curl -fsSL "https://nodejs.org/dist/v$node_version/$name.tar.xz" -o "$archive.part"
  echo "$want  $archive.part" | sha256sum -c --status ||
    { rm -f "$archive.part"; die "the download of Node $node_version doesn't match scripts/node.sha256"; }
  mv "$archive.part" "$archive"
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tar -xJf "$archive" -C "$work"
export PATH="$work/$name/bin:$PATH" NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# ---------------------------------------------------------------- build

say "building $version ($commit) with Node $node_version"
cd "$src"
npm ci --loglevel=error
npm run build --silent

# The server's production dependencies alone: a fresh install of the server workspace, so nothing
# the web app needs only to build (React, its fonts and icons) ships.
mkdir -p "$work/prod/server" "$work/prod/web"
cp package.json package-lock.json "$work/prod/"
cp server/package.json "$work/prod/server/"
cp web/package.json "$work/prod/web/"
(cd "$work/prod" && npm ci --omit=dev --workspace server --loglevel=error)
# The workspace links point back into the source tree. Native modules come with prebuilt binaries
# for every system (better-sqlite3 has eight); this one runs on Linux on x86-64 with glibc.
rm -rf "$work/prod/node_modules/@dispatch"
find "$work/prod/node_modules" -path '*/prebuilds/*' -name '*.node' ! -name 'linux-x64.node' -delete
# Their install step still runs node-gyp's configure, which leaves a build/ folder naming the paths it ran
# in; a module that loads its prebuilt binary never reads it, and it would make each build differ.
for prebuilt in "$work"/prod/node_modules/*/prebuilds/linux-x64.node; do
  [ -e "$prebuilt" ] && rm -rf "$(dirname "$(dirname "$prebuilt")")/build"
done

# ---------------------------------------------------------------- lay out

rm -rf "$out"
mkdir -p "$out/node/bin" "$out/server" "$out/web/src/avatar" "$out/scripts"
cp "$work/$name/bin/node" "$out/node/bin/node"
cp "$work/$name/LICENSE" "$out/node/LICENSE"
cp -a "$work/prod/node_modules" "$out/node_modules"
[ ! -d "$work/prod/server/node_modules" ] || cp -a "$work/prod/server/node_modules" "$out/server/node_modules"
cp -a server/dist server/box server/package.json "$out/server/"
cp -a web/dist "$out/web/dist"
cp web/src/avatar/shapes.gen.ts "$out/web/src/avatar/"
cp -a deploy "$out/deploy"
cp scripts/release.sh scripts/provision.sh scripts/build-release.sh scripts/bundle.sh scripts/node.sha256 "$out/scripts/"
cp -a scripts/install "$out/scripts/install"
# install.sh and uninstall.sh, joined from their parts: the app's updates run this release's.
bash scripts/bundle.sh "$out/scripts"
[ ! -d speech ] || cp -a speech "$out/speech"
cp LICENSE .node-version "$out/"
find "$out" -name __pycache__ -type d -prune -exec rm -rf {} +
printf 'version=%s\ncommit=%s\nnode=%s\n' "$version" "$commit" "$node_version" >"$out/BUILD"

[ -n "$tarball" ] || { say "built $out"; exit 0; }

# ---------------------------------------------------------------- the tarball

# Native modules must load on glibc 2.35 (Ubuntu 22.04, the oldest system Dispatch supports). A
# module that needs newer was compiled here rather than downloaded prebuilt; build it on 22.04.
command -v objdump >/dev/null || die "objdump (binutils) is needed to check the native modules"
while IFS= read -r -d '' module; do
  [ "$(head -c 4 "$module" | tail -c 3)" = ELF ] || continue
  need="$(objdump -T "$module" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -V | tail -n 1)"
  if [ -n "$need" ] && [ "$(printf '%s\n2.35\n' "$need" | sort -V | tail -n 1)" != 2.35 ]; then
    die "${module#"$out"/} needs glibc $need, newer than Ubuntu 22.04's 2.35"
  fi
done < <(find "$out" -name '*.node' -type f -print0)

epoch="${SOURCE_DATE_EPOCH:-$(git -C "$src" log -1 --format=%ct 2>/dev/null || echo 0)}"
mkdir -p "$(dirname "$tarball")"
tar --sort=name --format=gnu --mtime="@$epoch" --owner=0 --group=0 --numeric-owner --mode='u+rw,go+r,go-w' \
  -C "$out" -cf - . | gzip -n -9 >"$tarball.part"
mv "$tarball.part" "$tarball"
say "packed $tarball ($(du -h "$tarball" | cut -f1))"
