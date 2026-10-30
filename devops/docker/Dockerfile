# The plan board, built once and then handed out as files.
#
# Both pages (the board and availability/) come out of one Vite build into
# dist/, and both read planner.config.json at runtime from plan-api, so the
# image does not need rebuilding when the config changes.

FROM node:22-alpine AS builder
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# A broken config fails the build here rather than in everyone's browser.
RUN npm run check-config && npm run build

# ---------------------------------------------------------------------------
# The plan store. No dependencies, so no install step — just node and the file
# in server/. The plans themselves live on the /data volume, not in the image.
FROM node:22-alpine AS api-runner
WORKDIR /app

COPY server ./server
# The default config. compose.plan.yml mounts the repo's copy over it, so editing
# the file on the host is picked up without a rebuild.
COPY planner.config.json ./planner.config.json

# Created here so the named volume inherits the ownership and the service can
# run unprivileged; a volume mounted over a path that does not exist in the
# image comes up owned by root and the first write fails.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production
ENV PLAN_DATA_DIR=/data
ENV PLANNER_CONFIG=/app/planner.config.json
EXPOSE 3000
CMD ["node", "server/index.mjs"]

# ---------------------------------------------------------------------------
# TLS, the hostname and the certificate all belong to the edge nginx in
# compose.plan.yml, which proxies here over the compose network. This listens on
# plain HTTP/80 and never sees a certificate.
FROM nginx:1.27-alpine AS static-runner

COPY --from=builder /app/dist /usr/share/nginx/html
COPY devops/docker/static-site.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
