#!/usr/bin/env bash
# Sets a machine up as Dispatch's computer: what the bots' screens and the server run on, Node, Google
# Chrome and Hermes Agent, and on the production host also Docker (for the speech service), Dispatch's
# systemd unit and, when asked, Tailscale Serve. Safe to run again: it installs only what is missing or changed.
# scripts/release.sh runs it on the host whenever it or deploy/ changed; the dev image runs it at
# build time.
#
#   sudo scripts/provision.sh               # the production host
#   scripts/provision.sh --container        # the dev image (Dockerfile): no Docker or Tailscale; systemd
#                                           # runs in the container as on a host (compose.yaml)
#
# Everything here runs as root, and what the bots install later (apt, pip, npm, Hermes tools) through
# their account's sudo stays on the machine too.
set -euo pipefail

container=false
[ "${1:-}" = --container ] && container=true
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo $0)." >&2; exit 1; }
here="$(cd "$(dirname "$0")/.." && pwd)"

# needrestart would list every service a library update touched; nothing here needs it.
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1
apt_install() { apt-get install -y -qq --no-install-recommends -o Dpkg::Use-Pty=0 "$@" >/dev/null; }
say() { echo "[provision] $*"; }

# ---------------------------------------------------------------- vendor apt repositories

# key_of <file>: the fingerprint of each primary key in a key file, armored or not.
key_of() { gpg --show-keys --with-colons "$1" 2>/dev/null | awk -F: '$1 == "pub" { p = 1 } $1 == "fpr" && p { print $10; p = 0 }'; }

# keyring <file> <url> <fingerprint>: a vendor's apt signing key, trusted only when it is exactly the
# key with that fingerprint, so a changed key at the URL (or on the machine) stops provisioning
# rather than being trusted for every package after it. Kept unarmored, as apt reads a .gpg file.
keyring() {
  local tmp
  [ -s "$1" ] && [ "$(key_of "$1")" = "$3" ] && return 0
  tmp="$(mktemp)"
  curl -fsSL "$2" -o "$tmp"
  if [ "$(key_of "$tmp")" != "$3" ]; then
    echo "The signing key at $2 isn't the one expected ($3), so it isn't trusted. It has: $(key_of "$tmp" | tr '\n' ' ')" >&2
    rm -f "$tmp"
    exit 1
  fi
  mkdir -p "$(dirname "$1")"
  if grep -q -- '-----BEGIN PGP PUBLIC KEY BLOCK-----' "$tmp"; then gpg --dearmor --yes -o "$1" "$tmp"; else install -m 0644 "$tmp" "$1"; fi
  rm -f "$tmp"
}

apt-get update -qq
apt_install ca-certificates curl gnupg

# Chrome follows the stable channel on purpose: apt upgrades bring its security fixes.
# Fingerprint: https://www.google.com/linuxrepositories/ (the current signing key).
keyring /usr/share/keyrings/google-chrome.gpg https://dl.google.com/linux/linux_signing_key.pub EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796
# The same file Chrome's package writes for itself, so its own setup leaves it as it is.
cat > /etc/apt/sources.list.d/google-chrome.sources <<'EOF'
### THIS FILE IS AUTOMATICALLY CONFIGURED ###
# Changes to this file will not be preserved.
# This file will not be recreated if removed.
X-Repolib-Name: Google Chrome
Types: deb
URIs: https://dl.google.com/linux/chrome-stable/deb/
Suites: stable
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/google-chrome.gpg
EOF

# Node 24 from NodeSource, for the bots and Hermes: Hermes runs Node tools (language servers, MCP
# servers through npx, its verification recipes) and the bots build and run Node projects. Dispatch
# itself runs on the Node its release brings (scripts/build-release.sh). apt keeps this one patched
# within 24.x. NodeSource doesn't publish its key's
# fingerprint; this is the key its setup script (nodesource/distributions, scripts/deb/setup_24.x)
# downloads, on keyserver.ubuntu.com since 2016 as "NSolid <nsolid-gpg@nodesource.com>".
keyring /usr/share/keyrings/nodesource.gpg https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key 6F71F525282841EEDAF851B42F59B5F99B1BE0B4
cat > /etc/apt/sources.list.d/nodesource.sources <<'EOF'
Types: deb
URIs: https://deb.nodesource.com/node_24.x
Suites: nodistro
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/nodesource.gpg
EOF

