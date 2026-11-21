# Dispatch's dev image: the server, one X display and VNC server per bot, Chrome and Hermes Agent in one
# container, set up by the same script as the production host (scripts/provision.sh) and built by the
# same script as a release (scripts/build-release.sh). systemd runs in it as on a host: the server is
# dispatch.service, and each bot's screen and agent run as units of their own (server/src/units.ts).
# compose.yaml says how to run it. Production runs on its own machine without Docker
# (scripts/install.sh, scripts/deploy.sh).

# ---------------------------------------------------------------- the computer
FROM ubuntu:26.04@sha256:d66b366dac61b575bee2aef07e9c26e8070096fbe84a3d4d3eb0da069b5d76db AS computer
# The account the bots run as (server/src/account.ts), as the account that runs the installer is on a
# machine: an ordinary one, which provision.sh (scripts/install-units.sh) lets sudo. The entrypoint
# passes DISPATCH_USER on to the server.
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 DISPATCH_USER=bots
RUN useradd --create-home --shell /bin/bash --user-group bots
COPY scripts/provision.sh scripts/install-units.sh /tmp/dispatch/scripts/
COPY deploy/dispatch-*@.* /tmp/dispatch/deploy/
RUN bash /tmp/dispatch/scripts/provision.sh --container && rm -r /tmp/dispatch

# ---------------------------------------------------------------- build: as a release is built
# scripts/build-release.sh, the one build: its own Node, the server and web app, and the server's
# production dependencies alone. The caches keep the Node download and npm's packages between builds.
FROM computer AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/root/.npm --mount=type=cache,target=/root/.cache/dispatch-build \
    scripts/build-release.sh /out --commit dev

# ---------------------------------------------------------------- the app
# What a release unpacks to, run with the Node it brings.
FROM computer
COPY --from=build /out /app
WORKDIR /app
# The server as the host runs it, with what's different in a container (it runs from /app on the
# environment compose gives the container) in a drop-in. Services a container has no use for stay off.
COPY deploy/dispatch.service /etc/systemd/system/
COPY deploy/container/dispatch.conf /etc/systemd/system/dispatch.service.d/container.conf
COPY deploy/container/entrypoint.sh /usr/local/sbin/dispatch-entrypoint
RUN systemctl enable dispatch.service \
  && systemctl mask systemd-modules-load.service systemd-resolved.service systemd-networkd.service systemd-timesyncd.service \
    systemd-logind.service getty.target console-getty.service apt-daily.timer apt-daily-upgrade.timer \
    e2scrub_all.timer fstrim.timer motd-news.timer dpkg-db-backup.timer >/dev/null 2>&1
# systemd reads this to know it is in a container.
ENV container=docker
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fsS "http://127.0.0.1:8787/api/health" || exit 1
# What systemd takes as "shut down cleanly".
STOPSIGNAL SIGRTMIN+3
# Hands compose's environment to dispatch.service, then becomes systemd (PID 1).
ENTRYPOINT ["/usr/local/sbin/dispatch-entrypoint"]
