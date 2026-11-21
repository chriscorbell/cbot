# Installs Dispatch on a machine of its own, or updates it:
#
#   curl -fsSL https://raw.githubusercontent.com/chriscorbell/dispatch/main/scripts/install.sh | bash
#
# It checks the machine (Ubuntu or Debian on x86-64, with systemd), asks three things (the bots' time
# zone, how many bots at most, and whether to set up Tailscale too), then downloads the newest release
# from GitHub into /srv/dispatch/releases and runs its scripts/release.sh, the same step
# scripts/deploy.sh runs: it provisions the machine, builds the release and the speech image, and
# starts the dispatch service. A release is a vX.Y.Z tag signed by one of the keys in release_signers
# (scripts/publish.sh makes them), and nothing of it runs until the signature checks out. Dispatch
# serves HTTPS on the local network with a certificate of its own (server/src/https.ts), which
# browsers warn about once per device; Tailscale adds an address with a certificate they trust. The
# answers go to /etc/dispatch/env. Run it again to update to the newest release; the settings stay as
# they are. The app does that itself from Settings > General: it runs the installer of the release it
# is running, unattended (server/src/updates.ts), so each new release is checked against the keys of
# the one before it. /etc/dispatch/source tells it the repository to follow.
#
# At a terminal it takes the whole screen, as an editor does: a screen for each question, with gum's
# lists and buttons (a pinned release from GitHub, checked against its checksum and deleted when the
# installer ends), then the install's steps with their times. When it ends, the terminal gets its
# screen back and the outcome is printed there, so the address to open stays in the scrollback.
# Without gum, on a terminal smaller than 64 by 20, or with nobody at it, it prints its steps line by
# line instead.
#
# Unattended, the answers come from the environment, DISPATCH_TZ, DISPATCH_MAX_BOTS and DISPATCH_TAILSCALE (1 or
# 0), with the defaults for any left out. DISPATCH_YES=1 takes them without asking even at a terminal.
# DISPATCH_REF installs a branch, tag or commit instead of the newest release, with no signature to
# check, and updates then follow that branch. DISPATCH_REPO installs from a fork, and GITHUB_TOKEN
# reads a private one.
#
# Everything is in functions and main runs on the last line, so a download cut short runs nothing.