if ! $container; then
  # Docker Engine and Compose from Docker's repository, not the distribution's docker.io. Docker
  # keeps one repository for Debian and one for Ubuntu; Ubuntu's derivatives name their Ubuntu base.
  docker_os="$(. /etc/os-release && case " $ID ${ID_LIKE:-} " in *" ubuntu "*) echo ubuntu ;; *) echo debian ;; esac)"
  # Fingerprint: Docker's install guide, which listed it in 2020
  # (https://github.com/docker/docs/blob/777c5d23dafd4b640016f24f92fe416f246ec848/engine/install/ubuntu.md);
  # the same key signs both repositories.
  install -d -m 0755 /etc/apt/keyrings
  keyring /etc/apt/keyrings/docker.gpg "https://download.docker.com/linux/$docker_os/gpg" 9DC858229FC7DD38854AE2D88D81803C0EBFCD88
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$docker_os
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Signed-By: /etc/apt/keyrings/docker.gpg
EOF
fi

apt-get update -qq

# ---------------------------------------------------------------- packages

# What each display runs (server/src/displays.ts): TigerVNC's Xvnc, a session bus and xfwm4.
# What the box scripts (server/box) use on it, so their one-time setup has nothing to install:
# GTK for Python with the SVG loader (wallpaper and dock), wmctrl/xdotool/x11-utils/xsetroot
# (windows), openssl (packs the home screen extension), xfce4-terminal and Thunar (the dock's
# Terminal and Files; xfconf stores the terminal's look), Inter for the home screen, and the
# light theme and icons they look for first (Arc-Lighter, Papirus). ImageMagick takes screenshots.
# tzdata gives TZ its zone files. Build tools, git and Python's venv and pip are for the bots, and
# for npm when a native module has no prebuilt binary.
say "packages"
apt_install \
  git xz-utils unzip zip jq ripgrep libatomic1 procps psmisc lsof less nano tzdata sudo \
  build-essential python3 python3-venv python3-pip python3-dev \
  tigervnc-standalone-server xfwm4 xfconf dbus dbus-x11 \
  xfce4-terminal thunar \
  wmctrl xdotool x11-utils x11-xserver-utils \
  python3-gi python3-gi-cairo gir1.2-gtk-3.0 librsvg2-common \
  openssl imagemagick \
  fonts-inter fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
  arc-theme papirus-icon-theme adwaita-icon-theme \
  nodejs google-chrome-stable
$container || apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
# A host has systemd already; the dev container runs it as its first process.
! $container || apt_install systemd systemd-sysv

# ---------------------------------------------------------------- Hermes Agent

# Hermes Agent with its official source installer (https://hermes-agent.nousresearch.com/docs/getting-started/installation),
# pinned to a release: the script and the checkout both at the tag's commit, since a tag can move. The code, its
# tools and its Python go under /opt/hermes. Each bot's Hermes home links back to tools/, installs/
# and the plugins there (see engine.ts). No browser: the bots use the Chrome on their own screen.
#
# `hermes` is a copy of the checkout's launcher, kept outside the checkout. Hermes rewrites the
# checkout's own launcher to run from whichever bot home launched it last (each home links tools/
# and installs/ here, so Hermes takes it for the owner), and that launcher stops working once that
# bot is deleted. The copy keeps running the shared Python.
#
# GitHub Copilot left Hermes core for the github-copilot plugin, installed here at a pinned commit.
#
# A different pin moves the old install aside (/opt/hermes.<time>) and installs fresh; the bots'
# homes link to the same paths, so they pick up the new one when their gateways restart.
HERMES_VERSION=v0.23.1
HERMES_COMMIT=3b421578588243f920886e6fe79a6faa87ea026e
COPILOT_PLUGIN_COMMIT=df8f1321941125d45dde71ab20196fbeea093191
pin="$HERMES_VERSION $HERMES_COMMIT $COPILOT_PLUGIN_COMMIT"
if [ "$(cat /opt/hermes/.dispatch-pin 2>/dev/null)" != "$pin" ] || ! HERMES_HOME=/opt/hermes hermes --version >/dev/null 2>&1; then
  say "Hermes Agent $HERMES_VERSION"
  [ -e /opt/hermes ] && mv /opt/hermes "/opt/hermes.$(date +%Y%m%d%H%M%S)"
  tmp="$(mktemp -d)"
  curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_COMMIT}/scripts/install.sh" -o "$tmp/install.sh"
  bash "$tmp/install.sh" --commit "$HERMES_COMMIT" --dir /opt/hermes/hermes-agent --hermes-home /opt/hermes \
    --non-interactive --skip-browser
  rm -rf "$tmp"
  mkdir -p /opt/hermes/launcher
  cp /opt/hermes/hermes-agent/.hermes/bin/hermes /opt/hermes/launcher/hermes
  ln -sfn /opt/hermes/launcher/hermes /usr/local/bin/hermes
  HERMES_HOME=/opt/hermes hermes plugins install github-copilot --ref "$COPILOT_PLUGIN_COMMIT" --enable --yes-deps
  rm -rf /opt/hermes/cache
  echo "$pin" > /opt/hermes/.dispatch-pin
