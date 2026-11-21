# Removes Dispatch from a machine that scripts/install.sh set up, with all its data:
#
#   curl -fsSL https://raw.githubusercontent.com/chriscorbell/dispatch/main/scripts/uninstall.sh | bash
#
# It stops the service and everything it started (the bots' screens, Chromes and Hermes gateways),
# then deletes the releases, the database and the bots' homes, Chrome profiles and Library files,
# Hermes Agent, the speech service's containers and images and Docker's build cache, the settings,
# the logs, what the screens leave in root's home (window manager and GTK settings, Chrome's crash
# reports, the build caches), the Chrome policy, and the Tailscale Serve address for Dispatch. There is no
# undo. The programs provisioning installed for everyone (Google Chrome, Node.js, Docker and the
# desktop packages), Tailscale, and whatever the bots installed themselves stay on the machine.
#
# It asks before deleting anything; DISPATCH_YES=1 deletes without asking, for a machine nobody is at.
# At a terminal it takes the whole screen, as install.sh does: the question with two buttons, then
# each step with a spinner and its time. When it ends, the terminal gets its screen back with the
# steps printed there. On a terminal smaller than 64 by 20 it prints its steps line by line instead.
#
# Everything is in functions and main runs on the last line, so a download cut short runs nothing.
