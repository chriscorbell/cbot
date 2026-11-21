# Dispatch's dev image: the server, one X display and VNC server per bot, Chrome and Hermes Agent in one
# container, set up by the same script as the production host (scripts/provision.sh) and built by the
# same script as a release (scripts/build-release.sh). compose.yaml says how to run it. Production runs
# on its own machine without Docker (scripts/install.sh, scripts/deploy.sh).

# ---------------------------------------------------------------- the computer
FROM ubuntu:26.04@sha256:d66b366dac61b575bee2aef07e9c26e8070096fbe84a3d4d3eb0da069b5d76db AS computer
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
COPY scripts/provision.sh /tmp/provision.sh
RUN bash /tmp/provision.sh --container && rm /tmp/provision.sh

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
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1
# The server starts the displays and the bots' Hermes gateways itself.
CMD ["/app/node/bin/node", "server/dist/index.js"]