fi
HERMES_HOME=/opt/hermes hermes --version | head -1

# ---------------------------------------------------------------- the bots' units

# The systemd units each bot's screen and agent run as (deploy/, server/src/units.ts), and the account
# they run as (DISPATCH_USER in /etc/dispatch/env): its sudo rule, and the Hermes install made its.
bash "$here/scripts/install-units.sh"

# ---------------------------------------------------------------- the dev image stops here

if $container; then
  rm -f /etc/cron.daily/google-chrome
  rm -rf /var/lib/apt/lists/* /root/.local /root/.cache
  exit 0
fi

# ---------------------------------------------------------------- the production host

# /srv/dispatch: releases/<commit> and `current`, the one running (scripts/release.sh).
# /var/lib/dispatch: DATA_DIR (database, generated secret, setup code), root's alone.
# /etc/dispatch/env: the settings, from the installer or .env.prod on the dev machine (scripts/deploy.sh).
# ~<the bots' account>/dispatch: the bots' Hermes homes, Chrome profiles and Library files, which the
# server makes as it needs them. /opt/dispatch: what the box scripts make as they set up screens (desk.ts).
install -d -m 0755 /srv/dispatch /srv/dispatch/releases /var/log/dispatch
install -d -m 0700 /var/lib/dispatch /etc/dispatch

install -m 0644 "$here/deploy/dispatch.service" /etc/systemd/system/dispatch.service
systemctl daemon-reload
systemctl enable dispatch.service >/dev/null 2>&1
systemctl enable --now docker.service >/dev/null 2>&1

# Chrome opens whatever pages the bots visit, and nothing else updates it: unattended-upgrades takes
# only the distribution's own updates unless told otherwise. So it is on, and takes Chrome's too (the
# fields of Google's Release file). A Chrome already running keeps its version until it restarts;
# the server restarts each bot's once the bot is idle (server/src/chrome-updates.ts).
apt_install unattended-upgrades
cat > /etc/apt/apt.conf.d/52dispatch-upgrades <<'EOF'
// Written by Dispatch (scripts/provision.sh): security updates every day, Google Chrome's among them.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Origins-Pattern { "origin=Google LLC,label=Google,archive=stable"; };
EOF

# Tailscale Serve gives the app an HTTPS address on the tailnet, on the same port at both ends, only
# when /etc/dispatch/env asks with TAILSCALE_SERVE=1 (a machine scripts/deploy.sh looks after, from
# .env.prod). The installer asks its own question and serves the app on 443 itself
# (install-machine.sh), so a machine whose owner said no, or that runs Tailscale for something else,
# isn't put on the tailnet. Serve waits for HTTPS to be turned on for the tailnet when it isn't, and
# nobody would see its link here, so it gets half a minute.
if grep -qxE 'TAILSCALE_SERVE=["'\'']?1["'\'']?' /etc/dispatch/env 2>/dev/null && command -v tailscale >/dev/null &&
  ! tailscale serve status 2>/dev/null | grep -q '127.0.0.1:8787'; then
  timeout 30 tailscale serve --bg --https=8787 http://127.0.0.1:8787 >/dev/null ||
    say "Tailscale Serve didn't start; turn on HTTPS for the tailnet, then: tailscale serve --bg --https=8787 http://127.0.0.1:8787"
fi
say "done"
