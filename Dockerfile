# Dispatch's dev image: the server, one X display and VNC server per bot, Chrome and Hermes Agent in one
# container, set up by the same script as the production host (scripts/provision.sh). compose.yaml
# says how to run it. Production runs on its own machine without Docker (scripts/deploy.sh).

# ---------------------------------------------------------------- the computer
FROM ubuntu:26.04 AS computer
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
COPY scripts/provision.sh /tmp/provision.sh
RUN bash /tmp/provision.sh --container && rm /tmp/provision.sh

# ---------------------------------------------------------------- build: web app and server
FROM computer AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY server server
COPY web web
# server/ and web/ only get node_modules of their own when a version conflicts; make sure both exist for the COPY below.
RUN npm run build && npm prune --omit=dev && mkdir -p server/node_modules web/node_modules

# ---------------------------------------------------------------- the app
FROM computer
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/box server/box
COPY --from=build /app/web/dist web/dist
# desk.ts draws the bots' avatars on their screens from the web app's shapes.
COPY --from=build /app/web/src/avatar/shapes.gen.ts web/src/avatar/
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1
# The server starts the displays and the bots' Hermes gateways itself.
CMD ["node", "server/dist/index.js"]
